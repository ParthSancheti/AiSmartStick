/**
 * Geofence decision (pure, unit-tested in tests/geofence.test.ts).
 * Debounce so GPS noise can't produce EXIT/ENTER/EXIT/ENTER:
 *  - EXIT only after ≥ 2 consecutive outside readings spanning ≥ 30 s, each outside by more than its accuracy;
 *  - ENTER (re-arm) only after 2 consecutive readings clearly inside (radius − 25 m − accuracy).
 */
export interface FenceState {
  outside: boolean;
  candidate: 'none' | 'exit' | 'enter';
  candidateSince: number;
  candidateCount: number;
}

export const initialFence = (): FenceState => ({ outside: false, candidate: 'none', candidateSince: 0, candidateCount: 0 });

export function geofenceStep(st: FenceState, distanceM: number, accuracyM: number, radiusM: number, now: number): { state: FenceState; event: 'exit' | 'enter' | null } {
  if (accuracyM > 60) return { state: st, event: null };
  const clearlyOut = distanceM > radiusM + accuracyM;
  const clearlyIn = distanceM < radiusM - 25 - accuracyM;
  const want: FenceState['candidate'] = !st.outside && clearlyOut ? 'exit' : st.outside && clearlyIn ? 'enter' : 'none';
  if (want === 'none') return { state: { ...st, candidate: 'none', candidateCount: 0, candidateSince: 0 }, event: null };
  const next: FenceState = st.candidate === want ? { ...st, candidateCount: st.candidateCount + 1 } : { ...st, candidate: want, candidateCount: 1, candidateSince: now };
  if (want === 'exit' && next.candidateCount >= 2 && now - next.candidateSince >= 30_000) return { state: { outside: true, candidate: 'none', candidateCount: 0, candidateSince: 0 }, event: 'exit' };
  if (want === 'enter' && next.candidateCount >= 2) return { state: { outside: false, candidate: 'none', candidateCount: 0, candidateSince: 0 }, event: 'enter' };
  return { state: next, event: null };
}
