import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ binary: vi.fn() }));
vi.mock('../src/core/transport/stickHttp', () => ({ stickBinary: h.binary, isNativeApp: () => false }));
vi.mock('../src/core/device/deviceTrace', () => ({ trace: vi.fn() }));
vi.mock('../src/core/native/aissNative', () => ({ AissNative: {} }));
import { HttpTransport } from '../src/core/transport/httpTransport';

const jpeg = () => {
  const bytes = new Uint8Array(2500).fill(17);
  bytes.set([255, 216], 0);
  bytes.set([255, 217], bytes.length - 2);
  return { status: 200, bytes };
};
const connected = () => {
  const t = new HttpTransport({ deviceId: 'camera-test', host: '192.168.4.1' });
  // Fixture link is already connected; these tests target physical camera requests only.
  Object.assign(t, { state: 'connected' });
  return t;
};

describe('shared transport photo capture', () => {
  beforeEach(() => h.binary.mockReset());

  it('coalesces concurrent consumers into one physical request without a backlog', async () => {
    let finish!: (v: ReturnType<typeof jpeg>) => void;
    const response = new Promise<ReturnType<typeof jpeg>>(r => { finish = r; });
    h.binary.mockImplementation(() => response);
    const t = connected();
    const frames = Array.from({ length: 20 }, () => t.captureFrame());
    finish(jpeg());
    const results = await Promise.all(frames);
    expect(h.binary).toHaveBeenCalledTimes(1);
    expect(results.every(f => f.blob === results[0].blob && f.capturedAt === results[0].capturedAt)).toBe(true);
    expect(h.binary).toHaveBeenCalledTimes(1);
    h.binary.mockImplementation(async () => jpeg());
    await t.captureFrame();
    expect(h.binary).toHaveBeenCalledTimes(2);
  });

  it('releases the single-flight slot after a shared capture failure', async () => {
    let fail!: (e: Error) => void;
    const response = new Promise<ReturnType<typeof jpeg>>((_, r) => { fail = r; });
    h.binary.mockImplementation(() => response);
    const t = connected();
    const a = t.captureFrame();
    const b = t.captureFrame();
    const outcomes = Promise.allSettled([a, b]);
    fail(new Error('camera timeout'));
    expect((await outcomes).map(r => r.status)).toEqual(['rejected', 'rejected']);
    expect(h.binary).toHaveBeenCalledTimes(1);
    h.binary.mockImplementation(async () => jpeg());
    await expect(t.captureFrame()).resolves.toHaveProperty('blob');
    expect(h.binary).toHaveBeenCalledTimes(2);
  });

  it('retains HTTP camera-busy and JPEG validation errors', async () => {
    const t = connected();
    h.binary.mockResolvedValueOnce({ status: 409, bytes: null });
    await expect(t.captureFrame()).rejects.toThrow('camera: busy');
    h.binary.mockResolvedValueOnce({ status: 200, bytes: new Uint8Array(2500).fill(17) });
    await expect(t.captureFrame()).rejects.toThrow('camera:');
    h.binary.mockResolvedValueOnce(jpeg());
    await expect(t.captureFrame()).resolves.toHaveProperty('blob');
  });

  it('does not allow an offline caller to join a pending capture', async () => {
    let finish!: (v: ReturnType<typeof jpeg>) => void;
    h.binary.mockImplementationOnce(() => new Promise(r => { finish = r; }));
    const t = connected();
    const pending = t.captureFrame();
    Object.assign(t, { state: 'disconnected' });
    await expect(t.captureFrame()).rejects.toThrow('stick-offline');
    expect(h.binary).toHaveBeenCalledTimes(1);
    finish(jpeg());
    await pending;
  });
});
