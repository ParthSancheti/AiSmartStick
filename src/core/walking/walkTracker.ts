import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { AissLocation, type NativeWalkingState } from '../native/aissLocation';
import { haversineM, type Fix } from '../location/locationService';
import { isDemo } from '../runtime/mode';

/**
 * Walking distance from real GPS, with noise rejection:
 *  - fixes worse than 25 m accuracy are ignored,
 *  - movement smaller than max(3 m, 0.5 × accuracy) is jitter,
 *  - implied speed above 3.5 m/s is not walking (GPS jump or a vehicle) and is rejected,
 *  - a session starts on sustained movement and ends after 3 min without it.
 */
export interface WalkSession {
  id: string;
  startTime: number;
  endTime: number | null;
  distanceM: number;
  durationS: number;
  accSum: number;
  accN: number;
  rejected: number;
}

interface WalkState {
  /** Daily progress belongs to one signed-in account, including in the web fallback. */
  owner: string | null;
  current: WalkSession | null;
  /** Manual pause: fixes are ignored until resumed. */
  paused: boolean;
  today: { distanceM: number; durationS: number; sessions: number; day: string };
  source: 'gps' | 'demo' | null;
}

export const dayKey = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const emptyWalking = (): WalkState => ({ owner: null, current: null, paused: false, today: { distanceM: 0, durationS: 0, sessions: 0, day: dayKey() }, source: null });
// Capture the previous account before authentication/React can replace its cached avatar.
// This is the only ownership clue available for daily totals written by older releases.
const legacyOwner: string | null = (() => {
  try {
    const remembered = JSON.parse(localStorage.getItem('aiss.profilePhoto.account.v1') ?? 'null') as { uid?: unknown } | null;
    return typeof remembered?.uid === 'string' ? remembered.uid : null;
  } catch { return null; }
})();
export const useWalking = create<WalkState>()(persist(emptyWalking, {
  name: isDemo() ? 'aiss.walking.demo.v1' : 'aiss.walking.v1',
  storage: createJSONStorage(() => localStorage),
  partialize: (s) => ({ ...s, current: null, today: { ...s.today, sessions: s.today.sessions + (s.current ? 1 : 0) } }),
  // GPS anchors deliberately stay in memory: never count an unobserved movement
  // between closing the app and receiving the first new position.
  merge: (saved, current) => {
    const s = saved as Partial<WalkState> | undefined;
    const t = s?.today;
    if (!t || t.day !== dayKey() || ![t.distanceM, t.durationS, t.sessions].every(v => Number.isFinite(v) && v >= 0) || s?.source === 'demo') return current;
    return { ...current, owner: typeof s.owner === 'string' ? s.owner : null, today: { ...t }, source: s.source ?? null, paused: s.paused === true };
  },
}));

export const WALK = { maxAccuracyM: 25, maxSpeedMps: 3.5, endAfterMs: 180_000, maxGapMs: 30_000 };

let last: Fix | null = null;
let lastMoveAt = 0;
let lastSeenAt = 0;
let onEnd: ((s: WalkSession) => void) | null = null;
export const onWalkEnded = (cb: (s: WalkSession) => void) => {
  onEnd = cb;
  return () => {
    if (onEnd === cb) onEnd = null;
  };
};

export function walkFix(f: Fix) {
  // The native odometer owns Android totals, including while the WebView does not exist.
  // Never add the same GPS segment a second time in JavaScript.
  if (nativeOwner) return;
  if (useWalking.getState().paused) return;
  if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng) || Math.abs(f.lat) > 90 || Math.abs(f.lng) > 180 || !Number.isFinite(f.accuracyM) || f.accuracyM <= 0 || f.accuracyM > WALK.maxAccuracyM || !Number.isFinite(f.ts)) return;
  if (lastSeenAt && f.ts <= lastSeenAt) return;
  const st = useWalking.getState();
  if (st.today.day !== dayKey(f.ts)) {
    last = null;
    lastMoveAt = 0;
    lastSeenAt = 0;
    useWalking.setState({ current: null, today: { distanceM: 0, durationS: 0, sessions: 0, day: dayKey(f.ts) } });
  }
  const gap = lastSeenAt > 0 && f.ts - lastSeenAt > WALK.maxGapMs;
  lastSeenAt = f.ts;
  if (gap) {
    maybeEnd(f.ts);
    last = f;
    return;
  }
  if (!last) {
    last = f;
    return;
  }
  if (f.speedMps != null && Number.isFinite(f.speedMps) && (f.speedMps < 0.2 || f.speedMps > WALK.maxSpeedMps)) {
    maybeEnd(f.ts);
    last = f;
    return;
  }
  const d = haversineM(last, f);
  const dt = (f.ts - last.ts) / 1000;
  if (dt <= 0 || dt > WALK.maxGapMs / 1000) {
    maybeEnd(f.ts);
    last = f;
    return;
  }
  if (d < Math.max(3, Math.max(last.accuracyM, f.accuracyM) * 0.5)) {
    maybeEnd(f.ts);
    return;
  }
  const cur = useWalking.getState().current;
  if (d / dt > WALK.maxSpeedMps || d / dt < 0.2) {
    if (cur) useWalking.setState({ current: { ...cur, rejected: cur.rejected + 1 } });
    last = f;
    return;
  }
  lastMoveAt = f.ts;
  const s: WalkSession = cur ?? { id: `walk_${f.ts}`, startTime: last.ts, endTime: null, distanceM: 0, durationS: 0, accSum: 0, accN: 0, rejected: 0 };
  const next = { ...s, distanceM: s.distanceM + d, durationS: s.durationS + dt, accSum: s.accSum + f.accuracyM, accN: s.accN + 1 };
  const t = useWalking.getState().today;
  useWalking.setState({ current: next, source: 'gps', today: { ...t, distanceM: t.distanceM + d, durationS: t.durationS + dt } });
  last = f;
}

function maybeEnd(now: number) {
  const cur = useWalking.getState().current;
  if (cur && now - lastMoveAt > WALK.endAfterMs) {
    const ended = { ...cur, endTime: lastMoveAt };
    const t = useWalking.getState().today;
    useWalking.setState({ current: null, today: { ...t, sessions: t.sessions + 1 } });
    onEnd?.(ended);
  }
}

/** Demo mode: distance comes from the simulated walk, labelled as demo. */
export function demoWalk(distanceM: number) {
  const t = useWalking.getState().today;
  useWalking.setState({ source: 'demo', today: { ...t, distanceM } });
}

/** Manual controls (Health page). Automatic start/end on movement still applies when not paused. */
export function startWalk(now = Date.now()) {
  if (nativeOwner) { void nativeControl('start'); return; }
  const st = useWalking.getState();
  if (st.current) return;
  useWalking.setState({ paused: false, current: { id: `walk_${now}`, startTime: now, endTime: null, distanceM: 0, durationS: 0, accSum: 0, accN: 0, rejected: 0 } });
  last = null;
  lastMoveAt = now;
}

export function pauseWalk() {
  useWalking.setState({ paused: true });
  if (nativeOwner) void nativeControl('pause');
}

export function resumeWalk(now = Date.now()) {
  if (nativeOwner) { void nativeControl('resume'); return; }
  // Distance while paused is not counted: the next fix becomes the new reference point.
  last = null;
  lastSeenAt = 0;
  lastMoveAt = now;
  useWalking.setState({ paused: false });
}

export function endWalk(now = Date.now()) {
  if (nativeOwner) { void nativeControl('end'); return; }
  const cur = useWalking.getState().current;
  if (!cur) return;
  const t = useWalking.getState().today;
  useWalking.setState({ current: null, paused: false, today: { ...t, sessions: t.sessions + 1 } });
  last = null;
  onEnd?.({ ...cur, endTime: now, durationS: Math.round((now - cur.startTime) / 1000) });
}

/** Clear saved totals and GPS anchors on account reset, also used by tests. */
export function resetWalkTracker() {
  void stopNativeWalking(true);
  last = null;
  lastSeenAt = 0;
  lastMoveAt = 0;
  useWalking.setState(emptyWalking());
}

export const useWalkingTracking = create<{ native: boolean; background: boolean; error: string | null }>(() => ({ native: false, background: false, error: null }));
let nativeOwner: string | null = null;
let nativeGeneration = 0;
let nativeSubscriptions: PluginListenerHandle[] = [];
let nativeStart: Promise<boolean> | null = null;
let nativeOperations: Promise<unknown> = Promise.resolve();
let nativeRevision = -1;

// Configure, sign-out and controls reach Android in order even if authentication changes
// while the previous bridge call is still outstanding.
function serialNative<T>(operation: () => Promise<T>): Promise<T> {
  const result = nativeOperations.then(operation, operation);
  nativeOperations = result.catch(() => undefined);
  return result;
}

function applyNativeWalking(s: NativeWalkingState, owner: string) {
  if (nativeOwner !== owner || s.owner !== owner || !s.enabled) return;
  if (s.today.day !== dayKey() || ![s.today.distanceM, s.today.durationS, s.today.sessions].every(v => Number.isFinite(v) && v >= 0)) return;
  if (s.revision != null) {
    if (!Number.isFinite(s.revision) || s.revision < nativeRevision) return;
    nativeRevision = s.revision;
  }
  useWalkingTracking.setState({ native: true, background: s.tracking, error: s.error });
  const old = useWalking.getState();
  if (old.paused === s.paused && old.source === 'gps' && JSON.stringify(old.today) === JSON.stringify(s.today) && JSON.stringify(old.current) === JSON.stringify(s.current)) return;
  useWalking.setState({ today: s.today, current: s.current, paused: s.paused, source: 'gps' });
  if (old.owner === owner && old.today.day === s.today.day && old.current && old.current.id !== s.current?.id) onEnd?.({ ...old.current, endTime: Date.now() });
}

async function timedNative<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Walking tracker did not respond.')), 8000); })]);
  } finally { clearTimeout(timer); }
}

/** Call after a real user account is known. Old APKs/web keep the foreground-only JS tracker. */
export function startNativeWalking(owner: string): Promise<boolean> {
  if (!owner) return Promise.resolve(false);
  if (nativeOwner === owner) return nativeStart ?? Promise.resolve(true);
  const previous = useWalking.getState();
  if (previous.owner !== owner) {
    // Preserve an upgrade's progress only when the previously remembered account proves
    // who it belongs to; never seed another account or simulated demo activity.
    useWalking.setState(previous.owner === null && previous.source === 'gps' && legacyOwner === owner
      ? { owner } : { ...emptyWalking(), owner });
    last = null; lastSeenAt = 0; lastMoveAt = 0;
  }
  if (Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('AissLocation')) return Promise.resolve(false);
  const generation = ++nativeGeneration;
  nativeOwner = owner;
  nativeRevision = -1;
  const previousSubscriptions = nativeSubscriptions; nativeSubscriptions = [];
  const subscriptions: PluginListenerHandle[] = [];
  nativeStart = (async () => {
    await Promise.all(previousSubscriptions.map(s => s.remove().catch(() => undefined)));
    try {
      const snapshot = await serialNative(async () => {
        if (generation !== nativeGeneration) return null;
        const current = useWalking.getState();
        return timedNative(AissLocation.configureWalking({ owner, seed: { owner, ...current.today, sessions: current.today.sessions + (current.current ? 1 : 0) } }));
      });
      if (!snapshot || generation !== nativeGeneration) return false;
      applyNativeWalking(snapshot, owner);
      subscriptions.push(await AissLocation.addListener('walking', state => {
        if (generation === nativeGeneration) applyNativeWalking(state, owner);
      }));
      subscriptions.push(await App.addListener('appStateChange', ({ isActive }) => {
        if (isActive && generation === nativeGeneration) void timedNative(AissLocation.getWalkingState()).then(state => {
          if (generation === nativeGeneration) applyNativeWalking(state, owner);
        }).catch(() => undefined);
      }));
      if (generation !== nativeGeneration) {
        await Promise.all(subscriptions.map(s => s.remove().catch(() => undefined)));
        return false;
      }
      nativeSubscriptions = subscriptions;
      // Read again after subscribing so a service update between configure and addListener
      // cannot leave the displayed total behind the native odometer.
      const latest = await timedNative(AissLocation.getWalkingState());
      if (generation !== nativeGeneration) return false;
      applyNativeWalking(latest, owner);
      last = null; lastSeenAt = 0;
      return true;
    } catch (e) {
      await Promise.all(subscriptions.map(s => s.remove().catch(() => undefined)));
      if (generation === nativeGeneration) {
        nativeOwner = null;
        nativeSubscriptions = [];
        last = null; lastSeenAt = 0;
        await serialNative(() => timedNative(AissLocation.controlWalking({ command: 'stop', owner }))).catch(() => undefined);
        if (generation === nativeGeneration) useWalkingTracking.setState({ native: false, background: false, error: (e as Error).message });
      }
      return false;
    }
  })();
  return nativeStart;
}

async function nativeControl(command: 'start' | 'pause' | 'resume' | 'end') {
  const owner = nativeOwner;
  const generation = nativeGeneration;
  if (!owner) return;
  try {
    const state = await serialNative(async () => generation === nativeGeneration ? timedNative(AissLocation.controlWalking({ command, owner })) : null);
    if (state && generation === nativeGeneration) applyNativeWalking(state, owner);
  } catch (e) { if (generation === nativeGeneration) useWalkingTracking.setState({ error: (e as Error).message }); }
}

/** Stop on sign-out/guardian role. Clearing also erases the persisted native daily totals. */
export async function stopNativeWalking(clear = false) {
  const owner = nativeOwner ?? useWalking.getState().owner;
  nativeOwner = null;
  const generation = ++nativeGeneration;
  nativeStart = null;
  const subscriptions = nativeSubscriptions; nativeSubscriptions = [];
  let stopping: Promise<unknown> = Promise.resolve();
  if ((owner || clear) && Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('AissLocation')) {
    stopping = serialNative(() => timedNative(AissLocation.controlWalking({ command: clear ? 'clear' : 'stop', ...(owner ? { owner } : {}) }))).catch(() => undefined);
  }
  await Promise.all([stopping, ...subscriptions.map(s => s.remove().catch(() => undefined))]);
  if (generation === nativeGeneration) useWalkingTracking.setState({ native: false, background: false, error: null });
  last = null; lastSeenAt = 0;
}
