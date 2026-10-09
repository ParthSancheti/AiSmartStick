/**
 * relay.captureFrame (src/core/vision/relay.ts): the one-photo path the assistant uses.
 * A fresh live-stream frame is used as it is; else one photo through the transport, with retries
 * when the stick says "camera: busy" (or the stream's next frame while the stream runs).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Frame = { blob: Blob; capturedAt: number; seq: number };

const h = vi.hoisted(() => ({
  transport: null as null | { captureFrame: ReturnType<typeof import('vitest').vi.fn> },
  latest: null as null | Frame,
  running: false,
  seq: 0,
  next: null as null | Frame,
  latestArgs: [] as unknown[],
  waitArgs: [] as unknown[][],
}));

vi.mock('../src/core/device/bridge', () => ({ getTransport: () => h.transport }));
vi.mock('../src/core/camera/liveStream', () => ({
  latestStreamFrame: (maxAgeMs?: number) => {
    h.latestArgs.push(maxAgeMs);
    return h.latest;
  },
  isLiveStreamRunning: () => h.running,
  useLiveStream: { getState: () => ({ seq: h.seq }) },
  waitForStreamFrame: (after: number, timeoutMs: number) => {
    h.waitArgs.push([after, timeoutMs]);
    return new Promise((r) => setTimeout(() => r(h.next), 200));
  },
}));

import { captureFrame, BUSY_RETRIES, BUSY_WAIT_MS, FRESH_STREAM_FRAME_MS, STREAM_FRAME_WAIT_MS } from '../src/core/vision/relay';
import { useDevice } from '../src/core/store/device';
import { useVision } from '../src/core/store/vision';
import { useRuntime } from '../src/core/runtime/mode';

const jpegBlob = (tag: string) => new Blob([Uint8Array.of(0xff, 0xd8, tag.charCodeAt(0), 0xff, 0xd9) as BlobPart], { type: 'image/jpeg' });
const photo = (tag = 'p') => ({ blob: jpegBlob(tag), width: null, height: null, capturedAt: Date.now(), scene: 3 });

beforeEach(() => {
  vi.useFakeTimers();
  h.transport = { captureFrame: vi.fn(async () => photo()) };
  h.latest = null;
  h.running = false;
  h.seq = 0;
  h.next = null;
  h.latestArgs = [];
  h.waitArgs = [];
  useRuntime.setState({ mode: 'real' });
  useDevice.setState({ link: 'connected' });
  useVision.setState({ latest: null });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('relay.captureFrame', () => {
  it('uses a fresh live-stream frame and asks the stick for nothing', async () => {
    const blob = jpegBlob('s');
    h.latest = { blob, capturedAt: 12_345, seq: 7 };
    const f = await captureFrame('assistant');
    expect(f).toMatchObject({ blob, ts: 12_345, origin: 'assistant', scene: -1 });
    expect(h.latestArgs).toEqual([FRESH_STREAM_FRAME_MS]);
    expect(FRESH_STREAM_FRAME_MS).toBe(1000);
    expect(h.transport!.captureFrame).not.toHaveBeenCalled();
    expect(useVision.getState().latest?.blob).toBe(blob);
    expect(useDevice.getState().camera).toMatchObject({ status: 'idle', lastCaptureAt: 12_345 });
  });

  it('takes one photo through the transport when there is no fresh stream frame', async () => {
    const f = await captureFrame('sos', 2);
    expect(h.transport!.captureFrame).toHaveBeenCalledTimes(1);
    expect(h.transport!.captureFrame).toHaveBeenCalledWith({ sceneHint: 2 });
    expect(f).toMatchObject({ origin: 'sos', scene: 3 });
    expect(useDevice.getState().camera.status).toBe('idle');
  });

  it('retries a busy camera 3 times, 350 ms apart', async () => {
    let n = 0;
    h.transport!.captureFrame = vi.fn(async () => {
      if (++n <= 2) throw new Error('camera: busy');
      return photo('ok');
    });
    const p = captureFrame('assistant');
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(BUSY_WAIT_MS - 10);
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(n).toBe(2);
    await vi.advanceTimersByTimeAsync(BUSY_WAIT_MS);
    const f = await p;
    expect(n).toBe(3);
    expect(f.blob.size).toBe(5);
    expect(useDevice.getState().camera.status).toBe('idle');
  });

  it('gives up after 3 busy retries and marks the camera as failed', async () => {
    h.transport!.captureFrame = vi.fn(async () => {
      throw new Error('camera: busy');
    });
    const p = captureFrame('assistant');
    const caught = p.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(BUSY_WAIT_MS * (BUSY_RETRIES + 1));
    expect(((await caught) as Error).message).toBe('camera: busy');
    expect(h.transport!.captureFrame).toHaveBeenCalledTimes(BUSY_RETRIES + 1);
    expect(useDevice.getState().camera.status).toBe('error');
  });

  it('while the live stream runs, a busy camera waits for the stream frame instead', async () => {
    h.running = true;
    h.seq = 41;
    const blob = jpegBlob('n');
    h.next = { blob, capturedAt: 999, seq: 42 };
    h.transport!.captureFrame = vi.fn(async () => {
      throw new Error('camera: busy');
    });
    const p = captureFrame('assistant');
    await vi.advanceTimersByTimeAsync(250);
    const f = await p;
    expect(f).toMatchObject({ blob, ts: 999 });
    expect(h.waitArgs).toEqual([[41, STREAM_FRAME_WAIT_MS]]);
    expect(h.transport!.captureFrame).toHaveBeenCalledTimes(1);
    expect(useDevice.getState().camera).toMatchObject({ status: 'idle', lastCaptureAt: 999 });
  });

  it('while the stream runs but sends nothing, it asks for a photo again', async () => {
    h.running = true;
    let n = 0;
    h.transport!.captureFrame = vi.fn(async () => {
      if (++n === 1) throw new Error('HTTP 409');
      return photo('ok');
    });
    const p = captureFrame('assistant');
    await vi.advanceTimersByTimeAsync(250);
    await p;
    expect(n).toBe(2);
    expect(h.waitArgs).toHaveLength(1);
  });

  it('does not retry other errors', async () => {
    h.transport!.captureFrame = vi.fn(async () => {
      throw new Error('camera: unavailable');
    });
    await expect(captureFrame('assistant')).rejects.toThrow('camera: unavailable');
    expect(h.transport!.captureFrame).toHaveBeenCalledTimes(1);
    expect(useDevice.getState().camera.status).toBe('error');
  });

  it('fails at once when the stick is not linked', async () => {
    useDevice.setState({ link: 'disconnected' });
    await expect(captureFrame('assistant')).rejects.toThrow('stick-offline');
    h.transport = null;
    useDevice.setState({ link: 'connected' });
    await expect(captureFrame('assistant')).rejects.toThrow('stick-offline');
  });

  it('demo mode always asks the demo transport (the scene hint picks the picture)', async () => {
    useRuntime.setState({ mode: 'demo' });
    h.latest = { blob: jpegBlob('s'), capturedAt: 1, seq: 1 };
    await captureFrame('assistant', 4);
    expect(h.transport!.captureFrame).toHaveBeenCalledWith({ sceneHint: 4 });
    expect(h.latestArgs).toEqual([]);
  });
});
