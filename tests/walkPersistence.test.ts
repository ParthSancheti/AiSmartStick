import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
const position = (metres: number, ts: number) => ({ lat: 18.52 + metres / 111320, lng: 73.85, accuracyM: 5, altitude: null, speedMps: null, headingDeg: null, ts });
describe('walking progress survives a new app process', () => {
  beforeEach(() => {
    vi.resetModules(); storage.clear(); vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 10, 15));
    vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('restores totals once and never adds movement while the app was closed', async () => {
    let tracker = await import('../src/core/walking/walkTracker');
    const now = Date.now();
    tracker.walkFix(position(0, now)); tracker.walkFix(position(12, now + 10000));
    const before = tracker.useWalking.getState().today.distanceM;
    vi.resetModules(); tracker = await import('../src/core/walking/walkTracker');
    expect(tracker.useWalking.getState().today).toMatchObject({ distanceM: before, sessions: 1 });
    tracker.walkFix(position(1000, now + 120000));
    expect(tracker.useWalking.getState().today.distanceM).toBe(before);
    vi.resetModules(); tracker = await import('../src/core/walking/walkTracker');
    expect(tracker.useWalking.getState().today.sessions).toBe(1);
  });
  it('starts a new local day without restoring yesterday as today', async () => {
    const tracker = await import('../src/core/walking/walkTracker');
    tracker.walkFix(position(0, Date.now())); tracker.walkFix(position(12, Date.now() + 10000));
    vi.setSystemTime(new Date(2026, 9, 11, 0, 1)); vi.resetModules();
    const next = await import('../src/core/walking/walkTracker');
    expect(next.useWalking.getState().today.distanceM).toBe(0);
    expect(next.useWalking.getState().today.day).toBe('2026-10-11');
  });
  it('clears saved totals when account data is reset', async () => {
    let tracker = await import('../src/core/walking/walkTracker');
    tracker.walkFix(position(0, Date.now())); tracker.walkFix(position(12, Date.now() + 10000));
    tracker.resetWalkTracker(); vi.resetModules(); tracker = await import('../src/core/walking/walkTracker');
    expect(tracker.useWalking.getState().today.distanceM).toBe(0);
  });
});
