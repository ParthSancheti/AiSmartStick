import type { VisionFrame } from '../types';
import { useVision } from '../store/vision';
import { useDevice } from '../store/device';
import { getTransport } from '../device/bridge';

/**
 * Capture one frame from the stick camera on the user's phone. Frames live in memory only.
 * Guardian viewing goes through core/camera/cameraSession.ts (ephemeral WebRTC in real mode).
 */
export async function captureFrame(origin: VisionFrame['origin'], sceneHint?: number): Promise<VisionFrame> {
  const t = getTransport();
  const dev = useDevice.getState();
  if (!t || (dev.link !== 'connected' && dev.link !== 'degraded')) throw new Error('stick-offline');
  useDevice.setState({ camera: { ...dev.camera, status: 'capturing' } });
  try {
    const f = await t.captureFrame({ sceneHint });
    const frame: VisionFrame = { blob: f.blob, scene: f.scene ?? -1, ts: f.capturedAt, origin };
    useVision.setState({ latest: frame });
    useDevice.setState({ camera: { status: 'idle', lastCaptureAt: f.capturedAt } });
    return frame;
  } catch (e) {
    useDevice.setState({ camera: { ...useDevice.getState().camera, status: 'error' } });
    throw e;
  }
}
