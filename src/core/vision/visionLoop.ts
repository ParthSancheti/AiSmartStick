import { FramePipeline } from './framePipeline';
import { LocalDetector } from './detector';
import { ObjectTracker } from './objectTracker';
import { fuseSensors } from './fusionEngine';
import { getCurrentSensorContext } from './sensorConditioning';
import { useVisionDebug } from '../store/visionDebug';
import type { DetectionSnapshot, ObjectObservation } from './types';

export class VisionEngine {
  private pipeline = new FramePipeline();
  private detector = new LocalDetector();
  private tracker = new ObjectTracker();
  
  private isRunning = false;
  private loopId: ReturnType<typeof setTimeout> | null = null;
  
  public latestSnapshot: DetectionSnapshot | null = null;
  public onSnapshot: ((s: DetectionSnapshot) => void) | null = null;
  
  public async start() {
    if (this.isRunning) return;
    try {
      await this.detector.init();
    } catch (e) {
      console.error('Detector init failed:', e);
      // We still run the loop, but it will report unavailable
    }
    this.isRunning = true;
    this.loop();
  }
  
  public stop() {
    this.isRunning = false;
    if (this.loopId) clearTimeout(this.loopId);
    this.pipeline.reset();
  }
  
  private async loop() {
    if (!this.isRunning) return;
    
    try {
      const frameStartMs = performance.now();
      const frame = await this.pipeline.fetchNextFrame();
      const nowMs = Date.now();
      
      let observations: ObjectObservation[] = [];
      let detectorFailed = false;
      
      try {
        observations = await this.detector.detect(frame.blob, frame.capturedAt);
      } catch (e) {
        detectorFailed = true;
      }
      
      const tracks = this.tracker.update(observations, frame.capturedAt);
      const ctx = getCurrentSensorContext();
      const { fusedObjects, pathState } = fuseSensors(tracks, ctx, nowMs);
      
      const inferenceEnd = performance.now();
      const e2eLatency = inferenceEnd - frameStartMs;
      
      // Use the actual measured latency from the worker
      this.pipeline.finishInference(this.detector.actualInferenceLatencyMs, e2eLatency);
      
      if (detectorFailed) {
        // If detector is unavailable, force path state to UNKNOWN
        pathState.left = 'UNKNOWN';
        pathState.center = 'UNKNOWN';
        pathState.right = 'UNKNOWN';
      }
      
      this.latestSnapshot = {
        timestamp: nowMs,
        frameTimestamp: frame.capturedAt,
        processingLatencyMs: e2eLatency,
        sensorContext: ctx,
        objects: observations,
        tracks,
        fusedObjects,
        pathState,
        overallQuality: detectorFailed ? 'poor' : (ctx.quality === 'good' && pathState.center !== 'UNKNOWN' ? 'good' : 'degraded')
      };
      
      if (this.onSnapshot) this.onSnapshot(this.latestSnapshot);
      // Augment snapshot with pipeline metrics for debug
      (this.latestSnapshot as any).metrics = this.pipeline.metrics;
      useVisionDebug.getState().setSnapshot(this.latestSnapshot);

      // Generate debug frame URL (revoke old one to prevent memory leak)
      const state = useVisionDebug.getState();
      if (state.debugFrameUrl) URL.revokeObjectURL(state.debugFrameUrl);
      state.setDebugFrameUrl(URL.createObjectURL(frame.blob));
      
      // Yield to event loop, request next frame immediately
      this.loopId = setTimeout(() => this.loop(), 0);
      
    } catch (e) {
      // e.g. dropped frame or offline. Wait a bit before retrying.
      this.loopId = setTimeout(() => this.loop(), 100);
    }
  }
}

export const visionEngine = new VisionEngine();
