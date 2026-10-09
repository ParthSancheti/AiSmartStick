import { importLibrary, setOptions } from '@googlemaps/js-api-loader';
import { ENV } from '../runtime/env';

/**
 * Maps JavaScript API (browser key): rendering, and the client-side FALLBACK for Places search and
 * walking directions when the Cloud Functions (server key) cannot be reached (destinationSearch.ts).
 * The browser key must allow: Maps JavaScript API, Places API (New), and Directions API where it can
 * still be turned on (new Google projects cannot enable the legacy Directions API; the app then
 * takes walking routes from the server or OpenStreetMap). Setup: docs/GOOGLE_CLOUD_SETUP.md.
 *
 * In the Android app the page origin is https://localhost, so the browser key's "Websites"
 * restriction must include https://localhost/* — an "Android apps" restriction does NOT apply to the
 * JavaScript API. Key/referrer problems are reported by Google through window.gm_authFailure and a
 * console error naming the cause; both are captured here so the map can say exactly what is wrong.
 */
export type MapsErrorKind = 'not_configured' | 'offline' | 'referrer' | 'api_not_enabled' | 'billing' | 'invalid_key' | 'auth' | 'load_failed';

export interface MapsError {
  kind: MapsErrorKind;
  /** Short, for the user. */
  message: string;
  /** What to fix (developer / settings), shown under the message. */
  hint: string | null;
  /** Google's error name when known, e.g. RefererNotAllowedMapError. */
  code: string | null;
}

const LOCAL_ORIGIN = typeof location !== 'undefined' ? location.origin : 'https://localhost';

/** Google error name (from the console message) → what it means. */
export function mapsErrorFromCode(code: string | null): MapsError {
  switch (code) {
    case 'RefererNotAllowedMapError':
    case 'RefererDeniedMapError':
      return {
        kind: 'referrer',
        code,
        message: 'Map blocked: the Google Maps key does not allow this app.',
        hint: `Google Cloud Console → Credentials → the browser key → Website restrictions: add ${LOCAL_ORIGIN}/* (Android app: https://localhost/*).`,
      };
    case 'ApiNotActivatedMapError':
    case 'ApiTargetBlockedMapError':
      return {
        kind: 'api_not_enabled',
        code,
        message: 'Map unavailable: Maps JavaScript API is not enabled for this key.',
        hint: 'Enable "Maps JavaScript API" in the Google Cloud project and allow it in the key\'s API restrictions.',
      };
    case 'BillingNotEnabledMapError':
    case 'OverQuotaMapError':
      return { kind: 'billing', code, message: 'Map unavailable: Google Maps billing or quota problem.', hint: 'Enable billing on the Google Cloud project (Maps needs a billing account).' };
    case 'InvalidKeyMapError':
    case 'ExpiredKeyMapError':
    case 'MissingKeyMapError':
    case 'DeletedApiProjectMapError':
    case 'ProjectDeniedMapError':
      return { kind: 'invalid_key', code, message: 'Map unavailable: the Google Maps key is not valid.', hint: 'Check VITE_GOOGLE_MAPS_BROWSER_KEY in .env, then rebuild the app.' };
    default:
      return { kind: 'auth', code, message: 'Map unavailable: Google rejected the Maps key.', hint: `Allow ${LOCAL_ORIGIN}/* (and https://localhost/* for Android) on the browser key and enable Maps JavaScript API.` };
  }
}

/** Any thrown value from loading → a MapsError. */
export function mapsErrorFrom(e: unknown): MapsError {
  const anyE = e as Partial<MapsError> | null;
  if (anyE && typeof anyE === 'object' && typeof anyE.kind === 'string' && 'hint' in anyE) return anyE as MapsError;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { kind: 'offline', code: null, message: 'Map needs internet. Your position is still tracked.', hint: null };
  const msg = (e as Error)?.message ?? String(e);
  if (/could not load|failed to fetch|network|timed out/i.test(msg)) return { kind: 'offline', code: null, message: 'Map could not load (no internet or Google blocked). Your position is still tracked.', hint: null };
  if (/not configured/i.test(msg)) return { kind: 'not_configured', code: null, message: 'Map unavailable: Google Maps is not configured in this build.', hint: 'Set VITE_GOOGLE_MAPS_BROWSER_KEY in .env and rebuild.' };
  return { kind: 'load_failed', code: null, message: `Map unavailable: ${msg}`, hint: null };
}

// ---------------------------------------------------------------- auth-failure capture

let authError: MapsError | null = null;
let lastCode: string | null = null;
const authListeners = new Set<(e: MapsError) => void>();
let hooksInstalled = false;
const CODE_RE = /Google Maps JavaScript API (?:error|warning): (\w+)/;

function publish() {
  authError = mapsErrorFromCode(lastCode);
  authListeners.forEach((l) => l(authError!));
}

function installAuthHooks() {
  if (hooksInstalled || typeof window === 'undefined') return;
  hooksInstalled = true;
  const w = window as unknown as { gm_authFailure?: () => void };
  const prev = w.gm_authFailure;
  w.gm_authFailure = () => {
    prev?.();
    // The console error naming the cause is logged around the same time; give it a tick.
    setTimeout(publish, 0);
  };
  for (const level of ['error', 'warn'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        const m = typeof args[0] === 'string' ? CODE_RE.exec(args[0]) : null;
        if (m && /MapError$/.test(m[1])) {
          lastCode = m[1];
          if (authError) publish(); // refine an already-reported failure
        }
      } catch {
        /* never break logging */
      }
      orig(...args);
    };
  }
}

/** Called when Google rejects the key (possibly after the map was created). Returns unsubscribe. */
export function onMapsAuthFailure(cb: (e: MapsError) => void) {
  authListeners.add(cb);
  if (authError) cb(authError);
  return () => {
    authListeners.delete(cb);
  };
}

export const currentMapsAuthError = () => authError;

// ---------------------------------------------------------------- loading

let configured = false;
const LOAD_TIMEOUT_MS = 20_000;

export async function loadMaps() {
  configure();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error('Google Maps timed out')), LOAD_TIMEOUT_MS);
  });
  try {
    const maps = await Promise.race([importLibrary('maps'), timeout]);
    // Advanced markers are optional: without them RealMap draws classic markers.
    const marker = await Promise.race([importLibrary('marker'), timeout]).catch(() => null);
    return { maps, marker };
  } catch (e) {
    throw mapsErrorFrom(e);
  } finally {
    clearTimeout(timer);
  }
}

function configure() {
  if (!ENV.mapsBrowserKey) throw mapsErrorFrom(new Error('Google Maps is not configured (VITE_GOOGLE_MAPS_BROWSER_KEY).'));
  if (authError) throw authError;
  installAuthHooks();
  if (!configured) {
    setOptions({ key: ENV.mapsBrowserKey, v: 'weekly', language: 'en', region: 'IN' });
    configured = true;
  }
}

async function lib<T>(name: 'places' | 'routes'): Promise<T> {
  configure();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return (await Promise.race([
      importLibrary(name) as Promise<T>,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error('Google Maps timed out')), LOAD_TIMEOUT_MS);
      }),
    ])) as T;
  } catch (e) {
    throw mapsErrorFrom(e);
  } finally {
    clearTimeout(timer);
  }
}

/** Places (New) in the browser: AutocompleteSuggestion, Place.searchByText, Place.fetchFields. */
export const loadPlacesLibrary = () => lib<google.maps.PlacesLibrary>('places');
/** DirectionsService (walking routes in the browser). */
export const loadRoutesLibrary = () => lib<google.maps.RoutesLibrary>('routes');

/** Test helper. */
export function __resetMapsLoaderForTests() {
  authError = null;
  lastCode = null;
  authListeners.clear();
}

/** Test helper: simulate Google's auth failure callback + console message. */
export function __simulateMapsAuthFailure(code: string | null) {
  lastCode = code;
  publish();
}
