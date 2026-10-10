import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ detect: vi.fn(), post: vi.fn() }));
vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: vi.fn(async () => ({ wasmLoaderPath: '/wasm' })) },
  ObjectDetector: { createFromOptions: vi.fn(async () => ({ detect: h.detect, close: vi.fn() })) },
}));

let worker: { onmessage: (e: any) => Promise<void>; postMessage: typeof h.post; importScripts: () => void };
beforeEach(async () => {
  vi.resetModules();
  h.detect.mockReset();
  h.post.mockReset();
  worker = { onmessage: null as any, postMessage: h.post, importScripts: () => undefined };
  vi.stubGlobal('self', worker);
  await import('../src/core/vision/detector.worker');
});
afterEach(() => { vi.unstubAllGlobals(); });

const init = () => worker.onmessage({ data: { type: 'INIT', msgId: 1, payload: {
  modelPath: '/model', wasmBase: '/wasm', scoreThreshold: 0.35, maxResults: 12,
} } });

describe('detector worker bitmap cleanup', () => {
  it('closes the transferred bitmap when inference throws and reports the error', async () => {
    await init();
    const bitmap = { width: 320, height: 240, close: vi.fn() };
    h.detect.mockImplementation(() => { throw new Error('inference failed'); });
    await worker.onmessage({ data: { type: 'DETECT', msgId: 2, payload: { bmp: bitmap } } });
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenLastCalledWith({ type: 'ERROR', msgId: 2, error: 'inference failed' });
  });

  it('still normalizes successful detections and closes the transferred bitmap', async () => {
    await init();
    const bitmap = { width: 320, height: 240, close: vi.fn() };
    h.detect.mockReturnValue({ detections: [{
      boundingBox: { originX: 80, originY: 60, width: 160, height: 120 },
      categories: [{ categoryName: 'person', score: 0.9 }],
    }] });
    await worker.onmessage({ data: { type: 'DETECT', msgId: 2, payload: { bmp: bitmap } } });
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'DETECT_DONE', msgId: 2,
      payload: expect.objectContaining({ observations: [expect.objectContaining({
        label: 'person', confidence: 0.9, box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
      })] }),
    }));
  });

  it('closes a transferred bitmap even if no model is initialized', async () => {
    const bitmap = { close: vi.fn() };
    await worker.onmessage({ data: { type: 'DETECT', msgId: 2, payload: { bmp: bitmap } } });
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenLastCalledWith({ type: 'ERROR', msgId: 2, error: 'Detector not initialized' });
  });
});
