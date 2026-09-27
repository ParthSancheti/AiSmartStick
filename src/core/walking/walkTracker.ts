import { create } from 'zustand';
import { haversineM, type Fix } from '../location/locationService';

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
  current: WalkSession | null;
  /** Manual pause: fixes are ignored until resumed. */
  paused: boolean;
  today: { distanceM: number; durationS: number; sessions: number; day: string };
  source: 'gps' | 'demo' | null;
}

const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
export const useWalking = create<WalkState>(() => ({ current: null, paused: false, today: { distanceM: 0, durationS: 0, sessions: 0, day: dayKey() }, source: null }));

export const WALK = { maxAccuracyM: 25, maxSpeedMps: 3.5, endAfterMs: 180_000 };

let last: Fix | null = null;
let lastMoveAt = 0;
let onEnd: ((s: WalkSession) => void) | null = null;
export const onWalkEnded = (cb: (s: WalkSession) => void) => {
  onEnd = cb;
  return () => {
    if (onEnd === cb) onEnd = null;
  };
};

export function walkFix(f: Fix) {
  if (useWalking.getState().paused) return;
  if (f.accuracyM > WALK.maxAccuracyM) return;
  const st = useWalking.getState();
  if (st.today.day !== dayKey(f.ts)) useWalking.setState({ today: { distanceM: 0, durationS: 0, sessions: 0, day: dayKey(f.ts) } });
  if (!last) {
    last = f;
    return;
  }
  const d = haversineM(last, f);
  const dt = Math.max(0.001, (f.ts - last.ts) / 1000);
  if (d < Math.max(3, f.accuracyM * 0.5)) {
    maybeEnd(f.ts);
    return;
  }
  const cur = useWalking.getState().current;
  if (d / dt > WALK.maxSpeedMps) {
    if (cur) useWalking.setState({ current: { ...cur, rejected: cur.rejected + 1 } });
    last = f;
    return;
  }
  lastMoveAt = f.ts;
  const s: WalkSession = cur ?? { id: `walk_${f.ts}`, startTime: last.ts, endTime: null, distanceM: 0, durationS: 0, accSum: 0, accN: 0, rejected: 0 };
  const next = { ...s, distanceM: s.distanceM + d, durationS: Math.round((f.ts - s.startTime) / 1000), accSum: s.accSum + f.accuracyM, accN: s.accN + 1 };
  const t = useWalking.getState().today;
  useWalking.setState({ current: next, source: 'gps', today: { ...t, distanceM: t.distanceM + d, durationS: t.durationS + Math.round(dt) } });
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
  const st = useWalking.getState();
  if (st.current) return;
  useWalking.setState({ paused: false, current: { id: `walk_${now}`, startTime: now, endTime: null, distanceM: 0, durationS: 0, accSum: 0, accN: 0, rejected: 0 } });
  last = null;
  lastMoveAt = now;
}

export function pauseWalk() {
  useWalking.setState({ paused: true });
}

export function resumeWalk(now = Date.now()) {
  // Distance while paused is not counted: the next fix becomes the new reference point.
  last = null;
  lastMoveAt = now;
  useWalking.setState({ paused: false });
}

export function endWalk(now = Date.now()) {
  const cur = useWalking.getState().current;
  if (!cur) return;
  const t = useWalking.getState().today;
  useWalking.setState({ current: null, paused: false, today: { ...t, sessions: t.sessions + 1 } });
  last = null;
  onEnd?.({ ...cur, endTime: now, durationS: Math.round((now - cur.startTime) / 1000) });
}

/** Test helper. */
export function resetWalkTracker() {
  last = null;
  lastMoveAt = 0;
  useWalking.setState({ current: null, paused: false, today: { distanceM: 0, durationS: 0, sessions: 0, day: dayKey() }, source: null });
}
