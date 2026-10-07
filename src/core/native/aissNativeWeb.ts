import { WebPlugin } from '@capacitor/core';
import type { AissNativePlugin, AudioRoute, CallResult, SmsResult } from './aissNative';

/** Browser fallback. Honest: stick networking is Android-only; calls/SMS open the system handler. */
export class AissNativeWeb extends WebPlugin implements AissNativePlugin {
  // Browsers cannot run a foreground service; report it honestly.
  async startBackgroundService(): Promise<{ running: boolean }> {
    return this.no();
  }
  async stopBackgroundService() {
    return { running: false };
  }
  async isBackgroundServiceRunning() {
    return { running: false };
  }
  async setKeepScreenOn() {}
  /** Chrome on Android supports the Contact Picker API; elsewhere it is unavailable (typed entry). */
  async pickContact(): Promise<{ cancelled: boolean; name?: string; phone?: string }> {
    const nav = navigator as unknown as { contacts?: { select: (p: string[], o: { multiple: boolean }) => Promise<{ name?: string[]; tel?: string[] }[]> } };
    if (!nav.contacts?.select) throw this.unavailable('Contact picker not available here');
    const [c] = await nav.contacts.select(['name', 'tel'], { multiple: false });
    return c ? { cancelled: false, name: c.name?.[0], phone: c.tel?.[0] } : { cancelled: true };
  }
  async getBatteryOptimization(): Promise<{ ignoring: boolean; manufacturer: string }> {
    return this.no();
  }
  async openBatteryOptimizationSettings(): Promise<void> {
    return this.no();
  }
  async openWifiSettings(): Promise<void> {
    return this.no();
  }
  async openLocationSettings(): Promise<void> {
    return this.no();
  }
  async openAppSettings(): Promise<void> {
    return this.no();
  }
  async checkPermissions() {
    return { location: 'prompt', nearbyWifi: 'denied', phone: 'denied', sms: 'denied' } as const;
  }
  async requestPermissions() {
    return this.checkPermissions();
  }
  private no(): never {
    throw this.unavailable('Requires the AI SmartStick Android app');
  }
  async scanForSetupNetworks(): Promise<{ networks: { ssid: string; rssi: number }[] }> {
    return this.no();
  }
  async connectToSetupNetwork(): Promise<{ connected: boolean }> {
    return this.no();
  }
  async setStatusBarIcons(): Promise<void> {}
  async getFontScale(): Promise<{ fontScale: number }> {
    return { fontScale: 1 };
  }
  async getCurrentWifiSsid(): Promise<{ wifiEnabled: boolean; stickNetwork: boolean; bound: boolean }> {
    return this.no();
  }
  async setupRequest(): Promise<{ status: number; body: string }> {
    return this.no();
  }
  async requestBinary(): Promise<{ status: number; body: string }> {
    return this.no();
  }
  async releaseSetupNetwork() {}
  async startDiscovery(): Promise<void> {
    return this.no();
  }
  async stopDiscovery() {}
  async openHotspotSettings(): Promise<void> {
    return this.no();
  }
  async openBluetoothSettings(): Promise<void> {
    return this.no();
  }
  async secureSet(o: { key: string; value: string }) {
    localStorage.setItem(`aiss.secure.${o.key}`, o.value);
  }
  async secureGet(o: { key: string }) {
    return { value: localStorage.getItem(`aiss.secure.${o.key}`) };
  }
  async secureRemove(o: { key: string }) {
    localStorage.removeItem(`aiss.secure.${o.key}`);
  }
  async getAudioRoute(): Promise<{ route: AudioRoute; name: string | null }> {
    return { route: 'unknown', name: null };
  }
  async placeCall(o: { number: string }): Promise<{ result: CallResult }> {
    window.location.href = `tel:${o.number.replace(/\s+/g, '')}`;
    return { result: 'dialer_opened' };
  }
  async sendSms(o: { number: string; body: string }): Promise<{ result: SmsResult }> {
    window.location.href = `sms:${o.number.replace(/\s+/g, '')}?body=${encodeURIComponent(o.body)}`;
    return { result: 'composer_opened' };
  }
}
