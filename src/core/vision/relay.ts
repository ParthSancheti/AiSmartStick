import type { VisionFrame } from '../types';
import { useVision } from '../store/vision';
import { useDevice, isLinked } from '../store/device';
import { getTransport } from '../device/bridge';
import { isDemo } from '../runtime/mode';
import { isLiveStreamRunning, latestStreamFrame, useLiveStream, waitForStreamFrame } from '../camera/liveStream';

/** A live-stream frame younger than this is used as it is (no extra photo request). */
export const FRESH_STREAM_FRAME_MS = 1000;
/** 'camera: busy' (409) retries, and the wait between them. */
export const BUSY_RETRIES = 3;
export const BUSY_WAIT_MS = 350;
/** While the live stream runs, a busy camera means "wait for its next frame" (at most this long). */
export const STREAM_FRAME_WAIT_MS = 1500;

const isBusy = (e: unknown) => /camera: busy|\b409\b/i.test((e as Error)?.message ?? '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function publish(blob: Blob, scene: number, ts: number, origin: VisionFrame['origin']): VisionFrame {
  const frame: VisionFrame = { blob, scene, ts, origin };
  useVision.setState({ latest: frame });
  useDevice.setState({ camera: { status: 'idle', lastCaptureAt: ts } });
  return frame;
}

/**
 * One frame from the stick camera on the user's phone. Frames live in memory only.
 *  1. A live-stream frame from the last second (core/camera/liveStream.ts), when the stream runs.
 *  2. Else one photo through the transport (/api/v1/capture). The stick answers 409 while the stream
 *     holds the camera: then wait for the stream's next frame, or retry (3 times, 350 ms apart).
 * Demo mode always asks the demo transport (the scene hint picks the demo picture).
 * Guardian viewing goes through core/camera/cameraSession.ts (ephemeral WebRTC in real mode).
 */
export async function captureFrame(origin: VisionFrame['origin'], sceneHint?: number): Promise<VisionFrame> {
  const t = getTransport();
  const dev = useDevice.getState();
  if (!t || !isLinked(dev.link)) throw new Error('stick-offline');
  const real = !isDemo();
  if (real) {
    const s = latestStreamFrame(FRESH_STREAM_FRAME_MS);
    if (s) return publish(s.blob, -1, s.capturedAt, origin);
  }
  useDevice.setState({ camera: { ...dev.camera, status: 'capturing' } });
  try {
    for (let retry = 0; ; retry++) {
      try {
        const f = await t.captureFrame({ sceneHint });
        return publish(f.blob, f.scene ?? -1, f.capturedAt, origin);
      } catch (e) {
        if (!isBusy(e) || retry >= BUSY_RETRIES) throw e;
        if (real && isLiveStreamRunning()) {
          const s = await waitForStreamFrame(useLiveStream.getState().seq, STREAM_FRAME_WAIT_MS);
          if (s) return publish(s.blob, -1, s.capturedAt, origin);
        } else await sleep(BUSY_WAIT_MS);
      }
    }
  } catch (e) {
    useDevice.setState({ camera: { ...useDevice.getState().camera, status: 'error' } });
    throw e;
  }
}
