import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('keeps real walking totals when entering and leaving a simulated walk', async () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const recorded = JSON.stringify({ version: 0, state: { owner: 'real-user', today: { day, distanceM: 123, durationS: 100, sessions: 1 }, source: 'gps' } });
  values.set('aiss.walking.v1', recorded);
  values.set('aiss.mode', 'demo');
  vi.resetModules();
  const demo = await import('../src/core/walking/walkTracker');
  demo.demoWalk(500);
  expect(demo.useWalking.getState().today.distanceM).toBe(500);
  expect(values.get('aiss.walking.v1')).toBe(recorded);
  expect(values.has('aiss.walking.demo.v1')).toBe(true);
  values.set('aiss.mode', 'real');
  vi.resetModules();
  const real = await import('../src/core/walking/walkTracker');
  expect(real.useWalking.getState()).toMatchObject({ owner: 'real-user', source: 'gps', today: { distanceM: 123, durationS: 100, sessions: 1 } });
});
