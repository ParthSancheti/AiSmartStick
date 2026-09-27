import { useCallback, useState } from 'react';
import { useDevice } from '../core/store/device';
import { captureFrame } from '../core/vision/relay';
import type { VisionFrame } from '../core/types';

/**
 * Stick-user side of the camera: one-shot captures from the ESP32-CAM.
 * (The old `useESP32Stream` idea split in two: this for capture, and
 * useGuardianVision for rendering frames on the Guardian's screen.)
 */
export function useStickCamera() {
  const available = useDevice((s) => (s.link === 'connected' || s.link === 'degraded') && s.camera.status !== 'error' && s.camera.status !== 'unavailable');
  const busy = useDevice((s) => s.camera.status === 'capturing');
  const [error, setError] = useState<string | null>(null);
  const capture = useCallback(async (origin: VisionFrame['origin'] = 'assistant', sceneHint?: number) => {
    setError(null);
    try {
      return await captureFrame(origin, sceneHint);
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, []);
  return { available, busy, error, capture };
}
