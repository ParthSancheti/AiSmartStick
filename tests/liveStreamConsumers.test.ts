/**
 * Live-stream consumers: FramePipeline (src/core/vision/framePipeline.ts) prefers stream frames it has
 * not analysed yet, and VisionEngine (src/core/vision/visionLoop.ts) holds the live stream exactly
 * while detection runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Frame = { blob: Blob; capturedAt: number; seq: number };

const h = vi.hoisted(() => ({
  transport: null as null | { captureFrame: ReturnType<typeof import('vitest').vi.fn> },
  latest: null as null | Frame,
  running: false,
  next: null as null | Frame,
  waitArgs: [] as unknown[][],
  acquired: [] as string[],
  released: 0,
  detectorFails: false,
}));

vi.mock('../src/core/device/bridge', () => ({ getTransport: () => h.transport }));
vi.mock('../src/core/camera/liveStream', () => ({
  latestStreamFrame: () => h.latest,
  isLiveStreamRunning: () => h.running,
  useLiveStream: { getState: () => ({ width: 320, height: 240 }) },
  waitForStreamFrame: async (after: number, timeoutMs: number) => {
    h.waitArgs.push([after, timeoutMs]);
    return h.next && h.next.seq > after ? h.next : null;
  },
  acquireLiveStream: (reason: string) => {
    h.acquired.push(reason);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      h.released++;
    };
  },
}));
vi.mock('../src/core/vision/detector', () => ({
  LocalDetector: class {
    status: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
    initMs: number | null = null;
    actualInferenceLatencyMs = 5;
    get ready() {
      return this.status === 'ready';
    }
    async init() {
      this.status = 'loading';
      await Promise.resolve();
      if (h.detectorFails) {
        this.status = 'error';
        throw new Error('model missing');
      }
      this.status = 'ready';
      this.initMs = 10;
    }
    async detect() {
      return [];
    }
    terminate() {
      this.status = 'idle';
    }
  },
}));

import { FramePipeline } from '../src/core/vision/framePipeline';
import { VisionEngine } from '../src/core/vision/visionLoop';
import { useDevice } from '../src/core/store/device';
import { useVisionDebug } from '../src/core/store/visionDebug';

const jpegBlob = () => new Blob([Uint8Array.of(0xff, 0xd8, 1, 0xff, 0xd9) as BlobPart], { type: 'image/jpeg' });
const photo = () => ({ blob: jpegBlob(), width: null, height: null, capturedAt: Date.now() });

beforeEach(() => {
  h.transport = { captureFrame: vi.fn(async () => photo()) };
  h.latest = null;
  h.running = false;
  h.next = null;
  h.waitArgs = [];
  h.acquired = [];
  h.released = 0;
  h.detectorFails = false;
});

describe('FramePipeline with the live stream', () => {
  it('uses each fresh stream frame once, then waits for the next one', async () => {
    const p = new FramePipeline({ maxStaleMs: 1500 });
    h.running = true;
    h.latest = { blob: jpegBlob(), capturedAt: Date.now(), seq: 5 };
    const a = await p.fetchNextFrame();
    expect(a).toMatchObject({ blob: h.latest.blob, width: 320, height: 240 });
    expect(h.transport!.captureFrame).not.toHaveBeenCalled();

    // Same frame again: not analysed twice; the next stream frame is awaited instead.
    h.next = { blob: jpegBlob(), capturedAt: Date.now(), seq: 6 };
    const b = await p.fetchNextFrame();
    expect(b.blob).toBe(h.next.blob);
    expect(h.waitArgs).toEqual([[5, 1500]]);
    expect(h.transport!.captureFrame).not.toHaveBeenCalled();
    expect(p.metrics.capturedFrames).toBe(2);
  });

  it('asks the stick for a photo when the stream is off or sends nothing', async () => {
    const p = new FramePipeline({ maxStaleMs: 1500 });
    await p.fetchNextFrame();
    expect(h.transport!.captureFrame).toHaveBeenCalledTimes(1);
    expect(h.waitArgs).toEqual([]);

    h.running = true;
    await p.fetchNextFrame();
    expect(h.waitArgs).toHaveLength(1);
    expect(h.transport!.captureFrame).toHaveBeenCalledTimes(2);
  });

  it('still drops stale frames and fails when offline', async () => {
    const p = new FramePipeline({ maxStaleMs: 1500 });
    h.latest = { blob: jpegBlob(), capturedAt: Date.now() - 5000, seq: 9 };
    await expect(p.fetchNextFrame()).rejects.toThrow(/Stale frame dropped/);
    expect(p.metrics.droppedFrames).toBe(1);
    h.transport = null;
    await expect(p.fetchNextFrame()).rejects.toThrow('offline');
  });
});

describe('VisionEngine runs without the live stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    useDevice.setState({ link: 'connected' });
    useVisionDebug.setState({ runState: 'waiting_for_stick' } as Partial<ReturnType<typeof useVisionDebug.getState>>);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('never holds the live stream (hybrid: photos only when an obstacle is near)', async () => {
    const engine = new VisionEngine();
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(useVisionDebug.getState().runState).toBe('running');
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.acquired).toEqual([]);
    engine.stop();
  });

  it('does not hold the stream while the detector cannot load', async () => {
    h.detectorFails = true;
    const engine = new VisionEngine();
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(useVisionDebug.getState().runState).toBe('error');
    expect(h.acquired).toEqual([]);
    engine.stop();
    expect(h.released).toBe(0);
  });
});
