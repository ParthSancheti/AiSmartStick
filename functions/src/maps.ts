import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { CALLABLE, MAPS_SERVER_KEY, db, haversineM, num, quota, requireAuth, str } from './common';

/**
 * Google Maps Platform, server-side, with field masks (only the fields the app uses are
 * requested and billed). The server key is restricted to Places API (New), Routes API and
 * Geocoding API in Google Cloud and never leaves Secret Manager.
 */
const PLACES = 'https://places.googleapis.com/v1';
const ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const GEOCODE = 'https://maps.googleapis.com/maps/api/geocode/json';

const TYPES: Record<string, string[]> = {
  mall: ['shopping_mall'],
  pharmacy: ['pharmacy', 'drugstore'],
  hospital: ['hospital'],
  bus_stop: ['bus_stop', 'bus_station'],
  atm: ['atm'],
  cafe: ['cafe'],
  restaurant: ['restaurant'],
  salon: ['hair_salon', 'beauty_salon'],
  supermarket: ['supermarket', 'grocery_store'],
  police: ['police'],
  train_station: ['train_station', 'subway_station'],
};

const PLACE_FIELDS = 'places.id,places.displayName,places.formattedAddress,places.location,places.currentOpeningHours.openNow,places.primaryType';

function key() {
  const k = MAPS_SERVER_KEY.value();
  if (!k) throw new HttpsError('failed-precondition', 'Maps is not configured on the server.');
  return k;
}

async function gpost<T>(url: string, body: unknown, fieldMask: string): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key(), 'x-goog-fieldmask': fieldMask }, body: JSON.stringify(body) });
  if (!r.ok) throw new HttpsError('unavailable', `Maps request failed (${r.status}).`);
  return r.json() as Promise<T>;
}

interface GPlace {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  currentOpeningHours?: { openNow?: boolean };
  primaryType?: string;
}

/** distanceM is null when the phone sent no position (search works without GPS). */
const toPlace = (p: GPlace, from: { lat: number; lng: number } | null) => {
  const lat = p.location?.latitude ?? 0;
  const lng = p.location?.longitude ?? 0;
  return { placeId: p.id, name: p.displayName?.text ?? 'Unnamed place', address: p.formattedAddress ?? null, lat, lng, distanceM: from ? Math.round(haversineM(from, { lat, lng })) : null, openNow: p.currentOpeningHours?.openNow ?? null, primaryType: p.primaryType ?? null };
};

function point(d: Record<string, unknown>) {
  const lat = num(d.lat);
  const lng = num(d.lng);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpsError('invalid-argument', 'Bad coordinates.');
  return { lat, lng };
}

/** Optional search bias: absent → null (India-wide search); present but invalid → error. */
export function optionalPoint(d: Record<string, unknown>) {
  if (d.lat == null && d.lng == null) return null;
  return point(d);
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

const byDistance = (a: { distanceM: number | null }, b: { distanceM: number | null }) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity);

export const mapsSearch = onCall({ ...CALLABLE, secrets: [MAPS_SERVER_KEY] }, async (req) => {
  const uid = requireAuth(req);
  await quota(uid, 'maps', 30, 800);
  const d = (req.data ?? {}) as Record<string, unknown>;
  // The phone may have no GPS fix yet: then search India-wide (results unsorted, distanceM null).
  const from = optionalPoint(d);
  const radius = Math.min(Math.max(num(d.radiusM) ?? 3000, 100), 20000);
  const category = str(d.category, 40);
  const query = str(d.query, 120);

  if (category === 'home') {
    const home = await homeLocation(uid);
    if (!home) return { places: [] };
    return { places: [{ placeId: home.placeId, name: 'Home', address: home.address, lat: home.lat, lng: home.lng, distanceM: from ? Math.round(haversineM(from, home)) : null, openNow: null, primaryType: 'home' }] };
  }
  let places: GPlace[] = [];
  const bias = from ? { locationBias: { circle: { center: { latitude: from.lat, longitude: from.lng }, radius } } } : {};
  if (category && TYPES[category] && from) {
    const r = await gpost<{ places?: GPlace[] }>(`${PLACES}/places:searchNearby`, { includedTypes: TYPES[category], maxResultCount: 8, rankPreference: 'DISTANCE', locationRestriction: { circle: { center: { latitude: from.lat, longitude: from.lng }, radius } } }, PLACE_FIELDS);
    places = r.places ?? [];
  } else if (query || (category && CATEGORY_TEXT[category])) {
    const textQuery = query || CATEGORY_TEXT[category];
    const r = await gpost<{ places?: GPlace[] }>(`${PLACES}/places:searchText`, { textQuery, maxResultCount: 8, regionCode: 'in', ...bias }, PLACE_FIELDS);
    places = r.places ?? [];
  } else throw new HttpsError('invalid-argument', 'Give a category or a query.');
  const out = places.map((p) => toPlace(p, from));
  return { places: from ? out.sort(byDistance) : out };
});

/** Places Autocomplete (New). A session token groups keystrokes + the final details call for billing. */
export const mapsAutocomplete = onCall({ ...CALLABLE, secrets: [MAPS_SERVER_KEY] }, async (req) => {
  const uid = requireAuth(req);
  await quota(uid, 'autocomplete', 60, 2000);
  const d = (req.data ?? {}) as Record<string, unknown>;
  const input = str(d.input, 120);
  if (input.length < 2) return { suggestions: [] };
  // Bias around the phone when it knows where it is; otherwise India-wide (never refuse to search).
  const from = optionalPoint(d);
  const token = str(d.sessionToken, 64);
  const r = await gpost<{ suggestions?: { placePrediction?: { placeId: string; text?: { text: string }; structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } } } }[] }>(
    `${PLACES}/places:autocomplete`,
    { input, ...(from ? { locationBias: { circle: { center: { latitude: from.lat, longitude: from.lng }, radius: 5000 } }, origin: { latitude: from.lat, longitude: from.lng } } : {}), includedRegionCodes: ['in'], ...(token ? { sessionToken: token } : {}) },
    'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat',
  );
  return {
    suggestions: (r.suggestions ?? [])
      .map((x) => x.placePrediction)
      .filter((p): p is NonNullable<typeof p> => !!p?.placeId)
      .slice(0, 6)
      .map((p) => ({ placeId: p.placeId, main: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '', secondary: p.structuredFormat?.secondaryText?.text ?? null })),
  };
});

export const mapsPlace = onCall({ ...CALLABLE, secrets: [MAPS_SERVER_KEY] }, async (req) => {
  const uid = requireAuth(req);
  await quota(uid, 'maps', 30, 800);
  const id = str((req.data as Record<string, unknown>)?.placeId, 300);
  const token = str((req.data as Record<string, unknown>)?.sessionToken, 64);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new HttpsError('invalid-argument', 'Bad place id.');
  const r = await fetch(`${PLACES}/places/${id}${token ? `?sessionToken=${encodeURIComponent(token)}` : ''}`, { headers: { 'x-goog-api-key': key(), 'x-goog-fieldmask': 'id,displayName,formattedAddress,location,currentOpeningHours.openNow,primaryType' } });
  if (!r.ok) throw new HttpsError('not-found', 'Place not found.');
  const p = (await r.json()) as GPlace;
  return { place: toPlace(p, { lat: p.location?.latitude ?? 0, lng: p.location?.longitude ?? 0 }) };
});

interface GRoute {
  routes?: {
    distanceMeters?: number;
    duration?: string;
    polyline?: { encodedPolyline?: string };
    legs?: { steps?: { distanceMeters?: number; staticDuration?: string; navigationInstruction?: { maneuver?: string; instructions?: string }; startLocation?: { latLng: { latitude: number; longitude: number } }; endLocation?: { latLng: { latitude: number; longitude: number } } }[] }[];
  }[];
}

const secs = (d?: string) => (d ? Number(d.replace('s', '')) || 0 : 0);

export function decodePolyline(str: string): [number, number][] {
  let i = 0, lat = 0, lng = 0;
  const out: [number, number][] = [];
  while (i < str.length) {
    for (const w of [0, 1]) {
      let result = 0, shift = 0, b: number;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && i <= str.length);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (w === 0) lat += d;
      else lng += d;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

export const mapsRoute = onCall({ ...CALLABLE, secrets: [MAPS_SERVER_KEY] }, async (req) => {
  const uid = requireAuth(req);
  await quota(uid, 'routes', 20, 400);
  const d = (req.data ?? {}) as { origin?: Record<string, unknown>; destination?: Record<string, unknown> };
  const origin = point(d.origin ?? {});
  const dest = d.destination ?? {};
  const destination = typeof dest.placeId === 'string' && dest.placeId !== 'home' ? { placeId: str(dest.placeId, 300) } : dest.placeId === 'home' ? await homeWaypoint(uid) : (() => { const p = point(dest); return { location: { latLng: { latitude: p.lat, longitude: p.lng } } }; })();
  const r = await gpost<GRoute>(
    ROUTES,
    { origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } }, destination, travelMode: 'WALK', languageCode: 'en-IN', units: 'METRIC' },
    'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration,routes.legs.steps.navigationInstruction,routes.legs.steps.startLocation,routes.legs.steps.endLocation',
  );
  const route = r.routes?.[0];
  if (!route) throw new HttpsError('not-found', 'No walking route found.');
  const steps = (route.legs ?? []).flatMap((l) => l.steps ?? []).map((s) => ({
    instruction: s.navigationInstruction?.instructions ?? 'Continue',
    maneuver: s.navigationInstruction?.maneuver ?? null,
    distanceM: s.distanceMeters ?? 0,
    durationS: secs(s.staticDuration),
    start: { lat: s.startLocation?.latLng.latitude ?? 0, lng: s.startLocation?.latLng.longitude ?? 0 },
    end: { lat: s.endLocation?.latLng.latitude ?? 0, lng: s.endLocation?.latLng.longitude ?? 0 },
  }));
  return { distanceM: route.distanceMeters ?? 0, durationS: secs(route.duration), path: decodePolyline(route.polyline?.encodedPolyline ?? ''), steps };
});

export const mapsReverse = onCall({ ...CALLABLE, secrets: [MAPS_SERVER_KEY] }, async (req) => {
  const uid = requireAuth(req);
  await quota(uid, 'maps', 30, 800);
  const p = point((req.data ?? {}) as Record<string, unknown>);
  const g = await fetch(`${GEOCODE}?latlng=${p.lat},${p.lng}&result_type=street_address|premise|route|sublocality&language=en&key=${key()}`);
  const gj = (await g.json()) as { results?: { formatted_address: string }[] };
  const near = await gpost<{ places?: GPlace[] }>(`${PLACES}/places:searchNearby`, { maxResultCount: 1, rankPreference: 'DISTANCE', locationRestriction: { circle: { center: { latitude: p.lat, longitude: p.lng }, radius: 200 } } }, 'places.displayName,places.location').catch(() => ({ places: [] as GPlace[] }));
  const lm = near.places?.[0];
  return {
    address: gj.results?.[0]?.formatted_address ?? null,
    landmark: lm?.location ? { name: lm.displayName?.text ?? 'a place', distanceM: Math.round(haversineM(p, { lat: lm.location.latitude, lng: lm.location.longitude })) } : null,
  };
});

/** Geocodes the user's saved home address once and caches it (used by "take me home" and geofence). */
export async function homeLocation(uid: string): Promise<{ lat: number; lng: number; address: string; placeId: string } | null> {
  const ref = db.doc(`users/${uid}`);
  const u = await ref.get();
  // The exact point picked on the map during setup wins over geocoding the address text.
  const hp = u.get('homePlace') as { lat?: unknown; lng?: unknown; placeId?: unknown; address?: unknown } | undefined;
  if (hp && typeof hp.lat === 'number' && typeof hp.lng === 'number' && Math.abs(hp.lat) <= 90 && Math.abs(hp.lng) <= 180) {
    return { lat: hp.lat, lng: hp.lng, address: str(hp.address, 300), placeId: typeof hp.placeId === 'string' ? hp.placeId : '' };
  }
  const addr = str(u.get('homeAddress'), 300);
  if (!addr) return null;
  const cached = u.get('homeLocation');
  if (cached?.address === addr) return cached;
  const r = await fetch(`${GEOCODE}?address=${encodeURIComponent(addr)}&region=in&key=${key()}`);
  const j = (await r.json()) as { results?: { geometry: { location: { lat: number; lng: number } }; place_id: string }[] };
  const hit = j.results?.[0];
  if (!hit) return null;
  const home = { lat: hit.geometry.location.lat, lng: hit.geometry.location.lng, address: addr, placeId: hit.place_id };
  await ref.set({ homeLocation: home }, { merge: true });
  return home;
}

async function homeWaypoint(uid: string) {
  const h = await homeLocation(uid);
  if (!h) throw new HttpsError('failed-precondition', 'No home address saved.');
  return { location: { latLng: { latitude: h.lat, longitude: h.lng } } };
}
