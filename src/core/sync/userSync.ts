import { collection, doc, limit, onSnapshot, orderBy, query, setDoc, updateDoc, where, getDocs } from 'firebase/firestore';
import { fb } from '../firebase/app';
import { paths, type ActivityDoc, type LiveDeviceDoc, type LiveLocationDoc, type LiveNavigationDoc, type LiveSafetyDoc, type NotificationDoc, type SosDoc } from '../../../shared/firestoreSchema';
import { useDevice } from '../store/device';
import { useSession } from '../store/session';
import { useSafety } from '../store/safety';
import { mergeEvents, onActivityLogged } from '../store/activity';
import { useLocation } from '../location/locationService';
import { useNavView } from '../navigation/navView';
import { useSafetyEval } from '../safety/safetyRuntime';
import { onWalkEnded } from '../walking/walkTracker';
import { announce } from '../ai/voiceOut';
import { P } from '../ai/phrases';
import { earcon } from '../feedback/earcons';
import { showUserBanner } from '../store/ui';

/**
 * USER PHONE → FIREBASE. The phone is the authority for its own state; it writes a small,
 * throttled "live" summary (not raw 300 ms telemetry) plus append-only events.
 *   device:     on link/charging/sensor change, battery ±2 %, else every 60 s
 *   location:   moved ≥ 20 m or 30 s elapsed (10 s during SOS); only if sharing is on or SOS
 *   safety:     on state change
 *   navigation: on start/stop/arrival, else every 30 s
 * FIREBASE → USER PHONE: guardian messages (spoken), SOS acknowledgements.
 */
let uid: string | null = null;
let unsubs: (() => void)[] = [];
const last = { device: 0, deviceKey: '', loc: 0, locLat: 0, locLng: 0, safety: '', nav: 0, navKey: '' };

const db = () => fb().db;
let trailing: ReturnType<typeof setTimeout> | undefined;

function deviceKey() {
  const d = useDevice.getState();
  return [d.link, d.zone === 'danger' ? 'danger' : 'z', (d.health?.errors ?? []).join(','), d.health?.mode, d.battery.status, d.battery.charging, Math.round((d.battery.percent ?? -10) / 2), d.ultrasonic.status === 'ok' ? `ok${Math.round((d.ultrasonic.distanceCm ?? 0) / 50)}` : d.ultrasonic.status, d.imu.status, d.camera.status, d.internet].join('|');
}

async function writeDevice(force = false) {
  if (!uid) return;
  const key = deviceKey();
  const now = Date.now();
  const linkChanged = key.split('|')[0] !== last.deviceKey.split('|')[0];
  if (!force) {
    if (key === last.deviceKey && now - last.device < 60_000) return;
    if (key !== last.deviceKey && !linkChanged && now - last.device < 10_000) {
      // Throttle to one write per 10 s; make sure the latest state still goes out.
      clearTimeout(trailing);
      trailing = setTimeout(() => void writeDevice(), 10_000 - (now - last.device));
      return;
    }
  }
  last.device = now;
  last.deviceKey = key;
  const d = useDevice.getState();
  const docData: LiveDeviceDoc = {
    deviceId: d.identity?.deviceId ?? null,
    link: d.link === 'searching' ? 'connecting' : d.link,
    zone: d.zone,
    health: d.health ? { resetReason: d.health.resetReason ?? null, errors: d.health.errors ?? [], mode: d.health.mode ?? null, configVersion: d.health.configVersion ?? null } : null,
    battery: { percent: d.battery.status === 'ok' || d.battery.status === 'stale' ? d.battery.percent : null, charging: d.battery.charging, chargingSource: d.battery.chargingSource, status: d.battery.status, measuredAt: d.battery.measuredAt },
    sensors: { ultrasonic: d.ultrasonic.status, imu: d.imu.status, camera: d.camera.status, obstacleCm: d.ultrasonic.status === 'ok' && d.ultrasonic.distanceCm != null ? Math.round(d.ultrasonic.distanceCm / 10) * 10 : null },
    firmware: d.identity?.firmware ?? null,
    phoneInternet: d.internet === true,
    updatedAt: now,
    source: 'user-app',
  };
  await setDoc(doc(db(), paths.live(uid, 'device')), docData).catch(() => undefined);
  useDevice.setState({ lastSync: now });
}

async function writeLocation() {
  if (!uid) return;
  const f = useLocation.getState().fix;
  if (!f) return;
  const sos = useSafety.getState().phase === 'active';
  if (!useSession.getState().settings.locationSharing && !sos) return;
  const now = Date.now();
  const moved = Math.hypot((f.lat - last.locLat) * 111320, (f.lng - last.locLng) * 111320 * Math.cos((f.lat * Math.PI) / 180));
  const every = sos ? 10_000 : 30_000;
  if (moved < 20 && now - last.loc < every) return;
  last.loc = now;
  last.locLat = f.lat;
  last.locLng = f.lng;
  const d: LiveLocationDoc = {
    lat: f.lat,
    lng: f.lng,
    accuracyM: Math.round(f.accuracyM),
    headingDeg: f.headingDeg,
    speedMps: f.speedMps,
    measuredAt: f.ts,
    updatedAt: now,
    quality: f.accuracyM <= 15 ? 'good' : f.accuracyM <= 40 ? 'fair' : 'poor',
    source: 'gps',
  };
  await setDoc(doc(db(), paths.live(uid, 'location')), d).catch(() => undefined);
}

async function writeSafety() {
  if (!uid) return;
  const s = useSafetyEval.getState();
  const key = `${s.state}|${s.reasons.join(';')}`;
  if (key === last.safety) return;
  last.safety = key;
  const d: LiveSafetyDoc = { state: s.state, reasons: s.reasons, updatedAt: Date.now() };
  await setDoc(doc(db(), paths.live(uid, 'safety')), d).catch(() => undefined);
}

async function writeNavigation() {
  if (!uid) return;
  const n = useNavView.getState();
  const key = `${n.active}|${n.destination?.name}|${n.arrived}|${n.next?.text}`;
  const now = Date.now();
  if (key === last.navKey && now - last.nav < 30_000) return;
  last.nav = now;
  last.navKey = key;
  const d: LiveNavigationDoc = {
    active: n.active,
    destination: n.destination && n.destination.lat != null && n.destination.lng != null ? { name: n.destination.name, placeId: n.destination.placeId, lat: n.destination.lat, lng: n.destination.lng } : null,
    remainingM: n.remainingM,
    etaSec: n.etaSec,
    nextInstruction: n.next?.text ?? null,
    arrived: n.arrived,
    updatedAt: now,
  };
  await setDoc(doc(db(), paths.live(uid, 'navigation')), d).catch(() => undefined);
}

export async function startUserSync(userUid: string) {
  stopUserSync();
  uid = userUid;
  const d = db();

  unsubs.push(useDevice.subscribe(() => void writeDevice()));
  unsubs.push(useLocation.subscribe(() => void writeLocation()));
  unsubs.push(useSafetyEval.subscribe(() => void writeSafety()));
  unsubs.push(useNavView.subscribe(() => void writeNavigation()));
  const heartbeat = setInterval(() => void writeDevice(), 60_000);
  unsubs.push(() => clearInterval(heartbeat));

  unsubs.push(
    onActivityLogged((e) => {
      const a: ActivityDoc = { eventId: e.id, kind: e.kind, severity: e.severity, title: e.title, detail: e.detail ?? null, ts: e.ts, source: 'user-app', deviceId: useDevice.getState().identity?.deviceId ?? null };
      void setDoc(doc(d, paths.activity(userUid), e.id), a).catch(() => undefined);
    }),
  );
  unsubs.push(
    onWalkEnded((s) => {
      void setDoc(doc(d, paths.walkSessions(userUid), s.id), { startTime: s.startTime, endTime: s.endTime, distanceM: Math.round(s.distanceM), durationS: s.durationS, meanAccuracyM: s.accN ? Math.round(s.accSum / s.accN) : null, source: 'gps', rejectedFixes: s.rejected }).catch(() => undefined);
    }),
  );

  // Recent history for this phone's own activity screen.
  getDocs(query(collection(d, paths.activity(userUid)), orderBy('ts', 'desc'), limit(60)))
    .then((snap) => mergeEvents(snap.docs.map((x) => { const a = x.data() as ActivityDoc; return { id: a.eventId, ts: a.ts, kind: a.kind, severity: a.severity, title: a.title, detail: a.detail ?? undefined }; })))
    .catch(() => undefined);

  // Guardian → user voice messages.
  unsubs.push(
    onSnapshot(query(collection(d, paths.notifications(userUid)), where('spokenAt', '==', null), limit(5)), (snap) => {
      snap.docChanges().forEach((ch) => {
        if (ch.type !== 'added') return;
        const n = ch.doc.data() as NotificationDoc;
        const from = useSession.getState().guardian.heardAs || 'Your guardian';
        earcon('message');
        announce(P.guardianMsg(from, n.text), { high: true });
        showUserBanner({ tone: 'ink', icon: 'message', title: `Message from ${from}`, body: n.text }, 8000);
        void updateDoc(ch.doc.ref, { spokenAt: Date.now() }).catch(() => undefined);
      });
    }),
  );

  void writeDevice(true);
}

export function stopUserSync() {
  unsubs.forEach((u) => u());
  unsubs = [];
  uid = null;
}

// ─── SOS (user side) ──────────────────────────────────────────

let sosUnsub: (() => void) | null = null;

export async function createSosEvent(sosId: string, trigger: SosDoc['trigger']): Promise<'synced' | 'queued'> {
  if (!uid) return 'queued';
  const f = useLocation.getState().fix;
  const d: SosDoc = {
    sosId,
    trigger,
    state: 'active',
    createdAt: Date.now(),
    location: f ? { lat: f.lat, lng: f.lng, accuracyM: Math.round(f.accuracyM), measuredAt: f.ts } : null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    onTheWayAt: null,
    resolvedAt: null,
    resolvedBy: null,
    smsFallback: 'not_needed',
  };
  const ref = doc(db(), paths.sos(uid), sosId);
  const write = setDoc(ref, d);
  void writeLocation();
  watchSos(sosId);
  // With offline persistence, setDoc resolves when the server acknowledges; time out to "queued".
  const r = await Promise.race([write.then(() => 'synced' as const), new Promise<'queued'>((res) => setTimeout(() => res('queued'), 6000))]).catch(() => 'queued' as const);
  return r;
}

export async function updateSosEvent(sosId: string, patch: Partial<SosDoc>) {
  if (!uid) return;
  await updateDoc(doc(db(), paths.sos(uid), sosId), patch).catch(() => undefined);
}

let seen = { ack: false, onWay: false, resolved: false };
function watchSos(sosId: string) {
  sosUnsub?.();
  seen = { ack: false, onWay: false, resolved: false };
  if (!uid) return;
  sosUnsub = onSnapshot(doc(db(), paths.sos(uid), sosId), (snap) => {
    const s = snap.data() as SosDoc | undefined;
    if (!s) return;
    const name = useSession.getState().guardian.heardAs || 'Your guardian';
    if (s.acknowledgedAt && !seen.ack) {
      seen.ack = true;
      useSafety.setState({ guardianAck: true });
      announce(P.guardianSeen(name), { high: true });
    }
    if (s.onTheWayAt && !seen.onWay) {
      seen.onWay = true;
      useSafety.setState({ guardianAck: true, guardianOnWay: true });
      announce(P.guardianOnWay(name), { high: true });
    }
    if (s.state === 'resolved' && s.resolvedBy && s.resolvedBy !== uid && !seen.resolved) {
      seen.resolved = true;
      if (useSafety.getState().phase === 'active') useSafety.setState({ phase: 'resolved', resolvedBy: 'guardian' });
      announce(P.guardianResolved(name), { high: true });
    }
    // Delivery confirmation: the server has the document.
    if (!snap.metadata.hasPendingWrites && useSafety.getState().delivery !== 'cloud') useSafety.setState({ delivery: 'cloud', dispatchFailed: false });
    // Only the backend can say whether the guardian's phone was actually notified.
    const gn = (s as SosDoc & { guardianNotify?: { status: 'sent' | 'failed' | 'no_devices' | 'no_guardian' } }).guardianNotify;
    if (gn && useSafety.getState().guardianNotify !== gn.status) useSafety.setState({ guardianNotify: gn.status });
  });
}

export function stopSosWatch() {
  sosUnsub?.();
  sosUnsub = null;
}
