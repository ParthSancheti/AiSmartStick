import { describe, test, expect, beforeEach, vi } from 'vitest';
import { startRealNavigation, stopRealNavigation, progressOnPath, reroute, realNavActive, savedNavigation } from '../src/core/navigation/realNavigator';
import { announce } from '../src/core/ai/voiceOut';
import { useNavView } from '../src/core/navigation/navView';
import { useLocation } from '../src/core/location/locationService';
import { walkingRoute } from '../src/core/maps/mapsService';

vi.mock('../src/core/maps/mapsService', () => ({
  walkingRoute: vi.fn(),
  placeDetails: vi.fn(),
  autocomplete: vi.fn(),
}));

vi.mock('../src/core/ai/voiceOut', () => ({
  announce: vi.fn(),
}));

vi.mock('../src/core/feedback/haptics', () => ({
  haptics: { play: vi.fn() },
}));

vi.mock('../src/core/feedback/earcons', () => ({
  earcon: vi.fn(),
}));

vi.mock('../src/core/navigation/stickHaptics', () => ({ stickNavCue: vi.fn() }));

// Capture the navigator's GPS subscription so tests can walk along the route.
const fixListeners = new Set<(f: any) => void>();
vi.mock('../src/core/location/locationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/location/locationService')>();
  return {
    ...actual,
    onFix: (cb: (f: any) => void) => {
      fixListeners.add(cb);
      return () => fixListeners.delete(cb);
    },
  };
});
const walkTo = (lat: number, lng: number) => fixListeners.forEach((l) => l({ lat, lng, accuracyM: 5, ts: Date.now(), speedMps: 1.2 }));

// Node has no localStorage; the navigator persists the active destination there.
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };

const route = () => ({
  distanceM: 222,
  durationS: 200,
  path: [[0, 0], [0.001, 0], [0.002, 0]] as [number, number][],
  steps: [
    { distanceM: 111, durationS: 100, instruction: 'Head North', maneuver: null, start: { lat: 0, lng: 0 }, end: { lat: 0.001, lng: 0 } },
    { distanceM: 111, durationS: 100, instruction: 'Continue straight', maneuver: 'straight', start: { lat: 0.001, lng: 0 }, end: { lat: 0.002, lng: 0 } },
  ],
});
const dest = { placeId: 'p_end', name: 'End Point', lat: 0.002, lng: 0, address: null, distanceM: 222, openNow: true, primaryType: null };

describe('Walking Navigation State Machine', () => {
  beforeEach(() => {
    stopRealNavigation('user');
    useNavView.setState({ active: false, state: 'IDLE' });
    vi.clearAllMocks();
  });

  test('progressOnPath geometric projection', () => {
    const path: [number, number][] = [[0, 0], [0.001, 0]]; // North
    const cum = [0, 111]; // Roughly 111m
    
    // Exactly on start
    let r = progressOnPath(path, cum, { lat: 0, lng: 0 });
    expect(r.along).toBeCloseTo(0, 1);
    expect(r.off).toBeCloseTo(0, 1);

    // Halfway, slightly off
    r = progressOnPath(path, cum, { lat: 0.0005, lng: 0.0001 });
    expect(r.along).toBeGreaterThan(50);
    expect(r.off).toBeGreaterThan(5); // 0.0001 deg lon is ~11m at equator

    // Past end
    r = progressOnPath(path, cum, { lat: 0.002, lng: 0 });
    expect(r.along).toBeCloseTo(111, 1);
  });

  test('Start navigation transitions to ROUTE_READY', async () => {
    // Setup mock route
    vi.mocked(walkingRoute).mockResolvedValueOnce({
      distanceM: 500,
      durationS: 300,
      path: [[0, 0], [0.001, 0], [0.002, 0.001]],
      steps: [
        { distanceM: 111, durationS: 100, instruction: 'Head North', maneuver: null, start: { lat: 0, lng: 0 }, end: { lat: 0.001, lng: 0 } },
        { distanceM: 111, durationS: 100, instruction: 'Turn right', maneuver: 'turn-right', start: { lat: 0.001, lng: 0 }, end: { lat: 0.002, lng: 0.001 } }
      ]
    });

    useLocation.setState({ fix: { lat: 0, lng: 0, accuracyM: 5, ts: Date.now(), speedMps: 1 } as any });

    const place = { placeId: '123', name: 'Test Place', lat: 0.002, lng: 0.001, address: null, distanceM: 500, openNow: true, primaryType: null };
    await startRealNavigation(place);

    const state = useNavView.getState();
    expect(state.active).toBe(true);
    // Initial fix triggers immediately, so state might already be NAVIGATING
    expect(['ROUTE_READY', 'NAVIGATING']).toContain(state.state);
    expect(state.remainingM).toBeGreaterThan(0);
    expect(state.next?.text).toBe('Turn right');
  });

  test('speaks the start, announces arrival exactly once, and forgets the saved route', async () => {
    vi.mocked(walkingRoute).mockResolvedValueOnce(route() as any);
    useLocation.setState({ fix: { lat: 0, lng: 0, accuracyM: 5, ts: Date.now(), speedMps: 1 } as any });
    await startRealNavigation(dest);
    expect(vi.mocked(announce).mock.calls.some(([l]) => typeof l === 'object' && /Walking to End Point/.test((l as any).en))).toBe(true);
    expect(savedNavigation()?.placeId).toBe('p_end');

    walkTo(0.002, 0);
    walkTo(0.002, 0);
    walkTo(0.002, 0);
    const arrivals = vi.mocked(announce).mock.calls.filter(([l]) => typeof l === 'object' && /arrived/i.test((l as any).en));
    expect(arrivals).toHaveLength(1);
    expect(useNavView.getState().state).toBe('ARRIVED');

    stopRealNavigation('arrived');
    expect(savedNavigation()).toBeNull();
  });

  test('a reroute that finishes after Stop does not revive navigation', async () => {
    vi.mocked(walkingRoute).mockResolvedValueOnce(route() as any);
    useLocation.setState({ fix: { lat: 0, lng: 0, accuracyM: 5, ts: Date.now(), speedMps: 1 } as any });
    await startRealNavigation(dest);
    let finish: (r: any) => void = () => {};
    vi.mocked(walkingRoute).mockImplementationOnce(() => new Promise((r) => (finish = r)));
    const pending = reroute();
    stopRealNavigation('user');
    finish(route());
    await pending;
    expect(realNavActive()).toBe(false);
    expect(useNavView.getState().active).toBe(false);
  });
});
