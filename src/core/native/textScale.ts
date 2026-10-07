import { Capacitor } from '@capacitor/core';
import { AissNative } from './aissNative';
import { useSession } from '../store/session';

const KEY = 'aiss.textScaleSeeded.v1';

/**
 * Text size on Android. The WebView ignores the system font size (MainActivity pins textZoom to
 * 100 %): it enlarged text inside fixed-size boxes, which cut cards off on the right. Instead the
 * app's own text size (Settings → Voice & display, tested layouts) starts from the system value
 * once, capped at 130 %. The user can change it any time afterwards.
 */
export async function seedTextScaleFromSystem() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    if (localStorage.getItem(KEY)) return;
  } catch {
    return;
  }
  try {
    const { fontScale } = await AissNative.getFontScale();
    localStorage.setItem(KEY, '1');
    const s = useSession.getState();
    if (Number.isFinite(fontScale) && fontScale > 1.05 && Math.abs(s.settings.textScale - 1) < 0.01) {
      s.updateSettings({ textScale: Math.min(1.3, Math.round(fontScale * 20) / 20) });
    }
  } catch {
    /* older APK without getFontScale: keep 100 % */
  }
}
