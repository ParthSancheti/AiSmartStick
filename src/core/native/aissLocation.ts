import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * Android phone GPS straight from android.location.LocationManager
 * (android/app/src/main/java/in/aismartstick/app/AissLocationPlugin.java). No Google Play Services.
 * Only implemented on Android; on the web locationService uses the browser's geolocation.
 */
export interface NativeFix {
  lat: number;
  lng: number;
  /** metres (999 when the provider gave none) */
  accuracy: number;
  altitude: number | null;
  speed: number | null;
  bearing: number | null;
  /** wall-clock ms of the measurement, computed from its monotonic age */
  time: number;
  provider: string;
}

export interface NativePermission {
  /** granted = precise OR approximate. denied = "Don't ask again": only app settings can fix it. */
  state: 'granted' | 'denied' | 'prompt';
  precise: boolean;
  coarse: boolean;
}

export interface NativeLocationStatus {
  /** The phone's Location switch. */
  enabled: boolean;
  gps: boolean;
  network: boolean;
  providers: string[];
  running: boolean;
}

export interface NativeLocationDiagnostics extends NativePermission {
  sdk: number;
  /** The phone's Location switch. */
  enabled: boolean;
  /** JS asked for updates (start called, not stopped). */
  wanted: boolean;
  /** A listener is registered with LocationManager right now. */
  running: boolean;
  backgroundAllowed: boolean;
  /** Positions handed to JS since the app started. */
  delivered: number;
  lastDeliveredAt: number | null;
  lastProvider: string | null;
  lastError: string | null;
  activeProviders: string[];
  providers: { name: string; enabled: boolean; lastAgeMs: number | null; lastAccuracy: number | null; error?: string }[];
}

export interface AissLocationPlugin {
  checkPermission(): Promise<NativePermission>;
  /** FINE + COARSE in one dialog; an "Approximate" answer counts as granted. upgrade=true asks again for Precise. */
  requestPermission(opts?: { upgrade?: boolean }): Promise<NativePermission>;
  isLocationEnabled(): Promise<NativeLocationStatus>;
  openLocationSettings(): Promise<void>;
  openAppSettings(): Promise<void>;
  start(opts: { intervalMs: number }): Promise<NativeLocationStatus & { started: boolean; reason?: 'permission' | 'no_provider' }>;
  stop(): Promise<void>;
  getLastKnown(): Promise<{ fix: NativeFix | null }>;
  /** One fresh fix within timeoutMs (GPS/network/fused), else the freshest cached one. Newer APKs only. */
  getCurrent(opts: { timeoutMs: number }): Promise<{ fix: NativeFix | null; fresh: boolean; reason: 'fresh' | 'timeout' | 'permission' | 'off' | 'no_provider' }>;
  /** Everything the Location test page shows. Newer APKs only. */
  getDiagnostics(): Promise<NativeLocationDiagnostics>;
  addListener(event: 'location', cb: (f: NativeFix) => void): Promise<PluginListenerHandle>;
  addListener(event: 'status', cb: (s: NativeLocationStatus) => void): Promise<PluginListenerHandle>;
}

export const AissLocation = registerPlugin<AissLocationPlugin>('AissLocation');
