import { useEffect } from 'react';
import { useSession } from '../core/store/session';
import { StatusBar, Style } from '@capacitor/status-bar';
import { AissNative } from '../core/native/aissNative';
import type { GlassTier } from '../core/types';

function detectTier(): GlassTier {
  if (typeof window !== 'undefined' && (window as any).Capacitor?.isNativePlatform?.()) {
    return 'lite';
  }
  const supports = CSS.supports('backdrop-filter', 'blur(2px)') || CSS.supports('-webkit-backdrop-filter', 'blur(2px)');
  if (!supports) return 'solid';
  if (window.matchMedia('(prefers-reduced-transparency: reduce)').matches) return 'solid';
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  if (mem <= 3 || cores <= 4) return 'lite';
  return 'full';
}

// Chromium engines (Chrome, Edge, Samsung Internet, Android WebView). iOS "Chrome" is WebKit.
const isBlink = () => /Chrome\/\d+/.test(navigator.userAgent) && !/CriOS|FxiOS/.test(navigator.userAgent);

/** Pushes appearance settings onto <html> as data attributes the CSS reads. */
export function useApplySettings() {
  const theme = useSession((s) => s.settings.theme);
  const glass = useSession((s) => s.settings.glass);
  const reduceMotion = useSession((s) => s.settings.reduceMotion);

  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches);
      root.dataset.theme = dark ? 'dark' : 'light';
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b1820' : '#eaf1ef');
      if (typeof window !== 'undefined' && (window as any).Capacitor?.isNativePlatform?.()) { StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(()=>{}); void AissNative.setStatusBarIcons({ dark: !dark }).catch(()=>{}); }
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.glass = glass === 'auto' ? detectTier() : glass;
    root.dataset.engine = isBlink() ? 'blink' : 'other';
    root.dataset.reduceMotion = String(reduceMotion);
  }, [glass, reduceMotion]);
}
