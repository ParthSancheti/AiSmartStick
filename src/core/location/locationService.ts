import { create } from 'zustand';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { Geolocation, type Position } from '@capacitor/geolocation';
import { App } from '@capacitor/app';
import { AissLocation, type NativeFix, type NativeLocationStatus, type NativePermission } from '../native/aissLocation';

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
}

const INITIAL: LocationState = { permission: 'unknown', precise: null, servicesOn: null, status: 'idle', reason: null, fix: null, error: null, source: null };
export const useLocation = create<LocationState>(() => ({ ...INITIAL }));

export const LOCATION_STALE_MS = 30_000;
export const POOR_ACCURACY_M = 50;
/** No first fix after this long → tell the user why (indoors) instead of spinning forever. */
export const NO_SIGNAL_MS = 25_000;

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

let running: LocationState['source'] = null;
/** GPS was asked for (startLocation) and not stopped (sign-out). */
let wanted = false;
let starting: Promise<void> | null = null;
let startedAt = 0;
let watchId: string | null = null;
let nativeSubs: PluginListenerHandle[] = [];
let tick: ReturnType<typeof setInterval> | undefined;

const set = (p: Partial<LocationState>) => useLocation.setState(p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isAndroidNative = () => Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('AissLocation');

function fixStatus(fix: Fix, now = Date.now()): LocationStatusCode {
  if (now - fix.ts > LOCATION_STALE_MS) return 'stale';
  return fix.accuracyM > POOR_ACCURACY_M ? 'poor' : 'ok';
}

/** Applies a position. Old (cached) fixes are shown with their age but never fed to navigation. */
export function acceptFix(fix: Fix) {
  if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lng) || (fix.lat === 0 && fix.lng === 0)) return;
  const s = useLocation.getState();
  if (s.fix && fix.ts < s.fix.ts) return; // out of order
  const now = Date.now();
  const fresh = now - fix.ts <= LOCATION_STALE_MS;
  if (fresh) {
    set({ fix, status: fixStatus(fix, now), reason: null, error: null, permission: 'granted', servicesOn: true });
    listeners.forEach((l) => l(fix));
  } else {
    // Cached position: keep showing why it isn't live (location off, no signal).
    const keep = s.reason === 'off' || s.reason === 'no_provider' || s.status === 'error';
    set(keep ? { fix } : { fix, status: 'stale' });
  }
}

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

async function nativePermission(request: boolean): Promise<NativePermission> {
  let p = await AissLocation.checkPermission();
  if (p.state === 'granted' || !request) return p;
  const t0 = Date.now();
  p = await AissLocation.requestPermission().catch(() => AissLocation.checkPermission());
  // Android shows one permission dialog at a time and silently cancels the others (e.g. the
  // notification prompt at start-up). An instant "not answered" means ours never appeared: ask again once.
  if (p.state === 'prompt' && Date.now() - t0 < 1500) {
    await sleep(1500);
    p = await AissLocation.requestPermission().catch(() => AissLocation.checkPermission());
  }
  return p;
}

/** Returns false only when the plugin itself is unusable (caller falls back). */
async function startAndroid(request: boolean): Promise<boolean> {
  let perm: NativePermission;
  try {
    perm = await nativePermission(request);
  } catch {
    return false;
  }
  set({ source: 'android', precise: perm.state === 'granted' ? perm.precise : null, permission: perm.state });
  if (perm.state !== 'granted') {
    setPermissionProblem(perm.state);
    return true;
  }
  try {
    if (!nativeSubs.length) {
      nativeSubs = await Promise.all([
        AissLocation.addListener('location', (f) => acceptFix(fromNative(f))),
        AissLocation.addListener('status', onNativeStatus),
      ]);
    }
    startedAt = Date.now();
    const cur = useLocation.getState();
    if (!cur.fix || cur.status === 'error' || cur.status === 'idle') set({ status: 'acquiring', reason: null, error: null });
    const st = await AissLocation.start({ intervalMs: 1000 });
    running = 'android';
    if (!st.started) {
      set(st.reason === 'permission' ? { permission: 'prompt', status: 'error', reason: 'prompt', error: MSG.prompt } : { status: 'unavailable', reason: 'no_provider', error: MSG.noProvider });
      running = null;
      return true;
    }
    applyServices(st.enabled);
    startTick();
  } catch (e) {
    running = null;
    set({ status: 'unavailable', reason: 'error', error: (e as Error)?.message ?? 'Location failed to start' });
  }
  return true;
}

// ------------------------------------------------------------------ Capacitor Geolocation (web / fallback)

const permOf = (p: { location?: string; coarseLocation?: string } | null): LocationPermission => {
  if (!p) return 'unknown';
  if (p.location === 'granted' || p.coarseLocation === 'granted') return 'granted';
  if (p.location === 'denied') return 'denied';
  return 'prompt';
};

async function startCapacitor(request: boolean) {
  const native = Capacitor.isNativePlatform();
  set({ source: native ? 'capacitor' : 'browser' });
  if (!native && typeof navigator !== 'undefined' && !navigator.geolocation) {
    set({ status: 'unavailable', reason: 'unsupported', error: MSG.unsupported });
    return;
  }
  if (native) {
    // checkPermissions REJECTS (code OS-PLUG-GLOC-0007) when the Location switch is off — that is not a denial.
    let perm: LocationPermission = 'unknown';
    try {
      perm = permOf(await Geolocation.checkPermissions());
      if (perm !== 'granted' && request) perm = permOf(await Geolocation.requestPermissions());
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
    watchId = await Geolocation.watchPosition({ enableHighAccuracy: true, timeout: 20000, maximumAge: 3000, interval: 1000, minimumUpdateInterval: 1000 }, (p, err) => {
      if (p) {
        acceptFix(fromPosition(p));
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
  if (running) return Promise.resolve();
  if (starting) return starting;
  starting = doStart(opts.request ?? true).finally(() => {
    starting = null;
  });
  return starting;
}

/**
 * (Re)starts GPS when it is not delivering: permission granted later in setup or in Settings,
 * Location switched on, or the first start failed. Safe to call often; a healthy watch is left alone.
 */
export async function ensureLocation(opts: { request?: boolean } = {}) {
  if (starting) await starting;
  const s = useLocation.getState();
  if (running && (s.status === 'ok' || s.status === 'poor' || (s.status === 'acquiring' && s.reason === null))) return;
  if (running === 'android' && opts.request === false) {
    // Automatic recovery (resume, screen shown): the native watch survives permission/switch
    // changes, so just refresh what we know. An explicit Retry re-registers it below.
    try {
      const perm = await AissLocation.checkPermission();
      if (perm.state !== 'granted') {
        await halt();
        return startLocation(opts);
      }
      set({ permission: 'granted', precise: perm.precise });
      applyServices((await AissLocation.isLocationEnabled()).enabled);
      if (useLocation.getState().status !== 'unavailable') {
        const { fix } = await AissLocation.getLastKnown();
        if (fix) acceptFix(fromNative(fix));
      }
      return;
    } catch {
      /* fall through to a full restart */
    }
  }
  await halt();
  await startLocation(opts);
}

/** Explicit user action ("Allow location" / "Use precise location"). Resolves with the new permission. */
export async function requestLocationPermission(opts: { upgrade?: boolean } = {}): Promise<LocationPermission> {
  if (isAndroidNative()) {
    try {
      const p = opts.upgrade ? await AissLocation.requestPermission({ upgrade: true }) : await nativePermission(true);
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
  if (watchId) await Geolocation.clearWatch({ id: watchId }).catch(() => undefined);
  watchId = null;
  if (src === 'android') await AissLocation.stop().catch(() => undefined);
}

/** Stops GPS and forgets the position (sign-out: nothing of the previous account stays on screen). */
export async function stopLocation() {
  wanted = false;
  if (starting) await starting.catch(() => undefined);
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
  listeners.clear();
  useLocation.setState({ ...INITIAL });
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
