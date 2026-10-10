import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SensorContext } from '../src/core/vision/sensorConditioning';

const h = vi.hoisted(() => ({
  capture: vi.fn(), detect: vi.fn(),
  context: null as unknown as SensorContext,
  navigation: { active: false, arrived: false },
  walking: { current: null as object | null, paused: false },
  latest: null as null | { blob: Blob; capturedAt: number; seq: number },
  streamRunning: false,
  wait: vi.fn(),
}));
vi.mock('../src/core/device/bridge', () => ({ getTransport: () => ({ captureFrame: h.capture }) }));
vi.mock('../src/core/camera/liveStream', () => ({
  latestStreamFrame: () => h.latest,
  isLiveStreamRunning: () => h.streamRunning,
  useLiveStream: { getState: () => ({ width: 320, height: 240 }) },
  waitForStreamFrame: (...args: unknown[]) => h.wait(...args),
}));
vi.mock('../src/core/navigation/navView', () => ({ useNavView: { getState: () => h.navigation } }));
vi.mock('../src/core/walking/walkTracker', () => ({ useWalking: { getState: () => h.walking } }));
vi.mock('../src/core/store/session', () => ({ getSettings: () => ({ obstacleSensitivity: 'medium' }) }));
vi.mock('../src/core/store/ui', () => ({ useUI: { getState: () => ({ visionDebug: false }) } }));
vi.mock('../src/core/vision/sensorConditioning', async (original) => ({
  ...await original<typeof import('../src/core/vision/sensorConditioning')>(),
  getCurrentSensorContext: () => h.context,
}));
vi.mock('../src/core/vision/detector', () => ({
  LocalDetector: class {
    status = 'idle';
    initMs = 5;
    actualInferenceLatencyMs = 5;
    get ready() { return this.status === 'ready'; }
    async init() { this.status = 'ready'; }
    detect(...args: unknown[]) { return h.detect(...args); }
    terminate() { this.status = 'idle'; }
  },
}));

import { FramePipeline } from '../src/core/vision/framePipeline';
import { VisionEngine } from '../src/core/vision/visionLoop';
import { visionCaptureRequired, VISION_SCHEDULING } from '../src/core/vision/visionScheduling';
import { initialDevice, useDevice } from '../src/core/store/device';
import { useVisionDebug } from '../src/core/store/visionDebug';

const testEpoch = 200_000;
const photo = (capturedAt = Date.now()) => ({ blob: new Blob(['jpeg']), width: 320, height: 240, capturedAt });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const engines: VisionEngine[] = [];
function startEngine() {
  const engine = new VisionEngine();
  engines.push(engine);
  engine.start();
  return engine;
}
function policy() {
  return visionCaptureRequired({ context: h.context, navigationActive: h.navigation.active,
    walkingSessionActive: !!h.walking.current && !h.walking.paused, awarenessCm: 150 });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(testEpoch);
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - testEpoch);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.context = {
    timestamp: Date.now(), ultrasonic: { state: 'valid', value: 300, ageMs: 0 },
    accel: { state: 'valid', value: null, ageMs: 0 }, gyro: { state: 'valid', value: null, ageMs: 0 },
    orientation: { state: 'valid', value: null, ageMs: 0 }, motion: 'STABLE', quality: 'good',
  };
  h.navigation = { active: false, arrived: false };
  h.walking = { current: null, paused: false };
  h.capture.mockReset().mockImplementation(async () => photo());
  h.detect.mockReset().mockResolvedValue([]);
  h.latest = null;
  h.streamRunning = false;
  h.wait.mockReset().mockResolvedValue(null);
  useDevice.setState({ ...initialDevice(), link: 'connected' });
  useVisionDebug.setState({ runState: 'stopped', debugFrameUrl: null, lastFrameError: null });
});
afterEach(() => {
  engines.splice(0).forEach((engine) => engine.stop());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('walking vision capture scheduling', () => {
  it.each([300, null])('observes during navigation when front sonar reports %s cm', async (value) => {
    h.context.ultrasonic.value = value;
    h.navigation.active = true;
    startEngine();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(h.detect).toHaveBeenCalledTimes(1);
  });

  it('stays idle while stationary with a distant echo and no active session', async () => {
    startEngine();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.detect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    expect(VISION_SCHEDULING.idleCheckMs).toBe(400);
  });

  it('observes an unpaused walking session and idles once that session is paused', async () => {
    h.walking.current = {};
    startEngine();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.capture).toHaveBeenCalledTimes(1);
    h.walking.paused = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.capture).toHaveBeenCalledTimes(1);
  });

  it.each(['WALKING', 'SWINGING', 'RAPID_MOTION'] as const)('keeps vision active for conditioned %s motion', async (motion) => {
    h.context.motion = motion;
    startEngine();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.capture).toHaveBeenCalledTimes(1);
  });

  it.each([
    { state: 'valid' as const, value: 100, ageMs: 1501 },
    { state: 'stale' as const, value: 100, ageMs: 0 },
    { state: 'valid' as const, value: NaN, ageMs: 0 },
    { state: 'valid' as const, value: Infinity, ageMs: 0 },
    { state: 'valid' as const, value: 100, ageMs: -1 },
  ])('rejects stale or malformed proximity-only capture inputs: $state/$value/$ageMs', ({ state, value, ageMs }) => {
    h.context.ultrasonic = { state, value, ageMs };
    expect(policy()).toBe(false);
  });

  it('captures for a fresh near echo without an active walking session', async () => {
    h.context.ultrasonic.value = 100;
    startEngine();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.capture).toHaveBeenCalledTimes(1);
  });

  it('captures ahead of the proximity boundary only for a reliable approaching projection', () => {
    h.context.ultrasonicApproach = {
      trend: 'APPROACHING', closingSpeedCmS: 100, timeToWarningMs: 1800,
      warningDistanceCm: 100, confidence: 'good', sampleCount: 4, spanMs: 1500, resetReason: null,
    };
    expect(policy()).toBe(true);
    h.context.ultrasonicApproach.confidence = 'degraded';
    expect(policy()).toBe(false);
    h.context.ultrasonicApproach.confidence = 'good';
    h.context.ultrasonicApproach.timeToWarningMs = 3000;
    expect(policy()).toBe(false);
  });

  it('keeps walking vision active when the document is hidden', async () => {
    vi.stubGlobal('document', { hidden: true, visibilityState: 'hidden' });
    h.navigation.active = true;
    startEngine();
    await vi.advanceTimersByTimeAsync(750);
    expect(h.capture).toHaveBeenCalledTimes(4);
    expect(h.detect).toHaveBeenCalledTimes(4);
  });

  it('retains the existing four-FPS maximum without accumulating extra timers', async () => {
    const timestamps: number[] = [];
    h.capture.mockImplementation(async () => { timestamps.push(Date.now()); return photo(); });
    h.navigation.active = true;
    const engine = startEngine();
    engine.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(timestamps).toEqual([testEpoch, testEpoch + 250, testEpoch + 500, testEpoch + 750]);
    expect(vi.getTimerCount()).toBe(1);
    engine.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not overlap pending camera work across a stop/start during navigation', async () => {
    const pending = deferred<ReturnType<typeof photo>>();
    const oldPhoto = photo();
    h.capture.mockReturnValueOnce(pending.promise);
    h.navigation.active = true;
    const engine = startEngine();
    const snapshots = vi.fn();
    engine.onSnapshot = snapshots;
    await vi.advanceTimersByTimeAsync(1);
    engine.stop();
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.capture).toHaveBeenCalledTimes(1);
    pending.resolve(oldPhoto);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.capture).toHaveBeenCalledTimes(2);
    expect(h.detect).toHaveBeenCalledTimes(1);
    expect(snapshots).toHaveBeenCalledTimes(1);
  });

  it('waits for slow inference rather than building a capture or inference backlog', async () => {
    const pending = deferred<never[]>();
    h.detect.mockReturnValueOnce(pending.promise);
    h.navigation.active = true;
    startEngine();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(h.detect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.capture).toHaveBeenCalledTimes(2);
    expect(h.detect).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('physical frame identity and resource bounds', () => {
  it.each([NaN, Infinity, -Infinity, testEpoch + 1])('drops invalid frame timestamps (%s) before inference', async (capturedAt) => {
    h.capture.mockResolvedValueOnce(photo(capturedAt));
    const pipeline = new FramePipeline();
    await expect(pipeline.fetchNextFrame()).rejects.toThrow('Invalid frame timestamp');
    expect(pipeline.metrics.capturedFrames).toBe(0);
    expect(pipeline.metrics.droppedFrames).toBe(1);
    expect(Object.values(pipeline.metrics).every(Number.isFinite)).toBe(true);
  });

  it('does not reprocess the same physical-frame timestamp after a metrics reset', async () => {
    const repeated = photo();
    h.capture.mockResolvedValue(repeated);
    const pipeline = new FramePipeline();
    await pipeline.fetchNextFrame();
    pipeline.reset();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pipeline.fetchNextFrame()).rejects.toThrow('Repeated or out-of-order frame');
    expect(pipeline.metrics.droppedFrames).toBe(1);
    h.capture.mockResolvedValue(photo());
    await expect(pipeline.fetchNextFrame()).resolves.toMatchObject({ capturedAt: testEpoch + 1 });
    expect(pipeline.metrics.capturedFrames).toBe(1);
  });

  it('rejects an out-of-order frame even if it remains inside the freshness budget', async () => {
    const pipeline = new FramePipeline();
    await pipeline.fetchNextFrame();
    await vi.advanceTimersByTimeAsync(100);
    h.capture.mockResolvedValueOnce(photo(testEpoch - 1));
    await expect(pipeline.fetchNextFrame()).rejects.toThrow('Repeated or out-of-order frame');
  });

  it('preserves stream sequence identity across reset and ignores a reused awaited sequence', async () => {
    h.streamRunning = true;
    h.latest = { blob: photo().blob, capturedAt: testEpoch, seq: 5 };
    const pipeline = new FramePipeline();
    await pipeline.fetchNextFrame();
    pipeline.reset();
    h.wait.mockResolvedValue(h.latest);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pipeline.fetchNextFrame()).resolves.toMatchObject({ capturedAt: testEpoch + 1 });
    expect(h.wait).toHaveBeenCalledWith(5, 1500);
    expect(h.capture).toHaveBeenCalledTimes(1);
  });

  it('shares one pending stream wait between callers without an additional camera request', async () => {
    h.streamRunning = true;
    const heldFrame = deferred<{ blob: Blob; capturedAt: number; seq: number }>();
    h.wait.mockReturnValue(heldFrame.promise);
    const pipeline = new FramePipeline();
    const first = pipeline.fetchNextFrame();
    const second = pipeline.fetchNextFrame();
    expect(first).toBe(second);
    expect(h.wait).toHaveBeenCalledTimes(1);
    expect(h.capture).not.toHaveBeenCalled();
    heldFrame.resolve({ blob: photo().blob, capturedAt: Date.now(), seq: 1 });
    await Promise.all([first, second]);
    expect(pipeline.metrics.capturedFrames).toBe(1);
  });

  it('keeps FPS metrics finite when timing resolution reports equal completion times', async () => {
    vi.mocked(performance.now).mockReturnValue(100);
    const pipeline = new FramePipeline();
    await pipeline.fetchNextFrame();
    pipeline.finishInference(10, 20);
    await vi.advanceTimersByTimeAsync(1);
    await pipeline.fetchNextFrame();
    pipeline.finishInference(10, 20);
    expect(Number.isFinite(pipeline.metrics.effectiveFps)).toBe(true);
    expect(Number.isFinite(pipeline.metrics.inferenceFps)).toBe(true);
  });
});
