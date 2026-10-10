import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fix } from '../src/core/location/locationService';
import type { PlaceResult, RouteResult } from '../src/core/maps/mapsService';

const testState = vi.hoisted(() => ({
  listeners: new Set<(fix: Fix) => void>(),
  maneuverAllowed: true,
  spoken: [] as string[],
}));
vi.mock('../src/core/maps/destinationSearch', () => ({ routeWalking: vi.fn() }));
vi.mock('../src/core/guidance/guidanceState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/guidance/guidanceState')>();
  return { ...actual, routeManeuverAllowed: () => testState.maneuverAllowed };
});
vi.mock('../src/core/ai/voiceOut', () => ({
  cancelInvalidAnnouncements: vi.fn(),
  announce: vi.fn((line: { en: string } | string, opts: { isCurrent?: () => boolean } = {}) => {
    if (!opts.isCurrent || opts.isCurrent()) testState.spoken.push(typeof line === 'string' ? line : line.en);
  }),
}));
vi.mock('../src/core/feedback/haptics', () => ({ haptics: { play: vi.fn() } }));
vi.mock('../src/core/feedback/earcons', () => ({ earcon: vi.fn() }));
vi.mock('../src/core/navigation/stickHaptics', () => ({ stickNavCue: vi.fn() }));
vi.mock('../src/core/store/activity', () => ({ logEvent: vi.fn() }));
vi.mock('../src/core/location/locationService', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/location/locationService')>();
  return {
    ...original,
    ensureLocation: vi.fn(async () => {}),
    onFix: (listener: (fix: Fix) => void) => {
      testState.listeners.add(listener);
      return () => { testState.listeners.delete(listener); };
    },
  };
});

import { routeWalking } from '../src/core/maps/destinationSearch';
import { useLocation, LOCATION_STALE_MS } from '../src/core/location/locationService';
import { announce, cancelInvalidAnnouncements } from '../src/core/ai/voiceOut';
import { haptics } from '../src/core/feedback/haptics';
import { stickNavCue } from '../src/core/navigation/stickHaptics';
import { useNavView } from '../src/core/navigation/navView';
import { emptyWalkingGuidance, useWalkingGuidance } from '../src/core/guidance/guidanceState';
import { armNavigation, currentDestination, pendingDestination, realNavActive, reroute, startRealNavigation, stopRealNavigation } from '../src/core/navigation/realNavigator';

const destination: PlaceResult = { placeId: 'destination', name: 'Entrance', lat: 0.002, lng: 0.001, address: null, distanceM: null, openNow: null, primaryType: null };
const alternate: PlaceResult = { ...destination, placeId: 'alternate', name: 'Second entrance' };
function route(): RouteResult {
  return {
    distanceM: 333, durationS: 280,
    path: [[0, 0], [0.001, 0], [0.001, 0.001], [0.002, 0.001]],
    steps: [
      { instruction: 'Head north', maneuver: 'straight', distanceM: 111, durationS: 90, start: { lat: 0, lng: 0 }, end: { lat: 0.001, lng: 0 } },
      { instruction: 'Turn right', maneuver: 'turn-right', distanceM: 111, durationS: 90, start: { lat: 0.001, lng: 0 }, end: { lat: 0.001, lng: 0.001 } },
      { instruction: 'Turn left', maneuver: 'turn-left', distanceM: 111, durationS: 100, start: { lat: 0.001, lng: 0.001 }, end: { lat: 0.002, lng: 0.001 } },
    ],
  };
}
function fix(lat = 0, lng = 0, extra: Partial<Fix> = {}): Fix {
  return { lat, lng, accuracyM: 5, altitude: null, headingDeg: null, speedMps: 1.2, ts: Date.now(), ...extra };
}
function emit(f: Fix) {
  useLocation.setState({ fix: f, status: 'ok' });
  for (const listener of Array.from(testState.listeners)) listener(f);
}
function deferred<T>() {
  let resolve: (result: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('real walking route safety and lifecycle scenarios', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T09:00:00Z'));
    stopRealNavigation();
    vi.clearAllMocks();
    testState.spoken.length = 0;
    testState.maneuverAllowed = true;
    useWalkingGuidance.setState(emptyWalkingGuidance());
    useLocation.setState({ fix: fix(), precise: true, servicesOn: true, permission: 'granted', status: 'ok' });
    vi.mocked(routeWalking).mockResolvedValue(route());
  });

  afterEach(() => {
    stopRealNavigation();
    vi.useRealTimers();
  });

  it('does not revive a stopped route when its initial network request finishes', async () => {
    const request = deferred<RouteResult>();
    vi.mocked(routeWalking).mockReturnValueOnce(request.promise);
    const starting = startRealNavigation(destination);
    stopRealNavigation();
    request.resolve(route());
    await expect(starting).rejects.toThrow('navigation-cancelled');
    expect(realNavActive()).toBe(false);
    expect(testState.listeners.size).toBe(0);
    expect(testState.spoken).toEqual([]);
  });

  it('shares duplicate initial requests for the same destination and subscribes only once', async () => {
    const request = deferred<RouteResult>();
    vi.mocked(routeWalking).mockReturnValueOnce(request.promise);
    const first = startRealNavigation(destination);
    const second = startRealNavigation({ ...destination });
    expect(first).toBe(second);
    expect(routeWalking).toHaveBeenCalledTimes(1);
    request.resolve(route());
    await Promise.all([first, second]);
    expect(testState.listeners.size).toBe(1);
    expect(testState.spoken.filter((line) => line.startsWith('Walking to'))).toHaveLength(1);
  });

  it('keeps the latest destination when an older initial request finishes last', async () => {
    const request = deferred<RouteResult>();
    vi.mocked(routeWalking).mockReturnValueOnce(request.promise);
    const oldStart = startRealNavigation(destination);
    await startRealNavigation(alternate);
    request.resolve(route());
    await expect(oldStart).rejects.toThrow('navigation-cancelled');
    expect(currentDestination()?.placeId).toBe(alternate.placeId);
    expect(testState.listeners.size).toBe(1);
    expect(testState.spoken.filter((line) => line.startsWith('Walking to'))).toEqual([expect.stringContaining('Second entrance')]);
  });

  it('does not revive a cancelled pending-GPS route after its request finishes', async () => {
    const request = deferred<RouteResult>();
    vi.mocked(routeWalking).mockReturnValueOnce(request.promise);
    useLocation.setState({ fix: null });
    armNavigation(destination);
    emit(fix());
    expect(routeWalking).toHaveBeenCalledTimes(1);
    stopRealNavigation();
    request.resolve(route());
    await flush();
    expect(realNavActive()).toBe(false);
    expect(pendingDestination()).toBeNull();
    expect(testState.listeners.size).toBe(0);
  });

  it('allows a replacement pending destination to start while an obsolete request finishes', async () => {
    const request = deferred<RouteResult>();
    vi.mocked(routeWalking).mockReturnValueOnce(request.promise);
    useLocation.setState({ fix: null });
    armNavigation(destination);
    emit(fix());
    armNavigation(alternate);
    await flush();
    expect(currentDestination()?.placeId).toBe(alternate.placeId);
    request.resolve(route());
    await flush();
    expect(currentDestination()?.placeId).toBe(alternate.placeId);
    expect(testState.listeners.size).toBe(1);
  });

  it('does not request reroutes using stale or inaccurate GPS positions', async () => {
    await startRealNavigation(destination);
    vi.mocked(routeWalking).mockClear();
    useLocation.setState({ fix: fix(0.0005, 0, { ts: Date.now() - LOCATION_STALE_MS - 1 }) });
    await reroute();
    expect(routeWalking).not.toHaveBeenCalled();
    expect(useNavView.getState()).toMatchObject({ state: 'NAVIGATION_ERROR', next: null });
    useLocation.setState({ fix: fix(0.0005, 0, { accuracyM: 50 }) });
    await reroute();
    expect(routeWalking).not.toHaveBeenCalled();
  });

  it('shares in-flight reroutes and preserves the retry cooldown after success', async () => {
    await startRealNavigation(destination);
    const request = deferred<RouteResult>();
    vi.mocked(routeWalking).mockClear();
    vi.mocked(routeWalking).mockReturnValueOnce(request.promise);
    const first = reroute();
    const duplicate = reroute();
    expect(first).toBe(duplicate);
    expect(routeWalking).toHaveBeenCalledTimes(1);
    request.resolve(route());
    await first;
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(1000);
      emit(fix(0.0005, -0.001));
    }
    expect(routeWalking).toHaveBeenCalledTimes(1);
    expect(useNavView.getState().offRoute).toBe(true);
  });

  it('rejects an empty replacement route without losing the current route', async () => {
    await startRealNavigation(destination);
    vi.mocked(routeWalking).mockResolvedValueOnce({ ...route(), path: [] });
    await reroute();
    expect(realNavActive()).toBe(true);
    expect(useNavView.getState()).toMatchObject({ state: 'NAVIGATION_ERROR', rerouting: false, path: route().path });
    expect(testState.spoken).not.toContain('New route found.');
  });

  it('does not announce arrival when a distant lateral fix projects onto the endpoint', async () => {
    await startRealNavigation(destination);
    emit(fix(0.003, 0.002));
    expect(useNavView.getState().arrived).toBe(false);
    expect(haptics.play).not.toHaveBeenCalledWith('arrive');
    expect(testState.spoken.some((line) => /arrived/i.test(line))).toBe(false);
  });

  it('does not claim arrival when the mapped path ends far from the selected destination', async () => {
    await startRealNavigation({ ...destination, lat: 0.004 });
    emit(fix(0.002, 0.001));
    expect(useNavView.getState()).toMatchObject({ active: true, arrived: false, state: 'NAVIGATION_ERROR', next: null });
    expect(testState.spoken.some((line) => /arrived/i.test(line))).toBe(false);
    expect(haptics.play).not.toHaveBeenCalledWith('arrive');
  });

  it('announces valid arrival immediately once and clears its timer when stopped', async () => {
    await startRealNavigation(destination);
    emit(fix(destination.lat, destination.lng));
    emit(fix(destination.lat, destination.lng));
    expect(testState.spoken.filter((line) => /arrived/i.test(line))).toHaveLength(1);
    expect(useNavView.getState().state).toBe('ARRIVED');
    stopRealNavigation();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not advance turns from duplicate, older, or stale fixes', async () => {
    await startRealNavigation(destination);
    vi.advanceTimersByTime(1000);
    const approach = fix(0.0008, 0);
    emit(approach);
    expect(testState.spoken.filter((line) => line.startsWith('In '))).toHaveLength(1);
    emit(approach);
    expect(testState.spoken.filter((line) => line.startsWith('In '))).toHaveLength(1);
    emit(fix(0.001, 0.00096, { ts: approach.ts - 500 }));
    expect(haptics.play).not.toHaveBeenCalledWith('left');
    emit(fix(0.001, 0.00096, { ts: Date.now() - LOCATION_STALE_MS - 1 }));
    expect(haptics.play).not.toHaveBeenCalledWith('left');
    expect(useNavView.getState()).toMatchObject({ state: 'NAVIGATION_ERROR', next: null });
  });

  it('withholds route turns during an obstacle hold and reevaluates after fresh safe data', async () => {
    await startRealNavigation(destination);
    testState.spoken.length = 0;
    testState.maneuverAllowed = false;
    emit(fix(0.0008, 0));
    expect(useNavView.getState().next).toBeNull();
    expect(testState.spoken).toEqual([]);
    expect(stickNavCue).not.toHaveBeenCalled();
    testState.maneuverAllowed = true;
    vi.advanceTimersByTime(1000);
    emit(fix(0.00081, 0));
    expect(testState.spoken.filter((line) => line.startsWith('In '))).toHaveLength(1);
    expect(stickNavCue).toHaveBeenCalledWith('upcoming', expect.any(Function));
  });

  it('invalidates queued turn speech when stopped, rerouting, passed, or blocked', async () => {
    await startRealNavigation(destination);
    emit(fix(0.0008, 0));
    const options = vi.mocked(announce).mock.calls.find(([line]) => typeof line !== 'string' && line.en.startsWith('In '))![1]!;
    expect(options.isCurrent!()).toBe(true);
    testState.maneuverAllowed = false;
    expect(options.isCurrent!()).toBe(false);
    testState.maneuverAllowed = true;
    const request = deferred<RouteResult>();
    vi.mocked(routeWalking).mockReturnValueOnce(request.promise);
    const rerouting = reroute();
    expect(options.isCurrent!()).toBe(false);
    request.resolve(route());
    await rerouting;
    expect(options.isCurrent!()).toBe(false);
    stopRealNavigation();
    expect(options.isCurrent!()).toBe(false);
  });

  it('withholds maneuver prompts immediately when off-route and throughout rerouting', async () => {
    await startRealNavigation(destination);
    testState.spoken.length = 0;
    emit(fix(0.00095, -0.001));
    expect(useNavView.getState().next).toBeNull();
    expect(testState.spoken.some((line) => line.startsWith('In '))).toBe(false);
    const request = deferred<RouteResult>();
    vi.mocked(routeWalking).mockReturnValueOnce(request.promise);
    const rerouting = reroute();
    vi.advanceTimersByTime(1000);
    emit(fix(0.00096, 0));
    expect(useNavView.getState()).toMatchObject({ state: 'REROUTING', next: null });
    expect(haptics.play).not.toHaveBeenCalledWith('right');
    request.resolve(route());
    await rerouting;
  });

  it('reannounces the current maneuver after returning from a temporary off-route pause', async () => {
    await startRealNavigation(destination);
    emit(fix(0.0008, 0));
    expect(testState.spoken.filter(line => line.startsWith('In '))).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    emit(fix(0.0008, -0.001));
    expect(useNavView.getState().next).toBeNull();
    vi.advanceTimersByTime(1000);
    emit(fix(0.00081, 0));
    expect(testState.spoken.filter(line => line.startsWith('In '))).toHaveLength(2);
    expect(routeWalking).toHaveBeenCalledTimes(1);
  });

  it('invalidates old turns while a different destination is loading', async () => {
    await startRealNavigation(destination);
    emit(fix(0.0008, 0));
    const opts = vi.mocked(announce).mock.calls.find(([line]) => typeof line !== 'string' && line.en.startsWith('In '))![1]!;
    expect(opts.isCurrent!()).toBe(true);
    const request = deferred<RouteResult>();
    vi.mocked(routeWalking).mockReturnValueOnce(request.promise);
    const replacement = startRealNavigation(alternate);
    expect(opts.isCurrent!()).toBe(false);
    expect(cancelInvalidAnnouncements).toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    emit(fix(0.00096, 0));
    expect(haptics.play).not.toHaveBeenCalledWith('right');
    request.resolve(route());
    await replacement;
    expect(currentDestination()?.placeId).toBe(alternate.placeId);
  });

  it('does not let the previous arrival grace timer cancel a newly selected destination', async () => {
    await startRealNavigation(destination);
    emit(fix(destination.lat, destination.lng));
    expect(vi.getTimerCount()).toBe(1);
    const request = deferred<RouteResult>();
    vi.mocked(routeWalking).mockReturnValueOnce(request.promise);
    const replacement = startRealNavigation(alternate);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(9000);
    emit(fix());
    request.resolve(route());
    await replacement;
    expect(currentDestination()?.placeId).toBe(alternate.placeId);
    expect(realNavActive()).toBe(true);
  });

  it('pauses and invalidates pending turns when GPS expires without another fix', async () => {
    await startRealNavigation(destination);
    emit(fix(0.0008, 0));
    const opts = vi.mocked(announce).mock.calls.find(([line]) => typeof line !== 'string' && line.en.startsWith('In '))![1]!;
    expect(opts.isCurrent!()).toBe(true);
    vi.advanceTimersByTime(LOCATION_STALE_MS + 1);
    useLocation.setState({ status: 'stale' });
    expect(useNavView.getState()).toMatchObject({ state: 'NAVIGATION_ERROR', next: null });
    expect(opts.isCurrent!()).toBe(false);
    expect(cancelInvalidAnnouncements).toHaveBeenCalled();
  });

  it.each(['warning', 'unavailable'] as const)('immediately hides a published turn when guidance becomes %s between GPS fixes', async (severity) => {
    await startRealNavigation(destination);
    emit(fix(0.00096, 0));
    expect(useNavView.getState()).toMatchObject({ state: 'MANEUVER_NOW', next: { maneuver: 'right' } });
    vi.mocked(cancelInvalidAnnouncements).mockClear();
    testState.maneuverAllowed = false;
    useWalkingGuidance.setState({ severity, routeHold: true });
    expect(useNavView.getState()).toMatchObject({ state: 'NAVIGATION_ERROR', next: null });
    expect(useNavView.getState().error).toContain(severity === 'warning' ? 'Obstacle warning active' : 'Obstacle distance cannot be confirmed');
    expect(cancelInvalidAnnouncements).toHaveBeenCalledTimes(1);
    testState.maneuverAllowed = true;
    useWalkingGuidance.setState({ severity: 'none', routeHold: false });
    expect(useNavView.getState()).toMatchObject({ state: 'NAVIGATION_ERROR', next: null });
    vi.advanceTimersByTime(1000);
    emit(fix(0.000961, 0));
    expect(useNavView.getState()).toMatchObject({ state: 'MANEUVER_NOW', next: { maneuver: 'right' }, error: null });
  });

  it('owns one guidance subscription and cleans it up on route replacement and stop', async () => {
    const originalSubscribe = useWalkingGuidance.subscribe;
    const cleanups: ReturnType<typeof vi.fn>[] = [];
    const subscribe = vi.spyOn(useWalkingGuidance, 'subscribe').mockImplementation((listener) => {
      const cleanup = vi.fn(originalSubscribe(listener));
      cleanups.push(cleanup);
      return cleanup;
    });
    try {
      await startRealNavigation(destination);
      expect(subscribe).toHaveBeenCalledTimes(1);
      await reroute();
      expect(subscribe).toHaveBeenCalledTimes(1);
      await startRealNavigation(alternate);
      expect(subscribe).toHaveBeenCalledTimes(2);
      expect(cleanups[0]).toHaveBeenCalledTimes(1);
      stopRealNavigation();
      expect(cleanups[1]).toHaveBeenCalledTimes(1);
      testState.maneuverAllowed = false;
      useWalkingGuidance.setState({ severity: 'warning', routeHold: true });
      expect(useNavView.getState()).toMatchObject({ active: false, state: 'IDLE', next: null });
    } finally {
      stopRealNavigation();
      subscribe.mockRestore();
    }
  });

  it('does not republish unchanged paused navigation on guidance freshness refreshes', async () => {
    await startRealNavigation(destination);
    testState.maneuverAllowed = false;
    useWalkingGuidance.setState({ severity: 'warning', routeHold: true });
    const changed = vi.fn();
    const unsubscribe = useNavView.subscribe(changed);
    try {
      for (let i = 0; i < 20; i++) useWalkingGuidance.setState({ severity: 'warning', routeHold: true, evaluatedAt: Date.now() + i });
      expect(changed).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});
