import { getTransport } from '../device/bridge';
import type { CapturedFrame } from '../transport/types';

export interface FramePipelineConfig {
  /** Frames older than this when they arrive are dropped (the world has moved on). */
  maxStaleMs: number;
}

/**
 * Pull-based frame source: one capture in flight at a time (the vision loop is sequential), with
 * capture / inference / end-to-end latency and FPS metrics for the debug view.
 */
export class FramePipeline {
  public metrics = {
    captureLatency: 0,
    inferenceLatency: 0,
    e2eLatency: 0,
    effectiveFps: 0,
    inferenceFps: 0,
    droppedFrames: 0,
    capturedFrames: 0,
  };

  private lastFrameAt = 0;
  private lastInferenceAt = 0;

  constructor(private config: FramePipelineConfig = { maxStaleMs: 1500 }) {}

  public async fetchNextFrame(): Promise<CapturedFrame> {
    const t = getTransport();
    if (!t) throw new Error('offline');
    const t0 = performance.now();
    const frame = await t.captureFrame();
    this.metrics.captureLatency = performance.now() - t0;
    const age = Date.now() - frame.capturedAt;
    if (age > this.config.maxStaleMs) {
      this.metrics.droppedFrames++;
      throw new Error(`Stale frame dropped (${Math.round(age)} ms)`);
    }
    this.metrics.capturedFrames++;
    const now = performance.now();
    if (this.lastFrameAt > 0) this.metrics.effectiveFps = this.metrics.effectiveFps * 0.8 + (1000 / (now - this.lastFrameAt)) * 0.2;
    this.lastFrameAt = now;
    return frame;
  }

  public finishInference(inferenceTimeMs: number, e2eTimeMs: number) {
    const now = performance.now();
    if (this.lastInferenceAt > 0) this.metrics.inferenceFps = this.metrics.inferenceFps * 0.8 + (1000 / (now - this.lastInferenceAt)) * 0.2;
    this.lastInferenceAt = now;
    this.metrics.inferenceLatency = inferenceTimeMs;
    this.metrics.e2eLatency = e2eTimeMs;
  }

  public reset() {
    this.metrics = { captureLatency: 0, inferenceLatency: 0, e2eLatency: 0, effectiveFps: 0, inferenceFps: 0, droppedFrames: 0, capturedFrames: 0 };
    this.lastFrameAt = 0;
    this.lastInferenceAt = 0;
  }
}
