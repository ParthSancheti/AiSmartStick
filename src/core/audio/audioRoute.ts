import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { AissNative, type AudioRoute } from '../native/aissNative';

/**
 * Where AI Smart Stick audio is currently going, as reported by Android's AudioManager.
 * The app follows the system route; it does not pair devices or control other apps.
 */
export function useAudioRoute(pollMs = 5000) {
  const [state, setState] = useState<{ route: AudioRoute; name: string | null; native: boolean }>({ route: 'unknown', name: null, native: Capacitor.isNativePlatform() });
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let alive = true;
    const read = () =>
      AissNative.getAudioRoute()
        .then((r) => alive && setState({ ...r, native: true }))
        .catch(() => undefined);
    void read();
    const t = setInterval(read, pollMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pollMs]);
  return state;
}
