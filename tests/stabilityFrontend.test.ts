import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  transport: null as null | { captureFrame: ReturnType<typeof import('vitest').vi.fn> },
  latest: null as null | { blob: Blob; capturedAt: number; seq: number },
  running: false,
  seq: 0,
}));

vi.mock('../src/core/device/bridge', () => ({ getTransport: () => h.transport }));
vi.mock('../src/core/camera/liveStream', () => ({
  latestStreamFrame: (maxAgeMs?: number) => {
    if (!h.latest) return null;
    if (maxAgeMs != null && Date.now() - h.latest.capturedAt > maxAgeMs) return null;
    return h.latest;
  },
  isLiveStreamRunning: () => h.running,
  useLiveStream: { getState: () => ({ seq: h.seq }) },
  waitForStreamFrame: async () => null,
}));

import { SCENE_PHOTO_FRESH_MS, SPOKEN_SENSOR_FRESH_MS } from '../src/core/vision/fusion';
import { visionCaptureRequired } from '../src/core/vision/visionScheduling';
import { serverBackoffMs } from '../src/core/maps/destinationSearch';
import { BUSY_RETRIES, BUSY_WAIT_MS, captureFrame } from '../src/core/vision/relay';
import { useDevice } from '../src/core/store/device';
import { useRuntime } from '../src/core/runtime/mode';
import { useVision } from '../src/core/store/vision';

const jpeg = () => new Blob([Uint8Array.of(0xff, 0xd8, 1, 0xff, 0xd9) as BlobPart], { type: 'image/jpeg' });

describe('stability fixes across freshness, camera preview/detection, and maps backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    h.transport = { captureFrame: vi.fn() };
    h.latest = null;
    h.running = false;
    h.seq = 0;
    useRuntime.setState({ mode: 'real' });
    useDevice.setState({ link: 'connected' });
    useVision.setState({ latest: null });
  });
  afterEach(() => vi.useRealTimers());

  it('keeps ultrasonic freshness at 1 s while allowing normal cloud-vision roundtrips (15 s) before labelling earlier photo', () => {
    expect(SPOKEN_SENSOR_FRESH_MS).toBe(1000);
    expect(SCENE_PHOTO_FRESH_MS).toBe(15_000);
  });

  it('enables local object detection while Camera preview is open even when stationary with distant sonar', () => {
    const stationaryContext = {
      timestamp: Date.now(),
      ultrasonic: { state: 'valid' as const, value: 300, ageMs: 0 },
      accel: { state: 'valid' as const, value: null, ageMs: 0 },
      gyro: { state: 'valid' as const, value: null, ageMs: 0 },
      orientation: { state: 'valid' as const, value: null, ageMs: 0 },
      motion: 'STABLE' as const,
      quality: 'good' as const,
    };
    expect(visionCaptureRequired({
      context: stationaryContext,
      navigationActive: false,
      walkingSessionActive: false,
      awarenessCm: 150,
    })).toBe(false);
    expect(visionCaptureRequired({
      context: stationaryContext,
      navigationActive: false,
      walkingSessionActive: false,
      awarenessCm: 150,
      cameraPreviewOpen: true,
    })).toBe(true);
  });

  it('does not ban Google Maps Cloud Functions for 5 minutes when only home address is missing', () => {
    const missingHome = Object.assign(new Error('No home address saved.'), { code: 'functions/failed-precondition' });
    const missingKey = Object.assign(new Error('Maps is not configured on the server.'), { code: 'functions/failed-precondition' });
    expect(serverBackoffMs(missingHome)).toBe(0);
    expect(serverBackoffMs(missingKey)).toBe(5 * 60_000);
  });

  it('falls back to a visible preview frame when direct capture fails as camera: busy', async () => {
    const previewBlob = jpeg();
    h.latest = { blob: previewBlob, capturedAt: Date.now() - 2500, seq: 10 };
    h.transport!.captureFrame.mockRejectedValue(new Error('camera: busy'));

    const p = captureFrame('assistant');
    await vi.advanceTimersByTimeAsync(BUSY_WAIT_MS * (BUSY_RETRIES + 1));
    const frame = await p;

    expect(frame.blob).toBe(previewBlob);
    expect(frame.ts).toBe(100_000 - 2500);
    expect(useDevice.getState().camera.status).toBe('idle');
  });
});
