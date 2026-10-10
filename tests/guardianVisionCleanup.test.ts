import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  state: { guardianFrame: null as null | { blob: Blob }, requesting: false, autoRefresh: false, error: null as string | null, guardianViewing: false },
}));
vi.mock('react', () => ({ useEffect: (effect: () => void | (() => void)) => h.effects.push(effect) }));
vi.mock('../src/core/store/vision', () => ({
  useVision: Object.assign((select: (s: typeof h.state) => unknown) => select(h.state), {
    setState: (s: Partial<typeof h.state>) => Object.assign(h.state, s),
  }),
}));
vi.mock('../src/core/camera/cameraSession', () => ({ requestSnapshot: vi.fn(), stopViewing: vi.fn() }));

import { useGuardianVision } from '../src/hooks/useGuardianVision';

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('guardian frame bitmap ownership', () => {
  beforeEach(() => {
    h.effects = [];
    h.state.guardianFrame = { blob: new Blob(['jpeg']) };
    h.state.error = null;
  });
  afterEach(() => vi.unstubAllGlobals());

  const mount = (drawImage = vi.fn()) => {
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }) };
    useGuardianVision({ current: canvas as unknown as HTMLCanvasElement });
    return h.effects[0]();
  };

  it('draws and releases a decoded frame exactly once', async () => {
    const bmp = { width: 320, height: 240, close: vi.fn() };
    const draw = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bmp));
    mount(draw);
    await settle();
    expect(draw).toHaveBeenCalledWith(bmp, 0, 0);
    expect(bmp.close).toHaveBeenCalledTimes(1);
    expect(h.state.error).toBeNull();
  });

  it('releases the frame when canvas drawing fails', async () => {
    const bmp = { width: 320, height: 240, close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bmp));
    mount(vi.fn(() => { throw new Error('context lost'); }));
    await settle();
    expect(bmp.close).toHaveBeenCalledTimes(1);
    expect(h.state.error).toBe('failed');
  });

  it('releases a decode that completes after screen cleanup without drawing', async () => {
    const bmp = { width: 320, height: 240, close: vi.fn() };
    let resolve!: (v: typeof bmp) => void;
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(r => { resolve = r; })));
    const draw = vi.fn();
    const cleanup = mount(draw);
    if (typeof cleanup !== 'function') throw new Error('missing effect cleanup');
    cleanup();
    resolve(bmp);
    await settle();
    expect(draw).not.toHaveBeenCalled();
    expect(bmp.close).toHaveBeenCalledTimes(1);
    expect(h.state.error).toBeNull();
  });

  it('handles a decode error without an unhandled rejection', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('invalid JPEG'); }));
    mount();
    await settle();
    expect(h.state.error).toBe('failed');
  });

  it('ignores a decode error arriving after screen cleanup', async () => {
    let reject!: (e: Error) => void;
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise((_, r) => { reject = r; })));
    const cleanup = mount();
    if (typeof cleanup !== 'function') throw new Error('missing effect cleanup');
    cleanup();
    reject(new Error('invalid JPEG'));
    await settle();
    expect(h.state.error).toBeNull();
  });
});
