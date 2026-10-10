import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ workers: [] as any[], constructorError: null as Error | null }));
vi.mock('../src/core/vision/detector.worker?worker', () => ({
  default: class {
    onmessage: ((e: any) => void) | null = null;
    onerror: ((e: any) => void) | null = null;
    postMessage = vi.fn();
    terminate = vi.fn();
    constructor() {
      if (h.constructorError) throw h.constructorError;
      h.workers.push(this);
    }
    reply(type: string, payload: unknown) {
      const request = this.postMessage.mock.calls.at(-1)![0];
      this.onmessage?.({ data: { type, msgId: request.msgId, payload } });
    }
  },
}));

import { LocalDetector } from '../src/core/vision/detector';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  h.workers = [];
  h.constructorError = null;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function readyDetector() {
  const detector = new LocalDetector();
  const initialization = detector.init();
  h.workers[0].reply('INIT_DONE', { initMs: 10 });
  await initialization;
  return detector;
}

describe('LocalDetector image and worker ownership', () => {
  it('can retry after worker construction fails instead of remaining stuck in loading', async () => {
    const detector = new LocalDetector();
    h.constructorError = new Error('Worker blocked');
    await expect(detector.init()).rejects.toThrow('Worker blocked');
    expect(detector.status).toBe('error');
    h.constructorError = null;
    const initialization = detector.init();
    h.workers[0].reply('INIT_DONE', { initMs: 10 });
    await initialization;
    expect(detector.ready).toBe(true);
    detector.terminate();
  });

  it('closes the decoded image and clears the deadline when posting fails', async () => {
    const detector = await readyDetector();
    const bitmap = { close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    h.workers[0].postMessage.mockImplementation(() => { throw new Error('DataCloneError'); });

    await expect(detector.detect(new Blob(['jpeg']), 1000)).rejects.toThrow('DataCloneError');
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    detector.terminate();
  });

  it('drops and closes an image decoded after a stop, without posting to a new worker', async () => {
    const detector = await readyDetector();
    const decoding = deferred<ImageBitmap>();
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('createImageBitmap', vi.fn(() => decoding.promise));
    const detection = detector.detect(new Blob(['jpeg']), 1000);
    const result = expect(detection).rejects.toThrow('Detector stopped');
    detector.terminate();
    const initialization = detector.init();
    h.workers[1].reply('INIT_DONE', { initMs: 10 });
    await initialization;
    decoding.resolve(bitmap);

    await result;
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(h.workers[1].postMessage).toHaveBeenCalledTimes(1); // INIT only
    expect(detector.ready).toBe(true);
    detector.terminate();
  });

  it('shares initialization and preserves the new worker when an old initialization is stopped', async () => {
    const detector = new LocalDetector();
    const oldInitialization = detector.init();
    const oldResult = expect(oldInitialization).rejects.toThrow('Detector stopped');
    expect(detector.init()).toBe(oldInitialization);
    detector.terminate();
    const initialization = detector.init();
    await oldResult;
    expect(detector.init()).toBe(initialization);
    expect(h.workers).toHaveLength(2);
    expect(h.workers[1].terminate).not.toHaveBeenCalled();
    h.workers[1].reply('INIT_DONE', { initMs: 7 });
    await initialization;
    expect(detector.ready).toBe(true);
    expect(detector.initMs).toBe(7);
    detector.terminate();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates a crashed worker and rejects its active inference instead of keeping it ready', async () => {
    const detector = await readyDetector();
    const bitmap = { close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    const detection = detector.detect(new Blob(['jpeg']), 1000);
    const result = expect(detection).rejects.toThrow('worker crashed');
    await Promise.resolve();
    h.workers[0].onerror({ message: 'worker crashed' });
    await result;
    expect(detector.ready).toBe(false);
    expect(h.workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
