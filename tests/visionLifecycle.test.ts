import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ capture: vi.fn(), detect: vi.fn(), init: vi.fn() }));
vi.mock('../src/core/device/bridge', () => ({ getTransport: () => ({ captureFrame: h.capture }) }));
vi.mock('../src/core/camera/liveStream', () => ({
  latestStreamFrame: () => null,
  isLiveStreamRunning: () => false,
  useLiveStream: { getState: () => ({ width: 320, height: 240 }) },
  waitForStreamFrame: vi.fn(),
}));
vi.mock('../src/core/vision/detector', () => ({
  LocalDetector: class {
    status = 'idle';
    initMs = 5;
    actualInferenceLatencyMs = 5;
    get ready() { return this.status === 'ready'; }
    async init() {
      this.status = 'loading';
      await h.init();
      this.status = 'ready';
    }
    detect(...args: unknown[]) { return h.detect(...args); }
    terminate() { this.status = 'idle'; }
  },
}));
// These lifecycle tests isolate worker ownership; supply fresh range context from their fixture.
vi.mock('../src/core/vision/sensorConditioning', () => ({
  THRESHOLDS: { US_STALE_MS: 1500, IMU_STALE_MS: 1500 },
  getCurrentSensorContext: () => ({ timestamp: Date.now(),
    ultrasonic: { value: useDevice.getState().ultrasonic.distanceCm, state: 'valid', ageMs: 0 },
    motion: 'STABLE', quality: 'unknown' }),
}));

import { FramePipeline } from '../src/core/vision/framePipeline';
import { VisionEngine } from '../src/core/vision/visionLoop';
import { initialDevice, useDevice } from '../src/core/store/device';
import { useVisionDebug } from '../src/core/store/visionDebug';
import { useUI } from '../src/core/store/ui';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const photo = () => ({ blob: new Blob(['jpeg']), width: 320, height: 240, capturedAt: Date.now() });
const engines: VisionEngine[] = [];
const engine = () => {
  const instance = new VisionEngine();
  engines.push(instance);
  return instance;
};

beforeEach(() => {
  vi.useFakeTimers();
  h.capture.mockReset().mockImplementation(async () => photo());
  h.detect.mockReset().mockResolvedValue([]);
  h.init.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  useDevice.setState({ ...initialDevice(), link: 'connected', ultrasonic: {
    ...initialDevice().ultrasonic, status: 'ok', distanceCm: 100,
  } });
  useVisionDebug.setState({ runState: 'stopped', debugFrameUrl: null, lastFrameError: null });
  useUI.setState({ visionDebug: true });
});
afterEach(() => {
  engines.splice(0).forEach((instance) => instance.stop());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('FramePipeline bounded capture work', () => {
  it('shares a single in-flight capture even if the pipeline is reset', async () => {
    const capture = deferred<ReturnType<typeof photo>>();
    h.capture.mockReturnValue(capture.promise);
    const pipeline = new FramePipeline();
    const first = pipeline.fetchNextFrame();
    pipeline.reset();
    const second = pipeline.fetchNextFrame();
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    capture.resolve(photo());
    await Promise.all([first, second]);
    expect(pipeline.metrics.capturedFrames).toBe(1);
  });

  it('releases its capture slot after a failure so the next request can recover', async () => {
    h.capture.mockRejectedValueOnce(new Error('camera busy'));
    const pipeline = new FramePipeline();
    await expect(pipeline.fetchNextFrame()).rejects.toThrow('camera busy');
    await expect(pipeline.fetchNextFrame()).resolves.toMatchObject({ width: 320 });
    expect(h.capture).toHaveBeenCalledTimes(2);
    expect(pipeline.metrics.capturedFrames).toBe(1);
  });
});

describe('VisionEngine lifecycle ownership', () => {
  it('does not overlap capture work when the stick disconnects and reconnects', async () => {
    const capture = deferred<ReturnType<typeof photo>>();
    h.capture.mockReturnValueOnce(capture.promise);
    const vision = engine();
    const snapshots = vi.fn();
    vision.onSnapshot = snapshots;
    vision.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.capture).toHaveBeenCalledTimes(1);
    useDevice.setState({ link: 'reconnecting' });
    useDevice.setState({ link: 'connected' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.capture).toHaveBeenCalledTimes(1);
    // A different physical capture must have a later timestamp than the obsolete frame.
    const obsoletePhoto = photo();
    await vi.advanceTimersByTimeAsync(1);
    capture.resolve(obsoletePhoto);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.capture).toHaveBeenCalledTimes(2);
    expect(h.detect).toHaveBeenCalledTimes(1); // The old generation drops its completed capture.
    expect(snapshots).toHaveBeenCalledTimes(1);
  });

  it('does not overlap inference jobs or publish old results after a restart', async () => {
    const inference = deferred<never[]>();
    h.detect.mockReturnValueOnce(inference.promise);
    const vision = engine();
    const snapshots = vi.fn();
    vision.onSnapshot = snapshots;
    vision.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.detect).toHaveBeenCalledTimes(1);
    vision.stop();
    vision.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(h.detect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    inference.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.detect).toHaveBeenCalledTimes(2);
    expect(snapshots).toHaveBeenCalledTimes(1);
  });

  it('ignores the failure of an initialization belonging to a stopped lifecycle', async () => {
    const initialization = deferred<void>();
    h.init.mockReturnValueOnce(initialization.promise);
    const vision = engine();
    vision.start();
    vision.stop();
    vision.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(useVisionDebug.getState().runState).toBe('running');
    initialization.reject(new Error('old model stopped'));
    await vi.advanceTimersByTimeAsync(0);
    expect(useVisionDebug.getState().runState).toBe('running');
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.init).toHaveBeenCalledTimes(2);
  });

  it('keeps one idle-check timer, releases the debug image and stops all timers', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const vision = engine();
    vision.start();
    vision.start();
    await vi.advanceTimersByTimeAsync(0);
    const debugUrl = useVisionDebug.getState().debugFrameUrl;
    expect(debugUrl).toBeTruthy();
    useDevice.setState({ ultrasonic: { ...useDevice.getState().ultrasonic, distanceCm: 200 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    vision.stop();
    expect(revoke).toHaveBeenCalledWith(debugUrl);
    expect(useVisionDebug.getState().debugFrameUrl).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cannot recreate a debug URL if its snapshot callback stops detection', async () => {
    const vision = engine();
    const createUrl = vi.spyOn(URL, 'createObjectURL');
    vision.onSnapshot = () => vision.stop();
    vision.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(createUrl).not.toHaveBeenCalled();
    expect(useVisionDebug.getState().debugFrameUrl).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
