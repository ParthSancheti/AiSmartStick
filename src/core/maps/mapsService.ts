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

export async function searchPlaces(input: { query?: string; category?: string; lat: number; lng: number; radiusM?: number }) {
  return call<typeof input, { places: PlaceResult[] }>('mapsSearch', input, 15000);
}

export async function placeDetails(placeId: string, sessionToken?: string) {
  return call<{ placeId: string; sessionToken?: string }, { place: PlaceResult }>('mapsPlace', { placeId, sessionToken }, 15000);
}

export interface Suggestion {
  placeId: string;
  main: string;
  secondary: string | null;
}

export async function autocomplete(input: string, lat: number, lng: number, sessionToken: string) {
  return call<{ input: string; lat: number; lng: number; sessionToken: string }, { suggestions: Suggestion[] }>('mapsAutocomplete', { input, lat, lng, sessionToken }, 10000);
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
