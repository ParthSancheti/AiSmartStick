import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fix } from '../src/core/location/locationService';
import type { PlaceResult, RouteResult } from '../src/core/maps/mapsService';

const replay = vi.hoisted(() => ({ listeners: new Set<(fix: Fix) => void>() }));
vi.mock('../src/core/maps/destinationSearch', () => ({ routeWalking: vi.fn() }));
vi.mock('../src/core/ai/voiceOut', () => ({ announce: vi.fn(), cancelInvalidAnnouncements: vi.fn() }));
vi.mock('../src/core/feedback/haptics', () => ({ haptics: { play: vi.fn() } }));
vi.mock('../src/core/feedback/earcons', () => ({ earcon: vi.fn() }));
vi.mock('../src/core/navigation/stickHaptics', () => ({ stickNavCue: vi.fn() }));
vi.mock('../src/core/store/activity', () => ({ logEvent: vi.fn() }));
vi.mock('../src/core/guidance/guidanceState', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/guidance/guidanceState')>(),
  routeManeuverAllowed: () => true,
}));
vi.mock('../src/core/location/locationService', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/location/locationService')>(),
  onFix: (listener: (fix: Fix) => void) => {
    replay.listeners.add(listener);
    return () => { replay.listeners.delete(listener); };
  },
}));

import { routeWalking } from '../src/core/maps/destinationSearch';
import { haversineM, useLocation } from '../src/core/location/locationService';
import { useNavView } from '../src/core/navigation/navView';
import { startRealNavigation, stopRealNavigation } from '../src/core/navigation/realNavigator';
import { haptics } from '../src/core/feedback/haptics';

type Point = [number, number];
function position([lat, lng]: Point): Fix {
  return { lat, lng, ts: Date.now(), accuracyM: 5, speedMps: 1.2, headingDeg: null, altitude: null };
}
function emit(point: Point, elapsedMs = 1000) {
  vi.advanceTimersByTime(elapsedMs);
  const fix = position(point);
  useLocation.setState({ fix, status: 'ok' });
  for (const listener of [...replay.listeners]) listener(fix);
}
function walkingRoute(path: Point[]): RouteResult {
  const steps = path.slice(1).map(([lat, lng], index) => {
    const start = { lat: path[index][0], lng: path[index][1] };
    const end = { lat, lng };
    const distanceM = haversineM(start, end);
    return { start, end, distanceM, durationS: distanceM / 1.2, maneuver: index ? 'turn-right' : 'straight', instruction: `Route leg ${index + 1}` };
  });
  return { path, steps, distanceM: steps.reduce((sum, step) => sum + step.distanceM, 0), durationS: steps.reduce((sum, step) => sum + step.durationS, 0) };
}
async function start(path: Point[]) {
  const [lat, lng] = path[path.length - 1];
  const place: PlaceResult = { placeId: 'replay', name: 'Replay entrance', lat, lng, address: null, distanceM: null, openNow: null, primaryType: null };
  useLocation.setState({ fix: position(path[0]), status: 'ok' });
  vi.mocked(routeWalking).mockResolvedValue(walkingRoute(path));
  await startRealNavigation(place);
}
function walkSegment(from: Point, to: Point) {
  const distance = haversineM({ lat: from[0], lng: from[1] }, { lat: to[0], lng: to[1] });
  const samples = Math.max(1, Math.ceil(distance / 6));
  for (let index = 1; index <= samples; index++) {
    emit([from[0] + (to[0] - from[0]) * index / samples, from[1] + (to[1] - from[1]) * index / samples], 5000);
    if (useNavView.getState().arrived) return;
  }
}

describe('bounded walking navigation route replays', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T04:00:00Z'));
    stopRealNavigation();
    vi.clearAllMocks();
  });
  afterEach(() => {
    stopRealNavigation();
    vi.useRealTimers();
  });

  it('parallel return leg: lateral GPS drift cannot skip to a later route leg', async () => {
    await start([[0, 0], [0.002, 0], [0.002, 0.00015], [0, 0.00015], [0, 0.002]]);
    emit([0.0008, 0], 45000);
    const before = useNavView.getState().remainingM!;
    emit([0.00082, 0.00012]);
    expect(useNavView.getState().next?.stepIdx).toBe(1);
    expect(useNavView.getState().remainingM).toBeGreaterThan(before - 10);
    expect(useNavView.getState().arrived).toBe(false);
  });

  it('self-crossing: the second intersection cannot rewind progress to the first crossing', async () => {
    const path: Point[] = [[-0.001, -0.001], [0.001, 0.001], [0.001, -0.001], [-0.001, 0.001], [0.002, 0.001]];
    await start(path);
    walkSegment(path[0], path[1]);
    walkSegment(path[1], path[2]);
    walkSegment(path[2], [0.00005, -0.00005]);
    const before = useNavView.getState().remainingM!;
    emit([0, 0], 6000);
    expect(useNavView.getState().remainingM).toBeLessThan(before + 3);
    expect(useNavView.getState().next?.stepIdx).toBe(3);
    expect(useNavView.getState().arrived).toBe(false);
  });

  it('destination spike: two impossible fixes cannot claim arrival or ratchet route progress', async () => {
    await start([[0, 0], [0.001, 0], [0.001, 0.001], [0.002, 0.001]]);
    emit([0.0002, 0], 20000);
    const before = useNavView.getState().remainingM!;
    emit([0.002, 0.001]);
    emit([0.002, 0.001]);
    expect(useNavView.getState()).toMatchObject({ arrived: false, next: null });
    expect(useNavView.getState().remainingM).toBeGreaterThanOrEqual(before - 3);
    expect(haptics.play).not.toHaveBeenCalledWith('arrive');
    emit([0.00021, 0]);
    expect(useNavView.getState().next?.stepIdx).toBe(1);
    expect(useNavView.getState().arrived).toBe(false);
  });

  it('multi-turn spike: a single GPS jump cannot bypass two junctions', async () => {
    await start([[0, 0], [0.001, 0], [0.001, 0.001], [0.002, 0.001]]);
    emit([0.0002, 0], 20000);
    emit([0.0018, 0.001]);
    expect(useNavView.getState()).toMatchObject({ arrived: false, next: null });
    emit([0.00022, 0]);
    expect(useNavView.getState().next?.stepIdx).toBe(1);
  });

  it('nearby entrance across a loop: proximity alone cannot end an unwalked route', async () => {
    await start([[0, 0], [0.002, 0], [0.002, 0.0001], [0, 0.0001]]);
    expect(useNavView.getState().arrived).toBe(false);
    expect(useNavView.getState().remainingM).toBeGreaterThan(400);
    expect(haptics.play).not.toHaveBeenCalledWith('arrive');
  });

  it('intentional backtracking: a plausible reverse walk is still reflected in remaining distance', async () => {
    await start([[0, 0], [0.002, 0], [0.002, 0.001]]);
    emit([0.0008, 0], 45000);
    const before = useNavView.getState().remainingM!;
    emit([0.0007, 0], 10000);
    expect(useNavView.getState().remainingM).toBeGreaterThan(before + 8);
    expect(useNavView.getState().next?.stepIdx).toBe(1);
  });

  it('valid walking: continuous samples still reach the entrance and announce arrival once', async () => {
    const path: Point[] = [[0, 0], [0.001, 0], [0.001, 0.001], [0.002, 0.001]];
    await start(path);
    for (let index = 1; index < path.length; index++) walkSegment(path[index - 1], path[index]);
    expect(useNavView.getState().arrived).toBe(true);
    expect(vi.mocked(haptics.play).mock.calls.filter(([kind]) => kind === 'arrive')).toHaveLength(1);
  });
});
