import { autocomplete, friendlyMapsError, placeDetails, searchPlaces, walkingRoute, type PlaceResult, type RouteResult, type RouteStepResult, type Suggestion } from './mapsService';
import { loadPlacesLibrary, loadRoutesLibrary, mapsErrorFrom } from './mapsLoader';
import { haversineM, useLocation } from '../location/locationService';
import { useSession } from '../store/session';
import { log } from '../log';

/**
 * Destination search, place lookup and walking routes that keep working when one Google path is
 * down. Chain: Cloud Function (server key; mapsService.ts) → Maps JavaScript API in the browser
 * (browser key: Places API (New) + Directions API) → a clear error naming both causes.
 *
 * Works WITHOUT a GPS fix: the newest position of any age only biases results (India-wide
 * otherwise). Nothing here invents a place or a coordinate.
 */
export type SearchSource = 'server' | 'browser';

export interface DestinationSuggestion extends Suggestion {
  source: SearchSource;
  /** Straight-line metres from the bias point, when Google gave one. */
  distanceM?: number | null;
}

export class MapsUnavailableError extends Error {
  constructor(public causes: string[]) {
    super(causes.filter(Boolean).join(' Also: ') || 'Maps search is unavailable.');
  }
}

/** Search bias: the newest position of any age (null before the first one). */
export function searchBias(): { lat: number; lng: number } | null {
  const f = useLocation.getState().fix;
  return f ? { lat: f.lat, lng: f.lng } : null;
}

/** Longer than a Cloud Function cold start, shorter than the callable's own 10–15 s timeouts. */
const SERVER_TIMEOUT_MS = 12_000;
/** A server failure that will not fix itself (not deployed, App Check, key) skips it for a while. */
const SERVER_BACKOFF_MS = 5 * 60_000;
/** A slow or flaky answer (cold start, Google hiccup): skip the server only briefly. */
const SERVER_SHORT_BACKOFF_MS = 30_000;
let serverDownUntil = 0;
let lastServerError: string | null = null;

const codeOf = (e: unknown) => String((e as { code?: string })?.code ?? '').replace(/^functions\//, '');
/** Failures that will not fix themselves in the next minutes (deployment, App Check, key). */
const persistent = (e: unknown) => {
  const c = codeOf(e);
  const m = String((e as Error)?.message ?? '');
  if (c === 'not-found') return !/place not found|no walking route/i.test(m); // "not deployed" vs a real answer
  return ['unauthenticated', 'permission-denied', 'failed-precondition'].includes(c);
};
/** Transient: a timeout (cold start) or a server-side hiccup. ("unavailable" = network blip: no backoff.) */
const transient = (e: unknown) => {
  const c = codeOf(e);
  return ['deadline-exceeded', 'internal', 'resource-exhausted'].includes(c) || /timed out/i.test(String((e as Error)?.message ?? ''));
};
/** How long to skip the server after this failure (0 = try it again next time). */
export function serverBackoffMs(e: unknown) {
  return persistent(e) ? SERVER_BACKOFF_MS : transient(e) ? SERVER_SHORT_BACKOFF_MS : 0;
}

function timeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(Object.assign(new Error(`${what} timed out`), { code: 'deadline-exceeded' })), ms)))]).finally(() => clearTimeout(t));
}

/** Runs the server path unless it is known to be down; records why it failed. */
async function server<T>(what: string, fn: () => Promise<T>): Promise<T> {
  if (Date.now() < serverDownUntil) throw Object.assign(new Error(lastServerError ?? 'Server maps unavailable'), { code: 'skipped' });
  try {
    return await timeout(fn(), SERVER_TIMEOUT_MS, what);
  } catch (e) {
    lastServerError = friendlyMapsError(e);
    const backoff = serverBackoffMs(e);
    if (backoff) serverDownUntil = Date.now() + backoff;
    log.warn(`maps: server ${what} failed, using the browser`, { code: codeOf(e), message: (e as Error)?.message });
    throw e;
  }
}

const browserErrorText = (e: unknown) => {
  const m = mapsErrorFrom(e);
  return m.kind === 'load_failed' || m.kind === 'auth'
    ? `Google Maps in the app refused the search (${(e as Error)?.message ?? m.code ?? 'error'}). Enable "Places API (New)" for the browser key.`
    : m.message;
};

const serverErrorText = (e: unknown) => (codeOf(e) === 'skipped' ? (lastServerError ?? 'Server search unavailable.') : friendlyMapsError(e));

// ---------------------------------------------------------------- browser (Maps JavaScript API)

const tokens = new Map<string, google.maps.places.AutocompleteSessionToken>();
const predictions = new Map<string, google.maps.places.PlacePrediction>();
const PLACE_FIELDS = ['id', 'displayName', 'formattedAddress', 'location', 'primaryType'];

function browserToken(lib: google.maps.PlacesLibrary, key: string) {
  let t = tokens.get(key);
  if (!t) {
    t = new lib.AutocompleteSessionToken();
    tokens.clear(); // one live session at a time
    tokens.set(key, t);
  }
  return t;
}

function placeOut(p: google.maps.places.Place, from: { lat: number; lng: number } | null): PlaceResult | null {
  const loc = p.location;
  if (!loc) return null;
  const lat = loc.lat();
  const lng = loc.lng();
  return {
    placeId: p.id,
    name: p.displayName ?? 'Unnamed place',
    address: p.formattedAddress ?? null,
    lat,
    lng,
    distanceM: from ? Math.round(haversineM(from, { lat, lng })) : null,
    openNow: null,
    primaryType: p.primaryType ?? null,
  };
}

async function browserSuggest(text: string, token: string, bias: { lat: number; lng: number } | null): Promise<DestinationSuggestion[]> {
  const lib = await loadPlacesLibrary();
  const req: google.maps.places.AutocompleteRequest = { input: text, sessionToken: browserToken(lib, token), includedRegionCodes: ['in'], language: 'en' };
  if (bias) {
    req.locationBias = { center: bias, radius: 5000 };
    req.origin = bias;
  }
  const { suggestions } = await lib.AutocompleteSuggestion.fetchAutocompleteSuggestions(req);
  const out: DestinationSuggestion[] = [];
  for (const s of suggestions) {
    const p = s.placePrediction;
    if (!p?.placeId) continue;
    predictions.set(p.placeId, p);
    out.push({ placeId: p.placeId, main: p.mainText?.text ?? p.text?.text ?? text, secondary: p.secondaryText?.text ?? null, source: 'browser', distanceM: p.distanceMeters ?? null });
    if (out.length >= 6) break;
  }
  return out;
}

async function browserPlace(placeId: string): Promise<PlaceResult> {
  const lib = await loadPlacesLibrary();
  // toPlace() carries the autocomplete session token into this (billed-once) details call.
  const place = predictions.get(placeId)?.toPlace() ?? new lib.Place({ id: placeId });
  await place.fetchFields({ fields: PLACE_FIELDS });
  const out = placeOut(place, searchBias());
  if (!out) throw new Error('That place has no location.');
  return out;
}

const CATEGORY_TEXT: Record<string, string> = {
  mall: 'shopping mall',
  pharmacy: 'pharmacy',
  hospital: 'hospital',
  bus_stop: 'bus stop',
  atm: 'ATM',
  cafe: 'cafe',
  restaurant: 'restaurant',
  salon: 'hair salon',
  supermarket: 'supermarket',
  police: 'police station',
  train_station: 'railway station',
};

async function browserSearch(textQuery: string, bias: { lat: number; lng: number } | null, radiusM: number): Promise<PlaceResult[]> {
  const lib = await loadPlacesLibrary();
  const req: google.maps.places.SearchByTextRequest = { textQuery, fields: PLACE_FIELDS, maxResultCount: 8, region: 'in', language: 'en' };
  if (bias) req.locationBias = { center: bias, radius: Math.min(Math.max(radiusM, 500), 50_000) };
  const { places } = await lib.Place.searchByText(req);
  return places.map((p) => placeOut(p, bias)).filter((p): p is PlaceResult => !!p);
}

const byDistance = (a: PlaceResult, b: PlaceResult) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity);

// ---------------------------------------------------------------- public API

/** Autocomplete suggestions for what the user typed. Throws MapsUnavailableError when every path fails. */
export async function suggestDestinations(text: string, token: string, bias = searchBias()): Promise<{ suggestions: DestinationSuggestion[]; source: SearchSource }> {
  const q = text.trim();
  if (q.length < 2) return { suggestions: [], source: 'server' };
  const causes: string[] = [];
  try {
    const r = await server('autocomplete', () => autocomplete(q, bias?.lat ?? null, bias?.lng ?? null, token));
    return { suggestions: r.suggestions.map((s) => ({ ...s, source: 'server' as const })), source: 'server' };
  } catch (e) {
    causes.push(`Server search: ${serverErrorText(e)}`);
  }
  try {
    return { suggestions: await browserSuggest(q, token, bias), source: 'browser' };
  } catch (e) {
    causes.push(`In-app search: ${browserErrorText(e)}`);
  }
  throw new MapsUnavailableError(causes);
}

/** Full place (coordinates) for a picked suggestion. */
export async function resolveDestination(s: Pick<DestinationSuggestion, 'placeId' | 'source'> & Partial<DestinationSuggestion>, token: string): Promise<PlaceResult> {
  const causes: string[] = [];
  if (s.source !== 'browser') {
    try {
      return (await server('place', () => placeDetails(s.placeId, token))).place;
    } catch (e) {
      causes.push(`Server: ${serverErrorText(e)}`);
    }
  }
  try {
    return await browserPlace(s.placeId);
  } catch (e) {
    causes.push(`In-app: ${browserErrorText(e)}`);
  }
  throw new MapsUnavailableError(causes);
}

/** Place by id (the assistant's set_destination with an id it was given earlier). */
export const placeById = (placeId: string) => resolveDestination({ placeId, source: 'server' }, '');

/**
 * Text or category search (the assistant's search_place / find_nearest_place). Results are sorted
 * by distance when there is a bias position.
 */
export async function findPlaces(input: { query?: string; category?: string; radiusM?: number; bias?: { lat: number; lng: number } | null }): Promise<{ places: PlaceResult[]; source: SearchSource; biased: boolean }> {
  const bias = input.bias === undefined ? searchBias() : input.bias;
  const radiusM = input.radiusM ?? 3000;
  const causes: string[] = [];
  try {
    const r = await server('search', () => searchPlaces({ query: input.query, category: input.category, lat: bias?.lat ?? null, lng: bias?.lng ?? null, radiusM }));
    return { places: r.places, source: 'server', biased: !!bias };
  } catch (e) {
    causes.push(`Server search: ${serverErrorText(e)}`);
  }
  if (input.category === 'home') {
    // "Take me home" without the server: the exact point saved during setup.
    const home = useSession.getState().person.savedPlaces?.find((p) => p.id === 'home');
    if (home) return { places: [{ placeId: home.placeId || 'home', name: home.label || 'Home', address: home.address, lat: home.lat, lng: home.lng, distanceM: bias ? Math.round(haversineM(bias, home)) : null, openNow: null, primaryType: 'home' }], source: 'browser', biased: !!bias };
    throw new MapsUnavailableError([...causes, 'No home place is saved on this phone.']);
  }
  const text = input.query?.trim() || (input.category ? CATEGORY_TEXT[input.category] ?? input.category.replace(/_/g, ' ') : '');
  if (!text) throw new MapsUnavailableError(['Say what place to look for.']);
  try {
    const places = await browserSearch(text, bias, radiusM);
    return { places: bias ? places.sort(byDistance) : places, source: 'browser', biased: !!bias };
  } catch (e) {
    causes.push(`In-app search: ${browserErrorText(e)}`);
  }
  throw new MapsUnavailableError(causes);
}

const stripHtml = (s: string) =>
  s
    .replace(/<div[^>]*>/gi, '. ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .replace(/\s+\./g, '.')
    .trim();

async function browserRoute(origin: { lat: number; lng: number }, place: PlaceResult): Promise<RouteResult> {
  const lib = await loadRoutesLibrary();
  const usePlaceId = !!place.placeId && place.placeId !== 'home';
  const destination: google.maps.DirectionsRequest['destination'] = usePlaceId ? { placeId: place.placeId } : { lat: place.lat, lng: place.lng };
  const res = await new lib.DirectionsService().route({ origin, destination, travelMode: 'WALKING' as google.maps.TravelMode, region: 'in' });
  const leg = res.routes?.[0]?.legs?.[0];
  if (!leg) throw new Error('no-route');
  const steps: RouteStepResult[] = leg.steps.map((s) => ({
    instruction: stripHtml(s.instructions || 'Continue'),
    maneuver: s.maneuver ? s.maneuver.toUpperCase().replace(/-/g, '_') : null,
    distanceM: s.distance?.value ?? 0,
    durationS: s.duration?.value ?? 0,
    start: { lat: s.start_location.lat(), lng: s.start_location.lng() },
    end: { lat: s.end_location.lat(), lng: s.end_location.lng() },
  }));
  const path = (res.routes[0].overview_path ?? []).map((p) => [p.lat(), p.lng()] as [number, number]);
  return { distanceM: leg.distance?.value ?? steps.reduce((a, s) => a + s.distanceM, 0), durationS: leg.duration?.value ?? steps.reduce((a, s) => a + s.durationS, 0), path, steps };
}

/** Walking route from `origin` to `place`: Cloud Function (Routes API), else Maps JS DirectionsService. */
export async function routeWalking(origin: { lat: number; lng: number }, place: PlaceResult): Promise<RouteResult> {
  const causes: string[] = [];
  // 'home' and dropped pins (no placeId) route to the exact saved coordinates.
  const destination = place.placeId && place.placeId !== '' ? { placeId: place.placeId } : { lat: place.lat, lng: place.lng };
  try {
    return await server('route', () => walkingRoute({ origin, destination }));
  } catch (e) {
    // The function answered: there is genuinely no walking route (not a deployment problem).
    if (codeOf(e) === 'not-found' && /no walking route/i.test(String((e as Error)?.message))) throw new Error('no-route');
    causes.push(`Server route: ${serverErrorText(e)}`);
  }
  try {
    return await browserRoute(origin, place);
  } catch (e) {
    if ((e as Error)?.message === 'no-route' || /ZERO_RESULTS|NOT_FOUND/.test(String((e as { code?: string })?.code ?? (e as Error)?.message))) throw new Error('no-route');
    causes.push(`In-app route: ${browserErrorText(e)}`);
  }
  throw new MapsUnavailableError(causes);
}

/** Words for the user (and the person setting the phone up). */
export function searchErrorText(e: unknown) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'No internet connection.';
  if (e instanceof MapsUnavailableError) return `Search unavailable. ${e.message}`;
  return `Search unavailable. ${friendlyMapsError(e)}`;
}

/** Test helper. */
export function __resetDestinationSearchForTests() {
  serverDownUntil = 0;
  lastServerError = null;
  tokens.clear();
  predictions.clear();
}
