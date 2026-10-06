import { registerPlugin, type PermissionState, type PluginListenerHandle } from '@capacitor/core';

/**
 * Custom Android plugin (android/app/src/main/java/in/aismartstick/app/AissNativePlugin.kt).
 * Everything here needs platform APIs a WebView doesn't have. On the web each method
 * reports itself unavailable instead of pretending (see aissNativeWeb.ts).
 */
export interface SetupNetwork {
  ssid: string;
  rssi: number;
}

export type CallResult = 'call_started' | 'dialer_opened';
export type SmsResult = 'sent' | 'composer_opened';
export type AudioRoute = 'speaker' | 'wired' | 'bluetooth' | 'unknown';

export interface AissNativePlugin {
  /** Wi-Fi scan for the stick's setup AP (needs NEARBY_WIFI_DEVICES / location permission). */
  scanForSetupNetworks(opts: { prefix: string }): Promise<{ networks: SetupNetwork[] }>;
  /** Android 10+: WifiNetworkSpecifier request; shows one system "Connect to device?" sheet. */
  connectToSetupNetwork(opts: { ssid: string; passphrase: string; timeoutMs?: number }): Promise<{ connected: boolean; reason?: string }>;
  /** HTTP over the setup network specifically (process stays on mobile data for everything else). */
  setupRequest(opts: { method: 'GET' | 'POST'; path: string; body?: string; timeoutMs?: number }): Promise<{ status: number; body: string }>;
  requestBinary(opts: { path: string; timeoutMs?: number }): Promise<{ status: number; body: string }>;
  releaseSetupNetwork(): Promise<void>;
  /** Listen for the stick's UDP discovery broadcast on the hotspot. */
  startDiscovery(opts: { port: number }): Promise<void>;
  stopDiscovery(): Promise<void>;
  addListener(event: 'announcement', cb: (a: { json: string; fromIp: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'WIFI_STATE', cb: (a: { event: string; ip: string }) => void): Promise<PluginListenerHandle>;
  openHotspotSettings(): Promise<void>;
  openWifiSettings(): Promise<void>;
  openBluetoothSettings(): Promise<void>;
  /** Android Keystore-backed storage (EncryptedSharedPreferences) for the device key. */
  secureSet(opts: { key: string; value: string }): Promise<void>;
  secureGet(opts: { key: string }): Promise<{ value: string | null }>;
  secureRemove(opts: { key: string }): Promise<void>;
  getAudioRoute(): Promise<{ route: AudioRoute; name: string | null }>;
  /** Direct call when CALL_PHONE is granted, else the dialer with the number filled in. */
  placeCall(opts: { number: string; direct: boolean }): Promise<{ result: CallResult }>;
  /** Direct SMS when SEND_SMS is granted (see ANDROID_SETUP.md policy note), else the composer. */
  sendSms(opts: { number: string; body: string; direct: boolean }): Promise<{ result: SmsResult }>;
  /** Android foreground service: keeps stick link, GPS, SOS and sync alive with the screen off. */
  startBackgroundService(opts: { title: string; body: string; mic?: boolean }): Promise<{ running: boolean }>;
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
