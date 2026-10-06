import type { ObjectObservation } from './types';
import DetectorWorker from './detector.worker?worker';

export interface DetectorConfig {
  scoreThreshold: number;
  maxResults: number;
  modelPath: string;
}

export class LocalDetector {
  private config: DetectorConfig;
  private worker: Worker | null = null;
  private isReady = false;
  private msgIdSeq = 0;
  
  // Pending promises for RPC
  private pendingInit: ((v: void) => void) | null = null;
  private pendingInitErr: ((e: any) => void) | null = null;
  
  private pendingDetect: ((v: ObjectObservation[]) => void) | null = null;
  private pendingDetectErr: ((e: any) => void) | null = null;
  
  public actualInferenceLatencyMs = 0;

  constructor(config: Partial<DetectorConfig> = {}) {
    this.config = { 
      scoreThreshold: 0.35, 
      maxResults: 12, 
      modelPath: '/models/efficientdet_lite0.tflite',
      ...config 
    };
  }

  public async init(): Promise<void> {
    if (this.isReady) return;
    
    this.worker = new DetectorWorker();
    
    this.worker.onmessage = (e) => {
      const { type, payload, error } = e.data;
      if (type === 'INIT_DONE') {
        this.isReady = true;
        if (this.pendingInit) this.pendingInit();
      } else if (type === 'DETECT_DONE') {
        this.actualInferenceLatencyMs = payload.latencyMs;
        if (this.pendingDetect) this.pendingDetect(payload.observations);
      } else if (type === 'ERROR') {
        if (this.pendingInitErr) this.pendingInitErr(new Error(error));
        if (this.pendingDetectErr) this.pendingDetectErr(new Error(error));
      }
    };
    
    this.worker.onerror = (e) => {
      if (this.pendingInitErr) this.pendingInitErr(new Error(e.message));
      if (this.pendingDetectErr) this.pendingDetectErr(new Error(e.message));
    };

    return new Promise((resolve, reject) => {
      this.pendingInit = resolve;
      this.pendingInitErr = reject;
      
      const msgId = ++this.msgIdSeq;
      this.worker!.postMessage({
        type: 'INIT',
        msgId,
        payload: {
          modelPath: this.config.modelPath,
          scoreThreshold: this.config.scoreThreshold,
          maxResults: this.config.maxResults,
        }
      });
    });
  }

  public async detect(blob: Blob, nowMs: number): Promise<ObjectObservation[]> {
    if (!this.isReady || !this.worker) throw new Error('Detector unavailable');
    
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(blob);
    } catch (e) {
      throw new Error('Failed to decode JPEG blob');
    }

    return new Promise((resolve, reject) => {
      this.pendingDetect = (obs) => {
        // stamp with current timestamp
        resolve(obs.map(o => ({ ...o, timestamp: nowMs })));
      };
      this.pendingDetectErr = reject;
      
      const msgId = ++this.msgIdSeq;
      // Transfer the bitmap to the worker (zero-copy)
      this.worker!.postMessage({
        type: 'DETECT',
        msgId,
        payload: { bmp }
      }, [bmp]); // Transferable object
    });
  }
}
