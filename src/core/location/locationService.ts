import { create } from 'zustand';
import { Geolocation, type Position } from '@capacitor/geolocation';
import { App } from '@capacitor/app';

/**
 * Real GPS for the stick user's phone. Exposes accuracy, freshness and permission so the
 * UI never calls an old position "Live". (Background tracking requires the Android
 * foreground service described in ANDROID_SETUP.md.)
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

interface LocationState {
  permission: 'unknown' | 'granted' | 'denied' | 'prompt';
  status: 'idle' | 'acquiring' | 'ok' | 'stale' | 'poor' | 'error' | 'unavailable';
  fix: Fix | null;
  error: string | null;
}

export const useLocation = create<LocationState>(() => ({ permission: 'unknown', status: 'idle', fix: null, error: null }));

export const LOCATION_STALE_MS = 30_000;
export const POOR_ACCURACY_M = 50;

const listeners = new Set<(f: Fix) => void>();
export const onFix = (cb: (f: Fix) => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

let watchId: string | null = null;
let staleTimer: ReturnType<typeof setInterval> | undefined;

function accept(p: Position) {
  const c = p.coords;
  const fix: Fix = {
    lat: c.latitude,
    lng: c.longitude,
    accuracyM: c.accuracy,
    altitude: c.altitude ?? null,
    speedMps: c.speed ?? null,
    headingDeg: c.heading ?? null,
    ts: p.timestamp || Date.now(),
  };
  useLocation.setState({ fix, status: c.accuracy > POOR_ACCURACY_M ? 'poor' : 'ok', error: null, permission: 'granted' });
  listeners.forEach((l) => l(fix));
}

export async function startLocation() {
  hookLocationRecovery();
  if (watchId) return;
  useLocation.setState({ status: 'acquiring' });
  try {
    const perm = await Geolocation.checkPermissions().catch(() => null);
    let state = perm?.location ?? 'prompt';
    if (state !== 'granted') state = (await Geolocation.requestPermissions().catch(() => ({ location: 'denied' as const }))).location;
    useLocation.setState({ permission: state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : 'prompt' });
    if (state === 'denied') {
      useLocation.setState({ status: 'error', error: 'Location permission denied' });
      return;
    }
    watchId = await Geolocation.watchPosition({ enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 }, (p, err) => {
      if (err) {
        const msg = String((err as { message?: string }).message ?? err);
        const denied = /denied|permission/i.test(msg);
        const off = /disabled|location services|provider|not enabled|unavailable/i.test(msg);
        useLocation.setState({
          status: denied ? 'error' : useLocation.getState().fix ? 'stale' : 'unavailable',
          error: denied ? 'Location permission denied' : off ? 'Location is turned off on this phone' : msg,
          permission: denied ? 'denied' : useLocation.getState().permission,
        });
        return;
      }
      if (p) accept(p);
    });
  } catch (e) {
    useLocation.setState({ status: 'unavailable', error: (e as Error).message });
  }
  clearInterval(staleTimer);
  staleTimer = setInterval(() => {
    const s = useLocation.getState();
    if (s.fix && (s.status === 'ok' || s.status === 'poor') && Date.now() - s.fix.ts > LOCATION_STALE_MS) useLocation.setState({ status: 'stale' });
  }, 5000);
}

let resumeHooked = false;
/** Recover after the user turns location back on or returns to the app. */
export function hookLocationRecovery() {
  if (resumeHooked) return;
  resumeHooked = true;
  void App.addListener('resume', async () => {
    const s = useLocation.getState();
    if (s.status === 'error' || s.status === 'unavailable' || s.status === 'stale') {
      await stopLocation();
      await startLocation();
    }
  }).catch(() => undefined);
}

export async function stopLocation() {
  if (watchId) await Geolocation.clearWatch({ id: watchId }).catch(() => undefined);
  watchId = null;
  clearInterval(staleTimer);
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
