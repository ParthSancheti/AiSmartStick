import { create } from 'zustand';
import type { ActivityEvent } from '../types';
import { uid } from '../util';
import { useRuntime } from '../runtime/mode';

interface ActivityState {
  events: ActivityEvent[];
}

const now = Date.now();
const min = 60_000;
// Demo mode only. Real mode starts empty and loads from Firestore.
const demoSeed: ActivityEvent[] = [
  { id: uid(), ts: now - 18 * min, kind: 'navigation', severity: 'success', title: 'Arrived at City Pharmacy', detail: 'Demo data' },
  { id: uid(), ts: now - 26 * min, kind: 'safety', severity: 'warning', title: 'Obstacle ahead at 45 cm', detail: 'Demo data' },
  { id: uid(), ts: now - 74 * min, kind: 'device', severity: 'success', title: 'Stick connected', detail: 'Demo data' },
];

export const useActivity = create<ActivityState>(() => ({ events: useRuntime.getState().mode === 'demo' ? demoSeed : [] }));

const listeners = new Set<(e: ActivityEvent) => void>();
/** The sync layer subscribes here to persist events (idempotent by event id). */
export const onActivityLogged = (cb: (e: ActivityEvent) => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export function logEvent(e: Omit<ActivityEvent, 'id' | 'ts'>) {
  const ev: ActivityEvent = { ...e, id: `ev_${Date.now().toString(36)}_${uid()}`, ts: Date.now() };
  useActivity.setState((s) => ({ events: [ev, ...s.events].slice(0, 120) }));
  listeners.forEach((l) => l(ev));
}

/** Merge events loaded from the cloud (dedup by id, newest first). */
export function mergeEvents(list: ActivityEvent[]) {
  useActivity.setState((s) => {
    const map = new Map(s.events.map((e) => [e.id, e]));
    list.forEach((e) => map.set(e.id, e));
    return { events: [...map.values()].sort((a, b) => b.ts - a.ts).slice(0, 120) };
  });
}
