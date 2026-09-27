import { useEffect } from 'react';
import { startSilentKeepAlive } from '../core/feedback/earcons';
import { getSettings } from '../core/store/session';
import { Capacitor } from '@capacitor/core';
import { AissNative } from '../core/native/aissNative';

/**
 * Keeps the screen awake while the dim shield is up, and re-acquires the lock
 * when the page becomes visible again (browsers drop it on every hide).
 * Wake Lock only keeps the screen ON; it can't keep a locked phone running.
 * The Android app uses FLAG_KEEP_SCREEN_ON here and a foreground service for the rest.
 */
export function usePocketMode(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let sentinel: WakeLockSentinel | null = null;
    let done = false;
    const acquire = async () => {
      try {
        if (Capacitor.isNativePlatform()) {
          // Native: window flag; the foreground service (core/native/background.ts) keeps things running if the screen still goes off.
          await AissNative.setKeepScreenOn({ on: true });
          return;
        }
        if ('wakeLock' in navigator) sentinel = await navigator.wakeLock.request('screen');
      } catch {
        /* denied or unsupported */
      }
    };
    void acquire();
    const onVis = () => {
      if (!done && document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVis);
    const stopAudio = getSettings().pocketKeepAlive ? startSilentKeepAlive() : () => {};
    return () => {
      done = true;
      document.removeEventListener('visibilitychange', onVis);
      stopAudio();
      void sentinel?.release().catch(() => undefined);
      if (Capacitor.isNativePlatform()) void AissNative.setKeepScreenOn({ on: false }).catch(() => undefined);
    };
  }, [active]);
}
