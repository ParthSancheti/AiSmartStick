import { describe, test, expect, beforeEach, vi } from 'vitest';
import { startRealNavigation, stopRealNavigation, progressOnPath } from '../src/core/navigation/realNavigator';
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

});
