import { FramePipeline } from './framePipeline';
import { LocalDetector } from './detector';
import { ObjectTracker } from './objectTracker';
import { fuseSensors } from './fusionEngine';
import { getCurrentSensorContext } from './sensorConditioning';
import { useVisionDebug, type VisionRunState } from '../store/visionDebug';
import { useDevice, isLinked } from '../store/device';
import { trace } from '../device/deviceTrace';
import { log } from '../log';
import type { DetectionSnapshot } from './types';
import { useNavView } from '../navigation/navView';
import { useWalking } from '../walking/walkTracker';
import { getSettings } from '../store/session';
import { SENSITIVITY } from '../telemetry/obstaclePolicy';
import { visionCaptureRequired, VISION_SCHEDULING } from './visionScheduling';
import { useUI } from '../store/ui';

/** Upper bound on the stick camera pull rate: ~4 fps leaves room for telemetry on the ESP32's one HTTP task. */
const MIN_FRAME_INTERVAL_MS = VISION_SCHEDULING.frameIntervalMs;
/** Existing medium proximity boundary (cm); active walking also observes beyond sonar range. */
export const VISION_TRIGGER_CM = 150;
const IDLE_CHECK_MS = VISION_SCHEDULING.idleCheckMs;
/** Model load retries (missing asset, worker crash) back off instead of hammering. */
const INIT_RETRY_MS = [5_000, 15_000, 60_000];

/**
 * The one vision loop: stick camera JPEG → EfficientDet-Lite0 (worker) → ObjectTracker →
 * sensor fusion → DetectionSnapshot. Runs only while the stick is linked; no fake frames, no fake
 * detections. Its state (waiting / loading / running / error + reason) is published for the UI.
 */
export class VisionEngine {
  private pipeline = new FramePipeline();
  private detector = new LocalDetector();
  private tracker = new ObjectTracker();

  private enabled = false;
  private looping = false;
  private loopId: ReturnType<typeof setTimeout> | null = null;
  /** Each start gets a new generation; a loop from an earlier start ends at its next await. */
  private loopGen = 0;
  private lifecycleGen = 0;
  /** A restarted loop waits for the old iteration to release its capture / decode / inference. */
  private activeIteration: Promise<void> | null = null;
  private initAttempt = 0;
  private initTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubLink: (() => void) | null = null;
  private consecutiveErrors = 0;
  /** Holds the live camera stream while detection runs, so frames come from it, not from extra /capture calls. */
  private releaseStream: (() => void) | null = null;

  public latestSnapshot: DetectionSnapshot | null = null;
  public onSnapshot: ((s: DetectionSnapshot) => void) | null = null;

  /** Idempotent. The loop itself starts and pauses with the stick link. */
  public start() {
    if (this.enabled) return;
    this.enabled = true;
    this.lifecycleGen++;
    this.unsubLink = useDevice.subscribe((s, prev) => {
      if (isLinked(s.link) !== isLinked(prev.link)) this.reconcile();
    });
    this.reconcile();
  }

  public stop() {
    this.enabled = false;
    this.lifecycleGen++;
    this.unsubLink?.();
    this.unsubLink = null;
    this.halt('stopped');
    if (this.initTimer) clearTimeout(this.initTimer);
    this.initTimer = null;
    this.detector.terminate();
    this.publish({ detectorStatus: this.detector.status });
  }

  private publish(p: Partial<ReturnType<typeof useVisionDebug.getState>>) {
    useVisionDebug.setState(p);
  }

  private setRun(runState: VisionRunState) {
    if (useVisionDebug.getState().runState !== runState) this.publish({ runState });
  }

  private halt(state: VisionRunState) {
    this.looping = false;
    this.loopGen++;
    this.releaseStream?.();
    this.releaseStream = null;
    if (this.loopId) clearTimeout(this.loopId);
    this.loopId = null;
    this.latestSnapshot = null;
    this.publish({ latestSnapshot: null });
    const debugFrameUrl = useVisionDebug.getState().debugFrameUrl;
    if (debugFrameUrl) {
      URL.revokeObjectURL(debugFrameUrl);
      this.publish({ debugFrameUrl: null });
    }
    this.setRun(state);
  }

  private reconcile() {
    if (!this.enabled) return;
    if (!isLinked(useDevice.getState().link)) {
      this.halt('waiting_for_stick');
      return;
    }
    if (this.detector.ready) {
      if (!this.looping) {
        this.looping = true;
        this.consecutiveErrors = 0;
        this.tracker = new ObjectTracker();
        this.pipeline.reset();
        // Pull latest frames without opening a second continuous stream for inference.
        this.releaseStream?.();
        this.releaseStream = null;
        this.setRun('running');
        void this.loop(++this.loopGen);
      }
      return;
    }
    void this.ensureDetector();
  }

  private async ensureDetector() {
    if (this.detector.status === 'loading' || this.initTimer) return;
    const lifecycle = this.lifecycleGen;
    this.setRun('loading_model');
    this.publish({ detectorStatus: 'loading', detectorError: null });
    try {
      await this.detector.init();
      if (!this.enabled || lifecycle !== this.lifecycleGen) return;
      this.initAttempt = 0;
      log.info('vision: detector ready', { initMs: this.detector.initMs });
      this.publish({ detectorStatus: 'ready', detectorError: null, detectorInitTime: this.detector.initMs ?? 0 });
      this.reconcile();
    } catch (e) {
      if (!this.enabled || lifecycle !== this.lifecycleGen) return;
      const msg = (e as Error).message;
      log.error('vision: EfficientDet-Lite0 failed to load', { error: msg });
      this.publish({ detectorStatus: 'error', detectorError: msg });
      this.setRun('error');
      if (!this.enabled) return;
      const wait = INIT_RETRY_MS[Math.min(this.initAttempt++, INIT_RETRY_MS.length - 1)];
      this.initTimer = setTimeout(() => {
        this.initTimer = null;
        this.reconcile();
      }, wait);
    }
  }

  private async loop(gen: number) {
    const live = () => this.looping && gen === this.loopGen;
    if (!live()) return;
    if (this.activeIteration) {
      await this.activeIteration;
      if (!live()) return;
    }
    const iteration = this.runIteration(gen);
    this.activeIteration = iteration;
    try {
      await iteration;
    } finally {
      if (this.activeIteration === iteration) this.activeIteration = null;
    }
  }

  private async runIteration(gen: number) {
    const live = () => this.looping && gen === this.loopGen;
    if (!live()) return;
    const started = performance.now();
    let wait: number = MIN_FRAME_INTERVAL_MS;
    const thresholds = SENSITIVITY[getSettings().obstacleSensitivity] ?? SENSITIVITY.medium;
    const context = getCurrentSensorContext(thresholds.warningCm);
    const nav = useNavView.getState();
    const walking = useWalking.getState();
    if (!visionCaptureRequired({ context, navigationActive: nav.active && !nav.arrived,
      walkingSessionActive: !!walking.current && !walking.paused, awarenessCm: thresholds.awarenessCm })) {
      // Stationary, no nearby range or reliable approach: no camera/worker work this iteration.
      this.loopId = setTimeout(() => void this.loop(gen), IDLE_CHECK_MS);
      return;
    }
    try {
      const frame = await this.pipeline.fetchNextFrame();
      if (!live()) return;
      const observations = await this.detector.detect(frame.blob, frame.capturedAt);
      if (!live()) return;
      trace('frame_decoded', { bytes: frame.blob.size });
      trace('detector_ran', { objects: observations.length, ms: Math.round(this.detector.actualInferenceLatencyMs) });
      const nowMs = Date.now();
      const tracks = this.tracker.update(observations, frame.capturedAt);
      const ctx = getCurrentSensorContext(thresholds.warningCm);
      const { fusedObjects, pathState } = fuseSensors(tracks, ctx, nowMs);
      const e2e = performance.now() - started;
      this.pipeline.finishInference(this.detector.actualInferenceLatencyMs, e2e);

      const snapshot: DetectionSnapshot & { metrics: FramePipeline['metrics'] } = {
        timestamp: nowMs,
        frameTimestamp: frame.capturedAt,
        frameWidth: frame.width,
        frameHeight: frame.height,
        processingLatencyMs: e2e,
        sensorContext: ctx,
        frameSensorContext: context,
        objects: observations,
        tracks,
        fusedObjects,
        pathState,
        overallQuality: ctx.quality === 'good' && pathState.center !== 'UNKNOWN' ? 'good' : 'degraded',
        metrics: { ...this.pipeline.metrics },
      };
      this.latestSnapshot = snapshot;
      this.consecutiveErrors = 0;
      this.onSnapshot?.(snapshot);
      if (!live()) return;
      const dbg = useVisionDebug.getState();
      if (dbg.debugFrameUrl) URL.revokeObjectURL(dbg.debugFrameUrl);
      this.publish({ latestSnapshot: snapshot, debugFrameUrl: useUI.getState().visionDebug ? URL.createObjectURL(frame.blob) : null, lastFrameError: null });
    } catch (e) {
      if (!live()) return;
      const msg = (e as Error).message;
      this.consecutiveErrors++;
      if (useVisionDebug.getState().lastFrameError !== msg) this.publish({ lastFrameError: msg });
      if (/Detector (unavailable|stopped)|timed out|crashed/i.test(msg) && !this.detector.ready) {
        // The worker died: reload the model instead of capturing frames nobody can analyse.
        this.halt('loading_model');
        this.reconcile();
        return;
      }
      // camera busy / offline / stale: back off gently (max 2 s), never spin.
      wait = Math.min(2000, MIN_FRAME_INTERVAL_MS * 2 ** Math.min(this.consecutiveErrors, 3));
    }
    if (!live()) return;
    const elapsed = performance.now() - started;
    this.loopId = setTimeout(() => void this.loop(gen), Math.max(0, wait - elapsed));
  }
}

export const visionEngine = new VisionEngine();
