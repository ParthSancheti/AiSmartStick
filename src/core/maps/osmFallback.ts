import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { PlaceResult, RouteResult, RouteStepResult } from './mapsService';
import { ENV } from '../runtime/env';

/**
 * OpenStreetMap: the LAST resort for search and walking routes, used only when both Google paths
 * (Cloud Function and the in-app Maps JavaScript API) failed (destinationSearch.ts).
 *
 * Real data only: Photon (photon.komoot.io) for search/suggestions, the FOSSGIS OSRM foot router
 * (routing.openstreetmap.de) for walking routes. Both are free public services: requests are
 * throttled (Photon ≤ ~2/s), answers are cached briefly, every request has an 8 s limit.
 * Wherever these results are shown the UI must show OSM_ATTRIBUTION (ODbL requirement).
 *
 * Place ids are 'osm:<N|W|R><osm id>'. They are never sent to Google: an OSM place is looked up
 * from the in-memory cache (osmPlaceById) and always routed by its lat/lng.
 */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

const PHOTON = 'https://photon.komoot.io';
const OSRM_FOOT = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving';
export const OSM_TIMEOUT_MS = 8000;
/** Without a position: search India only (minLon,minLat,maxLon,maxLat). */
const INDIA_BBOX = '68.1,6.5,97.4,35.7';
const PHOTON_MIN_GAP_MS = 500;
export const OSM_MIN_SUGGEST_CHARS = 3;
const USER_AGENT = `AISmartStick/${ENV.appVersion} (assistive walking app)`;

type LatLng = { lat: number; lng: number };

/** Our categories (shared/tools.ts PLACE_CATEGORIES) → OSM tags and the word searched for. */
const CATEGORY: Record<string, { tags: string[]; word: string }> = {
  hospital: { tags: ['amenity:hospital'], word: 'hospital' },
  pharmacy: { tags: ['amenity:pharmacy', 'shop:chemist'], word: 'pharmacy' },
  atm: { tags: ['amenity:atm'], word: 'atm' },
  police: { tags: ['amenity:police'], word: 'police' },
  cafe: { tags: ['amenity:cafe'], word: 'cafe' },
  restaurant: { tags: ['amenity:restaurant'], word: 'restaurant' },
  bus_stop: { tags: ['highway:bus_stop', 'amenity:bus_station'], word: 'bus stop' },
  train_station: { tags: ['railway:station', 'railway:halt'], word: 'railway station' },
  supermarket: { tags: ['shop:supermarket'], word: 'supermarket' },
  mall: { tags: ['shop:mall'], word: 'mall' },
  salon: { tags: ['shop:hairdresser', 'shop:beauty'], word: 'salon' },
};

export class OsmError extends Error {
  constructor(
    public code: 'osm-timeout' | 'osm-http' | 'osm-network' | 'osm-bad-answer',
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- HTTP

function haversineM(a: LatLng, b: LatLng) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Native HTTP (sets our User-Agent, as the OSM services ask) on Android/iOS; fetch elsewhere. */
const useNativeHttp = () => {
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('CapacitorHttp');
  } catch {
    return false;
  }
};

/** GET JSON with a hard limit. Returns the parsed body even for an HTTP error (OSRM explains in it). */
async function getJson(url: string, what: string): Promise<{ status: number; data: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const limit = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      ctl?.abort();
      rej(new OsmError('osm-timeout', `${what} did not answer in ${Math.round(OSM_TIMEOUT_MS / 1000)} s.`));
    }, OSM_TIMEOUT_MS);
  });
  const request = async (): Promise<{ status: number; data: unknown }> => {
    if (useNativeHttp()) {
      const r = await CapacitorHttp.get({ url, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, connectTimeout: OSM_TIMEOUT_MS, readTimeout: OSM_TIMEOUT_MS, responseType: 'json' });
      let data: unknown = r.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          data = null;
        }
      }
      return { status: r.status, data };
    }
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctl?.signal });
    const data = await r.json().catch(() => null);
    return { status: r.status, data };
  };
  try {
    return await Promise.race([request(), limit]);
  } catch (e) {
    if (e instanceof OsmError) throw e;
    throw new OsmError('osm-network', `${what} could not be reached (${(e as Error)?.message || 'network error'}).`);
  } finally {
    clearTimeout(timer);
  }
}

/** Photon asks for fair use: at most ~2 requests per second from this app. */
let photonNextAt = 0;
async function photonSlot() {
  const now = Date.now();
  const at = Math.max(now, photonNextAt);
  photonNextAt = at + PHOTON_MIN_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

/** Short-lived answer cache (typing back and forth must not hit Photon again). */
const answers = new Map<string, { at: number; features: PhotonFeature[] }>();
const ANSWER_TTL_MS = 5 * 60_000;

/** Places from earlier OSM answers, for osmPlaceById (picking a suggestion, the assistant's ids). */
const places = new Map<string, PlaceResult>();
const MAX_PLACES = 300;
function remember(p: PlaceResult) {
  places.delete(p.placeId);
  places.set(p.placeId, p);
  if (places.size > MAX_PLACES) places.delete(places.keys().next().value as string);
}

// ---------------------------------------------------------------- Photon (search, suggestions)

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    osm_type?: string;
    osm_id?: number | string;
    osm_key?: string;
    osm_value?: string;
    name?: string;
    housenumber?: string;
    street?: string;
    locality?: string;
    district?: string;
    city?: string;
    county?: string;
    state?: string;
    country?: string;
  };
}

async function photon(path: '/api/' | '/reverse', params: [string, string][]): Promise<PhotonFeature[]> {
  const url = `${PHOTON}${path}?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
  const hit = answers.get(url);
  if (hit && Date.now() - hit.at < ANSWER_TTL_MS) return hit.features;
  await photonSlot();
  const { status, data } = await getJson(url, 'OpenStreetMap search');
  if (status < 200 || status >= 300) throw new OsmError('osm-http', `OpenStreetMap search failed (HTTP ${status}).`);
  const features = (data as { features?: PhotonFeature[] } | null)?.features;
  if (!Array.isArray(features)) throw new OsmError('osm-bad-answer', 'OpenStreetMap search gave an answer the app cannot read.');
  answers.set(url, { at: Date.now(), features });
  if (answers.size > 60) answers.delete(answers.keys().next().value as string);
  return features;
}

/** One Photon feature → PlaceResult (null without coordinates or an OSM id). Exported for tests. */
export function photonToPlace(f: PhotonFeature, bias: LatLng | null): PlaceResult | null {
  const p = f.properties ?? {};
  const c = f.geometry?.coordinates;
  if (!c || c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1]) || p.osm_id == null || !p.osm_type) return null;
  const lng = Number(c[0]);
  const lat = Number(c[1]);
  const line1 = [p.housenumber, p.street].filter(Boolean).join(' ');
  const name = p.name?.trim() || line1 || p.city || p.district || p.state || 'Unnamed place';
  const parts: string[] = [];
  for (const part of [line1, p.city ?? p.district ?? p.county, p.state]) {
    const t = part?.trim();
    if (t && t !== name && !parts.includes(t)) parts.push(t);
  }
  return {
    placeId: `osm:${p.osm_type.toUpperCase()}${p.osm_id}`,
    name,
    address: parts.length ? parts.join(', ') : null,
    lat,
    lng,
    distanceM: bias ? Math.round(haversineM(bias, { lat, lng })) : null,
    openNow: null,
    primaryType: p.osm_value ?? null,
  };
}

const where = (bias: LatLng | null): [string, string][] => (bias ? [['lat', bias.lat.toFixed(5)], ['lon', bias.lng.toFixed(5)]] : [['bbox', INDIA_BBOX]]);

function toPlaces(features: PhotonFeature[], bias: LatLng | null, tags: string[] | null) {
  const out: PlaceResult[] = [];
  for (const f of features) {
    // Photon filters by tag already; checked again so a wrong kind of place is never offered.
    if (tags && !tags.includes(`${f.properties?.osm_key}:${f.properties?.osm_value}`)) continue;
    const p = photonToPlace(f, bias);
    if (!p || out.some((x) => x.placeId === p.placeId)) continue;
    remember(p);
    out.push(p);
  }
  return out;
}

const byDistance = (a: PlaceResult, b: PlaceResult) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity);

/**
 * Text or category search. With a category and a position: the nearest places with that OSM tag
 * (Photon reverse, within the radius), else a tagged text search. Sorted by distance with a bias.
 */
export async function osmSearch(text: string, bias: LatLng | null, radiusM = 3000, category?: string): Promise<PlaceResult[]> {
  const cat = category ? CATEGORY[category] : undefined;
  const tags = cat?.tags ?? null;
  const tagParams: [string, string][] = (tags ?? []).map((t) => ['osm_tag', t]);
  const q = text.trim() || cat?.word || (category ? category.replace(/_/g, ' ') : '');
  if (!q) return [];
  let out: PlaceResult[] = [];
  if (tags && bias) {
    const radiusKm = Math.min(Math.max((radiusM * 2) / 1000, 1), 10);
    try {
      out = toPlaces(await photon('/reverse', [['lat', bias.lat.toFixed(5)], ['lon', bias.lng.toFixed(5)], ['radius', String(radiusKm)], ['limit', '8'], ['lang', 'en'], ...tagParams]), bias, tags);
    } catch {
      /* the text search below still runs */
    }
  }
  if (!out.length) out = toPlaces(await photon('/api/', [['q', q], ...where(bias), ['limit', '8'], ['lang', 'en'], ...tagParams]), bias, tags);
  return bias ? out.sort(byDistance) : out;
}

/** Autocomplete-style suggestions (3+ letters). */
export async function osmSuggest(text: string, bias: LatLng | null): Promise<{ placeId: string; main: string; secondary: string | null; distanceM: number | null }[]> {
  const q = text.trim();
  if (q.length < OSM_MIN_SUGGEST_CHARS) return [];
  const found = toPlaces(await photon('/api/', [['q', q], ...where(bias), ['limit', '8'], ['lang', 'en']]), bias, null);
  return found.slice(0, 6).map((p) => ({ placeId: p.placeId, main: p.name, secondary: p.address, distanceM: p.distanceM }));
}

/** A place from an earlier OSM answer (never looked up at Google). */
export function osmPlaceById(placeId: string): PlaceResult | null {
  return places.get(placeId) ?? null;
}

export const isOsmPlaceId = (placeId: string | null | undefined) => !!placeId && placeId.startsWith('osm:');

// ---------------------------------------------------------------- OSRM (walking route)

interface OsrmManeuver {
  type?: string;
  modifier?: string;
  location?: [number, number];
  bearing_after?: number;
  exit?: number;
}
interface OsrmStep {
  distance?: number;
  duration?: number;
  name?: string;
  ref?: string;
  driving_side?: string;
  geometry?: { coordinates?: [number, number][] };
  maneuver?: OsrmManeuver;
}
interface OsrmAnswer {
  code?: string;
  message?: string;
  routes?: { distance?: number; duration?: number; geometry?: { coordinates?: [number, number][] }; legs?: { steps?: OsrmStep[] }[] }[];
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const compass = (deg: number | undefined) => COMPASS[Math.round((((deg ?? 0) % 360) + 360) / 45) % 8];
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
const sideOf = (mod: string | undefined) => (mod?.includes('left') ? 'left' : mod?.includes('right') ? 'right' : null);

/** OSRM modifier → words and the same maneuver names the Google route mapping gives (navView.maneuverFrom reads both). */
function turn(mod: string | undefined, drivingSide: string | undefined): { text: string; maneuver: string } {
  switch (mod) {
    case 'left':
      return { text: 'Turn left', maneuver: 'TURN_LEFT' };
    case 'right':
      return { text: 'Turn right', maneuver: 'TURN_RIGHT' };
    case 'slight left':
      return { text: 'Turn slightly left', maneuver: 'TURN_SLIGHT_LEFT' };
    case 'slight right':
      return { text: 'Turn slightly right', maneuver: 'TURN_SLIGHT_RIGHT' };
    case 'sharp left':
      return { text: 'Turn sharp left', maneuver: 'TURN_SHARP_LEFT' };
    case 'sharp right':
      return { text: 'Turn sharp right', maneuver: 'TURN_SHARP_RIGHT' };
    case 'uturn':
      return { text: 'Make a U-turn', maneuver: drivingSide === 'right' ? 'UTURN_LEFT' : 'UTURN_RIGHT' };
    default:
      return { text: 'Continue straight', maneuver: 'STRAIGHT' };
  }
}

/** One OSRM step → readable instruction + maneuver. Exported for tests. */
export function osrmInstruction(s: OsrmStep): { instruction: string; maneuver: string | null } {
  const m = s.maneuver ?? {};
  const road = s.name?.trim() || s.ref?.trim() || '';
  const onto = road ? ` onto ${road}` : '';
  const mod = m.modifier;
  const straight = !mod || mod === 'straight';
  switch (m.type) {
    case 'depart':
      return { instruction: `Head ${compass(m.bearing_after)}${road ? ` on ${road}` : ''}`, maneuver: 'DEPART' };
    case 'arrive': {
      const side = sideOf(mod);
      return { instruction: `Arrive at your destination${side ? `, on the ${side}` : ''}`, maneuver: null };
    }
    case 'new name':
    case 'merge':
      if (straight) return { instruction: road ? `Continue onto ${road}` : 'Continue straight', maneuver: m.type === 'merge' ? 'MERGE' : 'NAME_CHANGE' };
      break;
    case 'continue':
    case 'notification':
    case 'use lane':
      if (straight) return { instruction: road ? `Continue straight on ${road}` : 'Continue straight', maneuver: 'STRAIGHT' };
      break;
    case 'end of road': {
      const t = turn(mod, s.driving_side);
      return { instruction: `At the end of the road, ${t.text.toLowerCase()}${onto}`, maneuver: t.maneuver };
    }
    case 'fork': {
      const side = sideOf(mod);
      return side ? { instruction: `Keep ${side} at the fork${onto}`, maneuver: side === 'left' ? 'FORK_LEFT' : 'FORK_RIGHT' } : { instruction: `Keep straight at the fork${onto}`, maneuver: 'STRAIGHT' };
    }
    case 'on ramp':
    case 'off ramp': {
      const side = sideOf(mod);
      return { instruction: `Take the ramp${side ? ` on the ${side}` : ''}${onto}`, maneuver: side === 'left' ? 'RAMP_LEFT' : side === 'right' ? 'RAMP_RIGHT' : 'STRAIGHT' };
    }
    case 'roundabout':
    case 'rotary': {
      const side = sideOf(mod);
      const exit = m.exit && m.exit > 0 ? `take the ${ordinal(m.exit)} exit` : 'go through it';
      return { instruction: `At the roundabout, ${exit}${onto}`, maneuver: mod === 'uturn' ? turn('uturn', s.driving_side).maneuver : side === 'left' ? 'ROUNDABOUT_LEFT' : side === 'right' ? 'ROUNDABOUT_RIGHT' : null };
    }
    case 'roundabout turn': {
      const t = turn(mod, s.driving_side);
      return { instruction: `At the roundabout, ${t.text.toLowerCase()}${onto}`, maneuver: t.maneuver };
    }
    case 'exit roundabout':
    case 'exit rotary':
      return { instruction: `Leave the roundabout${onto}`, maneuver: null };
    default:
      break;
  }
  const t = turn(mod, s.driving_side);
  return { instruction: `${t.text}${t.maneuver === 'STRAIGHT' ? (road ? ` on ${road}` : '') : onto}`, maneuver: t.maneuver };
}

const pt = (c: [number, number] | undefined): LatLng | null => (c && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? { lat: c[1], lng: c[0] } : null);

/** OSRM answer → RouteResult (throws 'no-route' when OSM has no walking route). Exported for tests. */
export function osrmToRoute(a: OsrmAnswer): RouteResult {
  if (a.code === 'NoRoute' || a.code === 'NoSegment') throw new Error('no-route');
  const r = a.routes?.[0];
  if (a.code !== 'Ok' || !r) throw new OsmError('osm-bad-answer', `OpenStreetMap route failed (${a.code ?? 'no answer'}${a.message ? `: ${a.message}` : ''}).`);
  const path = (r.geometry?.coordinates ?? []).map((c) => [c[1], c[0]] as [number, number]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (path.length < 2) throw new Error('no-route');
  const raw = (r.legs ?? []).flatMap((l) => l.steps ?? []);
  const steps: RouteStepResult[] = raw.map((s, i) => {
    const start = pt(s.maneuver?.location) ?? pt(s.geometry?.coordinates?.[0]) ?? { lat: path[0][0], lng: path[0][1] };
    const coords = s.geometry?.coordinates ?? [];
    const end = pt(coords[coords.length - 1]) ?? pt(raw[i + 1]?.maneuver?.location) ?? start;
    const { instruction, maneuver } = osrmInstruction(s);
    return { instruction, maneuver, distanceM: Math.round(s.distance ?? 0), durationS: Math.round(s.duration ?? 0), start, end };
  });
  return {
    distanceM: Math.round(r.distance ?? steps.reduce((x, s) => x + s.distanceM, 0)),
    durationS: Math.round(r.duration ?? steps.reduce((x, s) => x + s.durationS, 0)),
    path,
    steps,
    provider: 'osm',
  };
}

/** Walking route on OpenStreetMap data (FOSSGIS OSRM, foot profile). */
export async function osmRoute(origin: LatLng, dest: LatLng): Promise<RouteResult> {
  const c = (p: LatLng) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;
  const url = `${OSRM_FOOT}/${c(origin)};${c(dest)}?overview=full&geometries=geojson&steps=true`;
  const { status, data } = await getJson(url, 'OpenStreetMap route');
  const a = (data ?? {}) as OsrmAnswer;
  if (a.code === 'NoRoute' || a.code === 'NoSegment') throw new Error('no-route');
  if (status < 200 || status >= 300) throw new OsmError('osm-http', `OpenStreetMap route failed (HTTP ${status}${a.message ? `: ${a.message}` : ''}).`);
  return osrmToRoute(a);
}

/** Words for an OSM failure. */
export function osmErrorText(e: unknown): string {
  if (e instanceof OsmError) return e.message;
  return (e as Error)?.message || 'OpenStreetMap is unavailable.';
}

/** Test helper. */
export function __resetOsmForTests() {
  photonNextAt = 0;
  answers.clear();
  places.clear();
}
