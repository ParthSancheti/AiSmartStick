import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const { native } = vi.hoisted(() => ({ native: { on: false, get: vi.fn() } }));

vi.mock('@capacitor/core', async (orig) => {
  const actual = await orig<typeof import('@capacitor/core')>();
  return {
    ...actual,
    Capacitor: { ...actual.Capacitor, isNativePlatform: () => native.on, isPluginAvailable: (n: string) => native.on && n === 'CapacitorHttp' },
    CapacitorHttp: { get: native.get },
  };
});

import { osmSearch, osmSuggest, osmRoute, osmPlaceById, osrmInstruction, osrmToRoute, photonToPlace, OSM_ATTRIBUTION, __resetOsmForTests } from '../src/core/maps/osmFallback';
import { maneuverFrom } from '../src/core/navigation/navView';

/** A Photon (photon.komoot.io) GeoJSON feature as the service sends it. */
const feature = (id: number, name: string | undefined, lat: number, lng: number, extra: Record<string, unknown> = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lng, lat] },
  properties: { osm_type: 'N', osm_id: id, osm_key: 'amenity', osm_value: 'pharmacy', name, housenumber: '12', street: 'MG Road', city: 'Nashik', state: 'Maharashtra', country: 'India', countrycode: 'IN', postcode: '422001', type: 'house', ...extra },
});
const collection = (...features: unknown[]) => ({ type: 'FeatureCollection', features });

/** A FOSSGIS OSRM foot-profile answer (overview=full, geometries=geojson, steps=true). */
const osrmAnswer = () => ({
  code: 'Ok',
  routes: [
    {
      distance: 412.3,
      duration: 296.8,
      weight_name: 'duration',
      geometry: { type: 'LineString', coordinates: [[73.79, 20.01], [73.7905, 20.008], [73.789, 20.006], [73.789, 20.005]] },
      legs: [
        {
          distance: 412.3,
          duration: 296.8,
          summary: 'MG Road, Station Road',
          steps: [
            { distance: 230.1, duration: 165.7, name: 'MG Road', mode: 'walking', driving_side: 'left', geometry: { type: 'LineString', coordinates: [[73.79, 20.01], [73.7905, 20.008]] }, maneuver: { type: 'depart', location: [73.79, 20.01], bearing_before: 0, bearing_after: 170 } },
            { distance: 150, duration: 108, name: 'Station Road', mode: 'walking', driving_side: 'left', geometry: { type: 'LineString', coordinates: [[73.7905, 20.008], [73.789, 20.006]] }, maneuver: { type: 'turn', modifier: 'left', location: [73.7905, 20.008], bearing_before: 170, bearing_after: 260 } },
            { distance: 32.2, duration: 23.1, name: '', mode: 'walking', driving_side: 'left', geometry: { type: 'LineString', coordinates: [[73.789, 20.006], [73.789, 20.005]] }, maneuver: { type: 'continue', modifier: 'straight', location: [73.789, 20.006] } },
            { distance: 0, duration: 0, name: '', mode: 'walking', driving_side: 'left', geometry: { type: 'LineString', coordinates: [[73.789, 20.005], [73.789, 20.005]] }, maneuver: { type: 'arrive', modifier: 'right', location: [73.789, 20.005] } },
          ],
        },
      ],
    },
  ],
  waypoints: [],
});

const answer = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
let fetchMock: ReturnType<typeof vi.fn>;
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  __resetOsmForTests();
  native.on = false;
  native.get.mockReset();
  fetchMock = vi.fn(async () => answer(collection()));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.useRealTimers());

describe('Photon results → PlaceResult', () => {
  test('id, name, address from housenumber/street/city/state, distance from the bias, type from osm_value', () => {
    const p = photonToPlace(feature(123, 'Apollo Pharmacy', 20.0, 73.79) as never, { lat: 20.01, lng: 73.79 });
    expect(p).toEqual({ placeId: 'osm:N123', name: 'Apollo Pharmacy', address: '12 MG Road, Nashik, Maharashtra', lat: 20.0, lng: 73.79, distanceM: 1112, openNow: null, primaryType: 'pharmacy' });
  });

  test('no name → the street line is the name; no bias → no distance; no coordinates → dropped', () => {
    const p = photonToPlace(feature(9, undefined, 20, 73, { osm_type: 'W' }) as never, null)!;
    expect(p.placeId).toBe('osm:W9');
    expect(p.name).toBe('12 MG Road');
    expect(p.address).toBe('Nashik, Maharashtra');
    expect(p.distanceM).toBeNull();
    expect(photonToPlace({ properties: { osm_type: 'N', osm_id: 1, name: 'x' } } as never, null)).toBeNull();
  });

  test('the attribution text OSM requires', () => {
    expect(OSM_ATTRIBUTION).toBe('© OpenStreetMap contributors');
  });
});

describe('osmSuggest / osmSearch (Photon)', () => {
  test('suggestions need 3 letters; without a position the search stays inside India', async () => {
    expect(await osmSuggest('ab', null)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(answer(collection(feature(1, 'City Hospital', 20, 73.78, { osm_value: 'hospital' }))));
    const s = await osmSuggest('city hos', null);
    expect(s).toEqual([{ placeId: 'osm:N1', main: 'City Hospital', secondary: '12 MG Road, Nashik, Maharashtra', distanceM: null }]);
    const u = new URL(urls()[0]);
    expect(u.origin + u.pathname).toBe('https://photon.komoot.io/api/');
    expect(u.searchParams.get('q')).toBe('city hos');
    expect(u.searchParams.get('bbox')).toBe('68.1,6.5,97.4,35.7');
    expect(u.searchParams.get('lang')).toBe('en');
    expect(u.searchParams.get('limit')).toBe('8');
    // Cached for the pick (never looked up at Google).
    expect(osmPlaceById('osm:N1')).toMatchObject({ name: 'City Hospital', lat: 20, lng: 73.78 });
    expect(osmPlaceById('osm:N404')).toBeNull();
  });

  test('with a position: lat/lon bias instead of the India box', async () => {
    await osmSuggest('barber', { lat: 20.01, lng: 73.79 });
    const u = new URL(urls()[0]);
    expect(u.searchParams.get('lat')).toBe('20.01000');
    expect(u.searchParams.get('lon')).toBe('73.79000');
    expect(u.searchParams.get('bbox')).toBeNull();
  });

  test('category near a position: tagged nearest search, only that kind of place, nearest first', async () => {
    fetchMock.mockResolvedValueOnce(
      answer(
        collection(
          feature(2, 'Far Medical', 20.03, 73.79),
          feature(3, 'Some House', 20.0101, 73.79, { osm_key: 'building', osm_value: 'house' }), // wrong kind: never offered
          feature(4, 'Near Chemist', 20.011, 73.79, { osm_key: 'shop', osm_value: 'chemist' }),
        ),
      ),
    );
    const r = await osmSearch('', { lat: 20.01, lng: 73.79 }, 3000, 'pharmacy');
    expect(r.map((p) => p.name)).toEqual(['Near Chemist', 'Far Medical']);
    const u = new URL(urls()[0]);
    expect(u.pathname).toBe('/reverse');
    expect(u.searchParams.getAll('osm_tag')).toEqual(['amenity:pharmacy', 'shop:chemist']);
    expect(u.searchParams.get('radius')).toBe('6');
  });

  test('nothing tagged nearby → tagged text search; categories map to the OSM tags', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(answer(collection())).mockResolvedValueOnce(answer(collection(feature(5, 'Central Bus Stand', 20.0, 73.78, { osm_key: 'amenity', osm_value: 'bus_station' }))));
    const p = osmSearch('', { lat: 20.01, lng: 73.79 }, 3000, 'bus_stop');
    await vi.advanceTimersByTimeAsync(600);
    const r = await p;
    expect(r[0]).toMatchObject({ placeId: 'osm:N5', primaryType: 'bus_station' });
    const u = new URL(urls()[1]);
    expect(u.pathname).toBe('/api/');
    expect(u.searchParams.get('q')).toBe('bus stop');
    expect(u.searchParams.getAll('osm_tag')).toEqual(['highway:bus_stop', 'amenity:bus_station']);
  });

  test.each([
    ['hospital', 'amenity:hospital'],
    ['atm', 'amenity:atm'],
    ['police', 'amenity:police'],
    ['cafe', 'amenity:cafe'],
    ['restaurant', 'amenity:restaurant'],
    ['train_station', 'railway:station'],
    ['supermarket', 'shop:supermarket'],
    ['mall', 'shop:mall'],
    ['salon', 'shop:hairdresser'],
  ])('category %s → osm_tag %s', async (category, tag) => {
    await osmSearch('', null, 3000, category);
    expect(new URL(urls()[0]).searchParams.getAll('osm_tag')).toContain(tag);
  });

  test('never more than ~2 Photon requests per second', async () => {
    vi.useFakeTimers();
    const all = Promise.all([osmSuggest('first', null), osmSuggest('second', null), osmSuggest('third', null)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await all;
  });

  test('the same text again is answered from the short cache', async () => {
    vi.useFakeTimers();
    await osmSuggest('pharmacy', null);
    await vi.advanceTimersByTimeAsync(1000);
    await osmSuggest('pharmacy', null);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('8 s limit; HTTP errors are named', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    const p = osmSuggest('slow one', null).catch((e) => e);
    await vi.advanceTimersByTimeAsync(8000);
    expect((await p).message).toBe('OpenStreetMap search did not answer in 8 s.');
    fetchMock.mockResolvedValueOnce(answer({ message: 'rate limited' }, 429));
    const q = osmSuggest('busy one', null).catch((e) => e);
    await vi.advanceTimersByTimeAsync(600);
    expect((await q).message).toBe('OpenStreetMap search failed (HTTP 429).');
  });

  test('on the phone: native HTTP with the app User-Agent (fetch cannot set it)', async () => {
    native.on = true;
    native.get.mockResolvedValue({ status: 200, data: collection(feature(7, 'Station Cafe', 20, 73.79, { osm_value: 'cafe' })), headers: {}, url: '' });
    const s = await osmSuggest('station cafe', null);
    expect(s[0].placeId).toBe('osm:N7');
    expect(fetchMock).not.toHaveBeenCalled();
    const opts = native.get.mock.calls[0][0];
    expect(opts.headers['User-Agent']).toMatch(/^AISmartStick\/\S+ \(assistive walking app\)$/);
    expect(opts.connectTimeout).toBe(8000);
    expect(opts.readTimeout).toBe(8000);
  });
});

describe('osmRoute (FOSSGIS OSRM, foot)', () => {
  test('OSRM answer → RouteResult with readable steps and the Google maneuver names', async () => {
    fetchMock.mockResolvedValueOnce(answer(osrmAnswer()));
    const r = await osmRoute({ lat: 20.01, lng: 73.79 }, { lat: 20.005, lng: 73.789 });
    expect(urls()[0]).toBe('https://routing.openstreetmap.de/routed-foot/route/v1/driving/73.790000,20.010000;73.789000,20.005000?overview=full&geometries=geojson&steps=true');
    expect(r.provider).toBe('osm');
    expect(r.distanceM).toBe(412);
    expect(r.durationS).toBe(297);
    expect(r.path).toEqual([[20.01, 73.79], [20.008, 73.7905], [20.006, 73.789], [20.005, 73.789]]);
    expect(r.steps.map((s) => [s.instruction, s.maneuver])).toEqual([
      ['Head south on MG Road', 'DEPART'],
      ['Turn left onto Station Road', 'TURN_LEFT'],
      ['Continue straight', 'STRAIGHT'],
      ['Arrive at your destination, on the right', null],
    ]);
    expect(r.steps[1]).toMatchObject({ distanceM: 150, durationS: 108, start: { lat: 20.008, lng: 73.7905 }, end: { lat: 20.006, lng: 73.789 } });
    // What the navigator and the haptics make of them.
    expect(r.steps.map((s) => maneuverFrom(s.maneuver, s.instruction))).toEqual(['straight', 'left', 'straight', 'arrive']);
  });

  test.each([
    [{ type: 'turn', modifier: 'right' }, 'MG Road', 'Turn right onto MG Road', 'TURN_RIGHT', 'right'],
    [{ type: 'turn', modifier: 'slight left' }, '', 'Turn slightly left', 'TURN_SLIGHT_LEFT', 'left'],
    [{ type: 'turn', modifier: 'sharp right' }, '', 'Turn sharp right', 'TURN_SHARP_RIGHT', 'right'],
    [{ type: 'turn', modifier: 'uturn' }, '', 'Make a U-turn', 'UTURN_RIGHT', 'uturn'],
    [{ type: 'new name', modifier: 'straight' }, 'Link Road', 'Continue onto Link Road', 'NAME_CHANGE', 'straight'],
    [{ type: 'end of road', modifier: 'left' }, 'Gangapur Road', 'At the end of the road, turn left onto Gangapur Road', 'TURN_LEFT', 'left'],
    [{ type: 'fork', modifier: 'slight right' }, '', 'Keep right at the fork', 'FORK_RIGHT', 'right'],
    [{ type: 'roundabout', modifier: 'left', exit: 2 }, 'CBS Road', 'At the roundabout, take the 2nd exit onto CBS Road', 'ROUNDABOUT_LEFT', 'left'],
    [{ type: 'roundabout', modifier: 'straight', exit: 3 }, '', 'At the roundabout, take the 3rd exit', null, 'other'],
    [{ type: 'depart', bearing_after: 90 }, '', 'Head east', 'DEPART', 'straight'],
    [{ type: 'arrive' }, '', 'Arrive at your destination', null, 'arrive'],
  ])('%o on "%s" → "%s"', (maneuver, name, text, man, nav) => {
    const r = osrmInstruction({ maneuver, name, driving_side: 'left' } as never);
    expect(r).toEqual({ instruction: text, maneuver: man });
    expect(maneuverFrom(r.maneuver, r.instruction)).toBe(nav);
  });

  test('OSM has no walking route → no-route (HTTP 400 NoRoute / NoSegment)', async () => {
    fetchMock.mockResolvedValueOnce(answer({ code: 'NoRoute', message: 'Impossible route between points' }, 400));
    await expect(osmRoute({ lat: 20, lng: 73 }, { lat: 21, lng: 74 })).rejects.toThrow('no-route');
    expect(() => osrmToRoute({ code: 'NoSegment' })).toThrow('no-route');
  });

  test('server trouble is named, not called "no route"', async () => {
    fetchMock.mockResolvedValueOnce(answer(null, 502));
    await expect(osmRoute({ lat: 20, lng: 73 }, { lat: 20.01, lng: 73 })).rejects.toThrow('OpenStreetMap route failed (HTTP 502).');
  });
});
