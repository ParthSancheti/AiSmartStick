import { create } from 'zustand';
import { addDoc, collection, doc, limit, onSnapshot, orderBy, query, updateDoc, where } from 'firebase/firestore';
import { fb } from '../firebase/app';
import { paths, type WalkSessionDoc, type ActivityDoc, type LiveDeviceDoc, type LiveLocationDoc, type LiveNavigationDoc, type LiveSafetyDoc, type RelationshipDoc, type SosDoc, type UserDoc } from '../../../shared/firestoreSchema';
import type { ActivityEvent } from '../types';
import { isDemo } from '../runtime/mode';
import { useDevice } from '../store/device';
import { useSession } from '../store/session';
import { useSafety } from '../store/safety';
import { useActivity } from '../store/activity';
import { useNavView } from '../navigation/navView';
import { useSafetyEval } from '../safety/safetyRuntime';
import { useNav } from '../store/nav';
import { streetAt } from '../sim/geo';
import { guardianAcknowledge, guardianOnTheWay, guardianResolve } from '../safety/sos';
import { sendGuardianMessage } from '../messages';
import { toastGuardian } from '../store/ui';
import { useAuth } from '../auth/authStore';
import { useWalking } from '../walking/walkTracker';

/**
 * EVERYTHING the Guardian app shows comes from this feed.
 *  REAL: Firestore listeners on the related user's live/*, activity, sosEvents — gated by
 *        firestore.rules on the relationship; the Guardian never talks to the stick.
 *  DEMO: the same shape derived from the local simulation (both phones in one page).
 */
export interface FeedState {
  status: 'idle' | 'loading' | 'ready' | 'no_relationship' | 'error';
  userUid: string | null;
  userName: string;
  heardAs: string;
  userPhone: string | null;
  /** The person's profile photo (picked in the app, else Google), or null. */
  userPhoto: string | null;
  medicalId: string | null;
  permissions: RelationshipDoc['permissions'] | null;
  device: LiveDeviceDoc | null;
  location: LiveLocationDoc | null;
  /** Human-readable place (demo street name). Real mode shows coordinates/accuracy instead of guessing. */
  locationLabel: string | null;
  safety: LiveSafetyDoc | null;
  navigation: LiveNavigationDoc | null;
  activity: ActivityEvent[];
  /** Completed GPS walk sessions, last 7 days. */
  walks: WalkSessionDoc[];
  /** The stick user's SOS settings (settings/app), for the guardian's SOS settings screen. */
  userSafety: { sosTriggers?: { button: boolean; voice: boolean; fall: boolean }; sosCancelSec?: number } | null;
  sos: SosDoc | null;
  error: string | null;
}

const empty = (): FeedState => ({
  status: 'idle',
  userUid: null,
  userName: '',
  heardAs: '',
  userPhone: null,
  userPhoto: null,
  medicalId: null,
  permissions: null,
  device: null,
  location: null,
  locationLabel: null,
  safety: null,
  navigation: null,
  activity: [],
  walks: [],
  userSafety: null,
  sos: null,
  error: null,
});

export const useFeed = create<FeedState>(() => empty());

/** Anything older than this is "stale", not live. */
export const FEED_STALE_MS = 2 * 60_000;

let unsubs: (() => void)[] = [];

export function stopFeed() {
  unsubs.forEach((u) => u());
  unsubs = [];
  useFeed.setState(empty());
}

// ─── REAL ─────────────────────────────────────────────────────

export function startRealFeed(rel: RelationshipDoc) {
  stopFeed();
  const { db } = fb();
  const uid = rel.userUid;
  useFeed.setState({ status: 'loading', userUid: uid, userName: rel.userName, heardAs: rel.heardAs, permissions: rel.permissions });
  const onErr = (e: Error) => useFeed.setState({ status: 'error', error: e.message });
  const live = <T,>(name: 'device' | 'location' | 'safety' | 'navigation', key: keyof FeedState) =>
    onSnapshot(doc(db, paths.live(uid, name)), (s) => useFeed.setState({ [key]: (s.data() as T) ?? null, status: 'ready' } as Partial<FeedState>), onErr);

  unsubs.push(live<LiveDeviceDoc>('device', 'device'));
  unsubs.push(live<LiveSafetyDoc>('safety', 'safety'));
  unsubs.push(live<LiveNavigationDoc>('navigation', 'navigation'));
  if (rel.permissions.location) unsubs.push(live<LiveLocationDoc>('location', 'location'));
  if (rel.permissions.activity)
    unsubs.push(
      onSnapshot(query(collection(db, paths.activity(uid)), orderBy('ts', 'desc'), limit(80)), (snap) => {
        const events = snap.docs.map((d) => {
          const a = d.data() as ActivityDoc;
          return { id: a.eventId, ts: a.ts, kind: a.kind, severity: a.severity, title: a.title, detail: a.detail ?? undefined } satisfies ActivityEvent;
        });
        useFeed.setState({ activity: events });
      }, onErr),
    );
  if (rel.permissions.activity)
    unsubs.push(
      onSnapshot(query(collection(db, paths.walkSessions(uid)), where('startTime', '>=', Date.now() - 7 * 86_400_000), orderBy('startTime', 'desc'), limit(200)), (snap) => {
        useFeed.setState({ walks: snap.docs.map((d) => d.data() as WalkSessionDoc) });
      }, onErr),
    );
  if (rel.permissions.sos)
    unsubs.push(
      onSnapshot(query(collection(db, paths.sos(uid)), orderBy('createdAt', 'desc'), limit(1)), (snap) => {
        const s = (snap.docs[0]?.data() as SosDoc | undefined) ?? null;
        // Only recent SOS matter on screen; old resolved ones live in activity.
        useFeed.setState({ sos: s && (s.state !== 'resolved' || Date.now() - (s.resolvedAt ?? 0) < 60_000) ? s : null });
      }, onErr),
    );
  unsubs.push(
    onSnapshot(doc(db, paths.settings(uid, 'app')), (s) => {
      const d = s.data() as { sosTriggers?: { button: boolean; voice: boolean; fall: boolean }; sosCancelSec?: number } | undefined;
      useFeed.setState({ userSafety: d ? { sosTriggers: d.sosTriggers, sosCancelSec: d.sosCancelSec } : null });
    }, () => undefined),
  );
  // Live: a name, phone or photo the person changes on their phone shows here at once.
  unsubs.push(
    onSnapshot(doc(db, paths.user(uid)), (s) => {
      const u = s.data() as UserDoc | undefined;
      if (u) useFeed.setState({ userName: u.displayName || rel.userName, userPhone: u.phone, userPhoto: (typeof u.photoData === 'string' && u.photoData.startsWith('data:image/') ? u.photoData : null) ?? u.photoURL ?? null });
    }, () => undefined),
  );
}

async function sosPatch(patch: Partial<SosDoc>) {
  const f = useFeed.getState();
  const me = useAuth.getState().user?.uid;
  if (!f.userUid || !f.sos || !me) return;
  await updateDoc(doc(fb().db, paths.sos(f.userUid), f.sos.sosId), patch);
}

// ─── DEMO ─────────────────────────────────────────────────────

function demoSnapshot(): Partial<FeedState> {
  const d = useDevice.getState();
  const s = useSession.getState();
  const safety = useSafety.getState();
  const nav = useNavView.getState();
  const sim = useNav.getState();
  const now = Date.now();
  const online = d.internet !== false;
  const stamp = online ? now : (d.lastSync ?? now - 60_000);
  return {
    status: 'ready',
    userUid: 'demo-user',
    userName: s.person.name || 'Aarav',
    heardAs: s.guardian.heardAs,
    userPhone: '+91 00000 00003',
    permissions: { location: true, camera: true, activity: true, sos: true, messages: true, safetySettings: true },
    device: {
      deviceId: d.identity?.deviceId ?? null,
      link: d.link === 'searching' ? 'connecting' : d.link,
      zone: d.zone,
      battery: { percent: d.battery.percent, charging: d.battery.charging, chargingSource: d.battery.chargingSource, status: d.battery.status, measuredAt: d.battery.measuredAt },
      sensors: { ultrasonic: d.ultrasonic.status, imu: d.imu.status, camera: d.camera.status, obstacleCm: d.ultrasonic.distanceCm },
      firmware: d.identity?.firmware ?? null,
      phoneInternet: online,
      updatedAt: stamp,
      source: 'user-app',
    },
    location: null,
    locationLabel: `Near ${streetAt(sim.userPos)}`,
    safety: { ...useSafetyEval.getState(), updatedAt: stamp },
    navigation: { active: nav.active, destination: nav.destination && { name: nav.destination.name, placeId: null, lat: 0, lng: 0 }, remainingM: nav.remainingM, etaSec: nav.etaSec, nextInstruction: nav.next?.text ?? null, arrived: nav.arrived, updatedAt: stamp },
    activity: useActivity.getState().events,
    walks: (() => {
      const w = useWalking.getState().today;
      return w.distanceM > 0 ? [{ startTime: now - w.durationS * 1000, endTime: now, distanceM: w.distanceM, durationS: w.durationS || Math.round(w.distanceM / 1.4), meanAccuracyM: null, source: 'gps' as const, rejectedFixes: 0 }] : [];
    })(),
    sos:
      (safety.phase === 'active' || safety.phase === 'resolved') && safety.delivery === 'cloud'
        ? {
            sosId: `demo_${safety.startedAt}`,
            trigger: safety.trigger ?? 'button',
            state: safety.phase === 'resolved' ? 'resolved' : safety.guardianAck ? 'acknowledged' : 'active',
            createdAt: safety.startedAt,
            location: null,
            acknowledgedAt: safety.guardianAck ? now : null,
            acknowledgedBy: safety.guardianAck ? 'demo-guardian' : null,
            onTheWayAt: safety.guardianOnWay ? now : null,
            resolvedAt: safety.phase === 'resolved' ? now : null,
            resolvedBy: safety.resolvedBy,
            smsFallback: 'not_needed',
          }
        : null,
  };
}

export function startDemoFeed() {
  stopFeed();
  const push = () => useFeed.setState(demoSnapshot());
  push();
  unsubs.push(useDevice.subscribe(push), useSession.subscribe(push), useSafety.subscribe(push), useActivity.subscribe(push), useNavView.subscribe(push), useSafetyEval.subscribe(push), useWalking.subscribe(push));
  const t = setInterval(push, 5000);
  unsubs.push(() => clearInterval(t));
}

// ─── Guardian actions (same API in both modes) ────────────────

export const guardianActions = {
  async acknowledge() {
    if (isDemo()) return guardianAcknowledge();
    await sosPatch({ state: 'acknowledged', acknowledgedAt: Date.now(), acknowledgedBy: useAuth.getState().user?.uid ?? null });
  },
  async onTheWay() {
    if (isDemo()) return guardianOnTheWay();
    const me = useAuth.getState().user?.uid ?? null;
    const s = useFeed.getState().sos;
    await sosPatch({ state: 'acknowledged', onTheWayAt: Date.now(), acknowledgedAt: s?.acknowledgedAt ?? Date.now(), acknowledgedBy: s?.acknowledgedBy ?? me });
    toastGuardian(`${useFeed.getState().userName} will hear that you're on the way`);
  },
  async resolve() {
    if (isDemo()) return guardianResolve();
    await sosPatch({ state: 'resolved', resolvedAt: Date.now(), resolvedBy: useAuth.getState().user?.uid ?? null });
  },
  /**
   * Remote command via the backend (never directly to the stick). Resolves when the user's phone
   * reports a final status, or after 2 min with 'expired'.
   */
  async remoteCommand(type: 'locate' | 'nudge' | 'scan'): Promise<{ status: string; error?: string | null; result?: Record<string, unknown> | null }> {
    if (isDemo()) {
      const { getMock } = await import('../device/bridge');
      const m = getMock();
      if (!m?.isLinked()) return { status: 'failed', error: 'The stick is not connected (demo).' };
      if (type === 'scan') {
        const { runDirect } = await import('../ai/assistant');
        void runDirect('describe_scene', 'Guardian asked for a scan');
        return { status: 'completed', result: { spoken: 'Demo scan requested on the user phone.' } };
      }
      const ack = await m.send({ type });
      return { status: ack.status };
    }
    const { call } = await import('../backend/api');
    const { commandId, userUid } = await call<{ type: string }, { commandId: string; userUid: string }>('sendRemoteCommand', { type });
    return new Promise((resolve) => {
      const ref = doc(fb().db, `users/${userUid}/deviceCommands/${commandId}`);
      const t = setTimeout(() => {
        off();
        resolve({ status: 'expired', error: 'Their phone did not respond in time.' });
      }, 125_000);
      const off = onSnapshot(ref, (snap) => {
        const d = snap.data() as { status: string; error: string | null; result: Record<string, unknown> | null } | undefined;
        if (d && ['completed', 'failed', 'expired'].includes(d.status)) {
          clearTimeout(t);
          off();
          resolve({ status: d.status, error: d.error, result: d.result });
        }
      });
    });
  },
  /** Read aloud on the user's phone (queued by Firestore if their phone is offline). */
  async sendMessage(text: string): Promise<'spoken' | 'queued' | 'sent'> {
    if (isDemo()) return sendGuardianMessage(text);
    const f = useFeed.getState();
    const me = useAuth.getState().user?.uid;
    if (!f.userUid || !me) throw new Error('not-paired');
    await addDoc(collection(fb().db, paths.notifications(f.userUid)), { type: 'guardian_message', text: text.slice(0, 300), fromUid: me, createdAt: Date.now(), spokenAt: null });
    toastGuardian(f.device?.phoneInternet ? `Sent. It will be read out to ${f.userName}.` : `${f.userName}'s phone is offline. It will be read out when it reconnects.`);
    return 'sent';
  },
};

export const feedFresh = (ts: number | null | undefined, now = Date.now()) => !!ts && now - ts < FEED_STALE_MS;

/** Watch the SOS that belongs to this guardian's user and keep it on screen. */
export function sosNeedsAttention(s: SosDoc | null) {
  return !!s && (s.state === 'active' || s.state === 'acknowledged');
}


