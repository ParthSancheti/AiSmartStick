import { create } from 'zustand';
import { ENV } from './env';

/**
 * REAL vs DEMO. The single switch that decides every data source.
 *  - REAL: Firebase, the physical stick, GPS, Google Maps, Gemini. Missing data is shown as missing.
 *  - DEMO: MockTransport, the simulated street grid, the keyword brain, seeded activity.
 * Real mode never falls back to demo data. Switching mode reloads the app so no state leaks across.
 */
export type AppMode = 'real' | 'demo';

const KEY = 'aiss.mode';

function initialMode(): AppMode {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'real' || saved === 'demo') return saved;
  } catch {
    /* storage unavailable */
  }
  return ENV.appMode === 'demo' ? 'demo' : 'real';
}

interface RuntimeState {
  mode: AppMode;
}

export const useRuntime = create<RuntimeState>(() => ({ mode: initialMode() }));

export const isDemo = () => useRuntime.getState().mode === 'demo';
export const isReal = () => useRuntime.getState().mode === 'real';

/** Persist and reload; state from one mode must never appear in the other. */
export function switchMode(mode: AppMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* ignore */
  }
  window.location.reload();
}
