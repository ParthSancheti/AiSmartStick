import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { AissNative, type AudioRoute } from '../native/aissNative';

/**
 * Where AI SmartStick audio is currently going, as reported by Android's AudioManager.
 * The app follows the system route; it does not pair devices or control other apps.
 */
/** pollMs <= 0: read once (e.g. while the page showing it is closed). Never polls while hidden. */
export function useAudioRoute(pollMs = 5000) {
  const [state, setState] = useState<{ route: AudioRoute; name: string | null; native: boolean }>({ route: 'unknown', name: null, native: Capacitor.isNativePlatform() });
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let alive = true;
    const read = () =>
      document.visibilityState === 'hidden'
        ? undefined
        : AissNative.getAudioRoute()
        .then((r) => alive && setState({ ...r, native: true }))
        .catch(() => undefined);
    void read();
    const t = pollMs > 0 ? setInterval(read, pollMs) : undefined;
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pollMs]);
  return state;
}
