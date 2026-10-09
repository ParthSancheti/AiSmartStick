import { create } from 'zustand';
import { SETUP_AP_HOST } from '../../../shared/deviceProtocol';
import { AissNative } from '../native/aissNative';

/**
 * Every HTTP request to the stick goes through here, over a FALLBACK CHAIN (the first path that
 * really reaches the stick wins and is remembered):
 *
 *   1. native         AissNative.setupRequest — the bound stick Wi-Fi (WifiNetworkSpecifier), or the
 *                     Wi-Fi the user joined by hand (any network on 192.168.4.x).
 *   2. native-default AissNative.setupRequest({ route: 'default' }) — the process' default network
 *                     (phone's Wi-Fi IS the stick and mobile data is off, or "Use stick Wi-Fi for the
 *                     whole app" is on).
 *   3. webview        fetch('http://192.168.4.1/…') from the WebView (needs the default route to be the
 *                     stick and mixed content allowed).
 *
 * The plugin is imported STATICALLY. Never resolve a Promise with a Capacitor plugin object
 * (an `import()` whose `.then` returns the plugin): the plugin Proxy answers `.then` like a plugin method,
 * so the Promise never settles. That exact line kept the live link on "Connecting…" forever.
 *
 * Every native call has a JS-side timeout, so nothing here can hang.
 */
export type StickPath = 'native' | 'native-default' | 'webview';
export const STICK_PATHS: StickPath[] = ['native', 'native-default', 'webview'];

export interface StickResponse {
  status: number;
  text: string;
  path: StickPath;
  /** Native route actually used: bound | wifi | default | process. */
  via?: string;
  ms: number;
}

export interface StickBinaryResponse {
  status: number;
  bytes: Uint8Array | null;
  contentType: string | null;
  path: StickPath;
  via?: string;
  ms: number;
}

export interface PathResult {
  ok: boolean;
  at: number;
  ms: number;
  status?: number;
  error?: string;
  via?: string;
}

interface RouteState {
  /** The path that last reached the stick; tried first. */
  preferred: StickPath | null;
  results: Partial<Record<StickPath, PathResult>>;
  lastError: string | null;
  /** "Use stick Wi-Fi for the whole app" (native bindProcessToNetwork). Off by default. */
  wholeApp: boolean;
}

export const useStickRoute = create<RouteState>(() => ({ preferred: null, results: {}, lastError: null, wholeApp: false }));

export const isNativeApp = () => typeof window !== 'undefined' && (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() === true;

export class TimeoutError extends Error {}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => (t = setTimeout(() => rej(new TimeoutError(`${what} timed out after ${Math.round(ms / 100) / 10} s`)), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/** Fallback paths are tried at most this often while the preferred one fails (each costs a timeout). */
const FALLBACK_EVERY_MS = 4000;
/** Fallback paths get a short timeout: on mobile data 192.168.4.1 never answers. */
const FALLBACK_TIMEOUT_MS = 1500;
let lastFallbackAt = 0;

/** Test hook. */
export function resetStickRoute() {
  lastFallbackAt = 0;
  useStickRoute.setState({ preferred: null, results: {}, lastError: null });
}

function order(): StickPath[] {
  if (!isNativeApp()) return ['webview'];
  const pref = useStickRoute.getState().preferred;
  return pref ? [pref, ...STICK_PATHS.filter((p) => p !== pref)] : [...STICK_PATHS];
}

/** probe = a Connection-test request pinned to one path: recorded, but never changes the path in use. */
function record(path: StickPath, r: PathResult, probe = false) {
  useStickRoute.setState((s) => ({
    results: { ...s.results, [path]: r },
    ...(probe ? {} : r.ok ? { preferred: path, lastError: null } : { lastError: `${path}: ${r.error ?? 'failed'}` }),
  }));
}

/**
 * An answer that came from the stick (and not from some other box at 192.168.4.1: a home router, a
 * captive portal or a proxy answering 403 with an HTML page). The firmware answers JSON on every
 * /api/v1 route (errors too: {"error":"unauthorized"}) and plain text "AI SmartStick …" on "/".
 */
export function looksLikeStick(status: number, text: string) {
  const t = text.trimStart();
  if (t.startsWith('AI SmartStick')) return status === 200;
  if (!t.startsWith('{')) return false;
  if (status === 401 || status === 403) return /"error"\s*:/.test(t); // old secure firmware
  return [200, 400, 409, 413, 503].includes(status);
}

export interface RequestOpts {
  body?: string;
  bodyBase64?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Use exactly this path (Connection test). */
  only?: StickPath;
  /** WebView path only: host to fetch (tests / a dev laptop); the native plugin always uses 192.168.4.1. */
  host?: string;
}

const anySignal = (a: AbortSignal | undefined, b: AbortSignal) => (a && typeof AbortSignal.any === 'function' ? AbortSignal.any([a, b]) : b);

async function attempt(path: StickPath, method: 'GET' | 'POST', p: string, o: RequestOpts, timeoutMs: number): Promise<StickResponse> {
  const t0 = Date.now();
  if (path === 'webview') {
    const signal = anySignal(o.signal, AbortSignal.timeout(timeoutMs));
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    let body: BodyInit | undefined;
    if (o.bodyBase64 != null) {
      const bin = atob(o.bodyBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      body = bytes;
      headers['content-type'] = 'application/octet-stream';
    } else if (o.body) {
      body = o.body;
      // text/plain keeps this a CORS "simple request" (no OPTIONS preflight): the firmware parses the
      // body as JSON whatever the content type, and older stick firmware has no OPTIONS route.
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'text/plain;charset=UTF-8';
    }
    const r = await fetch(`http://${o.host ?? SETUP_AP_HOST}${p}`, { method, headers, body, signal, cache: 'no-store' });
    return { status: r.status, text: await r.text(), path, ms: Date.now() - t0 };
  }
  const r = await withTimeout(
    AissNative.setupRequest({ method, path: p, body: o.body, bodyBase64: o.bodyBase64, headers: o.headers, timeoutMs, ...(path === 'native-default' ? { route: 'default' as const } : {}) }),
    timeoutMs + 2500,
    `${method} ${p}`,
  );
  return { status: r.status, text: r.body ?? '', path, via: r.via, ms: Date.now() - t0 };
}

/**
 * One request over the best path. Throws the PREFERRED path's error when every path failed (so
 * "not bound" from the native plugin still reaches the transport and triggers a fast re-bind).
 */
export async function stickRequest(method: 'GET' | 'POST', path: string, o: RequestOpts = {}): Promise<StickResponse> {
  const timeoutMs = o.timeoutMs ?? 2000;
  const paths = o.only ? [o.only] : order();
  let firstErr: Error | null = null;
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    if (i === 1) {
      if (Date.now() - lastFallbackAt < FALLBACK_EVERY_MS) break;
      lastFallbackAt = Date.now();
    }
    const t0 = Date.now();
    try {
      const r = await attempt(p, method, path, o, i === 0 ? timeoutMs : Math.min(timeoutMs, FALLBACK_TIMEOUT_MS));
      if (!looksLikeStick(r.status, r.text)) throw new Error(`HTTP ${r.status} from something that is not the stick`);
      record(p, { ok: true, at: Date.now(), ms: r.ms, status: r.status, via: r.via }, !!o.only);
      return r;
    } catch (e) {
      const err = e as Error;
      record(p, { ok: false, at: Date.now(), ms: Date.now() - t0, error: err.message.slice(0, 160) }, !!o.only);
      firstErr ??= err;
      if (o.signal?.aborted) break;
    }
  }
  throw firstErr ?? new Error('no path to the stick');
}

/** GET returning bytes (camera JPEG), same chain. */
export async function stickBinary(path: string, o: { timeoutMs?: number; only?: StickPath; headers?: Record<string, string>; host?: string } = {}): Promise<StickBinaryResponse> {
  const timeoutMs = o.timeoutMs ?? 6000;
  const paths = o.only ? [o.only] : order();
  let firstErr: Error | null = null;
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    if (i === 1) {
      if (Date.now() - lastFallbackAt < FALLBACK_EVERY_MS) break;
      lastFallbackAt = Date.now();
    }
    const t0 = Date.now();
    const tm = i === 0 ? timeoutMs : Math.min(timeoutMs, 3000);
    try {
      let res: StickBinaryResponse;
      if (p === 'webview') {
        const r = await fetch(`http://${o.host ?? SETUP_AP_HOST}${path}`, { signal: AbortSignal.timeout(tm), cache: 'no-store', headers: o.headers });
        const ct = r.headers.get('content-type');
        res = { status: r.status, bytes: r.ok ? new Uint8Array(await r.arrayBuffer()) : null, contentType: ct, path: p, ms: Date.now() - t0 };
      } else {
        const r = await withTimeout(AissNative.requestBinary({ path, timeoutMs: tm, headers: o.headers, ...(p === 'native-default' ? { route: 'default' as const } : {}) }), tm + 2500, `GET ${path}`);
        let bytes: Uint8Array | null = null;
        if (r.status < 400 && r.body) {
          const bin = atob(r.body);
          bytes = new Uint8Array(bin.length);
          for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
        }
        res = { status: r.status, bytes, contentType: r.contentType ?? null, path: p, via: r.via, ms: Date.now() - t0 };
      }
      // Native errors carry no body/content type; WebView errors must be the firmware's JSON.
      const errOk = p === 'webview' ? /json/i.test(res.contentType ?? '') : true;
      const stickLike = ((res.status === 409 || res.status === 503 || res.status === 401 || res.status === 403) && errOk) || (res.status === 200 && (!res.contentType || /jpeg/i.test(res.contentType)));
      if (!stickLike) throw new Error(`HTTP ${res.status} from something that is not the stick`);
      record(p, { ok: true, at: Date.now(), ms: res.ms, status: res.status, via: res.via }, !!o.only);
      return res;
    } catch (e) {
      const err = e as Error;
      record(p, { ok: false, at: Date.now(), ms: Date.now() - t0, error: err.message.slice(0, 160) }, !!o.only);
      firstErr ??= err;
    }
  }
  throw firstErr ?? new Error('no path to the stick');
}

/**
 * LAST-RESORT fallback: route the WHOLE app over the stick's Wi-Fi (Android bindProcessToNetwork).
 * Maps, the assistant, Firebase and SOS-over-internet stop working while it is on (the stick has no
 * internet; SMS still works). Off by default; turning it off releases it at once.
 */
export async function setWholeAppOnStick(on: boolean): Promise<{ bound: boolean; reason?: string }> {
  if (!isNativeApp()) return { bound: false, reason: 'Android app only' };
  try {
    const r = await withTimeout(AissNative.setProcessBinding({ on }), 5000, 'process binding');
    useStickRoute.setState({ wholeApp: on && r.bound });
    return r;
  } catch (e) {
    useStickRoute.setState({ wholeApp: false });
    return { bound: false, reason: (e as Error).message };
  }
}

/** [SMARTSTICK] console line (shows in `npm run logcat` as Capacitor/Console). */
export function stickLog(msg: string, extra?: unknown) {
  if (extra === undefined) console.info(`[SMARTSTICK] ${msg}`);
  else console.info(`[SMARTSTICK] ${msg}`, typeof extra === 'string' ? extra : JSON.stringify(extra));
}
