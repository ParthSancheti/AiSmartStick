import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The full search/route chain: Cloud Function and in-app Google race (hedged), OpenStreetMap is the
 * last resort, OSM ids never reach Google, and every failure is named honestly.
 */
const { svc, browser } = vi.hoisted(() => {
  const svc = { autocomplete: vi.fn(), placeDetails: vi.fn(), searchPlaces: vi.fn(), walkingRoute: vi.fn() };
  const latLng = (lat: number, lng: number) => ({ lat: () => lat, lng: () => lng });
  const place = (id: string, name: string, lat: number, lng: number) => ({ id, displayName: name, formattedAddress: `${name} Road`, location: latLng(lat, lng), primaryType: 'pharmacy', fetchFields: vi.fn(async () => undefined) });
  const browser = { latLng, place, fetchAutocompleteSuggestions: vi.fn(), searchByText: vi.fn(), route: vi.fn(), placeIds: [] as string[] };
  return { svc, browser };
});

vi.mock('../src/core/maps/mapsService', async (orig) => ({ ...(await orig<typeof import('../src/core/maps/mapsService')>()), ...svc }));
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
      browser.placeIds.push(o.id);
    }
    fetchFields = vi.fn(async () => undefined);
    static searchByText = browser.searchByText;
  }
  return {
    ...actual,
    loadPlacesLibrary: vi.fn(async () => ({ AutocompleteSuggestion: { fetchAutocompleteSuggestions: browser.fetchAutocompleteSuggestions }, AutocompleteSessionToken: class {}, Place }) as never),
    loadRoutesLibrary: vi.fn(async () => ({ DirectionsService: class { route = browser.route; } }) as never),
  };
});
vi.mock('../src/core/ai/voiceOut', () => ({ announce: vi.fn() }));
vi.mock('../src/core/feedback/haptics', () => ({ haptics: { play: vi.fn() } }));
vi.mock('../src/core/feedback/earcons', () => ({ earcon: vi.fn() }));
vi.mock('../src/core/navigation/stickHaptics', () => ({ stickNavCue: vi.fn() }));

const store = new Map<string, string>();
(globalThis as any).localStorage ??= { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };

import { suggestDestinations, resolveDestination, placeById, findPlaces, routeWalking, MapsUnavailableError, browserErrorText, shortGoogleMessage, searchErrorText, HEDGE_AFTER_MS, __resetDestinationSearchForTests } from '../src/core/maps/destinationSearch';
import { friendlyMapsError } from '../src/core/maps/mapsService';
import { __resetOsmForTests } from '../src/core/maps/osmFallback';
import { useLocation } from '../src/core/location/locationService';
import { useSession } from '../src/core/store/session';
import { startRealNavigation, stopRealNavigation, activeRouteProvider } from '../src/core/navigation/realNavigator';
import { useNavView } from '../src/core/navigation/navView';

const fnErr = (code: string, message = code) => Object.assign(new Error(message), { code: `functions/${code}` });
const never = () => new Promise<never>(() => {});
const later = <T,>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
/** Google's real wording for the user's field report. */
const PLACES_OFF = 'PERMISSION_DENIED: Places API (New) has not been used in project 599970506387 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/places.googleapis.com/overview?project=599970506387 then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.';
const LEGACY_OFF = Object.assign(new Error("DIRECTIONS_ROUTE: REQUEST_DENIED: You're calling a legacy API, which is not enabled for your project. To get newer features and more functionality, switch to the Places API (New) or Routes API. Learn more: https://developers.google.com/maps/legacy#LegacyApiNotActivatedMapError"), { code: 'REQUEST_DENIED' });

const photon = (...f: { id: number; name: string; lat: number; lng: number; key?: string; value?: string }[]) => ({
  type: 'FeatureCollection',
  features: f.map((x) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [x.lng, x.lat] }, properties: { osm_type: 'N', osm_id: x.id, osm_key: x.key ?? 'amenity', osm_value: x.value ?? 'pharmacy', name: x.name, street: 'MG Road', city: 'Nashik', state: 'Maharashtra' } })),
});
const osrm = {
  code: 'Ok',
  routes: [
    {
      distance: 380,
      duration: 274,
      geometry: { coordinates: [[73.79, 20.01], [73.79, 20.005], [73.789, 20.005]] },
      legs: [
        {
          steps: [
            { distance: 300, duration: 216, name: 'MG Road', driving_side: 'left', geometry: { coordinates: [[73.79, 20.01], [73.79, 20.005]] }, maneuver: { type: 'depart', location: [73.79, 20.01], bearing_after: 180 } },
            { distance: 80, duration: 58, name: 'Station Road', driving_side: 'left', geometry: { coordinates: [[73.79, 20.005], [73.789, 20.005]] }, maneuver: { type: 'turn', modifier: 'right', location: [73.79, 20.005] } },
            { distance: 0, duration: 0, name: '', driving_side: 'left', geometry: { coordinates: [[73.789, 20.005], [73.789, 20.005]] }, maneuver: { type: 'arrive', location: [73.789, 20.005] } },
          ],
        },
      ],
    },
  ],
};
const ok = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });
let fetchMock: ReturnType<typeof vi.fn>;
const osmUrls = () => fetchMock.mock.calls.map((c) => String(c[0]));
const here = { lat: 20.01, lng: 73.79 };
const freshFix = () => ({ lat: 20.01, lng: 73.79, accuracyM: 8, altitude: null, speedMps: null, headingDeg: null, ts: Date.now() });

beforeEach(() => {
  vi.clearAllMocks();
  for (const f of [svc.autocomplete, svc.placeDetails, svc.searchPlaces, svc.walkingRoute, browser.fetchAutocompleteSuggestions, browser.searchByText, browser.route]) f.mockReset();
  browser.placeIds = [];
  __resetDestinationSearchForTests();
  __resetOsmForTests();
  stopRealNavigation('user');
  useLocation.setState({ fix: null });
  fetchMock = vi.fn(async (url: string) => (String(url).includes('routed-foot') ? ok(osrm) : ok(photon({ id: 11, name: 'Apollo Pharmacy', lat: 20.005, lng: 73.79 }))));
  vi.stubGlobal('fetch', fetchMock);
  browser.fetchAutocompleteSuggestions.mockResolvedValue({ suggestions: [{ placePrediction: { placeId: 'pl_g1', mainText: { text: 'Google Place' }, secondaryText: { text: 'Nashik' }, distanceMeters: 300, toPlace: () => browser.place('pl_g1', 'Google Place', 20, 73.79) } }] });
});
afterEach(() => vi.useRealTimers());

describe('hedged: server first, in-app Google joins after 3.5 s, first success wins', () => {
  test('server answers in 2 s → the in-app search is never started', async () => {
    vi.useFakeTimers();
    svc.autocomplete.mockImplementation(() => later(2000, { suggestions: [{ placeId: 'p1', main: 'City Hospital', secondary: null }] }));
    const p = suggestDestinations('city hos', 'tok');
    await vi.advanceTimersByTimeAsync(2000);
    expect((await p).source).toBe('server');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(browser.fetchAutocompleteSuggestions).not.toHaveBeenCalled();
  });

  test('server silent → the in-app search starts at 3.5 s (not before) and wins', async () => {
    vi.useFakeTimers();
    svc.autocomplete.mockImplementation(never);
    const p = suggestDestinations('google', 'tok');
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS - 1);
    expect(browser.fetchAutocompleteSuggestions).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(r.source).toBe('browser');
    expect(r.suggestions[0].placeId).toBe('pl_g1');
  });

  test('in-app fails first → keeps waiting for the slow server, which wins (no OSM)', async () => {
    vi.useFakeTimers();
    svc.autocomplete.mockImplementation(() => later(12_000, { suggestions: [{ placeId: 'p2', main: 'Late but good', secondary: null }] }));
    browser.fetchAutocompleteSuggestions.mockRejectedValue(new Error(PLACES_OFF));
    let r: Awaited<ReturnType<typeof suggestDestinations>> | undefined;
    void suggestDestinations('late', 'tok').then((x) => (r = x));
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
    expect(browser.fetchAutocompleteSuggestions).toHaveBeenCalledTimes(1);
    expect(r).toBeUndefined();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(r).toMatchObject({ source: 'server', suggestions: [{ placeId: 'p2' }] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a server failure starts the in-app search at once (no 3.5 s wait)', async () => {
    vi.useFakeTimers();
    svc.autocomplete.mockRejectedValue(fnErr('unauthenticated'));
    const p = suggestDestinations('google', 'tok');
    await vi.advanceTimersByTimeAsync(0);
    expect((await p).source).toBe('browser');
  });

  test('findPlaces and routeWalking are hedged the same way', async () => {
    vi.useFakeTimers();
    svc.searchPlaces.mockImplementation(never);
    svc.walkingRoute.mockImplementation(never);
    browser.searchByText.mockResolvedValue({ places: [browser.place('pl_s', 'Shop', 20.0, 73.79)] });
    browser.route.mockResolvedValue({ routes: [{ overview_path: [browser.latLng(20.01, 73.79), browser.latLng(20, 73.79)], legs: [{ distance: { value: 1100 }, duration: { value: 800 }, steps: [] }] }] });
    const f = findPlaces({ query: 'shop', bias: here });
    const w = routeWalking(here, { placeId: 'pl_s', name: 'Shop', lat: 20, lng: 73.79, address: null, distanceM: null, openNow: null, primaryType: null });
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
    expect((await f).source).toBe('browser');
    expect((await w).distanceM).toBe(1100);
  });
});

describe('OpenStreetMap only when both Google paths fail', () => {
  test("the user's field report: server times out (20 s), Places API (New) off → OSM suggestions, honest causes", async () => {
    vi.useFakeTimers();
    svc.autocomplete.mockImplementation(never);
    browser.fetchAutocompleteSuggestions.mockRejectedValue(new Error(PLACES_OFF));
    const p = suggestDestinations('apollo', 'tok', here);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(fetchMock).not.toHaveBeenCalled(); // still waiting for the server
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(r.source).toBe('osm');
    expect(r.suggestions[0]).toMatchObject({ placeId: 'osm:N11', main: 'Apollo Pharmacy', source: 'osm' });
    expect(osmUrls()[0]).toContain('photon.komoot.io/api/');
  });

  test('everything down → one error with each cause, Google message shortened, the exact fix', async () => {
    vi.useFakeTimers();
    svc.autocomplete.mockImplementation(never);
    browser.fetchAutocompleteSuggestions.mockRejectedValue(new Error(PLACES_OFF));
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const p = suggestDestinations('apollo', 'tok').catch((e) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    const e = await p;
    expect(e).toBeInstanceOf(MapsUnavailableError);
    expect(e.message).toContain('Server search: The server did not answer in 20 s (slow first start, App Check, or functions not deployed).');
    expect(e.message).not.toContain('Could not reach the server');
    expect(e.message).toContain('In-app search: Google Maps in the app refused the search (Places API (New) is not enabled in project 599970506387).');
    expect(e.message).toContain("Fix: Google Cloud → APIs & Services → enable Places API (New), and allow it in the browser key's API restrictions (see docs/GOOGLE_CLOUD_SETUP.md, 2 Enable APIs / 3 Browser key).");
    expect(e.message).not.toContain('https://');
    expect(e.message).toContain('OpenStreetMap: OpenStreetMap search could not be reached');
    expect(searchErrorText(e)).toMatch(/^Search unavailable\. Server search: /);
  });

  test('after that, the server and the refused in-app API are skipped: straight to OSM', async () => {
    vi.useFakeTimers();
    svc.autocomplete.mockImplementation(never);
    browser.fetchAutocompleteSuggestions.mockRejectedValue(new Error(PLACES_OFF));
    const p = suggestDestinations('apollo', 'tok');
    await vi.advanceTimersByTimeAsync(20_000);
    await p;
    svc.autocomplete.mockClear();
    browser.fetchAutocompleteSuggestions.mockClear();
    const q = suggestDestinations('apollo ph', 'tok');
    await vi.advanceTimersByTimeAsync(600); // Photon throttle
    expect((await q).source).toBe('osm');
    expect(svc.autocomplete).not.toHaveBeenCalled();
    expect(browser.fetchAutocompleteSuggestions).not.toHaveBeenCalled();
  });

  test('a repeated server timeout doubles the pause (30 s, then 60 s)', async () => {
    vi.useFakeTimers();
    svc.autocomplete.mockImplementation(never);
    browser.fetchAutocompleteSuggestions.mockRejectedValue(new Error('boom'));
    const first = suggestDestinations('one', 'tok');
    await vi.advanceTimersByTimeAsync(20_000);
    await first;
    await vi.advanceTimersByTimeAsync(30_000); // pause over: tried again, times out again
    const second = suggestDestinations('two', 'tok');
    await vi.advanceTimersByTimeAsync(20_000);
    await second;
    expect(svc.autocomplete).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(45_000); // still inside the 60 s pause
    const third = suggestDestinations('three', 'tok');
    await vi.advanceTimersByTimeAsync(600);
    await third;
    expect(svc.autocomplete).toHaveBeenCalledTimes(2);
  });

  test('two letters: Google failed and OSM needs three → the error says so', async () => {
    svc.autocomplete.mockRejectedValue(fnErr('unauthenticated'));
    browser.fetchAutocompleteSuggestions.mockRejectedValue(new Error('boom'));
    const e = await suggestDestinations('ab', 'tok').catch((x) => x);
    expect(e.message).toContain('Type 3 or more letters to search OpenStreetMap.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('findPlaces: server → in-app → OSM (category tags, nearest first)', async () => {
    svc.searchPlaces.mockRejectedValue(fnErr('failed-precondition'));
    browser.searchByText.mockRejectedValue(new Error(PLACES_OFF));
    fetchMock.mockResolvedValueOnce(ok(photon({ id: 1, name: 'Far Pharmacy', lat: 20.05, lng: 73.79 }, { id: 2, name: 'Near Chemist', lat: 20.011, lng: 73.79, key: 'shop', value: 'chemist' })));
    const r = await findPlaces({ category: 'pharmacy', bias: here });
    expect(r).toMatchObject({ source: 'osm', biased: true });
    expect(r.places.map((p) => p.placeId)).toEqual(['osm:N2', 'osm:N1']);
    expect(osmUrls()[0]).toContain('osm_tag=amenity%3Apharmacy');
  });

  test('"take me home" without the server uses the saved point, never OSM', async () => {
    svc.searchPlaces.mockRejectedValue(fnErr('unauthenticated'));
    const person = useSession.getState().person;
    useSession.setState({ person: { ...person, savedPlaces: [{ id: 'home', label: 'Home', placeId: 'osm:W77', name: 'Home', address: 'MG Road', lat: 20.0, lng: 73.78, updatedAt: 1 }] } as never });
    const r = await findPlaces({ category: 'home', bias: null });
    expect(r.places[0]).toMatchObject({ placeId: 'osm:W77', primaryType: 'home' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(browser.searchByText).not.toHaveBeenCalled();
    useSession.setState({ person });
  });
});

describe('OSM place ids never reach Google', () => {
  async function osmSuggestion() {
    svc.autocomplete.mockRejectedValue(fnErr('unauthenticated'));
    browser.fetchAutocompleteSuggestions.mockRejectedValue(new Error(PLACES_OFF));
    const r = await suggestDestinations('apollo', 'tok', here);
    expect(r.source).toBe('osm');
    return r.suggestions[0];
  }

  test('picking an OSM suggestion comes from the cache', async () => {
    const s = await osmSuggestion();
    const p = await resolveDestination(s, 'tok');
    expect(p).toMatchObject({ placeId: 'osm:N11', name: 'Apollo Pharmacy', lat: 20.005, lng: 73.79 });
    expect(svc.placeDetails).not.toHaveBeenCalled();
    expect(browser.placeIds).toEqual([]);
  });

  test("the assistant's placeById('osm:…'): cache, or a clear error — no Google call", async () => {
    await osmSuggestion();
    expect((await placeById('osm:N11')).name).toBe('Apollo Pharmacy');
    const e = await placeById('osm:N999').catch((x) => x);
    expect(e).toBeInstanceOf(MapsUnavailableError);
    expect(e.message).toMatch(/Search for it again/);
    expect(svc.placeDetails).not.toHaveBeenCalled();
    expect(browser.placeIds).toEqual([]);
  });

  test('an OSM place is routed by lat/lng on every path', async () => {
    const osmPlace = { placeId: 'osm:N11', name: 'Apollo Pharmacy', lat: 20.005, lng: 73.79, address: null, distanceM: null, openNow: null, primaryType: 'pharmacy' };
    svc.walkingRoute.mockRejectedValue(fnErr('unauthenticated'));
    browser.route.mockRejectedValue(LEGACY_OFF);
    const r = await routeWalking(here, osmPlace);
    expect(svc.walkingRoute.mock.calls[0][0].destination).toEqual({ lat: 20.005, lng: 73.79 });
    expect(browser.route.mock.calls[0][0].destination).toEqual({ lat: 20.005, lng: 73.79 });
    expect(osmUrls()[0]).toContain('/73.790000,20.010000;73.790000,20.005000?');
    expect(r.provider).toBe('osm');
  });
});

describe('walking routes: legacy Directions refused → OSM; a real no-route stays no-route', () => {
  const dest = { placeId: 'pl_b1', name: 'Boys Hair Salon', lat: 20.005, lng: 73.789, address: null, distanceM: null, openNow: null, primaryType: null };

  test('REQUEST_DENIED (legacy API not enabled) → OSRM route with readable steps; Directions then skipped', async () => {
    svc.walkingRoute.mockRejectedValue(fnErr('unauthenticated'));
    browser.route.mockRejectedValue(LEGACY_OFF);
    const r = await routeWalking(here, dest);
    expect(r).toMatchObject({ provider: 'osm', distanceM: 380, durationS: 274 });
    expect(r.steps.map((s) => s.instruction)).toEqual(['Head south on MG Road', 'Turn right onto Station Road', 'Arrive at your destination']);
    expect(r.steps.map((s) => s.maneuver)).toEqual(['DEPART', 'TURN_RIGHT', null]);
    await routeWalking(here, dest);
    expect(browser.route).toHaveBeenCalledTimes(1);
  });

  test.each(['LegacyApiNotActivatedMapError', 'ApiNotActivatedMapError', 'This API project is not authorized to use this API.'])('"%s" → OSM', async (msg) => {
    svc.walkingRoute.mockRejectedValue(fnErr('permission-denied'));
    browser.route.mockRejectedValue(new Error(msg));
    expect((await routeWalking(here, dest)).provider).toBe('osm');
  });

  test('Google ZERO_RESULTS is a real "no route": OSM is not asked', async () => {
    svc.walkingRoute.mockRejectedValue(fnErr('unauthenticated'));
    browser.route.mockRejectedValue(Object.assign(new Error('DIRECTIONS_ROUTE: ZERO_RESULTS: No route could be found between the origin and destination.'), { code: 'ZERO_RESULTS' }));
    await expect(routeWalking(here, dest)).rejects.toThrow('no-route');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('OSM says NoRoute → no-route', async () => {
    svc.walkingRoute.mockRejectedValue(fnErr('unauthenticated'));
    browser.route.mockRejectedValue(LEGACY_OFF);
    fetchMock.mockResolvedValueOnce(ok({ code: 'NoRoute', message: 'Impossible route' }, 400));
    await expect(routeWalking(here, dest)).rejects.toThrow('no-route');
  });

  test('all three fail → causes, with the legacy Directions explained', async () => {
    svc.walkingRoute.mockRejectedValue(fnErr('unauthenticated'));
    browser.route.mockRejectedValue(LEGACY_OFF);
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const e = await routeWalking(here, dest).catch((x) => x);
    expect(e).toBeInstanceOf(MapsUnavailableError);
    expect(e.message).toContain('In-app route: In-app walking directions are not available for this Google project');
    expect(e.message).toContain('OpenStreetMap route: OpenStreetMap route could not be reached');
  });

  test('the navigator follows an OSM route and knows to show the OSM attribution', async () => {
    useLocation.setState({ fix: freshFix() });
    svc.walkingRoute.mockRejectedValue(fnErr('unauthenticated'));
    browser.route.mockRejectedValue(LEGACY_OFF);
    await startRealNavigation(dest);
    expect(activeRouteProvider()).toBe('osm');
    // Walking the first step (south on MG Road): the next instruction is the OSM turn, read as a right turn.
    expect(useNavView.getState().next).toMatchObject({ text: 'Turn right onto Station Road', maneuver: 'right' });
    expect(useNavView.getState().path.length).toBe(3);
    stopRealNavigation('user');
    expect(activeRouteProvider()).toBeNull();
  });
});

describe('error words', () => {
  test('client-side timeouts are not called "could not reach"', () => {
    expect(friendlyMapsError(fnErr('deadline-exceeded', 'deadline-exceeded'))).toBe('The server did not answer in time (slow first start, App Check, or functions not deployed).');
    expect(friendlyMapsError(Object.assign(new Error('The server did not answer in 20 s (slow first start, App Check, or functions not deployed).'), { code: 'deadline-exceeded' }))).toMatch(/did not answer in 20 s/);
    expect(friendlyMapsError(fnErr('unavailable'))).toBe('Could not reach the server. Check the internet connection.');
    expect(friendlyMapsError(fnErr('unavailable', 'Maps request failed (403).'))).toMatch(/Google Maps refused the server's request \(HTTP 403\)/);
    // The function now sends Google's reason (and 'failed-precondition' for a refused key).
    const refused = fnErr('failed-precondition', 'Maps request failed (403). Google says: PERMISSION_DENIED: Places API (New) has not been used in project 599970506387 before or it is disabled. Enable it by visiting then retry.');
    expect(friendlyMapsError(refused)).toBe(
      "Google Maps refused the server's request (HTTP 403: Places API (New) has not been used in project 599970506387 before or it is disabled). Check MAPS_SERVER_KEY and the enabled APIs.",
    );
    expect(friendlyMapsError(fnErr('failed-precondition', 'Maps is not configured on the server.'))).toBe('Maps is not set up on the server (MAPS_SERVER_KEY). See docs/GOOGLE_CLOUD_SETUP.md, "4 Server key".');
    expect(friendlyMapsError(fnErr('internal', 'internal'))).toMatch(/could not be reached or failed/);
  });

  test("Google's long messages are shortened", () => {
    expect(shortGoogleMessage(PLACES_OFF)).toBe('Places API (New) is not enabled in project 599970506387');
    expect(shortGoogleMessage('API_KEY_SERVICE_BLOCKED: Requests to this API places.googleapis.com method x are blocked.')).toBe('the browser key is not allowed to use this API');
    expect(browserErrorText(new Error(PLACES_OFF))).toMatch(/^Google Maps in the app refused the search \(Places API \(New\) is not enabled in project 599970506387\)\. Fix: /);
    expect(browserErrorText(LEGACY_OFF, 'directions')).toMatch(/old Directions API cannot be turned on/);
  });
});
