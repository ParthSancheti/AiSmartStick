/**
 * Live camera hub (src/core/camera/liveStream.ts): the MJPEG multipart parser, the JPEG size reader,
 * ref-counted holders gated by the stick link, the native stream path (fake plugin), the single-photo
 * fallback and the way back to the stream, and the browser fetch path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  type Cb = (e: Record<string, unknown>) => void;
  const listeners = new Map<string, Set<Cb>>();
  return {
    listeners,
    startStream: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
    stopStream: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
    transport: null as null | { captureFrame: (o?: unknown) => Promise<{ blob: Blob; width: number | null; height: number | null; capturedAt: number }>; getHost?: () => string },
    emit(ev: string, data: Record<string, unknown>) {
      for (const cb of [...(listeners.get(ev) ?? [])]) cb(data);
    },
    count(ev: string) {
      return listeners.get(ev)?.size ?? 0;
    },
  };
});

vi.mock('../src/core/native/aissNative', async () => {
  const { vi } = await import('vitest');
  h.startStream = vi.fn(async () => ({ running: true }));
  h.stopStream = vi.fn(async () => undefined);
  return {
    AissNative: {
      addListener: async (ev: string, cb: (e: Record<string, unknown>) => void) => {
        if (!h.listeners.has(ev)) h.listeners.set(ev, new Set());
        h.listeners.get(ev)!.add(cb);
        return { remove: async () => void h.listeners.get(ev)?.delete(cb) };
      },
      startStream: (o: unknown) => h.startStream(o),
      stopStream: () => h.stopStream(),
    },
  };
});
vi.mock('../src/core/device/bridge', () => ({ getTransport: () => h.transport }));
vi.mock('@capacitor/app', () => ({ App: { addListener: async () => ({ remove: async () => undefined }) } }));

import {
  acquireLiveStream,
  createMultipartJpegParser,
  isLiveStreamRunning,
  jpegSize,
  latestStreamFrame,
  RELEASE_LINGER_MS,
  resetLiveStreamForTests,
  streamErrorWords,
  STREAM_ERRORS,
  useLiveStream,
  waitForStreamFrame,
} from '../src/core/camera/liveStream';
import { useDevice } from '../src/core/store/device';
import { useRuntime } from '../src/core/runtime/mode';

// ── Fixtures ─────────────────────────────────────────────────

const BOUNDARY = '123456789000000000000987654321';
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** A small JPEG-shaped buffer: SOI, APP0, SOFn with the size, SOS, filler (never 0xFF), EOI. */
function jpeg(width: number, height: number, fill = 600, seed = 1, sof = 0xc0): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sofSeg = [0xff, sof, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const sos = [0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00];
  const body = Array.from({ length: fill }, (_, i) => 0x10 + ((i * 7 + seed * 13) % 0x60));
  return Uint8Array.from([0xff, 0xd8, ...app0, ...sofSeg, ...sos, ...body, 0xff, 0xd9]);
}

const part = (j: Uint8Array, withLength = true) =>
  concat(ascii(`\r\n--${BOUNDARY}\r\nContent-Type: image/jpeg\r\n${withLength ? `Content-Length: ${j.length}\r\n` : ''}\r\n`), j);

/** Deterministic random split points. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function feedSplit(push: (c: Uint8Array) => void, data: Uint8Array, rand: () => number) {
  let i = 0;
  while (i < data.length) {
    const n = 1 + Math.floor(rand() * 700);
    push(data.subarray(i, Math.min(data.length, i + n)));
    i += n;
  }
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

// ── Parser ───────────────────────────────────────────────────

describe('createMultipartJpegParser', () => {
  it('splits a firmware-style stream into JPEGs', () => {
    const frames = [jpeg(320, 240, 800, 1), jpeg(320, 240, 900, 2), jpeg(320, 240, 700, 3)];
    const got: Uint8Array[] = [];
    const p = createMultipartJpegParser((f) => got.push(f), { boundary: BOUNDARY });
    p.push(concat(...frames.map((f) => part(f))));
    expect(got).toHaveLength(3);
    got.forEach((g, i) => expect(Buffer.from(g).equals(Buffer.from(frames[i]))).toBe(true));
    expect(p.dropped).toBe(0);
  });

  it('gives the same frames whatever the chunk boundaries', () => {
    const frames = Array.from({ length: 8 }, (_, i) => jpeg(160, 120, 300 + i * 97, i + 1));
    const stream = concat(...frames.map((f, i) => part(f, i % 3 !== 1)));
    for (let seed = 1; seed <= 40; seed++) {
      const got: Uint8Array[] = [];
      const p = createMultipartJpegParser((f) => got.push(f), { boundary: BOUNDARY });
      feedSplit((c) => p.push(c), stream, rng(seed));
      expect(got.length).toBe(frames.length);
      got.forEach((g, i) => expect(Buffer.from(g).equals(Buffer.from(frames[i]))).toBe(true));
    }
    // Byte by byte too.
    const got: Uint8Array[] = [];
    const p = createMultipartJpegParser((f) => got.push(f), { boundary: BOUNDARY });
    for (let i = 0; i < stream.length; i++) p.push(stream.subarray(i, i + 1));
    expect(got.length).toBe(frames.length);
  });

  it('reads parts without Content-Length from SOI to EOI', () => {
    const frames = [jpeg(320, 240, 500, 4), jpeg(320, 240, 650, 5)];
    const got: Uint8Array[] = [];
    const p = createMultipartJpegParser((f) => got.push(f), { boundary: BOUNDARY });
    feedSplit((c) => p.push(c), concat(...frames.map((f) => part(f, false))), rng(7));
    expect(got).toHaveLength(2);
    got.forEach((g, i) => expect(Buffer.from(g).equals(Buffer.from(frames[i]))).toBe(true));
  });

  it('skips garbage before and between parts', () => {
    const frames = [jpeg(320, 240, 500, 6), jpeg(320, 240, 520, 7), jpeg(320, 240, 540, 8)];
    const junk = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 0xfe);
    const stream = concat(junk(333, 1), part(frames[0]), junk(1200, 2), ascii('\r\n'), part(frames[1]), junk(50, 3), part(frames[2], false), junk(10, 4));
    for (let seed = 1; seed <= 10; seed++) {
      const got: Uint8Array[] = [];
      const p = createMultipartJpegParser((f) => got.push(f), { boundary: BOUNDARY });
      feedSplit((c) => p.push(c), stream, rng(seed));
      expect(got).toHaveLength(3);
      got.forEach((g, i) => expect(Buffer.from(g).equals(Buffer.from(frames[i]))).toBe(true));
    }
  });

  it('drops a part larger than the limit and keeps the next one', () => {
    const big = jpeg(640, 480, 5000, 9);
    const small = jpeg(160, 120, 400, 10);
    const got: Uint8Array[] = [];
    const p = createMultipartJpegParser((f) => got.push(f), { boundary: BOUNDARY, maxPartBytes: 2048 });
    feedSplit((c) => p.push(c), concat(part(small), part(big), part(small), part(big, false), part(small)), rng(3));
    expect(got).toHaveLength(3);
    got.forEach((g) => expect(Buffer.from(g).equals(Buffer.from(small))).toBe(true));
    expect(p.dropped).toBe(2);
  });

  it('works without a known boundary', () => {
    const frames = [jpeg(320, 240, 500, 11), jpeg(320, 240, 500, 12)];
    const got: Uint8Array[] = [];
    const p = createMultipartJpegParser((f) => got.push(f));
    feedSplit((c) => p.push(c), concat(...frames.map((f) => part(f))), rng(5));
    expect(got).toHaveLength(2);
  });
});

describe('jpegSize / streamErrorWords', () => {
  it('reads the size from SOF0 and SOF2', () => {
    expect(jpegSize(jpeg(320, 240))).toEqual({ width: 320, height: 240 });
    expect(jpegSize(jpeg(160, 120, 100, 1, 0xc2))).toEqual({ width: 160, height: 120 });
    expect(jpegSize(ascii('not a jpeg at all'))).toBeNull();
    // SOS before any SOF: unknown.
    expect(jpegSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]))).toBeNull();
  });

  it('turns raw errors into simple words', () => {
    expect(streamErrorWords('busy: the stick did not answer')).toBe(STREAM_ERRORS.busy);
    expect(streamErrorWords('camera unavailable (HTTP 503)')).toBe(STREAM_ERRORS.camera);
    expect(streamErrorWords('stick-offline')).toBe(STREAM_ERRORS.notConnected);
    expect(streamErrorWords('stream ended')).toBe(STREAM_ERRORS.noFrames);
  });
});

// ── Hub ──────────────────────────────────────────────────────

const setLink = (link: 'connected' | 'disconnected' | 'reconnecting') => useDevice.setState({ link });
const nativeFrame = (j: Uint8Array, seq = 1) => h.emit('streamFrame', { data: b64(j), seq, at: Date.now(), bytes: j.length });

describe('live stream hub (Android: native reader)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    (globalThis as { window?: unknown }).window = { Capacitor: { isNativePlatform: () => true } };
    h.listeners.clear();
    h.startStream.mockClear();
    h.stopStream.mockClear();
    h.transport = { captureFrame: vi.fn(async () => ({ blob: new Blob([jpeg(160, 120) as BlobPart], { type: 'image/jpeg' }), width: null, height: null, capturedAt: Date.now() })) };
    useRuntime.setState({ mode: 'real' });
    resetLiveStreamForTests();
    setLink('connected');
  });
  afterEach(() => {
    resetLiveStreamForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as { window?: unknown }).window;
  });

  it('is ref-counted and runs only while the stick is linked', async () => {
    setLink('disconnected');
    const r1 = acquireLiveStream('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(useLiveStream.getState()).toMatchObject({ status: 'off', viewers: 1, error: STREAM_ERRORS.notConnected });
    expect(h.startStream).not.toHaveBeenCalled();

    setLink('connected');
    await vi.advanceTimersByTimeAsync(0);
    expect(isLiveStreamRunning()).toBe(true);
    expect(h.startStream).toHaveBeenCalledTimes(1);
    expect(h.startStream).toHaveBeenCalledWith({ port: 81, path: '/stream', maxFps: 8 });
    expect(useLiveStream.getState()).toMatchObject({ status: 'connecting', source: 'stream', error: null });
    expect(h.count('streamFrame')).toBe(1);

    const r2 = acquireLiveStream('b');
    expect(useLiveStream.getState().viewers).toBe(2);
    expect(h.startStream).toHaveBeenCalledTimes(1);
    r1();
    r1(); // idempotent
    expect(useLiveStream.getState().viewers).toBe(1);
    expect(isLiveStreamRunning()).toBe(true);
    r2();
    await vi.advanceTimersByTimeAsync(0);
    // Lingers a moment for the next view, then lets go of the stick's only stream slot.
    expect(isLiveStreamRunning()).toBe(true);
    expect(useLiveStream.getState().viewers).toBe(0);
    expect(h.stopStream).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RELEASE_LINGER_MS);
    expect(useLiveStream.getState()).toMatchObject({ status: 'off', viewers: 0, source: null, error: null });
    expect(h.stopStream).toHaveBeenCalledTimes(1);
    expect(h.count('streamFrame')).toBe(0);
    expect(h.count('streamState')).toBe(0);
  });

  it('a view taking over within the linger keeps the stream (no reconnect)', async () => {
    const home = acquireLiveStream('home preview');
    await vi.advanceTimersByTimeAsync(0);
    nativeFrame(jpeg(320, 240), 1);
    home();
    await vi.advanceTimersByTimeAsync(RELEASE_LINGER_MS - 200);
    const page = acquireLiveStream('camera page');
    await vi.advanceTimersByTimeAsync(RELEASE_LINGER_MS * 2);
    expect(isLiveStreamRunning()).toBe(true);
    expect(h.startStream).toHaveBeenCalledTimes(1);
    expect(h.stopStream).not.toHaveBeenCalled();
    expect(useLiveStream.getState().viewers).toBe(1);
    page();
  });

  it('stops at once (no linger) when the link drops after the last release', async () => {
    const release = acquireLiveStream('view');
    await vi.advanceTimersByTimeAsync(0);
    release();
    setLink('disconnected');
    await vi.advanceTimersByTimeAsync(0);
    expect(isLiveStreamRunning()).toBe(false);
    expect(h.stopStream).toHaveBeenCalledTimes(1);
  });

  it('stops when the link drops and starts again when it is back', async () => {
    const release = acquireLiveStream('view');
    await vi.advanceTimersByTimeAsync(0);
    nativeFrame(jpeg(320, 240));
    expect(useLiveStream.getState().status).toBe('live');
    setLink('reconnecting');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.stopStream).toHaveBeenCalledTimes(1);
    expect(useLiveStream.getState()).toMatchObject({ status: 'off', frameUrl: null, error: STREAM_ERRORS.notConnected });
    expect(latestStreamFrame()).toBeNull();
    setLink('connected');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.startStream).toHaveBeenCalledTimes(2);
    release();
  });

  it('publishes frames: object URL, seq, fps, size, freshness, stalled', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const release = acquireLiveStream('view');
    await vi.advanceTimersByTimeAsync(0);
    nativeFrame(jpeg(320, 240, 600, 1), 1);
    const s1 = useLiveStream.getState();
    expect(s1).toMatchObject({ status: 'live', seq: 1, width: 320, height: 240, source: 'stream', error: null });
    expect(s1.frameUrl).toMatch(/^blob:/);
    await vi.advanceTimersByTimeAsync(125);
    nativeFrame(jpeg(320, 240, 600, 2), 2);
    const s2 = useLiveStream.getState();
    expect(s2.seq).toBe(2);
    expect(s2.fps).toBeCloseTo(8, 0);
    expect(revoke).toHaveBeenCalledWith(s1.frameUrl);
    const f = latestStreamFrame();
    expect(f?.seq).toBe(2);
    expect(f?.blob.type).toBe('image/jpeg');
    await vi.advanceTimersByTimeAsync(1100);
    expect(latestStreamFrame()).toBeNull();
    expect(latestStreamFrame(5000)?.seq).toBe(2);
    await vi.advanceTimersByTimeAsync(2500);
    expect(useLiveStream.getState()).toMatchObject({ status: 'stalled', fps: 0 });
    release();
  });

  it('waitForStreamFrame resolves with the next frame, or null after the timeout', async () => {
    const release = acquireLiveStream('view');
    await vi.advanceTimersByTimeAsync(0);
    const p = waitForStreamFrame(undefined, 1500);
    nativeFrame(jpeg(320, 240), 1);
    expect((await p)?.seq).toBe(1);
    const q = waitForStreamFrame(undefined, 1500);
    await vi.advanceTimersByTimeAsync(1600);
    expect(await q).toBeNull();
    release();
    await vi.advanceTimersByTimeAsync(RELEASE_LINGER_MS);
    expect(await waitForStreamFrame(0, 1000)).toBeNull();
  });

  it('falls back to single photos after 3 stream errors and goes back to the stream later', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    h.transport!.captureFrame = vi.fn(async () => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 150));
      inFlight--;
      if (calls === 2) throw new Error('camera: busy');
      return { blob: new Blob([jpeg(160, 120) as BlobPart], { type: 'image/jpeg' }), width: null, height: null, capturedAt: Date.now() };
    });
    const release = acquireLiveStream('view');
    await vi.advanceTimersByTimeAsync(0);
    h.emit('streamState', { state: 'error', error: 'busy: the stick did not answer (another viewer is watching the camera)' });
    expect(useLiveStream.getState()).toMatchObject({ status: 'error', error: STREAM_ERRORS.busy, source: 'stream' });
    h.emit('streamState', { state: 'error', error: 'busy: the stick did not answer' });
    expect(h.stopStream).not.toHaveBeenCalled();
    h.emit('streamState', { state: 'error', error: 'busy: the stick did not answer' });
    expect(h.stopStream).toHaveBeenCalledTimes(1);
    expect(useLiveStream.getState().source).toBe('snapshots');

    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(calls).toBeLessThanOrEqual(6);
    expect(maxInFlight).toBe(1);
    expect(useLiveStream.getState()).toMatchObject({ status: 'live', source: 'snapshots', error: null, width: 160, height: 120 });

    // 30 s later the stream is tried again; photos keep coming until its first frame.
    await vi.advanceTimersByTimeAsync(28_500);
    expect(h.startStream).toHaveBeenCalledTimes(2);
    expect(useLiveStream.getState().source).toBe('snapshots');
    const before = calls;
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBeGreaterThan(before);
    nativeFrame(jpeg(320, 240), 1);
    expect(useLiveStream.getState()).toMatchObject({ source: 'stream', width: 320 });
    const after = calls;
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls - after).toBeLessThanOrEqual(1); // at most the photo that was already in flight
    release();
  });

  it('falls back to single photos when the stream gives no frame for 6 s', async () => {
    const release = acquireLiveStream('view');
    await vi.advanceTimersByTimeAsync(5000);
    expect(useLiveStream.getState().source).toBe('stream');
    expect(h.transport!.captureFrame).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1600);
    expect(useLiveStream.getState().source).toBe('snapshots');
    expect(h.stopStream).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.transport!.captureFrame).toHaveBeenCalled();
    expect(useLiveStream.getState().status).toBe('live');
    release();
  });

  it('demo mode uses photos from the demo transport, never the stream', async () => {
    useRuntime.setState({ mode: 'demo' });
    const release = acquireLiveStream('view');
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.startStream).not.toHaveBeenCalled();
    expect(h.transport!.captureFrame).toHaveBeenCalled();
    expect(useLiveStream.getState()).toMatchObject({ source: 'snapshots', status: 'live' });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.startStream).not.toHaveBeenCalled();
    release();
  });

  it('lets go of the stream while the app is hidden', async () => {
    const doc = { visibilityState: 'visible', handlers: new Set<() => void>(), addEventListener: (_: string, cb: () => void) => doc.handlers.add(cb), removeEventListener: (_: string, cb: () => void) => doc.handlers.delete(cb) };
    (globalThis as { document?: unknown }).document = doc;
    try {
      resetLiveStreamForTests();
      const release = acquireLiveStream('view');
      await vi.advanceTimersByTimeAsync(0);
      expect(h.startStream).toHaveBeenCalledTimes(1);
      doc.visibilityState = 'hidden';
      doc.handlers.forEach((cb) => cb());
      await vi.advanceTimersByTimeAsync(0);
      expect(h.stopStream).toHaveBeenCalledTimes(1);
      expect(useLiveStream.getState()).toMatchObject({ status: 'off', viewers: 1 });
      doc.visibilityState = 'visible';
      doc.handlers.forEach((cb) => cb());
      await vi.advanceTimersByTimeAsync(0);
      expect(h.startStream).toHaveBeenCalledTimes(2);
      release();
    } finally {
      resetLiveStreamForTests();
      delete (globalThis as { document?: unknown }).document;
    }
  });

  it('goes to single photos at once when the native reader cannot start', async () => {
    h.startStream.mockRejectedValueOnce(new Error('"AissNative.startStream()" is not implemented on android'));
    const release = acquireLiveStream('view');
    await vi.advanceTimersByTimeAsync(0);
    expect(useLiveStream.getState().source).toBe('snapshots');
    await vi.advanceTimersByTimeAsync(500);
    expect(useLiveStream.getState().status).toBe('live');
    release();
  });
});

describe('live stream hub (browser: fetch)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    h.listeners.clear();
    h.startStream.mockClear();
    h.transport = { captureFrame: vi.fn(async () => ({ blob: new Blob([jpeg(160, 120) as BlobPart], { type: 'image/jpeg' }), width: null, height: null, capturedAt: Date.now() })), getHost: () => '10.0.0.7' };
    useRuntime.setState({ mode: 'real' });
    resetLiveStreamForTests();
    setLink('connected');
  });
  afterEach(() => {
    resetLiveStreamForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads the MJPEG stream with fetch and aborts it on release', async () => {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
      return new Response(body, { status: 200, headers: { 'content-type': `multipart/x-mixed-replace;boundary=${BOUNDARY}` } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const release = acquireLiveStream('view');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledWith('http://10.0.0.7:81/stream', expect.anything());
    const data = concat(part(jpeg(320, 240, 500, 1)), part(jpeg(320, 240, 500, 2)));
    ctl.enqueue(data.subarray(0, 700));
    ctl.enqueue(data.subarray(700));
    await vi.advanceTimersByTimeAsync(0);
    expect(useLiveStream.getState()).toMatchObject({ status: 'live', seq: 2, source: 'stream', width: 320 });
    release();
    await vi.advanceTimersByTimeAsync(RELEASE_LINGER_MS);
    expect(signal?.aborted).toBe(true);
    expect(useLiveStream.getState().status).toBe('off');
  });

  it('a stream that never answers counts as busy; 3 strikes → single photos', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))),
    );
    vi.stubGlobal('fetch', fetchMock);
    const release = acquireLiveStream('view');
    await vi.advanceTimersByTimeAsync(5100);
    expect(useLiveStream.getState()).toMatchObject({ error: STREAM_ERRORS.busy, status: 'error' });
    // The 6 s no-frame watchdog switches to photos before three 5 s timeouts could add up.
    await vi.advanceTimersByTimeAsync(1500);
    expect(useLiveStream.getState().source).toBe('snapshots');
    await vi.advanceTimersByTimeAsync(500);
    expect(useLiveStream.getState()).toMatchObject({ status: 'live', error: null });
    release();
  });
});
