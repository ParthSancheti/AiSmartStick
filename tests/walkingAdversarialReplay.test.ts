import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ObjectTracker } from '../src/core/vision/objectTracker';
import { fuseSensors } from '../src/core/vision/fusionEngine';
import type { DetectionSnapshot, ObjectObservation } from '../src/core/vision/types';
import type { SensorContext } from '../src/core/perception/sensorCore';
import { evaluateWalkingGuidance, normalizeWalkingEvidence, type ConditionedWalkingInput } from '../src/core/perception/walkingEvidence';
import { advanceWalkingGuidance, type WalkingGuidance, type WalkingCoreInput } from '../src/core/perception/walkingCore';

const seeds = [0xA155, 0xC0FFEE, 0x5EED1234, 0xBB67AE85];
const stepsPerSeed = 5000;
const profiles = [
  { dangerCm: 40, warningCm: 75, awarenessCm: 110 },
  { dangerCm: 50, warningCm: 100, awarenessCm: 150 },
  { dangerCm: 70, warningCm: 140, awarenessCm: 200 },
];
const randomFor = (seed: number) => () => {
  let n = seed += 0x6D2B79F5;
  n = Math.imul(n ^ n >>> 15, n | 1);
  n ^= n + Math.imul(n ^ n >>> 7, n | 61);
  return ((n ^ n >>> 14) >>> 0) / 4294967296;
};
const context = (at: number, cm: number | null): SensorContext => ({
  timestamp: at, ultrasonic: { state: 'valid', value: cm, ageMs: 0 },
  accel: { state: 'valid', value: { x: 0, y: 0, z: 1, mag: 1 }, ageMs: 0 },
  gyro: { state: 'valid', value: { x: 0, y: 0, z: 0, mag: 0 }, ageMs: 0 },
  orientation: { state: 'valid', value: { pitch: 0, roll: 0 }, ageMs: 0 }, motion: 'WALKING', quality: 'good',
});
const observation = (at: number, x: number, bottom: number, confidence = 0.9): ObjectObservation => ({
  label: 'person', confidence, box: { x, y: bottom - 0.3, w: 0.24, h: 0.3 }, centerX: x + 0.12,
  centerY: bottom - 0.15, bottomCenterX: x + 0.12, bottomCenterY: bottom, timestamp: at,
});
const validThresholds = (t: WalkingCoreInput['thresholds']) => Object.values(t).every(Number.isFinite)
  && t.dangerCm >= 2 && t.dangerCm < t.warningCm && t.warningCm < t.awarenessCm && t.awarenessCm <= 450;
const poseUsable = (p: WalkingCoreInput['pose'], now: number) => !!p?.valid
  && [p.sampledAt, p.orientationAt, p.angularRateAt].every(at => Number.isFinite(at) && at <= now && now - at <= 1500)
  && [p.pitchDegrees, p.rollDegrees, p.angularRateDegreesPerSecond].every(n => typeof n === 'number' && Number.isFinite(n))
  && Math.abs(p.pitchDegrees!) <= 35 && Math.abs(p.rollDegrees!) <= 35
  && p.angularRateDegreesPerSecond! >= 0 && p.angularRateDegreesPerSecond! < 90
  && (p.motion === 'STABLE' || p.motion === 'WALKING');
interface SeedSummary {
  seed: string; events: number; checks: number; rawDangerChecks: number; heldNoReturnChecks: number;
  duplicateTickChecks: number; invalidPoseHoldChecks: number; releaseChecks: number;
  eventCounts: Record<string, number>;
}
const summaries: SeedSummary[] = [];

describe('seeded adversarial replay through the production tracker, fusion, adapter and reducer', { timeout: 30_000 }, () => {
  it.each(seeds)('preserves walking invariants over 5000 events, seed %s', (seed) => {
    const random = randomFor(seed);
    const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)];
    const tracker = new ObjectTracker();
    let now = 10_000;
    let previous: WalkingGuidance | undefined;
    let previousInput: WalkingCoreInput | null = null;
    let lastSnapshot: DetectionSnapshot | null = null;
    const summary: SeedSummary = { seed: `0x${seed.toString(16).toUpperCase()}`, events: stepsPerSeed, checks: 0,
      rawDangerChecks: 0, heldNoReturnChecks: 0, duplicateTickChecks: 0, invalidPoseHoldChecks: 0,
      releaseChecks: 0, eventCounts: {} };
    const check = (actual: unknown, expected: unknown, detail: string) => {
      summary.checks++;
      expect(actual, `${summary.seed} event ${eventIndex} (${kind}): ${detail}`).toEqual(expected);
    };
    let eventIndex = 0;
    let kind = '';
    for (; eventIndex < stepsPerSeed; eventIndex++) {
      const forced = eventIndex % 211;
      const mode = forced < 4 ? forced === 0 ? 1 : 0 : Math.floor(random() * 29);
      const delta = forced < 4 ? 400 : pick([0, 10, 100, 250, 400, 700]);
      now += delta;
      let cm: number | null = 250 + Math.floor(random() * 150);
      const thresholds = { ...pick(profiles) };
      // The release controls use the same sensitivity for the complete three-sample episode.
      if (forced < 4) Object.assign(thresholds, profiles[1]);
      const ctx = context(now, cm);
      let capturedAt = now;
      let capturedPose = context(now, cm);
      let observations: ObjectObservation[] = [];
      let linked = true;
      let noCamera = false;
      let usePreviousCamera = false;
      let malformedCenter = false;
      let poseInvalidByConstruction = false;
      switch (mode) {
        case 0: kind = 'resolved_observation'; break;
        case 1: kind = 'sudden_raw_danger'; cm = 2 + Math.floor(random() * (thresholds.dangerCm - 2)); break;
        case 2: kind = 'warning_range'; cm = thresholds.dangerCm + 1; break;
        case 3: kind = 'fresh_no_return'; cm = null; break;
        case 4: kind = 'range_error'; ctx.ultrasonic.state = 'invalid'; break;
        case 5: kind = 'stale_range'; ctx.ultrasonic.ageMs = 1800; break;
        case 6: kind = 'link_loss'; linked = false; break;
        case 7: kind = 'stale_camera'; capturedAt = now - 1800; capturedPose = context(capturedAt, cm); break;
        case 8: kind = 'future_camera'; capturedAt = now + 100; capturedPose = context(capturedAt, cm); break;
        case 9: kind = 'duplicate_camera'; usePreviousCamera = true; break;
        case 10: kind = 'duplicate_range'; ctx.ultrasonic.ageMs = Math.max(0, now - (previous?.temporal.lastRangeAt ?? now)); break;
        case 11: kind = 'backward_range'; ctx.ultrasonic.ageMs = Math.max(0, now - (previous?.temporal.lastRangeAt ?? now) + 100); break;
        case 12: kind = 'nonfinite_pose'; ctx.orientation.value!.pitch = pick([NaN, Infinity, -Infinity]); poseInvalidByConstruction = true; break;
        case 13: kind = 'tilted_pose'; ctx.orientation.value!.roll = pick([60, 90, -90]); poseInvalidByConstruction = true; break;
        case 14: kind = 'changed_pose'; ctx.orientation.value!.roll = 25; break;
        case 15: kind = 'stick_sweep'; ctx.motion = 'SWINGING'; ctx.gyro.value!.mag = 150; poseInvalidByConstruction = true; break;
        case 16: kind = 'capture_pose_mismatch'; capturedPose = context(now - 800, cm); break;
        case 17: kind = 'unresolved_center'; observations = [observation(now, 0.4, 0.95)]; malformedCenter = true; break;
        case 18: kind = 'camera_center_object'; observations = [observation(now, 0.4, 0.95)]; break;
        case 19: kind = 'side_object'; observations = [observation(now, pick([0.05, 0.72]), 0.9)]; break;
        case 20: kind = 'missing_camera'; noCamera = true; break;
        case 21: kind = 'invalid_thresholds'; thresholds.warningCm = thresholds.dangerCm - 1; break;
        case 22: kind = 'sensitivity_change'; Object.assign(thresholds, pick(profiles)); break;
        case 23: kind = 'clock_regression'; now -= 800; ctx.timestamp = now; capturedAt = now; capturedPose = context(now, cm); break;
        case 24: kind = 'duplicate_timer_tick'; break;
        case 25: kind = 'long_processing_gap'; now += 5000; ctx.timestamp = now; capturedAt = now; capturedPose = context(now, cm); break;
        case 26: kind = 'delayed_frame'; capturedAt = now - 200; capturedPose = context(capturedAt, cm); break;
        case 27: kind = 'invalid_box'; observations = [observation(now, NaN, 0.95)]; break;
        default: kind = 'stale_pose'; ctx.gyro.ageMs = 2000; ctx.orientation.ageMs = 2000; poseInvalidByConstruction = true;
      }
      ctx.ultrasonic.value = cm;
      const tracks = tracker.update(observations.map(o => ({ ...o, timestamp: capturedAt })), capturedAt);
      const fused = fuseSensors(tracks, ctx, now);
      for (const side of Object.values(fused.pathState)) check(side === 'FREE', false, 'fusion never certifies free space');
      let snapshot: DetectionSnapshot | null = noCamera ? null : usePreviousCamera ? lastSnapshot : {
        timestamp: now, frameTimestamp: capturedAt, processingLatencyMs: Math.max(0, now - capturedAt), sensorContext: ctx,
        frameSensorContext: capturedPose, objects: observations, tracks, ...fused, overallQuality: 'degraded',
      };
      if (malformedCenter && snapshot) snapshot = { ...snapshot, fusedObjects: snapshot.fusedObjects.map(o => ({ ...o, evidence: 'tentative', hazardLevel: 'unknown' })) };
      const conditioned: ConditionedWalkingInput = { context: ctx, snapshot, thresholds, linked,
        walking: true, sensorRequired: true, boardZone: 'normal', now };
      let evidence = normalizeWalkingEvidence(conditioned);
      const duplicateOnly = mode === 24 && !!previousInput;
      if (duplicateOnly) evidence = { ...previousInput!, now };
      summary.eventCounts[kind] = (summary.eventCounts[kind] ?? 0) + 1;
      const serializedPrevious = JSON.stringify(previous);
      const next = advanceWalkingGuidance(evidence, previous);
      const roundTrippedPrevious: WalkingGuidance | undefined = previous ? JSON.parse(serializedPrevious) : undefined;
      check(next, advanceWalkingGuidance(evidence, roundTrippedPrevious), 'JSON state replay is deterministic');
      check(JSON.parse(JSON.stringify(next)), next, 'output state contains JSON-safe finite values');
      check(JSON.stringify(previous), serializedPrevious, 'previous state is immutable');
      if (!duplicateOnly) check(next, evaluateWalkingGuidance({ ...conditioned, previous }), 'runtime adapter uses the same decision reducer');
      const noClockRegression = !previous || evidence.now >= previous.evaluatedAt;
      const raw = evidence.range;
      const measurementUsable = !!raw && raw.state === 'measured' && Number.isFinite(raw.measuredAt)
        && raw.measuredAt <= evidence.now && evidence.now - raw.measuredAt <= 1500
        && raw.measuredAt >= (previous?.temporal.evidenceNotBefore ?? -Infinity) && noClockRegression
        && typeof raw.distanceCm === 'number' && Number.isFinite(raw.distanceCm) && raw.distanceCm >= 2 && raw.distanceCm <= 450;
      if (measurementUsable && raw!.distanceCm! < evidence.thresholds.dangerCm && validThresholds(evidence.thresholds)) {
        check(next.routeHold, true, 'fresh valid raw danger immediately holds the route regardless of pose/camera');
        check(next.severity, 'danger', 'fresh valid raw danger immediately escalates');
        summary.rawDangerChecks++;
      }
      if (previous?.routeHold && raw?.state === 'no_return') {
        check(next.routeHold, true, 'no echo cannot resolve a prior obstruction'); summary.heldNoReturnChecks++;
      }
      if (previous?.routeHold && duplicateOnly) {
        check(next.routeHold, true, 'duplicate-only timer ticks cannot establish new release proof'); summary.duplicateTickChecks++;
      }
      if (previous?.routeHold && poseInvalidByConstruction && !duplicateOnly) {
        check(next.routeHold, true, 'invalid current pose cannot resolve an obstruction');
        check(next.directionsReliable, false, 'invalid current pose cannot establish image direction'); summary.invalidPoseHoldChecks++;
      }
      if (previous?.routeHold && !next.routeHold) {
        summary.releaseChecks++;
        check(measurementUsable, true, 'release has a fresh actual range measurement');
        check(poseUsable(evidence.pose, now), true, 'release has usable current pose');
        check(poseUsable(evidence.camera?.pose ?? null, now), true, 'release has usable captured pose');
        check(!!evidence.camera && evidence.camera.capturedAt <= now && now - evidence.camera.capturedAt <= 1500, true, 'release has a fresh camera frame');
      }
      if (!measurementUsable) check(next.frontDistanceCm, null, 'camera objects never manufacture range');
      if (next.inspectionCandidates.length) {
        check(next.routeHold, true, 'inspection candidates are offered only while route is held');
        check(next.directionsReliable, true, 'inspection candidates have usable image direction');
      }
      previous = next;
      previousInput = evidence;
      if (snapshot) lastSnapshot = snapshot;
    }
    // These controls ensure adversarial categories and successful recovery were actually exercised.
    expect(summary.rawDangerChecks).toBeGreaterThan(100);
    expect(summary.heldNoReturnChecks).toBeGreaterThan(100);
    expect(summary.duplicateTickChecks).toBeGreaterThan(100);
    expect(summary.invalidPoseHoldChecks).toBeGreaterThan(400);
    expect(summary.releaseChecks).toBeGreaterThan(10);
    summaries.push(summary);
  });
});

afterAll(() => {
  if (process.env.AISS_WRITE_ALGORITHM_SUMMARY !== '1') return;
  const output = resolve('validation/algorithm-adversarial-summary.json');
  mkdirSync(resolve('validation'), { recursive: true });
  writeFileSync(output, JSON.stringify({ schemaVersion: 1, status: summaries.length === seeds.length ? 'passed' : 'incomplete',
    kind: 'Seeded synthetic evidence fault injection; not field validation or camera ground truth',
    command: 'AISS_WRITE_ALGORITHM_SUMMARY=1 npx vitest run tests/walkingAdversarialReplay.test.ts',
    seeds: summaries, events: summaries.reduce((n, s) => n + s.events, 0), checks: summaries.reduce((n, s) => n + s.checks, 0),
    invariants: ['Immediate fresh raw-danger hold', 'No hold release from no-return readings', 'No release from duplicate-only timer ticks',
      'No directional certainty or release with unusable pose', 'Fresh independent range and camera evidence on release',
      'No free-space certification by fusion', 'No metric camera distance', 'Deterministic JSON state replay', 'Immutable previous state'],
  }, null, 2) + '\n');
});
