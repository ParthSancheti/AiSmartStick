import { create } from 'zustand';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { Geolocation, type Position } from '@capacitor/geolocation';
import { App } from '@capacitor/app';
import { AissLocation, type NativeFix, type NativeLocationStatus, type NativePermission } from '../native/aissLocation';
import { log } from '../log';

/**
 * Real GPS for the stick user's phone. Exposes accuracy, freshness, permission and the reason a
 * position is missing so the UI never calls an old position "Live" and always offers the one action
 * that fixes it. Never invents a position.
 *
 * Android: the app's own AissLocation plugin (android.location.LocationManager: GPS + network +
 * system fused + passive). It works without Google Play Services, accepts an "Approximate" grant and
 * reports the Location switch. If that plugin is missing (old APK) it falls back to
 * @capacitor/geolocation. Web: the browser's geolocation via @capacitor/geolocation.
 * Background tracking requires the Android foreground service (ANDROID_SETUP.md).
 *
 * Belt and braces (a phone that "allows" location but never delivers a position):
 * - every native call has a timeout, so one lost answer can never freeze location for the session;
 * - one permission request at a time (a second dialog would be cancelled by Android at once);
 * - if AissLocation gives no live position within FALLBACK_AFTER_MS, @capacitor/geolocation
 *   (Google Play Services) and then the WebView's own geolocation are started as well, and
 *   whichever delivers is used;
 * - a watchdog restarts GPS by itself when it should run but does not (no dialog from it).
 * Every step is logged as "[LOCATION] …" (WebView console → logcat "Capacitor/Console").
 */
export interface Fix {
  lat: number;
  lng: number;
  accuracyM: number;
  altitude: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  ts: number;
}

export type LocationPermission = 'unknown' | 'granted' | 'denied' | 'prompt';
export type LocationStatusCode = 'idle' | 'acquiring' | 'ok' | 'stale' | 'poor' | 'error' | 'unavailable';
/**
 * Why there is no usable position:
 * - denied: blocked with "Don't ask again" → app settings
 * - prompt: not allowed yet (dialog dismissed) → ask again
 * - off: the phone's Location switch is off → location settings
 * - no_provider: this phone has no usable location source
 * - no_signal: switched on and allowed, but no fix yet (indoors)
 * - unsupported: no geolocation at all (old browser)
 * - error: anything else (see `error`)
 */
export type LocationReason = 'denied' | 'prompt' | 'off' | 'no_provider' | 'no_signal' | 'unsupported' | 'error' | null;

export interface LocationState {
  permission: LocationPermission;
  /** false = "Approximate" only (Android 12+): fine for SOS, too coarse for walking directions. */
  precise: boolean | null;
  /** The phone's Location switch (null = unknown). */
  servicesOn: boolean | null;
  status: LocationStatusCode;
  reason: LocationReason;
  fix: Fix | null;
  error: string | null;
  source: 'android' | 'capacitor' | 'browser' | null;
  /** Where the current fix came from (the fallbacks can deliver while AissLocation is silent). */
  fixSource: FixSource | null;
}

export type FixSource = 'android' | 'capacitor' | 'webview' | 'browser';

const INITIAL: LocationState = { permission: 'unknown', precise: null, servicesOn: null, status: 'idle', reason: null, fix: null, error: null, source: null, fixSource: null };
export const useLocation = create<LocationState>(() => ({ ...INITIAL }));

export const LOCATION_STALE_MS = 30_000;
export const POOR_ACCURACY_M = 50;
/** No first fix after this long → tell the user why (indoors) instead of spinning forever. */
export const NO_SIGNAL_MS = 25_000;
/** AissLocation silent this long → also start @capacitor/geolocation / WebView geolocation. */
export const FALLBACK_AFTER_MS = 10_000;
/** GPS should run but does not → the watchdog retries (never with a dialog) this often. */
export const WATCHDOG_MS = 15_000;

export const MSG = {
  denied: 'Location permission is blocked for AI SmartStick.',
  prompt: 'Location is not allowed yet.',
  off: 'Location is switched off on this phone.',
  noProvider: 'This phone has no location source available.',
  noSignal: 'No GPS signal yet. Move near a window or outdoors.',
  unsupported: 'This browser cannot share your location.',
} as const;

const listeners = new Set<(f: Fix) => void>();
/** Fresh fixes only (never an old cached position): navigation, walk tracking. */
export const onFix = (cb: (f: Fix) => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

/** Live diagnostics for the Location test page. */
export interface LocationDiag {
  /** Live (fresh) positions accepted since start. */
  updates: number;
  bySource: Partial<Record<FixSource, number>>;
  lastUpdateAt: number | null;
  /** Secondary sources started because AissLocation stayed silent. */
  fallback: ('capacitor' | 'webview')[];
  /** Recent "[LOCATION]" lines, newest last. */
  lines: string[];
}
const DIAG0: LocationDiag = { updates: 0, bySource: {}, lastUpdateAt: null, fallback: [], lines: [] };
export const useLocationDiag = create<LocationDiag>(() => ({ ...DIAG0, bySource: {}, fallback: [], lines: [] }));

/** "[LOCATION] …" in the console (→ logcat) and in the diagnostics ring. */
export function locLog(msg: string, meta?: Record<string, unknown>) {
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}${meta ? ` ${safeJson(meta)}` : ''}`;
  try {
    console.info(`[LOCATION] ${msg}`, meta ?? '');
  } catch {
    /* console unavailable */
  }
  log.info(`location: ${msg}`, meta);
  const lines = [...useLocationDiag.getState().lines, line];
  useLocationDiag.setState({ lines: lines.slice(-60) });
}
const safeJson = (v: unknown) => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

/** Rejects after `ms` (the native bridge can lose an answer, e.g. when the activity is recreated). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(new Error(`${what} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

let running: LocationState['source'] = null;
/** GPS was asked for (startLocation) and not stopped (sign-out). */
let wanted = false;
let starting: Promise<void> | null = null;
let startedAt = 0;
let watchId: string | null = null;
let nativeSubs: PluginListenerHandle[] = [];
let tick: ReturnType<typeof setInterval> | undefined;
let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
let watchdog: ReturnType<typeof setInterval> | undefined;
/** Secondary watches started by the fallback (never the primary source). */
let fallbackWatchId: string | null = null;
let webWatchId: number | null = null;
let permissionFlight: Promise<NativePermission> | null = null;

const set = (p: Partial<LocationState>) => useLocation.setState(p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isAndroidNative = () => Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('AissLocation');

function fixStatus(fix: Fix, now = Date.now()): LocationStatusCode {
  if (now - fix.ts > LOCATION_STALE_MS) return 'stale';
  return fix.accuracyM > POOR_ACCURACY_M ? 'poor' : 'ok';
}

/** Applies a position. Old (cached) fixes are shown with their age but never fed to navigation. */
export function acceptFix(fix: Fix, from: FixSource = 'android') {
  if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lng) || (fix.lat === 0 && fix.lng === 0)) return;
  const now = Date.now();
  // A wrong GPS/phone clock must not push the timestamp into the future (newer fixes would be dropped).
  if (!Number.isFinite(fix.ts) || fix.ts > now + 2000) fix = { ...fix, ts: now };
  const s = useLocation.getState();
  if (s.fix && fix.ts < s.fix.ts) return; // out of order
  // Two sources at once (fallback running): a much coarser fix from the other source must not
  // replace a precise one that is only a few seconds old (the dot would jump to the Wi-Fi guess).
  if (s.fix && s.fixSource && s.fixSource !== from && now - s.fix.ts < 5000 && fix.accuracyM > s.fix.accuracyM * 2 && fix.accuracyM > 20) return;
  const fresh = now - fix.ts <= LOCATION_STALE_MS;
  if (fresh) {
    set({ fix, fixSource: from, status: fixStatus(fix, now), reason: null, error: null, permission: 'granted', servicesOn: true });
    const d = useLocationDiag.getState();
    if (d.updates === 0) locLog(`first live position from ${from}`, { accuracyM: Math.round(fix.accuracyM) });
    useLocationDiag.setState({ updates: d.updates + 1, lastUpdateAt: now, bySource: { ...d.bySource, [from]: (d.bySource[from] ?? 0) + 1 } });
    listeners.forEach((l) => l(fix));
  } else {
    // Cached position: keep showing why it isn't live (location off, no signal).
    const keep = s.reason === 'off' || s.reason === 'no_provider' || s.status === 'error';
    set(keep ? { fix, fixSource: from } : { fix, fixSource: from, status: 'stale' });
  }
}

/** The newest position of any age (null = never had one). Never presented as live by itself. */
export const lastKnownFix = () => useLocation.getState().fix;
const hasFreshFix = (since = 0) => {
  const f = useLocation.getState().fix;
  return !!f && f.ts >= since && Date.now() - f.ts <= LOCATION_STALE_MS;
};

function fromNative(f: NativeFix): Fix {
  return {
    lat: f.lat,
    lng: f.lng,
    accuracyM: f.accuracy,
    altitude: f.altitude ?? null,
    speedMps: f.speed ?? null,
    headingDeg: f.bearing ?? null,
    ts: f.time || Date.now(),
  };
}

function fromPosition(p: Position): Fix {
  const c = p.coords;
  return {
    lat: c.latitude,
    lng: c.longitude,
    accuracyM: c.accuracy,
    altitude: c.altitude ?? null,
    speedMps: c.speed ?? null,
    headingDeg: c.heading ?? null,
    ts: p.timestamp || Date.now(),
  };
}

function setPermissionProblem(state: 'denied' | 'prompt') {
  set({ permission: state, status: 'error', reason: state, error: state === 'denied' ? MSG.denied : MSG.prompt });
}

function applyServices(enabled: boolean) {
  const s = useLocation.getState();
  if (!enabled) {
    set({ servicesOn: false, status: 'unavailable', reason: 'off', error: MSG.off });
    return;
  }
  if (s.reason === 'off' || s.servicesOn !== true) {
    startedAt = Date.now(); // the no-signal clock restarts when the switch comes on
    const fresh = s.fix && Date.now() - s.fix.ts <= LOCATION_STALE_MS;
    set({ servicesOn: true, status: fresh && s.fix ? fixStatus(s.fix) : s.fix ? 'stale' : 'acquiring', reason: s.reason === 'off' ? null : s.reason, error: s.reason === 'off' ? null : s.error });
  }
}

function onNativeStatus(st: NativeLocationStatus) {
  if (typeof st?.enabled === 'boolean') applyServices(st.enabled);
}

function startTick() {
  clearInterval(tick);
  tick = setInterval(() => {
    const s = useLocation.getState();
    if (!running) return;
    if (s.fix && (s.status === 'ok' || s.status === 'poor') && Date.now() - s.fix.ts > LOCATION_STALE_MS) set({ status: 'stale' });
    const waiting = s.status === 'acquiring' || (s.status === 'stale' && s.reason === null);
    if (waiting && s.reason === null && Date.now() - startedAt > NO_SIGNAL_MS) set({ reason: 'no_signal', error: MSG.noSignal });
  }, 5000);
}

// ------------------------------------------------------------------ Android (AissLocation)

const CHECK_MS = 5000;
/** The user may read the dialog for a while; after this the request is treated as unanswered. */
const DIALOG_MS = 90_000;
const checkNative = () => withTimeout(AissLocation.checkPermission(), CHECK_MS, 'checkPermission');
const askNative = (upgrade = false) =>
  withTimeout(upgrade ? AissLocation.requestPermission({ upgrade: true }) : AissLocation.requestPermission(), DIALOG_MS, 'requestPermission').catch((e) => {
    locLog('permission request failed', { error: String((e as Error)?.message ?? e) });
    return checkNative();
  });

/**
 * One permission request at a time for the whole app (boot, setup, map and SOS may all ask at
 * once): later callers share the answer of the dialog already on screen.
 */
async function nativePermission(request: boolean, upgrade = false): Promise<NativePermission> {
  let p = await checkNative();
  if ((p.state === 'granted' && !upgrade) || !request) return p;
  if (permissionFlight) return permissionFlight;
  permissionFlight = (async () => {
    const t0 = Date.now();
    locLog('asking for permission', { upgrade });
    p = await askNative(upgrade);
    // Android shows one permission dialog at a time and silently cancels the others (e.g. the
    // notification prompt at start-up). An instant "not answered" means ours never appeared: ask again once.
    if (p.state === 'prompt' && Date.now() - t0 < 1500) {
      await sleep(1500);
      p = await askNative(upgrade);
    }
    locLog('permission answer', { state: p.state, precise: p.precise, coarse: p.coarse });
    return p;
  })().finally(() => {
    permissionFlight = null;
  });
  return permissionFlight;
}

/** Returns false only when the plugin itself is unusable (caller falls back). */
async function startAndroid(request: boolean): Promise<boolean> {
  let perm: NativePermission;
  try {
    perm = await nativePermission(request);
  } catch (e) {
    locLog('AissLocation unusable, falling back', { error: String((e as Error)?.message ?? e) });
    return false;
  }
  set({ source: 'android', precise: perm.state === 'granted' ? perm.precise : null, permission: perm.state });
  if (perm.state !== 'granted') {
    setPermissionProblem(perm.state);
    return true;
  }
  try {
    if (!nativeSubs.length) {
      nativeSubs = await withTimeout(
        Promise.all([AissLocation.addListener('location', (f) => acceptFix(fromNative(f), 'android')), AissLocation.addListener('status', onNativeStatus)]),
        CHECK_MS,
        'addListener',
      );
    }
    startedAt = Date.now();
    const cur = useLocation.getState();
    if (!cur.fix || cur.status === 'error' || cur.status === 'idle') set({ status: 'acquiring', reason: null, error: null });
    const st = await withTimeout(AissLocation.start({ intervalMs: 1000 }), 8000, 'start');
    locLog('AissLocation started', { started: st.started, reason: st.reason ?? null, enabled: st.enabled, gps: st.gps, network: st.network, providers: st.providers });
    running = 'android';
    if (!st.started) {
      set(st.reason === 'permission' ? { permission: 'prompt', status: 'error', reason: 'prompt', error: MSG.prompt } : { status: 'unavailable', reason: 'no_provider', error: MSG.noProvider });
      running = null;
      // No LocationManager provider: Google Play Services may still have one.
      if (st.reason === 'no_provider') armFallback(0);
      return true;
    }
    applyServices(st.enabled);
    startTick();
    armFallback(FALLBACK_AFTER_MS);
  } catch (e) {
    running = null;
    const msg = (e as Error)?.message ?? 'Location failed to start';
    locLog('AissLocation start failed', { error: msg });
    if (/timed out/.test(msg)) return false; // bridge not answering: use @capacitor/geolocation instead
    set({ status: 'unavailable', reason: 'error', error: msg });
    armFallback(0);
  }
  return true;
}

// ------------------------------------------------------------------ fallback sources (AissLocation silent)

/** Starts the secondary sources if AissLocation has not delivered a live position after `ms`. */
function armFallback(ms: number) {
  clearTimeout(fallbackTimer);
  const since = startedAt;
  fallbackTimer = setTimeout(() => {
    if (!wanted || hasFreshFix(since) || fallbackWatchId || webWatchId != null) return;
    const s = useLocation.getState();
    if (s.reason === 'denied' || s.reason === 'prompt' || s.reason === 'off') return; // fallbacks cannot fix these
    locLog(`no live position from AissLocation after ${Math.round(ms / 1000)} s: starting fallbacks`);
    void startFallbacks();
  }, ms);
}

const positionCb = (from: FixSource) => (p: Position | null, err?: unknown) => {
  if (p) return acceptFix(fromPosition(p), from);
  if (err) locLog(`${from} error`, { error: String((err as { message?: string })?.message ?? err), code: (err as { code?: unknown })?.code ?? null });
};

async function startFallbacks() {
  const d = useLocationDiag.getState();
  // 1) @capacitor/geolocation (Google Play Services fused provider on Android).
  if (!fallbackWatchId) {
    try {
      const raw = await withTimeout(Geolocation.checkPermissions(), CHECK_MS, 'geolocation.checkPermissions');
      const perm = permOf(raw);
      if (perm === 'granted') {
        // enableHighAccuracy needs FINE: asking for it with only an Approximate grant opens the
        // Android permission dialog by itself (@capacitor/geolocation), so it follows the grant.
        fallbackWatchId = await withTimeout(
          Geolocation.watchPosition({ enableHighAccuracy: fineGranted(raw), timeout: 20000, maximumAge: 3000, interval: 1000, minimumUpdateInterval: 1000 }, positionCb('capacitor')),
          CHECK_MS,
          'geolocation.watchPosition',
        );
        useLocationDiag.setState({ fallback: [...new Set([...d.fallback, 'capacitor' as const])] });
        locLog('fallback @capacitor/geolocation started');
      } else locLog('fallback @capacitor/geolocation not allowed', { perm });
    } catch (e) {
      locLog('fallback @capacitor/geolocation failed', { error: String((e as Error)?.message ?? e) });
    }
  }
  // 2) The WebView's own geolocation (Chromium: Play Services or LocationManager). Capacitor's
  //    WebChromeClient grants it only when the app holds FINE and COARSE; otherwise it opens the
  //    Android permission dialog by itself, so on a phone it runs only with a precise grant.
  const webviewAllowed = !Capacitor.isNativePlatform() || (await nativeGeoAccess()).fine;
  if (!webviewAllowed) locLog('fallback WebView geolocation skipped (no precise permission; it would open a dialog)');
  if (webviewAllowed && webWatchId == null && typeof navigator !== 'undefined' && navigator.geolocation?.watchPosition) {
    try {
      webWatchId = navigator.geolocation.watchPosition(
        (p) => acceptFix(fromPosition(p as unknown as Position), 'webview'),
        (e) => locLog('fallback WebView geolocation error', { code: e.code, error: e.message }),
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
      );
      useLocationDiag.setState({ fallback: [...new Set([...useLocationDiag.getState().fallback, 'webview' as const])] });
      locLog('fallback WebView geolocation started');
    } catch (e) {
      locLog('fallback WebView geolocation failed', { error: String((e as Error)?.message ?? e) });
    }
  }
}

async function stopFallbacks() {
  clearTimeout(fallbackTimer);
  if (fallbackWatchId) await Geolocation.clearWatch({ id: fallbackWatchId }).catch(() => undefined);
  fallbackWatchId = null;
  if (webWatchId != null) {
    try {
      navigator.geolocation.clearWatch(webWatchId);
    } catch {
      /* ignore */
    }
  }
  webWatchId = null;
  useLocationDiag.setState({ fallback: [] });
}

// ------------------------------------------------------------------ Capacitor Geolocation (web / fallback)

const permOf = (p: { location?: string; coarseLocation?: string } | null): LocationPermission => {
  if (!p) return 'unknown';
  if (p.location === 'granted' || p.coarseLocation === 'granted') return 'granted';
  if (p.location === 'denied') return 'denied';
  return 'prompt';
};
/** FINE ("Precise") granted: only then may Geolocation be asked for high accuracy without a dialog. */
const fineGranted = (p: { location?: string } | null) => p?.location === 'granted';

/** Android permission as @capacitor/geolocation sees it (never asks). Unknown → no access. */
async function nativeGeoAccess(): Promise<{ granted: boolean; fine: boolean }> {
  try {
    const raw = await withTimeout(Geolocation.checkPermissions(), CHECK_MS, 'geolocation.checkPermissions');
    return { granted: permOf(raw) === 'granted', fine: fineGranted(raw) };
  } catch {
    return { granted: false, fine: false };
  }
}

async function startCapacitor(request: boolean) {
  const native = Capacitor.isNativePlatform();
  // Native: high accuracy only with a FINE grant (with Approximate only it would open a dialog).
  let highAccuracy = true;
  set({ source: native ? 'capacitor' : 'browser' });
  if (!native && typeof navigator !== 'undefined' && !navigator.geolocation) {
    set({ status: 'unavailable', reason: 'unsupported', error: MSG.unsupported });
    return;
  }
  if (native) {
    // checkPermissions REJECTS (code OS-PLUG-GLOC-0007) when the Location switch is off — that is not a denial.
    let perm: LocationPermission = 'unknown';
    try {
      let raw = await Geolocation.checkPermissions();
      perm = permOf(raw);
      if (perm !== 'granted' && request) perm = permOf((raw = await Geolocation.requestPermissions()));
      highAccuracy = fineGranted(raw);
    } catch (e) {
      if (/not enabled|0007|disabled/i.test(String((e as { code?: string })?.code ?? '') + (e as Error)?.message)) {
        set({ servicesOn: false, status: 'unavailable', reason: 'off', error: MSG.off });
        return; // resume recovery restarts it after the user switches Location on
      }
    }
    set({ permission: perm });
    if (perm === 'denied' || perm === 'prompt') {
      setPermissionProblem(perm);
      return;
    }
  }
  // Web: the browser asks on watchPosition itself (Capacitor's web requestPermissions is not implemented).
  startedAt = Date.now();
  if (!useLocation.getState().fix) set({ status: 'acquiring', reason: null, error: null });
  try {
    const from: FixSource = native ? 'capacitor' : 'browser';
    watchId = await Geolocation.watchPosition({ enableHighAccuracy: highAccuracy, timeout: 20000, maximumAge: 3000, interval: 1000, minimumUpdateInterval: 1000 }, (p, err) => {
      if (p) {
        acceptFix(fromPosition(p), from);
        return;
      }
      if (!err) return;
      const code = (err as { code?: number | string }).code;
      const msg = String((err as { message?: string }).message ?? err);
      if (code === 1 || /denied|permission/i.test(msg)) setPermissionProblem('denied');
      else if (/not enabled|disabled|turned off|0007|0017/i.test(msg + String(code))) set({ servicesOn: false, status: 'unavailable', reason: 'off', error: MSG.off });
      else if (code === 3 || /timeout|in time/i.test(msg)) {
        if (!useLocation.getState().fix || useLocation.getState().status === 'stale') set({ reason: 'no_signal', error: MSG.noSignal });
      } else set({ status: useLocation.getState().fix ? 'stale' : 'unavailable', reason: 'error', error: msg });
    });
    running = native ? 'capacitor' : 'browser';
    startTick();
  } catch (e) {
    set({ status: 'unavailable', reason: 'error', error: (e as Error)?.message ?? 'Location failed to start' });
  }
}

// ------------------------------------------------------------------ public API

async function doStart(request: boolean) {
  locLog('starting', { request, platform: Capacitor.getPlatform(), aissLocation: isAndroidNative() });
  if (isAndroidNative() && (await startAndroid(request))) return;
  await startCapacitor(request);
}

/**
 * Starts GPS. `request` (default true) shows the permission dialog when not yet allowed; recovery
 * paths pass false so a dismissed dialog never pops up again by itself.
 */
export function startLocation(opts: { request?: boolean } = {}): Promise<void> {
  hookLocationRecovery();
  wanted = true;
  startWatchdog();
  if (running) return Promise.resolve();
  if (starting) return starting;
  const mine = doStart(opts.request ?? true)
    .catch((e) => {
      locLog('start failed', { error: String((e as Error)?.message ?? e) });
    })
    .finally(() => {
      if (starting === mine) starting = null;
    });
  starting = mine;
  return mine;
}

/**
 * GPS should be running but is not (start failed, permission granted in another dialog or in
 * Settings without a resume event, plugin answer lost): retry quietly. Never shows a dialog.
 */
function startWatchdog() {
  if (watchdog) return;
  watchdog = setInterval(() => {
    if (!wanted || starting) return;
    // A running Capacitor/browser watch is left alone: restarting it would only delay its first fix.
    if (running && running !== 'android') return;
    const s = useLocation.getState();
    const healthy = running && (s.status === 'ok' || s.status === 'poor' || (s.status === 'acquiring' && Date.now() - startedAt < NO_SIGNAL_MS));
    if (healthy) return;
    void ensureLocation({ request: false });
  }, WATCHDOG_MS);
}

/**
 * (Re)starts GPS when it is not delivering: permission granted later in setup or in Settings,
 * Location switched on, or the first start failed. Safe to call often; a healthy watch is left alone.
 */
export async function ensureLocation(opts: { request?: boolean } = {}) {
  // A start waiting on a lost native answer must not block every later caller forever.
  if (starting) await withTimeout(starting, opts.request === false ? 15_000 : DIALOG_MS + 5000, 'start').catch(() => undefined);
  const s = useLocation.getState();
  if (running && (s.status === 'ok' || s.status === 'poor' || (s.status === 'acquiring' && s.reason === null))) return;
  if (running === 'android' && opts.request === false) {
    // Automatic recovery (resume, screen shown): the native watch survives permission/switch
    // changes, so just refresh what we know. An explicit Retry re-registers it below.
    try {
      const perm = await checkNative();
      if (perm.state !== 'granted') {
        await halt();
        return startLocation(opts);
      }
      set({ permission: 'granted', precise: perm.precise });
      applyServices((await withTimeout(AissLocation.isLocationEnabled(), CHECK_MS, 'isLocationEnabled')).enabled);
      if (useLocation.getState().status !== 'unavailable') {
        const { fix } = await withTimeout(AissLocation.getLastKnown(), CHECK_MS, 'getLastKnown');
        if (fix) acceptFix(fromNative(fix), 'android');
      }
      // Still nothing live long after start: the native watch is silent, try the other sources.
      if (!hasFreshFix() && Date.now() - startedAt > FALLBACK_AFTER_MS) void startFallbacks();
      return;
    } catch {
      /* fall through to a full restart */
    }
  }
  await halt();
  starting = null;
  await startLocation(opts);
}

/** Explicit user action ("Allow location" / "Use precise location"). Resolves with the new permission. */
export async function requestLocationPermission(opts: { upgrade?: boolean } = {}): Promise<LocationPermission> {
  wanted = true;
  if (isAndroidNative()) {
    try {
      const p = await nativePermission(true, !!opts.upgrade);
      set({ permission: p.state, precise: p.state === 'granted' ? p.precise : null });
      await ensureLocation({ request: false });
      return p.state;
    } catch {
      /* fall back below */
    }
  }
  await halt();
  await startLocation({ request: true });
  return useLocation.getState().permission;
}

/** Android Location switch. */
export async function openLocationSettings() {
  try {
    if (isAndroidNative()) return await AissLocation.openLocationSettings();
    const { AissNative } = await import('../native/aissNative');
    await AissNative.openLocationSettings();
  } catch {
    /* web: nothing to open */
  }
}

/** This app's settings page (a permission blocked with "Don't ask again"). */
export async function openAppLocationSettings() {
  try {
    if (isAndroidNative()) return await AissLocation.openAppSettings();
    const { AissNative } = await import('../native/aissNative');
    await AissNative.openAppSettings();
  } catch {
    /* web: nothing to open */
  }
}

let resumeHooked = false;
/** Recover after the user turns location on / allows it in Settings and comes back to the app. */
export function hookLocationRecovery() {
  if (resumeHooked) return;
  resumeHooked = true;
  try {
    void App.addListener('resume', () => {
      // Never re-prompt by itself: the permission dialog itself pauses/resumes the app.
      if (wanted) void ensureLocation({ request: false });
    }).catch(() => undefined);
  } catch {
    /* App plugin unavailable */
  }
}

/** Stops the watch but keeps the last position (internal restart). */
async function halt() {
  const src = running;
  running = null;
  clearInterval(tick);
  await stopFallbacks();
  if (watchId) await Geolocation.clearWatch({ id: watchId }).catch(() => undefined);
  watchId = null;
  if (src === 'android') await withTimeout(AissLocation.stop(), CHECK_MS, 'stop').catch(() => undefined);
}

/** Stops GPS and forgets the position (sign-out: nothing of the previous account stays on screen). */
export async function stopLocation() {
  wanted = false;
  clearInterval(watchdog);
  watchdog = undefined;
  if (starting) await withTimeout(starting, 5000, 'start').catch(() => undefined);
  await halt();
  useLocation.setState({ ...INITIAL });
}

/** Test helper: forget everything (module state + store). */
export async function __resetLocationForTests() {
  await stopLocation();
  resumeHooked = false;
  nativeSubs.forEach((h) => void h.remove?.());
  nativeSubs = [];
  starting = null;
  permissionFlight = null;
  listeners.clear();
  useLocation.setState({ ...INITIAL });
  useLocationDiag.setState({ ...DIAG0, bySource: {}, fallback: [], lines: [] });
}

// ------------------------------------------------------------------ one fresh position (SOS, "where am I")

export interface AcquiredFix {
  fix: Fix | null;
  /** fix is at most maxAgeMs old */
  fresh: boolean;
}

/**
 * The best position for something that must carry one (SOS text): the current fix when it is
 * at most `maxAgeMs` old, otherwise actively asks every source for a fresh one (native one-shot,
 * Capacitor/WebView getCurrentPosition) for up to `timeoutMs`, then falls back to the newest
 * position of any age (fresh=false). Never shows a permission dialog.
 */
export async function acquireFix(opts: { maxAgeMs?: number; timeoutMs?: number } = {}): Promise<AcquiredFix> {
  const maxAge = opts.maxAgeMs ?? 120_000;
  const timeout = opts.timeoutMs ?? 8000;
  const goodNow = () => {
    const f = useLocation.getState().fix;
    return f && Date.now() - f.ts <= maxAge ? f : null;
  };
  const now0 = goodNow();
  if (now0) return { fix: now0, fresh: true };
  locLog('acquiring a fresh position', { maxAgeMs: maxAge, timeoutMs: timeout });
  if (wanted || running) void ensureLocation({ request: false }).catch(() => undefined);
  else void startLocation({ request: false });

  return new Promise<AcquiredFix>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      const g = goodNow();
      const any = useLocation.getState().fix;
      locLog('acquire result', { fresh: !!g, hasAny: !!any, ageS: any ? Math.round((Date.now() - any.ts) / 1000) : null });
      resolve({ fix: g ?? any, fresh: !!g });
    };
    const check = () => {
      if (goodNow()) finish();
    };
    const unsub = useLocation.subscribe(check);
    const timer = setTimeout(finish, timeout);
    if (isAndroidNative()) {
      // Cached first (instant), then one fresh update.
      withTimeout(AissLocation.getLastKnown(), CHECK_MS, 'getLastKnown')
        .then(({ fix }) => fix && acceptFix(fromNative(fix), 'android'))
        .catch(() => undefined);
      withTimeout(AissLocation.getCurrent({ timeoutMs: Math.max(1000, timeout - 500) }), timeout + 1000, 'getCurrent')
        .then(({ fix }) => fix && acceptFix(fromNative(fix), 'android'))
        .catch(() => undefined); // older APK without getCurrent: the other sources still run
    }
    // On a phone, ask @capacitor/geolocation only when it cannot open a permission dialog: with no
    // grant it would ask, and high accuracy with only Approximate would too (SOS must never wait on one).
    const native = Capacitor.isNativePlatform();
    void (native ? nativeGeoAccess() : Promise.resolve({ granted: true, fine: true })).then((access) => {
      if (done) return;
      if (!access.granted) return locLog('acquire: @capacitor/geolocation skipped (no permission; it would open a dialog)');
      Geolocation.getCurrentPosition({ enableHighAccuracy: access.fine, timeout: Math.max(1000, timeout - 500), maximumAge: maxAge })
        .then((p) => acceptFix(fromPosition(p), native ? 'capacitor' : 'browser'))
        .catch(() => undefined);
    });
    check();
  });
}

export interface LocationProblem {
  kind: 'denied' | 'prompt' | 'off' | 'approximate' | 'searching' | 'no_signal' | 'unavailable';
  text: string;
  action: 'app_settings' | 'request' | 'location_settings' | 'upgrade' | 'retry' | null;
  actionLabel: string | null;
}

/** What to tell the user (and the one button) when there is no good live position. null = all fine. */
export function locationProblem(s: Pick<LocationState, 'status' | 'reason' | 'permission' | 'precise' | 'fix' | 'error'>, opts: { native?: boolean; wantPrecise?: boolean } = {}): LocationProblem | null {
  const native = opts.native ?? true;
  if (s.reason === 'denied' || (s.status === 'error' && s.permission === 'denied'))
    return { kind: 'denied', text: native ? `${MSG.denied} Open Settings → Permissions → Location → Allow while using the app.` : MSG.denied, action: native ? 'app_settings' : 'retry', actionLabel: native ? 'Open settings' : 'Retry' };
  if (s.reason === 'prompt' || (s.status === 'error' && s.permission === 'prompt')) return { kind: 'prompt', text: MSG.prompt, action: 'request', actionLabel: 'Allow' };
  if (s.reason === 'off') return { kind: 'off', text: MSG.off, action: native ? 'location_settings' : 'retry', actionLabel: native ? 'Turn on' : 'Retry' };
  if (s.fix && (s.status === 'ok' || s.status === 'poor')) {
    if (opts.wantPrecise && s.precise === false) return { kind: 'approximate', text: 'Only approximate location is allowed. Walking directions need Precise location.', action: 'upgrade', actionLabel: 'Use precise' };
    return null;
  }
  if (s.reason === 'no_signal') return { kind: 'no_signal', text: MSG.noSignal, action: 'retry', actionLabel: 'Retry' };
  if (s.status === 'acquiring' || s.status === 'idle' || (s.status === 'stale' && !s.reason))
    return { kind: 'searching', text: s.status === 'stale' ? 'Position is out of date. Getting a new one…' : 'Finding your position…', action: null, actionLabel: null };
  return { kind: 'unavailable', text: s.error ?? 'Your position is not available yet.', action: 'retry', actionLabel: 'Retry' };
}

/** Runs the action from locationProblem(). */
export async function runLocationAction(action: LocationProblem['action']) {
  if (action === 'app_settings') return openAppLocationSettings();
  if (action === 'location_settings') return openLocationSettings();
  if (action === 'request') return void (await requestLocationPermission());
  if (action === 'upgrade') return void (await requestLocationPermission({ upgrade: true }));
  if (action === 'retry') return ensureLocation({ request: true });
}

/** Great-circle distance in metres. */
export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR;
  const dLng = (b.lng - a.lng) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function freshnessLabel(ts: number | null | undefined, now = Date.now()) {
  if (!ts) return 'Location unavailable';
  const s = Math.round((now - ts) / 1000);
  if (s <= 10) return 'Live';
  if (s < 60) return `Updated ${s} sec ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `Updated ${m} min ago`;
  return `Updated ${Math.round(m / 60)} h ago`;
}
