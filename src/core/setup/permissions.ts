import { Capacitor } from '@capacitor/core';
import { AissNative } from '../native/aissNative';

/**
 * Everything the stick needs from Android, asked once during setup while the user is looking at the
 * screen. Screen-off use depends on this: a permission dialog cannot appear on a locked phone, and a
 * foreground service only gets microphone/location access if those permissions already exist.
 */
export type PermState = 'granted' | 'denied' | 'prompt' | 'unavailable';
export type SetupPermission = 'location' | 'nearby' | 'microphone' | 'notifications';

const norm = (s: string | undefined): PermState => (s === 'granted' ? 'granted' : s === 'denied' ? 'denied' : s ? 'prompt' : 'unavailable');

async function microphone(): Promise<PermState> {
  if (!navigator.mediaDevices?.getUserMedia) return 'unavailable';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    return 'granted';
  } catch (e) {
    return /NotAllowed|Permission/i.test((e as Error).name + (e as Error).message) ? 'denied' : 'unavailable';
  }
}

async function notifications(): Promise<PermState> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { FirebaseMessaging } = await import('@capacitor-firebase/messaging');
      return norm((await FirebaseMessaging.requestPermissions()).receive);
    }
    if (typeof Notification === 'undefined') return 'unavailable';
    return norm(await Notification.requestPermission().then((r) => (r === 'default' ? 'prompt' : r)));
  } catch {
    return 'unavailable';
  }
}

export async function requestSetupPermissions(): Promise<Record<SetupPermission, PermState>> {
  let location: PermState = 'unavailable';
  let nearby: PermState = 'unavailable';
  if (Capacitor.isNativePlatform()) {
    try {
      const r = await AissNative.requestPermissions({ permissions: ['location', 'nearbyWifi'] });
      location = norm(r.location);
      nearby = norm(r.nearbyWifi);
    } catch {
      /* plugin unavailable */
    }
  } else if (navigator.geolocation) {
    location = await new Promise<PermState>((res) => navigator.geolocation.getCurrentPosition(() => res('granted'), (e) => res(e.code === 1 ? 'denied' : 'prompt'), { timeout: 8000 }));
  }
  const mic = await microphone();
  const notif = await notifications();
  return { location, nearby, microphone: mic, notifications: notif };
}
