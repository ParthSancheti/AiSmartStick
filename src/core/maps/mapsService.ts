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
 * Cloud Function errors in words the user (and the person setting the app up) can act on.
 * Firebase callable codes: https://firebase.google.com/docs/reference/js/functions#functionserrorcode
 */
export function friendlyMapsError(e: unknown): string {
  const code = String((e as { code?: string })?.code ?? '').replace(/^functions\//, '');
  const msg = (e as Error)?.message ?? '';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'No internet connection.';
  switch (code) {
    case 'unavailable':
    case 'deadline-exceeded':
      return 'Could not reach the server. Check the internet connection.';
    case 'unauthenticated':
      return 'Server refused the request (sign-in or App Check). See SETUP: App Check debug token for test APKs.';
    case 'permission-denied':
    case 'failed-precondition':
      return 'Server refused the request (App Check or Maps key). See SETUP.';
    case 'not-found':
      return 'Maps service is not deployed (firebase deploy --only functions).';
    case 'resource-exhausted':
      return 'Google Maps quota reached. Try again later.';
    case 'internal':
      return 'Google Maps server error (check MAPS_SERVER_KEY and enabled APIs).';
    default:
      return msg || 'Maps service unavailable.';
  }
}
