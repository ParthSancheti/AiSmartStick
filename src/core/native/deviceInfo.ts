import { create } from 'zustand';
import { Device } from '@capacitor/device';
import { ENV } from '../runtime/env';

/** Real phone information. Anything the platform won't tell us stays null → "Unavailable". */
interface PhoneInfo {
  loaded: boolean;
  model: string | null;
  manufacturer: string | null;
  osVersion: string | null;
  platform: string | null;
  batteryPct: number | null;
  charging: boolean | null;
  appVersion: string;
}

export const usePhoneInfo = create<PhoneInfo>(() => ({ loaded: false, model: null, manufacturer: null, osVersion: null, platform: null, batteryPct: null, charging: null, appVersion: ENV.appVersion }));

export async function loadPhoneInfo() {
  try {
    const [info, bat] = await Promise.all([Device.getInfo(), Device.getBatteryInfo().catch(() => null)]);
    const web = info.platform === 'web';
    usePhoneInfo.setState({
      loaded: true,
      model: web ? null : info.model || null,
      manufacturer: web ? null : info.manufacturer || null,
      osVersion: web ? null : `${info.operatingSystem === 'android' ? 'Android' : info.operatingSystem} ${info.osVersion}`,
      platform: info.platform,
      batteryPct: bat?.batteryLevel != null ? Math.round(bat.batteryLevel * 100) : null,
      charging: bat?.isCharging ?? null,
    });
  } catch {
    usePhoneInfo.setState({ loaded: true });
  }
}

export const phoneLabel = (p: PhoneInfo) => (p.model ? `${p.manufacturer ? `${p.manufacturer} ` : ''}${p.model}` : 'Unavailable');
