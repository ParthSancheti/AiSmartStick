import { call } from '../backend/api';

/**
 * Places and Routes go through Cloud Functions (functions/src/maps.ts) so the server key,
 * field masks and quotas are controlled centrally. The AI never supplies coordinates:
 * it asks for a search, Google returns real places, the app picks by rule (nearest open).
 */
export interface PlaceResult {
  placeId: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  distanceM: number | null;
  openNow: boolean | null;
  primaryType: string | null;
}

export interface RouteStepResult {
  instruction: string;
  maneuver: string | null;
  distanceM: number;
  durationS: number;
  start: { lat: number; lng: number };
  end: { lat: number; lng: number };
}

export interface RouteResult {
  distanceM: number;
  durationS: number;
  /** Decoded polyline [lat, lng][] */
  path: [number, number][];
  steps: RouteStepResult[];
  /** Whose map data the route is on. Absent = Google. 'osm' = OpenStreetMap (show its attribution). */
  provider?: 'google' | 'osm';
}

/** lat/lng are optional: without a position Google searches India-wide (distanceM is then null). */
export async function searchPlaces(input: { query?: string; category?: string; lat?: number | null; lng?: number | null; radiusM?: number }) {
  const { lat, lng, ...rest } = input;
  const data = lat != null && lng != null ? { ...rest, lat, lng } : rest;
  return call<typeof data, { places: PlaceResult[] }>('mapsSearch', data, 15000);
}

export async function placeDetails(placeId: string, sessionToken?: string) {
  return call<{ placeId: string; sessionToken?: string }, { place: PlaceResult }>('mapsPlace', { placeId, sessionToken }, 15000);
}

export interface Suggestion {
  placeId: string;
  main: string;
  secondary: string | null;
}

/** lat/lng only bias the results; null = no position yet (search still works). */
export async function autocomplete(input: string, lat: number | null | undefined, lng: number | null | undefined, sessionToken: string) {
  const data = lat != null && lng != null ? { input, lat, lng, sessionToken } : { input, sessionToken };
  return call<typeof data, { suggestions: Suggestion[] }>('mapsAutocomplete', data, 10000);
}

export async function walkingRoute(input: { origin: { lat: number; lng: number }; destination: { lat: number; lng: number } | { placeId: string } }) {
  return call<typeof input, RouteResult>('mapsRoute', input, 20000);
}

/** Google encoded polyline → [lat, lng][] (used by the backend response and tests). */
export function decodePolyline(str: string): [number, number][] {
  let index = 0;
  let lat = 0;
  let lng = 0;
  const out: [number, number][] = [];
  while (index < str.length) {
    for (const which of [0, 1] as const) {
      let result = 0;
      let shift = 0;
      let b: number;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && index < str.length + 1);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d;
      else lng += d;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

export interface ReverseResult {
  address: string | null;
  landmark: { name: string; distanceM: number } | null;
}

/** Nearest street address + nearest named place (server-side Geocoding + Places Nearby). */
export async function reverseLookup(lat: number, lng: number) {
  return call<{ lat: number; lng: number }, ReverseResult>('mapsReverse', { lat, lng }, 15000);
}

/**
 * "Maps request failed (403). Google says: PERMISSION_DENIED: Places API (New) has not been used in
 * project 1 before or it is disabled. …" → short words with Google's first sentence; null otherwise.
 */
function serverGoogleRefusal(msg: string): string | null {
  const m = /Maps request failed \((\d+)\)\.?(?:\s*Google says:\s*(.*))?/i.exec(msg);
  if (!m) return null;
  const why = (m[2] ?? '')
    .replace(/^[A-Z][A-Z_]+:\s*/, '')
    .split(/\.\s/)[0]
    .replace(/\.$/, '')
    .trim()
    .slice(0, 140);
  return `Google Maps refused the server's request (HTTP ${m[1]}${why ? `: ${why}` : ''}). Check MAPS_SERVER_KEY and the enabled APIs.`;
}

/**
 * Cloud Function errors in words the user (and the person setting the app up) can act on.
 * Firebase callable codes: https://firebase.google.com/docs/reference/js/functions#functionserrorcode
 */
export function friendlyMapsError(e: unknown): string {
  const code = String((e as { code?: string })?.code ?? '').replace(/^functions\//, '');
  const msg = (e as Error)?.message ?? '';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'No internet connection.';
  // Google refused the server's own request (functions/src/maps.ts gpost): say why, not "no internet".
  const refused = serverGoogleRefusal(msg);
  if (refused && (code === 'unavailable' || code === 'failed-precondition')) return refused;
  switch (code) {
    case 'deadline-exceeded':
      // Always a client-side limit (ours or the Firebase SDK's): the phone gave up waiting.
      return /did not answer in \d+/i.test(msg) ? msg : 'The server did not answer in time (slow first start, App Check, or functions not deployed).';
    case 'unavailable':
      return 'Could not reach the server. Check the internet connection.';
    case 'unauthenticated':
      return 'Server refused the request (sign-in or App Check). See docs/GOOGLE_CLOUD_SETUP.md, "6 App Check".';
    case 'permission-denied':
    case 'failed-precondition':
      if (/not configured/i.test(msg)) return 'Maps is not set up on the server (MAPS_SERVER_KEY). See docs/GOOGLE_CLOUD_SETUP.md, "4 Server key".';
      return 'Server refused the request (App Check or Maps key). See docs/GOOGLE_CLOUD_SETUP.md.';
    case 'not-found':
      return 'Maps service is not deployed (firebase deploy --only functions).';
    case 'resource-exhausted':
      return 'Google Maps quota reached. Try again later.';
    case 'internal':
      // A bare "internal" is what the Firebase SDK reports when the request never got a readable
      // answer: no connection, a function that is not deployed (no CORS answer), or a crash.
      if (!msg || /^internal$/i.test(msg.trim())) return 'The server could not be reached or failed (no internet, functions not deployed, or a server error).';
      return 'Google Maps server error (check MAPS_SERVER_KEY and enabled APIs).';
    default:
      return msg || 'Maps service unavailable.';
  }
}
