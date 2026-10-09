import { describe, test, expect, beforeEach, vi } from 'vitest';
import { executeAction } from '../src/core/ai/executor';
import { useNavView } from '../src/core/navigation/navView';
import { useLocation } from '../src/core/location/locationService';
import { useDevice } from '../src/core/store/device';

vi.mock('../src/core/maps/mapsService', () => ({
  walkingRoute: vi.fn().mockResolvedValue({
    distanceM: 500,
    durationS: 300,
    path: [[0, 0], [0.001, 0]],
    steps: [{ instruction: 'Head North', distanceM: 500, maneuver: 'straight' }]
  }),
  searchPlaces: vi.fn().mockResolvedValue({
    places: [{ placeId: '123', name: 'Barber Shop', lat: 0.005, lng: 0.005, openNow: true, primaryType: 'store' }]
  }),
  reverseLookup: vi.fn(),
}));

vi.mock('../src/core/native/aissNative', () => ({
  AissNative: {
    startBackgroundService: vi.fn().mockResolvedValue({ running: true }),
    stopBackgroundService: vi.fn().mockResolvedValue({ running: false }),
  }
}));

describe('Hands-Free Navigation Flow', () => {
  beforeEach(() => {
    useNavView.setState({ active: false, state: 'IDLE' });
    useLocation.setState({ fix: { lat: 0, lng: 0, accuracyM: 5, ts: Date.now() }, status: 'ok' });
    useDevice.setState({ internet: true });
  });

  test('Voice search and confirmation starts navigation in background', async () => {
    const searchRes = await executeAction({ 
      id: '1', 
      name: 'find_nearest_place', 
      type: 'navigation.findNearestPlace',
      arguments: { category: 'salon', query: 'barber' }
    });
    
    if (!searchRes.ok) console.log(searchRes.error);
    expect(searchRes.ok).toBe(true);
    // The best open match is OFFERED; start_navigation without a placeId uses exactly that offer.
    expect((searchRes as any).data.offered.placeId).toBe('123');

    const startRes = await executeAction({
      id: '2',
      name: 'start_navigation',
      type: 'navigation.startNavigation',
      arguments: {}
    });

    expect(startRes.ok).toBe(true);
    
    const nav = useNavView.getState();
    expect(nav.active).toBe(true);
    expect(nav.state).toBe('NAVIGATING');
    expect(nav.destination?.placeId).toBe('123');
  });
});
