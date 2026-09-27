import { onDocumentCreated, onDocumentUpdated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getMessaging, type MulticastMessage } from 'firebase-admin/messaging';
import { MAPS_SERVER_KEY, activeRelationshipForUser, db, haversineM } from './common';
import { homeLocation } from './maps';
import { geofenceStep, initialFence, type FenceState } from './geofence';
import type { LiveDeviceDoc, LiveLocationDoc, SosDoc } from './shared/firestoreSchema';

/**
 * Push notifications for events that need attention — never for telemetry.
 * Realtime state itself flows through Firestore listeners in the apps.
 */
export type Kind = 'sos' | 'deviceDisconnected' | 'lowBattery' | 'locationStale' | 'geofence' | 'snapshot' | 'sosResolved' | 'pairing';

async function tokens(uid: string) {
  const s = await db.collection(`users/${uid}/fcmTokens`).get();
  return s.docs.map((d) => d.id);
}

async function prefs(uid: string) {
  const s = await db.doc(`users/${uid}/settings/app`).get();
  return (s.get('notify') ?? { deviceDisconnected: true, lowBattery: true, locationStale: true, snapshot: false }) as Record<string, boolean>;
}

export async function push(uid: string, kind: Kind, title: string, body: string, data: Record<string, string> = {}): Promise<{ sent: number; failed: number; tokens: number }> {
  const list = await tokens(uid);
  if (!list.length) return { sent: 0, failed: 0, tokens: 0 };
  const critical = kind === 'sos';
  const msg: MulticastMessage = {
    tokens: list,
    notification: { title, body },
    data: { kind, ...data },
    android: { priority: 'high', ttl: critical ? 0 : 3600_000, notification: { channelId: critical ? 'sos' : 'status', sound: critical ? 'default' : undefined, tag: kind } },
    webpush: { headers: { Urgency: critical ? 'high' : 'normal' }, notification: { requireInteraction: critical, tag: kind } },
  };
  const res = await getMessaging().sendEachForMulticast(msg);
  // Drop tokens FCM says are dead.
  await Promise.all(
    res.responses.map((r, i) =>
      !r.success && /registration-token-not-registered|invalid-argument/.test(r.error?.code ?? '') ? db.doc(`users/${uid}/fcmTokens/${list[i]}`).delete() : null,
    ),
  );
  return { sent: res.successCount, failed: res.failureCount, tokens: list.length };
}

/** Idempotency: one push per (user, kind, key). */
async function once(uid: string, kind: string, key: string) {
  const ref = db.doc(`users/${uid}/private/notified_${kind}`);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (s.get('key') === key) return false;
    tx.set(ref, { key, at: Date.now() });
    return true;
  });
}

export const onSosCreated = onDocumentCreated('users/{uid}/sosEvents/{sosId}', async (e) => {
  const sos = e.data?.data() as SosDoc | undefined;
  if (!sos) return;
  const rel = await activeRelationshipForUser(e.params.uid);
  const ref = e.data!.ref;
  if (!rel?.permissions?.sos) {
    await ref.update({ guardianNotify: { status: 'no_guardian', at: Date.now() } });
    return;
  }
  const where = sos.location ? `https://maps.google.com/?q=${sos.location.lat},${sos.location.lng}` : 'Location not available yet';
  // Dedupe: one push per SOS id even if the trigger is retried.
  if (!(await once(rel.guardianUid, `sos_${e.params.sosId}`, e.params.sosId))) return;
  try {
    const r = await push(rel.guardianUid, 'sos', `SOS: ${rel.userName || 'Your person'} needs help`, `Tap to open. ${where}`, { userUid: e.params.uid, sosId: e.params.sosId });
    // "Guardian notified" is only claimed when FCM accepted at least one message.
    await ref.update({ guardianNotify: { status: r.tokens === 0 ? 'no_devices' : r.sent > 0 ? 'sent' : 'failed', sent: r.sent, failed: r.failed, at: Date.now() } });
  } catch {
    await ref.update({ guardianNotify: { status: 'failed', at: Date.now() } });
  }
});

export const onSosUpdated = onDocumentUpdated('users/{uid}/sosEvents/{sosId}', async (e) => {
  const before = e.data?.before.data() as SosDoc | undefined;
  const after = e.data?.after.data() as SosDoc | undefined;
  if (!before || !after || before.state === after.state || after.state !== 'resolved' || after.resolvedBy !== 'user') return;
  const rel = await activeRelationshipForUser(e.params.uid);
  if (rel) await push(rel.guardianUid, 'sosResolved', `${rel.userName || 'They'} marked themselves safe`, 'The SOS was closed from their phone.', { userUid: e.params.uid });
});

export const onLiveDevice = onDocumentWritten('users/{uid}/live/device', async (e) => {
  const before = e.data?.before.data() as LiveDeviceDoc | undefined;
  const after = e.data?.after.data() as LiveDeviceDoc | undefined;
  if (!after) return;
  const rel = await activeRelationshipForUser(e.params.uid);
  if (!rel) return;
  const p = await prefs(rel.guardianUid);
  const name = rel.userName || 'Your person';
  if (p.deviceDisconnected && before?.link === 'connected' && (after.link === 'disconnected' || after.link === 'auth_failed')) {
    await push(rel.guardianUid, 'deviceDisconnected', `${name}'s stick disconnected`, 'The stick still vibrates for obstacles on its own. Open the app for details.', { userUid: e.params.uid });
  }
  const pct = after.battery.percent;
  const was = before?.battery.percent ?? 100;
  if (p.lowBattery && pct != null && !after.battery.charging && pct <= 10 && was > 10 && (await once(rel.guardianUid, 'lowBattery', String(Math.floor(Date.now() / 3600_000))))) {
    await push(rel.guardianUid, 'lowBattery', `${name}'s stick battery is critically low`, `About ${pct}% (estimate). It needs charging soon.`, { userUid: e.params.uid });
  }
});

/** Guardian geofence (center = custom point or the user's geocoded home), debounced (geofence.ts). */
export const onLiveLocation = onDocumentWritten({ document: 'users/{uid}/live/location', secrets: [MAPS_SERVER_KEY] }, async (e) => {
  const loc = e.data?.after.data() as LiveLocationDoc | undefined;
  if (!loc) return;
  const rel = await activeRelationshipForUser(e.params.uid);
  if (!rel?.permissions?.location) return;
  const g = await db.doc(`users/${rel.guardianUid}/settings/app`).get();
  const fence = g.get('geofence') as { enabled: boolean; radiusM: number; name?: string; center?: { lat: number; lng: number } | null } | undefined;
  if (!fence?.enabled || !(fence.radiusM >= 50 && fence.radiusM <= 5000)) return;
  const center = fence.center && Number.isFinite(fence.center.lat) && Number.isFinite(fence.center.lng) ? fence.center : await homeLocation(e.params.uid).catch(() => null);
  if (!center) return;
  const stateRef = db.doc(`users/${e.params.uid}/private/geofence`);
  const prev = ((await stateRef.get()).data() as FenceState | undefined) ?? initialFence();
  const { state, event } = geofenceStep(prev, haversineM(center, loc), loc.accuracyM, fence.radiusM, loc.measuredAt || Date.now());
  await stateRef.set(state);
  const name = fence.name || 'Home';
  const who = rel.userName || 'They';
  if (event === 'exit') await push(rel.guardianUid, 'geofence', `${who} left ${name}`, `More than ${fence.radiusM} m from ${name}. Open the map to see where.`, { userUid: e.params.uid });
  if (event === 'enter') await push(rel.guardianUid, 'geofence', `${who} is back at ${name}`, `Within ${fence.radiusM} m of ${name}.`, { userUid: e.params.uid });
});

/** Every 10 minutes: tell guardians when a location they rely on has gone stale (once per episode). */
export const staleLocationSweep = onSchedule({ schedule: 'every 10 minutes', timeZone: 'Asia/Kolkata' }, async () => {
  const rels = await db.collection('relationships').where('status', '==', 'active').get();
  const now = Date.now();
  await Promise.all(
    rels.docs.map(async (r) => {
      const rel = r.data();
      const [loc, dev] = await Promise.all([db.doc(`users/${rel.userUid}/live/location`).get(), db.doc(`users/${rel.userUid}/live/device`).get()]);
      const locAt = loc.get('updatedAt') as number | undefined;
      const devAt = dev.get('updatedAt') as number | undefined;
      if (!locAt || now - locAt < 30 * 60_000) return;
      if (devAt && now - devAt < 30 * 60_000 && dev.get('link') !== 'connected') return; // stick not in use
      const p = await prefs(rel.guardianUid);
      if (!p.locationStale) return;
      if (await once(rel.guardianUid, 'locationStale', String(locAt)))
        await push(rel.guardianUid, 'locationStale', `No recent location from ${rel.userName || 'your person'}`, 'Their phone has not shared a position for over 30 minutes.', { userUid: rel.userUid });
    }),
  );
});

/** A guardian asked for the camera: wake the stick user's phone (the app announces it). */
export const onCameraSessionCreated = onDocumentCreated('cameraSessions/{sid}', async (e) => {
  const s = e.data?.data();
  if (!s) return;
  const rel = await activeRelationshipForUser(s.userUid);
  if (!rel || rel.guardianUid !== s.guardianUid || !rel.permissions?.camera) {
    await e.data?.ref.update({ state: 'denied', reason: 'no-permission', updatedAt: Date.now() });
    return;
  }
  await push(s.userUid, 'snapshot', `${rel.heardAs || 'Your guardian'} asked to see your camera`, 'You will hear when it starts and ends. Nothing is stored.', { sessionId: e.params.sid });
});
