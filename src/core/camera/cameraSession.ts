import { addDoc, collection, doc, limit, onSnapshot, query, setDoc, Timestamp, updateDoc, where, type DocumentReference } from 'firebase/firestore';
import { fb } from '../firebase/app';
import { paths, type CameraSessionDoc } from '../../../shared/firestoreSchema';
import { ENV } from '../runtime/env';
import { isDemo } from '../runtime/mode';
import { useVision } from '../store/vision';
import { useSession, getSettings } from '../store/session';
import { useDevice, getStrategy, isLinked } from '../store/device';
import { showUserBanner } from '../store/ui';
import { logEvent } from '../store/activity';
import { announce } from '../ai/voiceOut';
import { P } from '../ai/phrases';
import { earcon } from '../feedback/earcons';
import { userSurfaceActive } from '../surfaces';
import { captureFrame } from '../vision/relay';
import { validateJpeg } from '../transport/types';
import { useFeed, feedFresh } from '../sync/guardianFeed';
import { useAuth } from '../auth/authStore';
import { onStickButton } from '../device/bridge';
import { wait } from '../util';

/**
 * Guardian camera access — privacy first.
 *  - Firestore carries ONLY signalling + session state + metadata (auto-deleted by a TTL policy).
 *  - JPEG bytes travel over an ephemeral WebRTC data channel, phone to phone. Nothing is stored.
 *  - The stick user is ALWAYS told: "Camera requested", "Camera active", "Camera ended".
 */
const CHUNK = 16 * 1024;
const SESSION_TTL_MS = 10 * 60_000;
const LIVE_MAX_MS = 60_000;

function iceServers(): RTCIceServer[] {
  const s: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (ENV.turn.urls) s.push({ urls: ENV.turn.urls.split(','), username: ENV.turn.username, credential: ENV.turn.credential });
  return s;
}

const GUARDIAN_SCENES = ['Street ahead with parked scooters', 'Shop entrance with steps', 'Road crossing'];

// ─── GUARDIAN SIDE ────────────────────────────────────────────

let gSession: { ref: DocumentReference; pc: RTCPeerConnection; unsubs: (() => void)[]; mode: 'snapshot' | 'live' } | null = null;

export async function requestSnapshot(mode: 'snapshot' | 'live' = 'snapshot') {
  if (isDemo()) return demoRequest();
  const v = useVision.getState();
  if (v.requesting || gSession) return;
  const f = useFeed.getState();
  const me = useAuth.getState().user?.uid;
  if (!f.userUid || !me) return useVision.setState({ error: 'phone' });
  if (!f.permissions?.camera) return useVision.setState({ error: 'permission' });
  if (!f.device || !feedFresh(f.device.updatedAt) || !f.device.phoneInternet) return useVision.setState({ error: 'phone' });
  if (f.device.link !== 'connected' && f.device.link !== 'degraded') return useVision.setState({ error: 'stick' });

  useVision.setState({ requesting: true, error: null, guardianViewing: true, session: 'requesting' });
  const { db } = fb();
  const ref = doc(collection(db, paths.cameraSessions()));
  const pc = new RTCPeerConnection({ iceServers: iceServers() });
  const dc = pc.createDataChannel('frames', { ordered: true });
  dc.binaryType = 'arraybuffer';
  const unsubs: (() => void)[] = [];
  gSession = { ref, pc, unsubs, mode };

  let expected = 0;
  let parts: ArrayBuffer[] = [];
  let got = 0;
  dc.onmessage = async (e) => {
    if (typeof e.data === 'string') {
      const h = JSON.parse(e.data) as { t: string; bytes?: number };
      if (h.t === 'frame' && h.bytes) {
        expected = h.bytes;
        parts = [];
        got = 0;
      }
      return;
    }
    parts.push(e.data as ArrayBuffer);
    got += (e.data as ArrayBuffer).byteLength;
    if (expected && got >= expected) {
      const blob = new Blob(parts, { type: 'image/jpeg' });
      expected = 0;
      if (await validateJpeg(blob)) return;
      useVision.setState({ guardianFrame: { blob, scene: -1, ts: Date.now(), origin: 'guardian' }, requesting: false, session: 'active' });
      if (mode === 'snapshot') void endGuardianSession('ended');
    }
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) void addDoc(collection(ref, 'guardianCandidates'), e.candidate.toJSON());
  };
  pc.oniceconnectionstatechange = () => {
    const st = pc.iceConnectionState;
    if (st === 'disconnected') useVision.setState({ session: 'reconnecting' });
    else if ((st === 'connected' || st === 'completed') && useVision.getState().session === 'reconnecting') useVision.setState({ session: 'active' });
    else if (st === 'failed') {
      useVision.setState({ session: 'failed', error: 'failed', requesting: false });
      void endGuardianSession('failed');
    }
  };
  dc.onopen = () => useVision.setState({ session: 'active' });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const now = Date.now();
  // expireAt must be a Firestore Timestamp for the TTL policy to delete the session.
  const session: CameraSessionDoc = { userUid: f.userUid, guardianUid: me, mode, state: 'requested', reason: null, offer: { type: 'offer', sdp: offer.sdp ?? '' }, answer: null, createdAt: now, updatedAt: now, expireAt: Timestamp.fromMillis(now + SESSION_TTL_MS) };
  await setDoc(ref, session);
  useVision.setState({ session: 'waiting' });

  unsubs.push(
    onSnapshot(ref, async (s) => {
      const d = s.data() as CameraSessionDoc | undefined;
      if (!d) return;
      if (d.answer && !pc.currentRemoteDescription) {
        useVision.setState({ session: 'connecting' });
        await pc.setRemoteDescription(d.answer).catch(() => undefined);
      }
      if (d.state === 'denied' || d.state === 'failed') {
        useVision.setState({ error: d.reason === 'stick-offline' ? 'stick' : d.state === 'denied' ? 'denied' : 'failed', requesting: false, session: 'failed' });
        void endGuardianSession(null);
      }
      if (d.state === 'ended') void endGuardianSession(null);
    }),
    onSnapshot(collection(ref, 'userCandidates'), (s) =>
      s.docChanges().forEach((c) => {
        if (c.type === 'added') void pc.addIceCandidate(c.doc.data() as RTCIceCandidateInit).catch(() => undefined);
      }),
    ),
  );
  // Nothing within 25 s (NAT without TURN, phone asleep…) → honest failure.
  setTimeout(() => {
    if (gSession?.ref === ref && useVision.getState().requesting) {
      useVision.setState({ error: 'failed', requesting: false, session: 'failed' });
      void endGuardianSession('failed');
    }
  }, 25_000);
}

export async function endGuardianSession(state: 'ended' | 'failed' | null) {
  const s = gSession;
  gSession = null;
  if (!s) return;
  s.unsubs.forEach((u) => u());
  s.pc.close();
  if (state) await updateDoc(s.ref, { state, updatedAt: Date.now() }).catch(() => undefined);
  const cur = useVision.getState().session;
  useVision.setState({ requesting: false, session: cur === 'failed' || state === 'failed' ? 'failed' : 'ended' });
}

export function stopViewing() {
  if (isDemo()) {
    useVision.setState({ guardianViewing: false, autoRefresh: false });
    return;
  }
  useVision.setState({ guardianViewing: false, autoRefresh: false, guardianFrame: null });
  void endGuardianSession('ended');
}

// ─── USER SIDE (stick user's phone) ───────────────────────────

let responderUnsub: (() => void) | null = null;
const handled = new Set<string>();

export function startCameraResponder(uid: string) {
  responderUnsub?.();
  const { db } = fb();
  responderUnsub = onSnapshot(query(collection(db, paths.cameraSessions()), where('userUid', '==', uid), where('state', '==', 'requested'), limit(3)), (snap) => {
    snap.docChanges().forEach((c) => {
      if (c.type !== 'added' || handled.has(c.doc.id)) return;
      handled.add(c.doc.id);
      void respond(c.doc.ref, c.doc.data() as CameraSessionDoc);
    });
  });
}

export function stopCameraResponder() {
  responderUnsub?.();
  responderUnsub = null;
}

/** Camera use on someone else's request: the stick user allows it with one button press. */
export async function askUser(name: string): Promise<boolean> {
  showUserBanner({ tone: 'teal', icon: 'eye', title: `${name} wants to see your camera`, body: 'Press the stick button once to allow' }, 15000);
  return new Promise((resolve) => {
    const off = onStickButton((p) => {
      if (p === 'single') {
        off();
        clearTimeout(t);
        resolve(true);
        return true;
      }
    });
    const t = setTimeout(() => {
      off();
      resolve(false);
    }, 15000);
  });
}

async function respond(ref: DocumentReference, s: CameraSessionDoc) {
  const name = useSession.getState().guardian.heardAs || 'Your guardian';
  if (Date.now() - s.createdAt > 60_000) return void updateDoc(ref, { state: 'failed', reason: 'expired', updatedAt: Date.now() }).catch(() => undefined);
  announce(P.cameraRequested(name), { high: true });
  if (userSurfaceActive()) earcon('viewing');
  if (getSettings().cameraRequests === 'ask' && !(await askUser(name))) {
    logEvent({ kind: 'vision', severity: 'info', title: `Camera request from ${name} declined` });
    return void updateDoc(ref, { state: 'denied', reason: 'user', updatedAt: Date.now() });
  }
  if (!isLinked(useDevice.getState().link)) {
    logEvent({ kind: 'vision', severity: 'warning', title: `${name} asked for the camera`, detail: 'The stick was not connected' });
    return void updateDoc(ref, { state: 'failed', reason: 'stick-offline', updatedAt: Date.now() });
  }
  const pc = new RTCPeerConnection({ iceServers: iceServers() });
  const unsubs: (() => void)[] = [];
  let ended = false;
  const finish = async (state: 'ended' | 'failed', reason: string | null = null) => {
    if (ended) return;
    ended = true;
    unsubs.forEach((u) => u());
    pc.close();
    await updateDoc(ref, { state, reason, updatedAt: Date.now() }).catch(() => undefined);
    announce(P.cameraEnded(name));
    showUserBanner({ tone: 'ink', icon: 'eye', title: 'Camera ended', body: `${name} is no longer viewing` }, 4000);
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) void addDoc(collection(ref, 'userCandidates'), e.candidate.toJSON());
  };
  pc.ondatachannel = (e) => {
    const dc = e.channel;
    dc.binaryType = 'arraybuffer';
    dc.onopen = async () => {
      showUserBanner({ tone: 'teal', icon: 'eye', title: `Camera active: ${name} is viewing`, body: 'Photos are not saved' }, 9000);
      logEvent({ kind: 'vision', severity: 'info', title: `${name} viewed the camera`, detail: `${s.mode === 'live' ? 'Live view' : 'One photo'}. Announced; nothing was stored.` });
      const until = Date.now() + (s.mode === 'live' ? LIVE_MAX_MS : 0);
      try {
        do {
          const f = await captureFrame('guardian');
          const buf = await f.blob.arrayBuffer();
          dc.send(JSON.stringify({ t: 'frame', bytes: buf.byteLength, ts: f.ts }));
          for (let i = 0; i < buf.byteLength; i += CHUNK) {
            while (dc.bufferedAmount > 1_000_000) await wait(20);
            dc.send(buf.slice(i, i + CHUNK));
          }
          if (s.mode === 'live') await wait(1500);
        } while (s.mode === 'live' && Date.now() < until && !ended && dc.readyState === 'open');
        setTimeout(() => void finish('ended'), 1500);
      } catch {
        void finish('failed', 'capture-failed');
      }
    };
  };
  unsubs.push(
    onSnapshot(collection(ref, 'guardianCandidates'), (snap) =>
      snap.docChanges().forEach((c) => {
        if (c.type === 'added') void pc.addIceCandidate(c.doc.data() as RTCIceCandidateInit).catch(() => undefined);
      }),
    ),
    onSnapshot(ref, (snap) => {
      const d = snap.data() as CameraSessionDoc | undefined;
      if (d?.state === 'ended' && !ended) void finish('ended');
    }),
  );
  try {
    await pc.setRemoteDescription(s.offer!);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await updateDoc(ref, { answer: { type: 'answer', sdp: answer.sdp ?? '' }, state: 'accepted', updatedAt: Date.now() });
  } catch {
    void finish('failed', 'negotiation');
  }
  setTimeout(() => !ended && void finish('ended'), s.mode === 'live' ? LIVE_MAX_MS + 20_000 : 40_000);
}

// ─── DEMO (both phones on one page) ───────────────────────────

async function demoRequest() {
  const v = useVision.getState();
  if (v.requesting) return;
  const strategy = getStrategy();
  if (strategy !== 'full') {
    useVision.setState({ error: strategy === 'cloud' ? 'stick' : 'phone' });
    return;
  }
  useVision.setState({ requesting: true, error: null });
  if (!v.guardianViewing) {
    useVision.setState({ guardianViewing: true });
    const { guardian, person } = useSession.getState();
    announce(P.viewing(guardian.heardAs));
    if (userSurfaceActive()) earcon('viewing');
    showUserBanner({ tone: 'teal', icon: 'eye', title: `${guardian.heardAs} is viewing your camera` }, 9000);
    logEvent({ kind: 'vision', severity: 'info', title: `${guardian.heardAs} viewed the camera`, detail: `${person.name} heard an announcement (demo)` });
  }
  try {
    await wait(300);
    const f = await captureFrame('guardian');
    useVision.setState({ guardianFrame: { ...f, description: GUARDIAN_SCENES[f.scene] } });
  } catch {
    useVision.setState({ error: 'stick' });
  } finally {
    useVision.setState({ requesting: false });
  }
}
