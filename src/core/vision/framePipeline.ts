import { getTransport } from '../device/bridge';
import type { CapturedFrame } from '../transport/types';

export interface FramePipelineConfig {
  maxStaleMs: number;
}

export class FramePipeline {
  private processing = false;
  
  public metrics = {
    captureLatency: 0,
    inferenceLatency: 0,
    e2eLatency: 0,
    effectiveFps: 0,
    inferenceFps: 0,
    droppedFrames: 0,
  };
  
  private lastFrameAt = 0;
  private lastInferenceAt = 0;

  constructor(private config: FramePipelineConfig = { maxStaleMs: 500 }) {}

  public async fetchNextFrame(): Promise<CapturedFrame> {
    if (this.processing) {
      this.metrics.droppedFrames++;
      throw new Error('Pipeline busy - frame dropped');
    }
    
    this.processing = true;
    const t0 = performance.now();
    
    try {
      const t = getTransport();
      if (!t) throw new Error('offline');
      const frame = await t.captureFrame();
      const t1 = performance.now();
      
      this.metrics.captureLatency = t1 - t0;
      
      const age = Date.now() - frame.capturedAt;
      if (age > this.config.maxStaleMs) {
        this.metrics.droppedFrames++;
        this.processing = false;
        throw new Error('Stale frame dropped');
      }
      
      const now = performance.now();
      if (this.lastFrameAt > 0) {
        const delta = now - this.lastFrameAt;
        this.metrics.effectiveFps = this.metrics.effectiveFps * 0.8 + (1000 / delta) * 0.2;
      }
      this.lastFrameAt = now;
      
      return frame;
    } catch (e) {
      this.processing = false;
      throw e;
    }
  }

  public finishInference(inferenceTimeMs: number, e2eTimeMs: number) {
    const now = performance.now();
    if (this.lastInferenceAt > 0) {
      const delta = now - this.lastInferenceAt;
      this.metrics.inferenceFps = this.metrics.inferenceFps * 0.8 + (1000 / delta) * 0.2;
    }
    this.lastInferenceAt = now;
    this.metrics.inferenceLatency = inferenceTimeMs;
    this.metrics.e2eLatency = e2eTimeMs;
    this.processing = false;
  }
  
  public reset() {
    this.processing = false;
    this.metrics = {
      captureLatency: 0, inferenceLatency: 0, e2eLatency: 0, effectiveFps: 0, inferenceFps: 0, droppedFrames: 0
    };
    this.lastFrameAt = 0;
    this.lastInferenceAt = 0;
  }
}
