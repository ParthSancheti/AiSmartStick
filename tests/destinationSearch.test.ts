import { describe, test, expect, beforeEach, vi } from 'vitest';

const { svc, browser } = vi.hoisted(() => {
  const svc = {
    autocomplete: vi.fn(),
    placeDetails: vi.fn(),
    searchPlaces: vi.fn(),
    walkingRoute: vi.fn(),
  };
  const latLng = (lat: number, lng: number) => ({ lat: () => lat, lng: () => lng });
  const place = (id: string, name: string, lat: number, lng: number) => ({ id, displayName: name, formattedAddress: `${name} Road`, location: latLng(lat, lng), primaryType: 'hair_salon', fetchFields: vi.fn(async () => undefined) });
  const browser = {
    latLng,
    place,
    fetchAutocompleteSuggestions: vi.fn(),
    searchByText: vi.fn(),
    route: vi.fn(),
    placesFails: null as Error | null,
    lastPlaceId: null as string | null,
  };
  return { svc, browser };
});

vi.mock('../src/core/maps/mapsService', async (orig) => {
  const actual = await orig<typeof import('../src/core/maps/mapsService')>();
  return { ...actual, ...svc };
});

vi.mock('../src/core/maps/mapsLoader', async (orig) => {
  const actual = await orig<typeof import('../src/core/maps/mapsLoader')>();
  class Place {
    id: string;
    displayName = 'Looked up';
    formattedAddress = 'Somewhere';
    location = browser.latLng(19, 73);
    primaryType = null;
    constructor(o: { id: string }) {
      this.id = o.id;
      browser.lastPlaceId = o.id;
    }
    fetchFields = vi.fn(async () => undefined);
    static searchByText = browser.searchByText;
  }
  return {
    ...actual,
    loadPlacesLibrary: vi.fn(async () => {
      if (browser.placesFails) throw browser.placesFails;
      return { AutocompleteSuggestion: { fetchAutocompleteSuggestions: browser.fetchAutocompleteSuggestions }, AutocompleteSessionToken: class {}, Place } as never;
    }),
    loadRoutesLibrary: vi.fn(async () => ({ DirectionsService: class { route = browser.route; } }) as never),
  };
});

import { suggestDestinations, resolveDestination, findPlaces, routeWalking, MapsUnavailableError, searchBias, serverBackoffMs, __resetDestinationSearchForTests } from '../src/core/maps/destinationSearch';
import { useLocation } from '../src/core/location/locationService';

const fnErr = (code: string, message = code) => Object.assign(new Error(message), { code: `functions/${code}` });

beforeEach(() => {
  vi.clearAllMocks();
  __resetDestinationSearchForTests();
  browser.placesFails = null;
  useLocation.setState({ fix: null });
  browser.fetchAutocompleteSuggestions.mockResolvedValue({
    suggestions: [
      {
        placePrediction: {
          placeId: 'pl_b1',
          mainText: { text: 'Boys Hair Salon' },
          secondaryText: { text: 'MG Road, Nashik' },
          text: { text: 'Boys Hair Salon, MG Road' },
          distanceMeters: 420,
          toPlace: () => browser.place('pl_b1', 'Boys Hair Salon', 20.0, 73.79),
        },
      },
    ],
  });
});

describe('destination search works without GPS and without the Cloud Function', () => {
  test('server answers: its suggestions, no browser call; no GPS → no lat/lng sent', async () => {
    svc.autocomplete.mockResolvedValue({ suggestions: [{ placeId: 'p1', main: 'City Hospital', secondary: 'Nashik' }] });
    const r = await suggestDestinations('city hos', 'tok');
    expect(r.source).toBe('server');
    expect(r.suggestions[0]).toMatchObject({ placeId: 'p1', source: 'server' });
    expect(svc.autocomplete).toHaveBeenCalledWith('city hos', null, null, 'tok');
    expect(browser.fetchAutocompleteSuggestions).not.toHaveBeenCalled();
  });

  test('uses the last known position (any age) only as a bias', async () => {
    useLocation.setState({ fix: { lat: 20.01, lng: 73.79, accuracyM: 30, altitude: null, speedMps: null, headingDeg: null, ts: Date.now() - 3_600_000 } });
    expect(searchBias()).toEqual({ lat: 20.01, lng: 73.79 });
    svc.autocomplete.mockResolvedValue({ suggestions: [] });
    await suggestDestinations('barber', 'tok');
    expect(svc.autocomplete).toHaveBeenCalledWith('barber', 20.01, 73.79, 'tok');
  });

  test('Cloud Function refused (App Check) → in-app Google Places; server skipped for a while', async () => {
    svc.autocomplete.mockRejectedValue(fnErr('unauthenticated'));
    const r = await suggestDestinations('barber', 'tok');
    expect(r.source).toBe('browser');
    expect(r.suggestions).toEqual([{ placeId: 'pl_b1', main: 'Boys Hair Salon', secondary: 'MG Road, Nashik', source: 'browser', distanceM: 420 }]);
    const req = browser.fetchAutocompleteSuggestions.mock.calls[0][0];
    expect(req).toMatchObject({ input: 'barber', includedRegionCodes: ['in'] });
    expect(req.locationBias).toBeUndefined(); // no GPS: India-wide
    await suggestDestinations('barbe', 'tok');
    expect(svc.autocomplete).toHaveBeenCalledTimes(1); // backed off, straight to the browser
  });

  test('a transient server error is retried next time (no backoff)', async () => {
    svc.autocomplete.mockRejectedValueOnce(fnErr('unavailable')).mockResolvedValueOnce({ suggestions: [] });
    await suggestDestinations('barber', 'tok');
    await suggestDestinations('barbers', 'tok');
    expect(svc.autocomplete).toHaveBeenCalledTimes(2);
  });

  test('both fail → one error naming both causes (never a silent empty list)', async () => {
    svc.autocomplete.mockRejectedValue(fnErr('not-found', 'NOT FOUND'));
    browser.placesFails = new Error('PlacesApiNotEnabled');
    const e = await suggestDestinations('barber', 'tok').catch((x) => x);
    expect(e).toBeInstanceOf(MapsUnavailableError);
    expect(e.message).toMatch(/not deployed/);
    expect(e.message).toMatch(/Places API \(New\)/);
  });

  test('a browser suggestion resolves through the same autocomplete session (toPlace)', async () => {
    svc.autocomplete.mockRejectedValue(fnErr('unauthenticated'));
    const [s] = (await suggestDestinations('barber', 'tok')).suggestions;
    const p = await resolveDestination(s, 'tok');
    expect(svc.placeDetails).not.toHaveBeenCalled();
    expect(p).toMatchObject({ placeId: 'pl_b1', name: 'Boys Hair Salon', lat: 20, lng: 73.79 });
  });

  test('server place lookup failing falls back to Place.fetchFields', async () => {
    svc.placeDetails.mockRejectedValue(fnErr('internal'));
    const p = await resolveDestination({ placeId: 'pl_x', source: 'server' }, 'tok');
    expect(browser.lastPlaceId).toBe('pl_x');
    expect(p).toMatchObject({ placeId: 'pl_x', lat: 19, lng: 73 });
  });

  test('assistant search: server down → Place.searchByText, nearest first with a bias', async () => {
    svc.searchPlaces.mockRejectedValue(fnErr('failed-precondition'));
    browser.searchByText.mockResolvedValue({ places: [browser.place('far', 'Far Salon', 20.05, 73.79), browser.place('near', 'Near Salon', 20.011, 73.79)] });
    const r = await findPlaces({ category: 'salon', bias: { lat: 20.01, lng: 73.79 } });
    expect(r.source).toBe('browser');
    expect(r.places.map((p) => p.placeId)).toEqual(['near', 'far']);
    expect(browser.searchByText.mock.calls[0][0]).toMatchObject({ textQuery: 'hair salon', region: 'in' });
  });

  test('assistant search without any position: server gets no lat/lng', async () => {
    svc.searchPlaces.mockResolvedValue({ places: [] });
    const r = await findPlaces({ query: 'City Hospital', bias: null });
    expect(svc.searchPlaces.mock.calls[0][0]).toMatchObject({ query: 'City Hospital', lat: null, lng: null });
    expect(r.biased).toBe(false);
  });
});

describe('walking route fallback', () => {
  const dest = { placeId: 'pl_b1', name: 'Boys Hair Salon', lat: 20.0, lng: 73.79, address: null, distanceM: null, openNow: null, primaryType: null };

  test('server route when it works', async () => {
    svc.walkingRoute.mockResolvedValue({ distanceM: 400, durationS: 300, path: [[0, 0]], steps: [] });
    const r = await routeWalking({ lat: 20.01, lng: 73.79 }, dest);
    expect(r.distanceM).toBe(400);
    expect(svc.walkingRoute).toHaveBeenCalledWith({ origin: { lat: 20.01, lng: 73.79 }, destination: { placeId: 'pl_b1' } });
    expect(browser.route).not.toHaveBeenCalled();
  });

  test('server down → Maps JS DirectionsService (WALKING), instructions without HTML', async () => {
    svc.walkingRoute.mockRejectedValue(fnErr('unauthenticated'));
    browser.route.mockResolvedValue({
      routes: [
        {
          overview_path: [browser.latLng(20.01, 73.79), browser.latLng(20.0, 73.79)],
          legs: [
            {
              distance: { value: 1100 },
              duration: { value: 840 },
              steps: [{ instructions: 'Head <b>south</b> on <b>MG Rd</b><div style="x">Pass by the bank</div>', maneuver: 'turn-left', distance: { value: 1100 }, duration: { value: 840 }, start_location: browser.latLng(20.01, 73.79), end_location: browser.latLng(20.0, 73.79) }],
            },
          ],
        },
      ],
    });
    const r = await routeWalking({ lat: 20.01, lng: 73.79 }, dest);
    expect(browser.route.mock.calls[0][0]).toMatchObject({ travelMode: 'WALKING', destination: { placeId: 'pl_b1' } });
    expect(r).toMatchObject({ distanceM: 1100, durationS: 840, path: [[20.01, 73.79], [20.0, 73.79]] });
    expect(r.steps[0].instruction).toBe('Head south on MG Rd. Pass by the bank');
    expect(r.steps[0].maneuver).toBe('TURN_LEFT');
  });

  test('a real "no walking route" answer is not retried elsewhere', async () => {
    svc.walkingRoute.mockRejectedValue(fnErr('not-found', 'No walking route found.'));
    await expect(routeWalking({ lat: 20.01, lng: 73.79 }, dest)).rejects.toThrow('no-route');
    expect(browser.route).not.toHaveBeenCalled();
  });

  test('saved places without a place id route to the exact coordinates', async () => {
    svc.walkingRoute.mockResolvedValue({ distanceM: 1, durationS: 1, path: [[0, 0]], steps: [] });
    await routeWalking({ lat: 20.01, lng: 73.79 }, { ...dest, placeId: '' });
    expect(svc.walkingRoute.mock.calls[0][0].destination).toEqual({ lat: 20.0, lng: 73.79 });
  });
});

describe('server backoff', () => {
  test('a slow answer (cold start) skips the server only briefly; setup errors skip it for minutes', () => {
    expect(serverBackoffMs(Object.assign(new Error('Server search timed out'), { code: 'deadline-exceeded' }))).toBe(30_000);
    expect(serverBackoffMs(fnErr('internal'))).toBe(30_000);
    for (const c of ['unauthenticated', 'permission-denied', 'failed-precondition']) expect(serverBackoffMs(fnErr(c))).toBe(5 * 60_000);
    expect(serverBackoffMs(fnErr('not-found', 'Function not found'))).toBe(5 * 60_000);
    expect(serverBackoffMs(fnErr('not-found', 'Place not found.'))).toBe(0);
    expect(serverBackoffMs(fnErr('invalid-argument'))).toBe(0);
  });
});
