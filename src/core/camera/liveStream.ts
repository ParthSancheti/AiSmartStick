import { useEffect } from 'react';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { PluginListenerHandle } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { SETUP_AP_HOST } from '../../../shared/deviceProtocol';
import { AissNative } from '../native/aissNative';
import { useDevice, isLinked } from '../store/device';
import { isDemo } from '../runtime/mode';
import { getTransport } from '../device/bridge';
import { isNativeApp, stickLog, withTimeout } from '../transport/stickHttp';

/**
 * LIVE CAMERA HUB: one place that gets frames from the stick camera and shares them with every
 * screen and with vision (the detector, the assistant).
 *
 *  - Real mode, Android app: the native plugin reads the MJPEG stream (http://192.168.4.1:81/stream)
 *    over the stick Wi-Fi and sends each JPEG here (events "streamFrame" / "streamState").
 *  - Real mode, browser: fetch() of the same stream, parsed here (createMultipartJpegParser).
 *  - The stick serves ONE stream viewer. When the stream gives no frame for 6 s, or fails 3 times in
 *    a row, the hub polls single photos (/api/v1/capture) instead and tries the stream again after 30 s.
 *  - Demo mode: single photos from the demo transport (no stream).
 *
 * Ref-counted: it runs only while somebody holds it (acquireLiveStream / useLiveStreamHold; plus
 * RELEASE_LINGER_MS after the last release), the stick link is up and the app is on screen.
 * No fake frames in real mode.
 *
 * The native plugin is imported STATICALLY (see stickHttp.ts): never resolve a Promise with it.
 */
export type LiveStreamStatus = 'off' | 'connecting' | 'live' | 'stalled' | 'error';

export interface LiveStreamState {
  /** off = nobody watching or stick not linked; stalled = no new frame for > 3 s */
  status: LiveStreamStatus;
  /** Object URL of the newest JPEG (previous one revoked); null before the first frame. */
  frameUrl: string | null;
  /** Date.now() when the newest frame arrived. */
  frameAt: number | null;
  /** +1 per frame (never goes back, also across stops). */
  seq: number;
  /** Smoothed frames per second. */
  fps: number;
  /** From the JPEG header when known. */
  width: number | null;
  height: number | null;
  /** MJPEG :81/stream, or polling /api/v1/capture as fallback. */
  source: 'stream' | 'snapshots' | null;
  /** Simple words for the last failure, null when fine. */
  error: string | null;
  /** Current holders. */
  viewers: number;
}

export interface StreamFrame {
  blob: Blob;
  capturedAt: number;
  seq: number;
}

export const STREAM_PORT = 81;
export const STREAM_PATH = '/stream';
/** Frames per second asked from the native reader (extra frames are dropped there, never queued). */
export const STREAM_MAX_FPS = 8;
/** No new frame for this long while running → "stalled". */
export const STALL_MS = 3000;
/** The stream gave no frame for this long → single photos instead. */
export const STREAM_NO_FRAME_MS = 6000;
/** Stream failures in a row (no frame in between) → single photos instead. */
export const STREAM_MAX_ERRORS = 3;
/** Single-photo poll period. */
export const SNAPSHOT_EVERY_MS = 400;
/** While on single photos, try the stream again after this long. */
export const STREAM_RETRY_AFTER_MS = 30_000;
/** Largest JPEG part accepted from the stream. */
export const MAX_PART_BYTES = 512 * 1024;
/**
 * After the last holder lets go, the stream keeps running this long, so going from one camera view
 * to the next (Home preview → Camera page) does not drop and reconnect the stick's only stream.
 * Link loss and the app going to the background still stop it at once.
 */
export const RELEASE_LINGER_MS = 1500;

export const STREAM_ERRORS = {
  busy: 'Camera stream busy: another phone or browser is watching the stick camera. Close it and try again.',
  noFrames: 'No camera frames from the stick.',
  notConnected: 'Stick not connected.',
  camera: 'The stick camera is not working. Restart the stick.',
} as const;

/** Raw native / network error → short words for the user. */
export function streamErrorWords(raw: string | null | undefined): string {
  const r = raw ?? '';
  if (/busy|another viewer|\b409\b/i.test(r)) return STREAM_ERRORS.busy;
  if (/\b503\b|camera[ _]?(error|unavailable|not available)|unavailable/i.test(r)) return STREAM_ERRORS.camera;
  if (/offline|not bound|not linked|no stick|stick wi-?fi/i.test(r)) return STREAM_ERRORS.notConnected;
  return STREAM_ERRORS.noFrames;
}

const initialState = (): LiveStreamState => ({ status: 'off', frameUrl: null, frameAt: null, seq: 0, fps: 0, width: null, height: null, source: null, error: null, viewers: 0 });

export const useLiveStream: UseBoundStore<StoreApi<LiveStreamState>> = create<LiveStreamState>()(() => initialState());

// ── Pure helpers ─────────────────────────────────────────────

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const CRLF2 = ascii('\r\n\r\n');
const LF2 = ascii('\n\n');
const SOI = Uint8Array.of(0xff, 0xd8);
const EOI = Uint8Array.of(0xff, 0xd9);
/** Part headers longer than this are garbage. */
const MAX_HEADER_BYTES = 1024;

function indexOf(buf: Uint8Array, pat: Uint8Array, from: number, end: number): number {
  const first = pat[0];
  const last = end - pat.length;
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    if (buf[i] !== first) continue;
    for (let k = 1; k < pat.length; k++) if (buf[i + k] !== pat[k]) continue outer;
    return i;
  }
  return -1;
}

export const isJpegStart = (b: Uint8Array) => b.length >= 2 && b[0] === 0xff && b[1] === 0xd8;

/**
 * Width / height from a JPEG header (SOF0…SOF15 marker, baseline and progressive). Reads only the
 * marker segments before the image data. null when not found.
 */
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (!isJpegStart(b)) return null;
  const end = Math.min(b.length, 128 * 1024);
  let i = 2;
  while (i + 3 < end) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) {
      i++; // fill byte
      continue;
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2; // standalone marker
      continue;
    }
    if (m === 0xd9 || m === 0xda) return null; // end of image / start of scan: no SOF before the data
    const segLen = (b[i + 2] << 8) | b[i + 3];
    if (segLen < 2) return null;
    const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (isSof) {
      if (i + 8 >= end) return null;
      const height = (b[i + 5] << 8) | b[i + 6];
      const width = (b[i + 7] << 8) | b[i + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + segLen;
  }
  return null;
}

export interface MultipartJpegParser {
  /** Feed the next bytes of the HTTP body (any split). */
  push(chunk: Uint8Array): void;
  reset(): void;
  /** Parts dropped so far (too large, not a JPEG, broken headers). */
  readonly dropped: number;
}

type ParseState = { k: 'seek' } | { k: 'headers' } | { k: 'body'; length: number } | { k: 'scan'; soi: number; scanned: number };

/**
 * multipart/x-mixed-replace parser for an MJPEG stream. Each part:
 *   "\r\n--BOUNDARY\r\nContent-Type: image/jpeg\r\nContent-Length: N\r\n\r\n<N bytes JPEG>"
 * Uses Content-Length when present; without it, takes the bytes from JPEG SOI (FFD8) to EOI (FFD9).
 * Skips garbage between parts; drops a part larger than maxPartBytes and finds the next boundary.
 * Without a boundary, any line starting with "--" counts as one.
 */
export function createMultipartJpegParser(onFrame: (jpeg: Uint8Array) => void, opts: { boundary?: string | null; maxPartBytes?: number } = {}): MultipartJpegParser {
  const max = opts.maxPartBytes ?? MAX_PART_BYTES;
  const marker = ascii(`--${(opts.boundary ?? '').trim()}`);
  let buf = new Uint8Array(32 * 1024);
  let len = 0;
  /** Everything before pos is consumed. Offsets in the state are relative to pos. */
  let pos = 0;
  let st: ParseState = { k: 'seek' };
  let dropped = 0;

  const append = (chunk: Uint8Array) => {
    if (len + chunk.length > buf.length) {
      if (pos > 0) {
        buf.copyWithin(0, pos, len);
        len -= pos;
        pos = 0;
      }
      if (len + chunk.length > buf.length) {
        let cap = buf.length;
        while (cap < len + chunk.length) cap *= 2;
        const next = new Uint8Array(cap);
        next.set(buf.subarray(0, len));
        buf = next;
      }
    }
    buf.set(chunk, len);
    len += chunk.length;
  };

  const headerText = (from: number, to: number) => {
    let s = '';
    for (let i = from; i < to; i++) s += String.fromCharCode(buf[i]);
    return s;
  };

  const drop = () => {
    dropped++;
    st = { k: 'seek' };
  };

  const step = (): boolean => {
    switch (st.k) {
      case 'seek': {
        const i = indexOf(buf, marker, pos, len);
        if (i < 0) {
          // Keep only a tail that may be the start of a split boundary.
          pos = Math.max(pos, len - (marker.length - 1));
          return false;
        }
        pos = i;
        st = { k: 'headers' };
        return true;
      }
      case 'headers': {
        const from = pos + marker.length;
        const a = indexOf(buf, CRLF2, from, len);
        const b = indexOf(buf, LF2, from, len);
        const end = a < 0 ? b : b < 0 ? a : Math.min(a, b);
        if (end < 0) {
          if (len - pos > MAX_HEADER_BYTES) {
            pos += marker.length;
            drop();
            return true;
          }
          return false;
        }
        const bodyStart = end + (end === a ? CRLF2.length : LF2.length);
        if (bodyStart - pos > MAX_HEADER_BYTES) {
          pos += marker.length;
          drop();
          return true;
        }
        const m = /content-length\s*:\s*(\d+)/i.exec(headerText(from, end));
        pos = bodyStart;
        if (m) {
          const n = Number(m[1]);
          if (n > max) drop();
          else if (n === 0) st = { k: 'seek' };
          else st = { k: 'body', length: n };
        } else st = { k: 'scan', soi: -1, scanned: 0 };
        return true;
      }
      case 'body': {
        if (len - pos < st.length) return false;
        const part = buf.slice(pos, pos + st.length);
        pos += st.length;
        st = { k: 'seek' };
        // Tolerate a few stray bytes before SOI.
        const soi = indexOf(part, SOI, 0, Math.min(part.length, 64));
        if (soi < 0) dropped++;
        else onFrame(soi === 0 ? part : part.slice(soi));
        return true;
      }
      case 'scan': {
        if (st.soi < 0) {
          const i = indexOf(buf, SOI, pos + st.scanned, len);
          if (i < 0) {
            st.scanned = Math.max(0, len - pos - 1);
            if (st.scanned > max) {
              pos += st.scanned;
              drop();
              return true;
            }
            return false;
          }
          st.soi = i - pos;
          st.scanned = st.soi + 2;
        }
        const j = indexOf(buf, EOI, pos + st.scanned, len);
        if (j < 0) {
          st.scanned = Math.max(st.soi + 2, len - pos - 1);
          if (len - pos - st.soi > max) {
            pos += st.scanned;
            drop();
            return true;
          }
          return false;
        }
        const part = buf.slice(pos + st.soi, j + 2);
        pos = j + 2;
        st = { k: 'seek' };
        if (part.length > max) dropped++;
        else onFrame(part);
        return true;
      }
    }
  };

  return {
    push(chunk: Uint8Array) {
      if (!chunk.length) return;
      append(chunk);
      while (step()) {
        /* parse everything available */
      }
      if (pos >= len) {
        pos = 0;
        len = 0;
      } else if (pos > buf.length / 2) {
        buf.copyWithin(0, pos, len);
        len -= pos;
        pos = 0;
      }
    },
    reset() {
      len = 0;
      pos = 0;
      st = { k: 'seek' };
    },
    get dropped() {
      return dropped;
    },
  };
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Hub state ────────────────────────────────────────────────

const holders = new Map<number, string>();
let nextHolder = 1;
let wired = false;
let unwire: (() => void)[] = [];
let appActive = true;
/** The hub is running (holders, link up, on screen). */
let active = false;
/**
 * Generations: bumped when that source stops, so async work of an older attempt ends quietly.
 * The stream and the single photos have their own: while on photos, the hub tries the stream again
 * in the background and switches over at its first frame (no gap in the picture).
 */
let streamGen = 0;
let snapGen = 0;
let streamRunning = false;
let snapRunning = false;
let latest: (StreamFrame & { arrivedAt: number }) | null = null;
let lastArrival = 0;
/** Last frame that came from the stream (watchdog), and when the current stream attempt began. */
let lastStreamArrival = 0;
let streamSince = 0;
let streamErrors = 0;
let ticker: ReturnType<typeof setInterval> | undefined;
let snapTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let lingerTimer: ReturnType<typeof setTimeout> | undefined;
let webRetryTimer: ReturnType<typeof setTimeout> | undefined;
let webCtrl: AbortController | null = null;
let nativeHandles: PluginListenerHandle[] = [];
let nativeRunning = false;
let snapshotInFlight = false;
const waiters = new Set<{ after: number; done: (f: StreamFrame | null) => void }>();

const set = (p: Partial<LiveStreamState>) => useLiveStream.setState(p);
const visible = () => appActive && (typeof document === 'undefined' || document.visibilityState !== 'hidden');
const linked = () => isLinked(useDevice.getState().link);

function streamHost(): string {
  const t = getTransport() as { getHost?: () => string | null } | null;
  return t?.getHost?.() || SETUP_AP_HOST;
}

function makeUrl(blob: Blob): string | null {
  try {
    return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}

function revoke(url: string | null) {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* ignore */
  }
}

function computeStatus(): LiveStreamStatus {
  if (!active) return 'off';
  if (lastArrival && Date.now() - lastArrival <= STALL_MS) return 'live';
  if (useLiveStream.getState().error) return 'error';
  return lastArrival ? 'stalled' : 'connecting';
}

function refreshStatus() {
  const status = computeStatus();
  const s = useLiveStream.getState();
  const stale = !lastArrival || Date.now() - lastArrival > STALL_MS;
  if (s.status !== status || (stale && s.fps !== 0)) set({ status, ...(stale ? { fps: 0 } : {}) });
}

function publishFrame(blob: Blob, capturedAt: number, size: { width: number; height: number } | null) {
  const now = Date.now();
  const s = useLiveStream.getState();
  const seq = s.seq + 1;
  const dt = lastArrival ? now - lastArrival : 0;
  let fps = s.fps;
  if (dt > 0 && dt <= STALL_MS) {
    const inst = 1000 / dt;
    fps = fps > 0 ? fps * 0.75 + inst * 0.25 : inst;
  } else fps = 0;
  lastArrival = now;
  latest = { blob, capturedAt, seq, arrivedAt: now };
  const url = makeUrl(blob);
  revoke(s.frameUrl);
  set({
    frameUrl: url,
    frameAt: now,
    seq,
    fps: Math.round(fps * 10) / 10,
    width: size?.width ?? s.width,
    height: size?.height ?? s.height,
    status: 'live',
    error: null,
  });
  for (const w of [...waiters]) {
    if (seq > w.after) {
      waiters.delete(w);
      w.done({ blob, capturedAt, seq });
    }
  }
}

function onStreamBytes(gen: number, bytes: Uint8Array, capturedAt: number) {
  if (gen !== streamGen || !active || !isJpegStart(bytes) || bytes.length < 100) return;
  streamErrors = 0;
  lastStreamArrival = Date.now();
  if (useLiveStream.getState().source !== 'stream') {
    // The stream is back: single photos stop (they would only fight it for the camera).
    stopSnapshots();
    clearTimeout(retryTimer);
    stickLog('camera: live stream back');
    set({ source: 'stream' });
  }
  publishFrame(new Blob([bytes as BlobPart], { type: 'image/jpeg' }), capturedAt, jpegSize(bytes));
}

/** A stream attempt failed. 3 in a row (no frame in between) → single photos. */
function streamFailed(gen: number, raw: string) {
  if (gen !== streamGen || !active) return;
  streamErrors++;
  const words = streamErrorWords(raw);
  stickLog(`camera stream: ${raw} (${streamErrors} in a row)`);
  // While single photos show the picture, a failing background retry is not news.
  if (!snapRunning) {
    set({ error: words });
    refreshStatus();
  }
  if (streamErrors >= STREAM_MAX_ERRORS) toSnapshots(words);
}

function stopStreamSource() {
  streamGen++;
  streamRunning = false;
  clearTimeout(webRetryTimer);
  webCtrl?.abort();
  webCtrl = null;
  const hs = nativeHandles;
  nativeHandles = [];
  for (const h of hs) void h.remove().catch(() => undefined);
  if (nativeRunning) {
    nativeRunning = false;
    // Frees the stick's only stream slot at once.
    void withTimeout(AissNative.stopStream(), 3000, 'stop camera stream').catch(() => undefined);
  }
}

function stopSnapshots() {
  snapGen++;
  snapRunning = false;
  clearTimeout(snapTimer);
}

function stopSources() {
  stopStreamSource();
  stopSnapshots();
  clearTimeout(retryTimer);
}

/** Starts a stream attempt. Single photos (if running) keep going until its first frame. */
function startStream() {
  stopStreamSource();
  clearTimeout(retryTimer);
  const gen = streamGen;
  streamRunning = true;
  streamErrors = 0;
  streamSince = Date.now();
  if (!snapRunning) set({ source: 'stream' });
  if (isNativeApp()) void startNativeStream(gen);
  else void startWebStream(gen, 0);
}

async function startNativeStream(gen: number) {
  const keep = (h: PluginListenerHandle) => {
    if (gen === streamGen) nativeHandles.push(h);
    else void h.remove().catch(() => undefined);
  };
  try {
    nativeRunning = true;
    await withTimeout(
      Promise.all([
        AissNative.addListener('streamFrame', (e) => onStreamBytes(gen, b64ToBytes(e.data ?? ''), typeof e.at === 'number' ? e.at : Date.now())).then(keep),
        AissNative.addListener('streamState', (e) => {
          if (e.state === 'error') streamFailed(gen, e.error ?? 'stream error');
        }).then(keep),
      ]),
      3000,
      'camera stream listeners',
    );
    if (gen !== streamGen) return;
    await withTimeout(AissNative.startStream({ port: STREAM_PORT, path: STREAM_PATH, maxFps: STREAM_MAX_FPS }), 5000, 'start camera stream');
    stickLog('camera stream: native reader started');
  } catch (e) {
    // The reader could not even start (e.g. an app build without it): single photos at once.
    if (gen !== streamGen || !active) return;
    const msg = (e as Error).message;
    stickLog(`camera stream: native reader failed to start (${msg})`);
    const words = streamErrorWords(msg);
    if (!snapRunning) set({ error: words });
    toSnapshots(words);
  }
}

async function startWebStream(gen: number, attempt: number) {
  if (gen !== streamGen || !active) return;
  const ctrl = new AbortController();
  webCtrl = ctrl;
  let noAnswer = false;
  let gotFrame = false;
  // The stick accepts a second viewer's connection but never answers it while one is watching.
  const headerTimer = setTimeout(() => {
    noAnswer = true;
    ctrl.abort();
  }, 5000);
  try {
    const res = await fetch(`http://${streamHost()}:${STREAM_PORT}${STREAM_PATH}`, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(headerTimer);
    if (gen !== streamGen) return;
    if (res.status === 503) throw new Error('camera unavailable (HTTP 503)');
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get('content-type') ?? '';
    if (!/multipart/i.test(ct)) throw new Error('not a camera stream');
    const boundary = /boundary="?([^";\s]+)"?/i.exec(ct)?.[1] ?? null;
    const parser = createMultipartJpegParser(
      (jpeg) => {
        gotFrame = true;
        onStreamBytes(gen, jpeg, Date.now());
      },
      { boundary },
    );
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (gen !== streamGen) {
        void reader.cancel().catch(() => undefined);
        return;
      }
      if (done) throw new Error('stream ended');
      if (value) parser.push(value);
    }
  } catch (e) {
    clearTimeout(headerTimer);
    if (gen !== streamGen) return;
    streamFailed(gen, noAnswer ? 'busy: no answer from the stream (another viewer?)' : (e as Error).message);
    if (gen !== streamGen) return; // gave up on the stream for now
    const next = gotFrame ? 0 : attempt + 1;
    const wait = Math.min(8000, 1000 * 2 ** Math.min(next, 3));
    webRetryTimer = setTimeout(() => void startWebStream(gen, next), wait);
  } finally {
    if (webCtrl === ctrl) webCtrl = null;
  }
}

/** Single photos through the transport (fallback, and demo mode). Real mode retries the stream after 30 s. */
function toSnapshots(reason: string | null) {
  stopStreamSource();
  clearTimeout(retryTimer);
  if (!snapRunning) {
    stopSnapshots();
    snapRunning = true;
    stickLog(`camera: single photos${reason ? ` (${reason})` : ''}`);
    set({ source: 'snapshots' });
    void snapshotTick(snapGen);
  }
  if (!isDemo()) retryTimer = setTimeout(() => active && startStream(), STREAM_RETRY_AFTER_MS);
}

async function snapshotTick(gen: number) {
  if (gen !== snapGen || !active) return;
  const t0 = Date.now();
  const t = getTransport();
  if (!t) set({ error: STREAM_ERRORS.notConnected });
  else if (!snapshotInFlight) {
    snapshotInFlight = true;
    try {
      const f = await withTimeout(t.captureFrame({ timeoutMs: 4000 }), 6500, 'camera photo');
      if (gen === snapGen && active) {
        let size = f.width && f.height ? { width: f.width, height: f.height } : null;
        if (!size) {
          try {
            size = jpegSize(new Uint8Array(await f.blob.slice(0, 64 * 1024).arrayBuffer()));
          } catch {
            size = null;
          }
        }
        if (gen === snapGen && active) publishFrame(f.blob, f.capturedAt, size);
      }
    } catch (e) {
      const msg = (e as Error).message;
      // 409 = the camera is busy for a moment: just try again next tick.
      if (gen === snapGen && active && !/busy|\b409\b/i.test(msg)) set({ error: /offline/i.test(msg) ? STREAM_ERRORS.notConnected : streamErrorWords(msg) });
    } finally {
      snapshotInFlight = false;
    }
  }
  if (gen !== snapGen || !active) return;
  refreshStatus();
  snapTimer = setTimeout(() => void snapshotTick(gen), Math.max(0, SNAPSHOT_EVERY_MS - (Date.now() - t0)));
}

function tick() {
  if (!active) return;
  if (streamRunning && Date.now() - Math.max(streamSince, lastStreamArrival) > STREAM_NO_FRAME_MS) {
    const s = useLiveStream.getState();
    const why = s.error ?? STREAM_ERRORS.noFrames;
    if (!snapRunning) set({ error: why });
    toSnapshots(why);
  }
  refreshStatus();
}

function startHub() {
  active = true;
  lastArrival = 0;
  lastStreamArrival = 0;
  latest = null;
  set({ status: 'connecting', error: null, fps: 0, source: null });
  clearInterval(ticker);
  ticker = setInterval(tick, 500);
  if (isDemo()) toSnapshots(null);
  else startStream();
}

function stopHub() {
  active = false;
  clearTimeout(lingerTimer);
  lingerTimer = undefined;
  stopSources();
  clearInterval(ticker);
  ticker = undefined;
  latest = null;
  lastArrival = 0;
  lastStreamArrival = 0;
  for (const w of [...waiters]) w.done(null);
  waiters.clear();
  revoke(useLiveStream.getState().frameUrl);
  set({ status: 'off', source: null, fps: 0, frameUrl: null, frameAt: null });
}

function reconcile() {
  const canRun = linked() && visible();
  const want = holders.size > 0 && canRun;
  if (want) {
    clearTimeout(lingerTimer);
    lingerTimer = undefined;
    if (!active) startHub();
  } else if (active) {
    if (canRun) {
      // Nobody holds it any more, but the next view usually takes over within a moment.
      lingerTimer ??= setTimeout(() => {
        lingerTimer = undefined;
        if (active && holders.size === 0) stopHub();
        reconcile();
      }, RELEASE_LINGER_MS);
    } else stopHub();
  }
  const viewers = holders.size;
  const s = useLiveStream.getState();
  if (active) {
    if (s.viewers !== viewers) set({ viewers });
    return;
  }
  const error = viewers > 0 && !linked() ? STREAM_ERRORS.notConnected : null;
  if (s.viewers !== viewers || s.error !== error || s.status !== 'off') set({ viewers, error, status: 'off' });
}

function wire() {
  if (wired) return;
  wired = true;
  unwire.push(
    useDevice.subscribe((s, p) => {
      if (isLinked(s.link) !== isLinked(p.link)) reconcile();
    }),
  );
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    const onVis = () => reconcile();
    document.addEventListener('visibilitychange', onVis);
    unwire.push(() => document.removeEventListener('visibilitychange', onVis));
  }
  // Android: the WebView may miss visibilitychange on pause/resume; appStateChange does not.
  if (isNativeApp()) {
    let handle: PluginListenerHandle | null = null;
    let gone = false;
    try {
      CapApp.addListener('appStateChange', ({ isActive }) => {
        appActive = isActive;
        reconcile();
      })
        .then((h) => {
          if (gone) void h.remove();
          else handle = h;
        })
        .catch(() => undefined);
    } catch {
      /* no app plugin */
    }
    unwire.push(() => {
      gone = true;
      void handle?.remove().catch(() => undefined);
    });
  }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Ref-counted. The stream runs while at least one holder exists AND the stick link is
 * connected/degraded (and RELEASE_LINGER_MS after the last release). Returns release() (idempotent).
 */
export function acquireLiveStream(reason: string): () => void {
  wire();
  const id = nextHolder++;
  holders.set(id, reason);
  reconcile();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders.delete(id);
    reconcile();
  };
}

/** Newest frame if it arrived within maxAgeMs (default 1000), else null. */
export function latestStreamFrame(maxAgeMs = 1000): { blob: Blob; capturedAt: number; seq: number } | null {
  if (!active || !latest || Date.now() - latest.arrivedAt > maxAgeMs) return null;
  return { blob: latest.blob, capturedAt: latest.capturedAt, seq: latest.seq };
}

/** React hook: holds the stream while mounted and active (default true); returns the store state. */
export function useLiveStreamHold(active = true): LiveStreamState {
  useEffect(() => {
    if (!active) return undefined;
    return acquireLiveStream('screen');
  }, [active]);
  return useLiveStream();
}

/** The hub is running (somebody holds it, the stick is linked, the app is on screen). */
export function isLiveStreamRunning(): boolean {
  return active;
}

/**
 * The next frame with seq > afterSeq (default: the current one), or null after timeoutMs or when the
 * hub stops. Resolves at once with null when the hub is not running.
 */
export function waitForStreamFrame(afterSeq: number = useLiveStream.getState().seq, timeoutMs = 1500): Promise<StreamFrame | null> {
  if (!active) return Promise.resolve(null);
  if (latest && latest.seq > afterSeq) return Promise.resolve({ blob: latest.blob, capturedAt: latest.capturedAt, seq: latest.seq });
  return new Promise((resolve) => {
    const w = {
      after: afterSeq,
      done: (f: StreamFrame | null) => {
        clearTimeout(timer);
        resolve(f);
      },
    };
    const timer = setTimeout(() => {
      waiters.delete(w);
      resolve(null);
    }, timeoutMs);
    waiters.add(w);
  });
}

/** Test hook: stops everything and forgets all holders. */
export function resetLiveStreamForTests() {
  holders.clear();
  clearTimeout(lingerTimer);
  lingerTimer = undefined;
  if (active) stopHub();
  unwire.forEach((u) => u());
  unwire = [];
  wired = false;
  appActive = true;
  snapshotInFlight = false;
  nativeRunning = false;
  useLiveStream.setState(initialState());
}
