/**
 * Platform capability flags, set once on <html> before React renders (main.tsx).
 *
 *   html.native     Capacitor app (Android / iOS WebView)
 *   html.android    Android app or Android browser
 *   html.low-power  a phone WebView/browser: the CSS swaps expensive effects (backdrop-filter blur,
 *                   big animated layers, clip-path reveals) for cheap equivalents with the same look
 *   html.page-hidden  the app is in the background: ambient animations are paused
 *
 * Android WebView is far weaker than desktop Chrome: every backdrop-filter is re-rendered on every
 * frame something moves beneath it. Desktop browsers keep the full effects.
 * `?lowpower=1` (or window.__AISS_FORCE_LOW_POWER) forces the phone profile on a desktop for testing.
 */
export interface PlatformFlags {
  native: boolean;
  android: boolean;
  lowPower: boolean;
}

export function platformFlags(platform: string, userAgent: string, search = '', forced = false): PlatformFlags {
  const native = platform === 'android' || platform === 'ios';
  const android = platform === 'android' || /Android/i.test(userAgent);
  const param = new URLSearchParams(search).get('lowpower');
  const lowPower = param === '0' ? false : forced || param === '1' || native || android;
  return { native, android, lowPower };
}

export function applyPlatformClasses(platform: string) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const forced = !!(window as Window & { __AISS_FORCE_LOW_POWER?: boolean }).__AISS_FORCE_LOW_POWER;
  const f = platformFlags(platform, navigator.userAgent, location.search, forced);
  root.classList.toggle('native', f.native);
  root.classList.toggle('android', f.android);
  root.classList.toggle('low-power', f.lowPower);
  const vis = () => root.classList.toggle('page-hidden', document.visibilityState === 'hidden');
  vis();
  document.addEventListener('visibilitychange', vis);
}

export const isLowPower = () => typeof document !== 'undefined' && document.documentElement.classList.contains('low-power');
