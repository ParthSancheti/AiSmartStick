import { registerPlugin, type PermissionState, type PluginListenerHandle } from '@capacitor/core';

/**
 * Custom Android plugin (android/app/src/main/java/in/aismartstick/app/AissNativePlugin.java).
 * Everything here needs platform APIs a WebView doesn't have. On the web each method
 * reports itself unavailable instead of pretending (see aissNativeWeb.ts).
 */
export interface SetupNetwork {
  ssid: string;
  rssi: number;
}

export type CallResult = 'call_started' | 'dialer_opened';
/** sent = accepted by the mobile network; queued = handed to Android, no answer yet; failed = radio refused it. */
export type SmsResult = 'sent' | 'queued' | 'composer_opened' | 'failed';
export type AudioRoute = 'speaker' | 'wired' | 'bluetooth' | 'unknown';

export interface AissNativePlugin {
  /** Wi-Fi scan for the stick's setup AP (needs NEARBY_WIFI_DEVICES / location permission). */
  scanForSetupNetworks(opts: { prefix: string }): Promise<{ networks: SetupNetwork[] }>;
  /**
   * Makes the stick reachable: keeps a live binding, adopts a Wi-Fi network already on the stick's
   * subnet (joined by hand), or (Android 10+) shows one system "Connect to device" sheet.
   * reason: WIFI_DISABLED | UNAVAILABLE (not found / declined / timed out) | CANCELLED | UNSUPPORTED (Android 9-) | PERMISSION_DENIED
   * | NOT_IN_RANGE / RANGE_UNKNOWN (only with onlyIfVisible: the last scan did not see the stick / Android would not say).
   */
  connectToSetupNetwork(opts: { ssid: string; passphrase: string; timeoutMs?: number; openWifiPanelIfOff?: boolean; onlyIfVisible?: boolean }): Promise<{ connected: boolean; reason?: string; via?: 'bound' | 'existing' | 'request' }>;
  /** Wi-Fi state hint for setup. ssid needs location permission + location on; stickNetwork does not. */
  /** Android system font size (Settings → Display → Font size), e.g. 1.15. The WebView itself is pinned to 100 %. */
  getFontScale(): Promise<{ fontScale: number }>;
  /** dark: true = dark status/navigation bar icons (light theme). */
  setStatusBarIcons(opts: { dark: boolean }): Promise<void>;
  /**
   * requested = a "Connect to device" request is registered; connecting = it is still waiting for
   * Android; processBound = the whole app runs over the stick Wi-Fi (setProcessBinding).
   */
  getCurrentWifiSsid(): Promise<{ wifiEnabled: boolean; ssid?: string | null; stickNetwork: boolean; bound: boolean; requested?: boolean; connecting?: boolean; processBound?: boolean; locationEnabled?: boolean; sdk?: number }>;
  /**
   * HTTP to http://192.168.4.1 over the stick network (process stays on mobile data for everything else).
   * route 'default' = skip the stick binding and use the process default network (fallback path).
   * via = the route actually used: bound | wifi (joined by hand) | default | process.
   */
  setupRequest(opts: { method: 'GET' | 'POST'; path: string; body?: string; bodyBase64?: string; headers?: Record<string, string>; timeoutMs?: number; route?: 'auto' | 'default' }): Promise<{ status: number; body: string; via?: string }>;
  /** GET returning the raw response bytes base64-encoded (camera JPEG). Same network binding and headers as setupRequest. */
  requestBinary(opts: { path: string; headers?: Record<string, string>; timeoutMs?: number; route?: 'auto' | 'default' }): Promise<{ status: number; body: string; contentType?: string; via?: string }>;
  releaseSetupNetwork(): Promise<void>;
  /**
   * Last-resort fallback: bindProcessToNetwork(stick network) — ALL app traffic (WebView included)
   * goes over the stick Wi-Fi; maps / assistant / Firebase stop while it is on. on: false releases it.
   */
  setProcessBinding(opts: { on: boolean }): Promise<{ bound: boolean; reason?: string }>;
  /** Listen for the stick's UDP discovery broadcast on the hotspot. */
  startDiscovery(opts: { port: number }): Promise<void>;
  stopDiscovery(): Promise<void>;
  addListener(event: 'announcement', cb: (a: { json: string; fromIp: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'WIFI_STATE', cb: (a: { event: string; ip: string }) => void): Promise<PluginListenerHandle>;
  openHotspotSettings(): Promise<void>;
  openWifiSettings(): Promise<void>;
  openLocationSettings(): Promise<void>;
  openAppSettings(): Promise<void>;
  openBluetoothSettings(): Promise<void>;
  /** Android Keystore-backed storage (EncryptedSharedPreferences). Only read once to migrate old pairing records. */
  secureSet(opts: { key: string; value: string }): Promise<void>;
  secureGet(opts: { key: string }): Promise<{ value: string | null }>;
  secureRemove(opts: { key: string }): Promise<void>;
  getAudioRoute(): Promise<{ route: AudioRoute; name: string | null }>;
  /** Direct call when CALL_PHONE is granted, else the dialer with the number filled in. */
  placeCall(opts: { number: string; direct: boolean }): Promise<{ result: CallResult }>;
  /** Direct SMS when SEND_SMS is granted (see ANDROID_SETUP.md policy note), else the composer. */
  sendSms(opts: { number: string; body: string; direct: boolean }): Promise<{ result: SmsResult; error?: string }>;
  /** Android foreground service: keeps stick link, GPS, SOS and sync alive with the screen off. */
  startBackgroundService(opts: { title: string; body: string; promote?: boolean }): Promise<{ running: boolean; types?: number }>;
  stopBackgroundService(): Promise<{ running: boolean }>;
  isBackgroundServiceRunning(): Promise<{ running: boolean }>;
  setKeepScreenOn(opts: { on: boolean }): Promise<void>;
  /** System contact picker. The app only receives the one contact the user picks. */
  pickContact(): Promise<{ cancelled: boolean; name?: string; phone?: string }>;
  getBatteryOptimization(): Promise<{ ignoring: boolean; manufacturer: string }>;
  openBatteryOptimizationSettings(): Promise<void>;
  checkPermissions(): Promise<Record<'location' | 'nearbyWifi' | 'phone' | 'sms', PermissionState>>;
  requestPermissions(opts: { permissions: ('location' | 'nearbyWifi' | 'phone' | 'sms')[] }): Promise<Record<'location' | 'nearbyWifi' | 'phone' | 'sms', PermissionState>>;
}

export const AissNative = registerPlugin<AissNativePlugin>('AissNative', {
  web: () => import('./aissNativeWeb').then((m) => new m.AissNativeWeb()),
});
