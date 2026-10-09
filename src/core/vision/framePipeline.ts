import { getTransport } from '../device/bridge';
import type { CapturedFrame } from '../transport/types';
import { isLiveStreamRunning, latestStreamFrame, useLiveStream, waitForStreamFrame } from '../camera/liveStream';

export interface FramePipelineConfig {
  /** Frames older than this when they arrive are dropped (the world has moved on). */
  maxStaleMs: number;
}

/** How long to wait for the live stream's next frame before asking the stick for a photo. */
const STREAM_WAIT_MS = 1500;

/**
 * Pull-based frame source: one capture in flight at a time (the vision loop is sequential), with
 * capture / inference / end-to-end latency and FPS metrics for the debug view.
 * Prefers live-stream frames (core/camera/liveStream.ts) not analysed yet; while the stream runs it
 * waits for the next one instead of competing for the camera with /api/v1/capture.
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
  /** Newest live-stream frame handed out (stream seq only grows). */
  private lastStreamSeq = 0;

  constructor(private config: FramePipelineConfig = { maxStaleMs: 1500 }) {}

  private fromStream(f: { blob: Blob; capturedAt: number; seq: number }): CapturedFrame {
    this.lastStreamSeq = f.seq;
    const s = useLiveStream.getState();
    return { blob: f.blob, width: s.width, height: s.height, capturedAt: f.capturedAt };
  }

  private async nextFrame(): Promise<CapturedFrame> {
    const fresh = latestStreamFrame(this.config.maxStaleMs);
    if (fresh && fresh.seq > this.lastStreamSeq) return this.fromStream(fresh);
    if (isLiveStreamRunning()) {
      const next = await waitForStreamFrame(this.lastStreamSeq, STREAM_WAIT_MS);
      if (next) return this.fromStream(next);
    }
    const t = getTransport();
    if (!t) throw new Error('offline');
    return t.captureFrame();
  }

  public async fetchNextFrame(): Promise<CapturedFrame> {
    if (!getTransport()) throw new Error('offline');
    const t0 = performance.now();
    const frame = await this.nextFrame();
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
