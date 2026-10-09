import type { ObjectObservation } from './types';
import DetectorWorker from './detector.worker?worker';

export interface DetectorConfig {
  scoreThreshold: number;
  maxResults: number;
  modelPath: string;
  wasmBase: string;
  initTimeoutMs: number;
  detectTimeoutMs: number;
}

export type DetectorStatus = 'idle' | 'loading' | 'ready' | 'error';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

const base = (() => {
  const b = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return b.endsWith('/') ? b : `${b}/`;
})();

/**
 * Main-thread side of the EfficientDet-Lite0 worker. Every request carries a msgId and its own
 * timeout, so a stalled or crashed worker can never freeze the vision loop. Init is shared:
 * concurrent callers get the same promise and only one worker ever exists.
 */
export class LocalDetector {
  private config: DetectorConfig;
  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();

  status: DetectorStatus = 'idle';
  error: string | null = null;
  initMs: number | null = null;
  actualInferenceLatencyMs = 0;

  constructor(config: Partial<DetectorConfig> = {}) {
    this.config = {
      scoreThreshold: 0.35,
      maxResults: 12,
      modelPath: `${base}models/efficientdet_lite0.tflite`,
      wasmBase: `${base}mediapipe/wasm`,
      initTimeoutMs: 30_000,
      detectTimeoutMs: 3_000,
      ...config,
    };
  }

  get ready() {
    return this.status === 'ready';
  }

  init(): Promise<void> {
    if (this.status === 'ready') return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    this.status = 'loading';
    this.error = null;
    this.worker = new DetectorWorker();
    this.worker.onmessage = (e: MessageEvent) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.failAll(new Error(e.message || 'Detector worker crashed'));
    const { modelPath, wasmBase, scoreThreshold, maxResults } = this.config;
    this.initPromise = this.call<{ initMs: number }>('INIT', { modelPath, wasmBase, scoreThreshold, maxResults }, this.config.initTimeoutMs)
      .then((r) => {
        this.status = 'ready';
        this.initMs = r.initMs;
      })
      .catch((e: Error) => {
        this.status = 'error';
        this.error = e.message;
        this.terminate();
        throw e;
      })
      .finally(() => {
        this.initPromise = null;
      });
    return this.initPromise;
  }

  async detect(blob: Blob, frameTs: number): Promise<ObjectObservation[]> {
    if (this.status !== 'ready' || !this.worker) throw new Error('Detector unavailable');
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(blob);
    } catch {
      throw new Error('Failed to decode JPEG');
    }
    let r: { observations: Omit<ObjectObservation, 'timestamp'>[]; latencyMs: number };
    try {
      r = await this.call('DETECT', { bmp }, this.config.detectTimeoutMs, [bmp]);
    } catch (e) {
      // A hung worker never recovers by itself: drop it so the vision loop reloads the model.
      if (/timed out/.test((e as Error).message)) this.terminate();
      throw e;
    }
    this.actualInferenceLatencyMs = r.latencyMs;
    return r.observations.map((o) => ({ ...o, timestamp: frameTs }));
  }

  /** Frees the worker (and its ~20 MB of WASM + model). init() can start it again. */
  terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.failAll(new Error('Detector stopped'));
    if (this.status === 'ready' || this.status === 'loading') this.status = 'idle';
  }

  private call<T>(type: string, payload: unknown, timeoutMs: number, transfer: Transferable[] = []): Promise<T> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('Detector unavailable'));
    const msgId = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msgId);
        reject(new Error(`${type} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(msgId, { resolve, reject, timer });
      worker.postMessage({ type, msgId, payload }, transfer);
    });
  }

  private onMessage(m: { type: string; msgId: number; payload?: unknown; error?: string }) {
    const p = this.pending.get(m.msgId);
    if (!p) return; // late answer to a request that already timed out
    this.pending.delete(m.msgId);
    clearTimeout(p.timer);
    if (m.type === 'ERROR') p.reject(new Error(m.error ?? 'Detector error'));
    else p.resolve(m.payload);
  }

  private failAll(e: Error) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
}
