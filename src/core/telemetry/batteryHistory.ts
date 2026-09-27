import { create } from 'zustand';
import { useDevice } from '../store/device';

/** Filtered battery estimates sampled once a minute on this phone (last 24 h, kept locally). */
export interface BatterySample {
  t: number;
  pct: number;
  charging: boolean | null;
}

const KEY = 'aiss.batteryHistory.v1';
const load = (): BatterySample[] => {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? '[]') as BatterySample[]).filter((s) => Date.now() - s.t < 86_400_000);
  } catch {
    return [];
  }
};

export const useBatteryHistory = create<{ samples: BatterySample[] }>(() => ({ samples: load() }));

let last = 0;
useDevice.subscribe((s) => {
  const b = s.battery;
  if (b.status !== 'ok' || b.percent == null || Date.now() - last < 60_000) return;
  last = Date.now();
  const samples = [...useBatteryHistory.getState().samples, { t: last, pct: b.percent, charging: b.charging }].filter((x) => last - x.t < 86_400_000).slice(-1440);
  useBatteryHistory.setState({ samples });
  try {
    localStorage.setItem(KEY, JSON.stringify(samples));
  } catch {
    /* ignore */
  }
});
