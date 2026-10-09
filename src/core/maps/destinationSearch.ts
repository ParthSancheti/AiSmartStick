import { autocomplete, friendlyMapsError, placeDetails, searchPlaces, walkingRoute, type PlaceResult, type RouteResult, type RouteStepResult, type Suggestion } from './mapsService';
import { loadPlacesLibrary, loadRoutesLibrary, mapsErrorFrom } from './mapsLoader';
import { OSM_MIN_SUGGEST_CHARS, isOsmPlaceId, osmErrorText, osmPlaceById, osmRoute, osmSearch, osmSuggest } from './osmFallback';
import { haversineM, useLocation } from '../location/locationService';
import { useSession } from '../store/session';
import { log } from '../log';

/**
 * Destination search, place lookup and walking routes that keep working when one path is down.
 *
 * 1. Cloud Function (server key; mapsService.ts) starts first.
 * 2. Maps JavaScript API in the app (browser key: Places API (New), Directions API) joins when the
 *    server has not answered in HEDGE_AFTER_MS, or at once when the server fails. The first
 *    success wins; when one fails the other is still awaited.
 * 3. OpenStreetMap (osmFallback.ts), only when both Google paths failed.
 * 4. A clear error naming every cause.
 *
 * Works WITHOUT a GPS fix: the newest position of any age only biases results (India-wide
 * otherwise). Nothing here invents a place or a coordinate. OSM place ids ('osm:…') never go to
 * Google: they come from the OSM cache and are routed by lat/lng.
 */
export type SearchSource = 'server' | 'browser' | 'osm';

export interface DestinationSuggestion extends Suggestion {
  source: SearchSource;
  /** Straight-line metres from the bias point, when known. */
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

/** The in-app path starts when the server has not answered by then. */
export const HEDGE_AFTER_MS = 3500;
/** Whole server call, including a Cloud Functions cold start and the App Check token. */
export const SERVER_TIMEOUT_MS = 20_000;
/** Whole in-app Google call (library load + request). */
const BROWSER_TIMEOUT_MS = 15_000;
/** A server failure that will not fix itself (not deployed, App Check, key) skips it for a while. */
const SERVER_BACKOFF_MS = 5 * 60_000;
/** A slow or flaky answer (cold start, Google hiccup): skip the server only briefly (doubles when it repeats). */
const SERVER_SHORT_BACKOFF_MS = 30_000;
/** The in-app Google API is refused (not enabled, key restriction): skip it for a while. */
const BROWSER_BACKOFF_MS = 5 * 60_000;
let serverDownUntil = 0;
let serverFailStreak = 0;
let lastServerError: string | null = null;
type BrowserApi = 'places' | 'directions';
const browserDownUntil: Record<BrowserApi, number> = { places: 0, directions: 0 };
const lastBrowserError: Record<BrowserApi, string | null> = { places: null, directions: null };

const codeOf = (e: unknown) => String((e as { code?: string })?.code ?? '').replace(/^functions\//, '');
const msgOf = (e: unknown) => String((e as Error)?.message ?? '');
/** Failures that will not fix themselves in the next minutes (deployment, App Check, key). */
const persistent = (e: unknown) => {
  const c = codeOf(e);
  if (c === 'not-found') return !/place not found|no walking route/i.test(msgOf(e)); // "not deployed" vs a real answer
  return ['unauthenticated', 'permission-denied', 'failed-precondition'].includes(c);
};
/** Transient: a timeout (cold start) or a server-side hiccup. ("unavailable" = network blip: no backoff.) */
const transient = (e: unknown) => {
  const c = codeOf(e);
  return ['deadline-exceeded', 'internal', 'resource-exhausted'].includes(c) || /timed out|did not answer/i.test(msgOf(e));
};
/** How long to skip the server after this failure (0 = try it again next time). */
export function serverBackoffMs(e: unknown) {
  return persistent(e) ? SERVER_BACKOFF_MS : transient(e) ? SERVER_SHORT_BACKOFF_MS : 0;
}

function timeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(Object.assign(new Error(message), { code: 'deadline-exceeded' })), ms)))]).finally(() => clearTimeout(t));
}

const skipped = (message: string) => Object.assign(new Error(message), { code: 'skipped' });

/** Runs the server path unless it is known to be down; records why it failed. */
async function server<T>(what: string, fn: () => Promise<T>): Promise<T> {
  if (Date.now() < serverDownUntil) throw skipped(lastServerError ?? 'Server maps unavailable.');
  try {
    const r = await timeout(fn(), SERVER_TIMEOUT_MS, `The server did not answer in ${Math.round(SERVER_TIMEOUT_MS / 1000)} s (slow first start, App Check, or functions not deployed).`);
    serverFailStreak = 0;
    return r;
  } catch (e) {
    lastServerError = friendlyMapsError(e);
    const base = serverBackoffMs(e);
    const now = Date.now();
    if (base) {
      // Parallel requests failing together count once; a repeat after the pause doubles it.
      if (now >= serverDownUntil) serverFailStreak++;
      serverDownUntil = Math.max(serverDownUntil, now + Math.min(SERVER_BACKOFF_MS, base * 2 ** Math.max(0, serverFailStreak - 1)));
    }
    log.warn(`maps: server ${what} failed`, { code: codeOf(e), message: msgOf(e) });
    throw e;
  }
}

// ---------------------------------------------------------------- error words

const PLACES_FIX = "Fix: Google Cloud → APIs & Services → enable Places API (New), and allow it in the browser key's API restrictions (see docs/GOOGLE_CLOUD_SETUP.md, 2 Enable APIs / 3 Browser key).";

/** Google's long error message → the part that says what is wrong. */
export function shortGoogleMessage(raw: string): string {
  const s = String(raw ?? '');
  const project = /project (\d+)/i.exec(s)?.[1];
  if (/has not been used in project|it is disabled|SERVICE_DISABLED/i.test(s)) {
    const api = /(Places API \(New\)|Places API|Directions API|Routes API|Maps JavaScript API|Geocoding API)/i.exec(s)?.[1] ?? 'This Google API';
    return `${api} is not enabled${project ? ` in project ${project}` : ''}`;
  }
  if (/API_KEY_SERVICE_BLOCKED|requests to this API .* are blocked|not authorized to use this (API|service)/i.test(s)) return 'the browser key is not allowed to use this API';
  if (/referer|referrer/i.test(s)) return 'the browser key does not allow this app';
  const cleaned = s
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\b[A-Z][A-Z_]{4,}:\s*/g, '') // "PLACES_AUTOCOMPLETE: PERMISSION_DENIED: …"
    .replace(/\s+/g, ' ')
    .trim();
  const first = (cleaned.split(/\.\s/)[0] ?? cleaned).replace(/\.$/, '');
  return first.length > 120 ? `${first.slice(0, 117)}…` : first || 'error';
}

/** Legacy Directions API refused: projects made after March 2025 cannot turn it on. */
export function legacyDirectionsRefused(e: unknown) {
  return /REQUEST_DENIED|LegacyApiNotActivated|ApiNotActivated|not authorized|legacy API/i.test(`${codeOf(e)} ${msgOf(e)}`);
}

/** In-app Google failure → words, with the exact fix for the person setting the phone up. */
export function browserErrorText(e: unknown, api: BrowserApi = 'places'): string {
  const code = codeOf(e);
  if (code === 'skipped' || code === 'deadline-exceeded') return msgOf(e);
  if (api === 'directions' && legacyDirectionsRefused(e)) return 'In-app walking directions are not available for this Google project (the old Directions API cannot be turned on).';
  const m = mapsErrorFrom(e);
  switch (m.kind) {
    case 'offline':
      return 'Google Maps in the app could not load (no internet, or Google is blocked).';
    case 'not_configured':
      return `Google Maps is not set up in this build. ${m.hint ?? ''}`.trim();
    case 'referrer':
    case 'api_not_enabled':
    case 'billing':
    case 'invalid_key':
    case 'auth':
      return `${m.message} ${m.hint ?? ''}`.trim();
    default: {
      const raw = msgOf(e) || m.code || 'error';
      return api === 'places' ? `Google Maps in the app refused the search (${shortGoogleMessage(raw)}). ${PLACES_FIX}` : `Google Maps in the app refused the route (${shortGoogleMessage(raw)}).`;
    }
  }
}

/** Refusals that will not fix themselves soon (API off, key restriction, no key). */
const browserPersistent = (e: unknown, api: BrowserApi) => {
  const kind = mapsErrorFrom(e).kind;
  if (['not_configured', 'referrer', 'api_not_enabled', 'billing', 'invalid_key'].includes(kind)) return true;
  if (api === 'directions' && legacyDirectionsRefused(e)) return true;
  return /has not been used in project|it is disabled|PERMISSION_DENIED|API_KEY|not authorized|are blocked/i.test(msgOf(e));
};

/** Runs an in-app Google call unless that API is known to be refused; records why it failed. */
async function browser<T>(api: BrowserApi, fn: () => Promise<T>): Promise<T> {
  if (Date.now() < browserDownUntil[api]) throw skipped(lastBrowserError[api] ?? 'In-app Google Maps unavailable.');
  try {
    return await timeout(fn(), BROWSER_TIMEOUT_MS, `Google Maps in the app did not answer in ${Math.round(BROWSER_TIMEOUT_MS / 1000)} s.`);
  } catch (e) {
    if (codeOf(e) !== 'no-route' && msgOf(e) !== 'no-route') {
      lastBrowserError[api] = browserErrorText(e, api);
      if (browserPersistent(e, api)) browserDownUntil[api] = Date.now() + BROWSER_BACKOFF_MS;
      log.warn(`maps: in-app ${api} failed`, { code: codeOf(e), message: msgOf(e) });
    }
    throw e;
  }
}

const serverErrorText = (e: unknown) => (codeOf(e) === 'skipped' ? (lastServerError ?? 'Server search unavailable.') : friendlyMapsError(e));

// ---------------------------------------------------------------- hedging

interface Hedged<T> {
  value?: T;
  source?: 'server' | 'browser';
  serverError?: unknown;
  browserError?: unknown;
}

/**
 * Starts `serverRun`; `browserRun` joins after HEDGE_AFTER_MS, or at once when the server fails
 * (but not after a `final` answer such as a real "no route"). First success wins; a failure keeps
 * waiting for the other path. Never rejects: the outcome says what happened.
 */
function hedged<T>(serverRun: () => Promise<T>, browserRun: (() => Promise<T>) | null, final: (e: unknown) => boolean = () => false): Promise<Hedged<T>> {
  return new Promise((resolve) => {
    const out: Hedged<T> = {};
    let settled = false;
    let running = 0;
    let browserStarted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out);
    };
    const run = (source: 'server' | 'browser', fn: () => Promise<T>) => {
      running++;
      let p: Promise<T>;
      try {
        p = Promise.resolve(fn()); // started right now (callers rely on the request being sent synchronously)
      } catch (e) {
        p = Promise.reject(e);
      }
      p.then(
          (v) => {
            if (settled) return;
            out.value = v;
            out.source = source;
            done();
          },
          (e) => {
            running--;
            if (source === 'server') out.serverError = e;
            else out.browserError = e;
            if (settled) return;
            if (source === 'server' && !final(e)) startBrowser();
            if (running === 0) done();
          },
        );
    };
    const startBrowser = () => {
      if (browserStarted || settled || !browserRun) return;
      browserStarted = true;
      clearTimeout(timer);
      run('browser', browserRun);
    };
    run('server', serverRun);
    if (browserRun) timer = setTimeout(startBrowser, HEDGE_AFTER_MS);
  });
}

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
  const r = await hedged<DestinationSuggestion[]>(
    () => server('autocomplete', () => autocomplete(q, bias?.lat ?? null, bias?.lng ?? null, token)).then((x) => x.suggestions.map((s) => ({ ...s, source: 'server' as const }))),
    () => browser('places', () => browserSuggest(q, token, bias)),
  );
  if (r.source) return { suggestions: r.value as DestinationSuggestion[], source: r.source };
  const causes = [`Server search: ${serverErrorText(r.serverError)}`, `In-app search: ${browserErrorText(r.browserError)}`];
  if (q.length < OSM_MIN_SUGGEST_CHARS) {
    causes.push(`Type ${OSM_MIN_SUGGEST_CHARS} or more letters to search OpenStreetMap.`);
    throw new MapsUnavailableError(causes);
  }
  try {
    const found = await osmSuggest(q, bias);
    log.warn('maps: Google search failed, using OpenStreetMap', { causes });
    return { suggestions: found.map((s) => ({ ...s, source: 'osm' as const })), source: 'osm' };
  } catch (e) {
    causes.push(`OpenStreetMap: ${osmErrorText(e)}`);
  }
  throw new MapsUnavailableError(causes);
}

const OSM_GONE = 'That OpenStreetMap place is no longer in memory. Search for it again.';

/** Full place (coordinates) for a picked suggestion. */
export async function resolveDestination(s: Pick<DestinationSuggestion, 'placeId' | 'source'> & Partial<DestinationSuggestion>, token: string): Promise<PlaceResult> {
  if (s.source === 'osm' || isOsmPlaceId(s.placeId)) {
    // Never sent to Google: the OSM answer that offered it is cached.
    const p = osmPlaceById(s.placeId);
    if (p) return p;
    throw new MapsUnavailableError([OSM_GONE]);
  }
  if (s.source === 'browser') {
    try {
      return await browser('places', () => browserPlace(s.placeId));
    } catch (e) {
      throw new MapsUnavailableError([`In-app: ${browserErrorText(e)}`]);
    }
  }
  const r = await hedged(
    () => server('place', () => placeDetails(s.placeId, token)).then((x) => x.place),
    () => browser('places', () => browserPlace(s.placeId)),
  );
  if (r.source) return r.value as PlaceResult;
  throw new MapsUnavailableError([`Server: ${serverErrorText(r.serverError)}`, `In-app: ${browserErrorText(r.browserError)}`]);
}

/** Place by id (the assistant's set_destination with an id it was given earlier). */
export const placeById = (placeId: string) => resolveDestination({ placeId, source: isOsmPlaceId(placeId) ? 'osm' : 'server' }, '');

/**
 * Text or category search (the assistant's search_place / find_nearest_place). Results are sorted
 * by distance when there is a bias position.
 */
export async function findPlaces(input: { query?: string; category?: string; radiusM?: number; bias?: { lat: number; lng: number } | null }): Promise<{ places: PlaceResult[]; source: SearchSource; biased: boolean }> {
  const bias = input.bias === undefined ? searchBias() : input.bias;
  const biased = !!bias;
  const radiusM = input.radiusM ?? 3000;
  const serverRun = () => server('search', () => searchPlaces({ query: input.query, category: input.category, lat: bias?.lat ?? null, lng: bias?.lng ?? null, radiusM })).then((x) => x.places);
  if (input.category === 'home') {
    let cause: string;
    try {
      return { places: await serverRun(), source: 'server', biased };
    } catch (e) {
      cause = `Server search: ${serverErrorText(e)}`;
    }
    // "Take me home" without the server: the exact point saved during setup.
    const home = useSession.getState().person.savedPlaces?.find((p) => p.id === 'home');
    if (home) return { places: [{ placeId: home.placeId || 'home', name: home.label || 'Home', address: home.address, lat: home.lat, lng: home.lng, distanceM: bias ? Math.round(haversineM(bias, home)) : null, openNow: null, primaryType: 'home' }], source: 'browser', biased };
    throw new MapsUnavailableError([cause, 'No home place is saved on this phone.']);
  }
  const text = input.query?.trim() || (input.category ? CATEGORY_TEXT[input.category] ?? input.category.replace(/_/g, ' ') : '');
  const r = await hedged(serverRun, text ? () => browser('places', () => browserSearch(text, bias, radiusM)).then((p) => (bias ? p.sort(byDistance) : p)) : null);
  if (r.source) return { places: r.value as PlaceResult[], source: r.source, biased };
  if (!text) throw new MapsUnavailableError(['Say what place to look for.']);
  const causes = [`Server search: ${serverErrorText(r.serverError)}`, `In-app search: ${browserErrorText(r.browserError)}`];
  try {
    const places = await osmSearch(input.query?.trim() ?? '', bias, radiusM, input.category);
    log.warn('maps: Google search failed, using OpenStreetMap', { causes });
    return { places, source: 'osm', biased };
  } catch (e) {
    causes.push(`OpenStreetMap: ${osmErrorText(e)}`);
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

/** A Google place id that Google can route to ('' = dropped pin, 'home' and OSM ids are routed by lat/lng here). */
const googlePlaceId = (placeId: string) => (placeId && placeId !== 'home' && !isOsmPlaceId(placeId) ? placeId : null);

const NO_ROUTE = () => new Error('no-route');
const isNoRoute = (e: unknown) => msgOf(e) === 'no-route';

/** Legacy DirectionsService (browser key). Only ZERO_RESULTS is a real "no route". */
async function browserRoute(origin: { lat: number; lng: number }, place: PlaceResult): Promise<RouteResult> {
  const lib = await loadRoutesLibrary();
  const id = googlePlaceId(place.placeId);
  const destination: google.maps.DirectionsRequest['destination'] = id ? { placeId: id } : { lat: place.lat, lng: place.lng };
  let res: google.maps.DirectionsResult;
  try {
    res = await new lib.DirectionsService().route({ origin, destination, travelMode: 'WALKING' as google.maps.TravelMode, region: 'in' });
  } catch (e) {
    if (/ZERO_RESULTS/.test(`${codeOf(e)} ${msgOf(e)}`)) throw NO_ROUTE();
    throw e;
  }
  const leg = res.routes?.[0]?.legs?.[0];
  if (!leg) throw NO_ROUTE();
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

/** The server's real answer that there is no walking route (not a deployment problem). */
const serverNoRoute = (e: unknown) => codeOf(e) === 'not-found' && /no walking route/i.test(msgOf(e));

/**
 * Walking route from `origin` to `place`: Cloud Function (Routes API) and the in-app
 * DirectionsService (hedged), else OpenStreetMap. A real "no route" from Google ends it ('no-route').
 */
export async function routeWalking(origin: { lat: number; lng: number }, place: PlaceResult): Promise<RouteResult> {
  // Google place ids (and 'home', which the server resolves itself) by id; dropped pins and OSM places by lat/lng.
  const destination = place.placeId && !isOsmPlaceId(place.placeId) ? { placeId: place.placeId } : { lat: place.lat, lng: place.lng };
  const r = await hedged(
    () => server('route', () => walkingRoute({ origin, destination })),
    () => browser('directions', () => browserRoute(origin, place)),
    serverNoRoute,
  );
  if (r.source) return r.value as RouteResult;
  if (serverNoRoute(r.serverError) || isNoRoute(r.browserError)) throw NO_ROUTE();
  const causes = [`Server route: ${serverErrorText(r.serverError)}`, `In-app route: ${browserErrorText(r.browserError, 'directions')}`];
  try {
    const route = await osmRoute(origin, { lat: place.lat, lng: place.lng });
    log.warn('maps: Google routes failed, using OpenStreetMap', { causes });
    return route;
  } catch (e) {
    if (isNoRoute(e)) throw NO_ROUTE();
    causes.push(`OpenStreetMap route: ${osmErrorText(e)}`);
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
  serverFailStreak = 0;
  lastServerError = null;
  browserDownUntil.places = 0;
  browserDownUntil.directions = 0;
  lastBrowserError.places = null;
  lastBrowserError.directions = null;
  tokens.clear();
  predictions.clear();
}
