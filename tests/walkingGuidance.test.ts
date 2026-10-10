import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emptyWalkingGuidance, evaluateWalkingGuidance, routeManeuverAllowed,
  useWalkingGuidance, type WalkingGuidance,
} from '../src/core/guidance/guidanceState';
import { THRESHOLDS, type SensorContext } from '../src/core/vision/sensorConditioning';
import { VISION_OBSERVATION_STALE_MS, type DetectionSnapshot, type FusedObject, type SpatialSide } from '../src/core/vision/types';

const now = 10_000;
const thresholds = { awarenessCm: 150, warningCm: 100, dangerCm: 50 };
const context = (distanceCm: number | null = 200, overrides: Partial<SensorContext> = {}): SensorContext => ({
  timestamp: now,
  ultrasonic: { value: distanceCm, state: 'valid', ageMs: 0 },
  accel: { value: { x: 0, y: 0, z: 1, mag: 1 }, state: 'valid', ageMs: 0 },
  gyro: { value: { x: 0, y: 0, z: 0, mag: 0 }, state: 'valid', ageMs: 0 },
  orientation: { value: { pitch: 0, roll: 0 }, state: 'valid', ageMs: 0 },
  motion: 'WALKING', quality: 'good', ...overrides,
});
const object = (occupiedSides: SpatialSide[], overrides: Partial<FusedObject> = {}): FusedObject => ({
  track: { trackId: 1, label: 'chair', currentBox: { x: 0.05, y: 0.7, w: 0.2, h: 0.2 },
    previousBox: null, velocity: { x: 0, y: 0 }, ageFrames: 3, hits: 3, misses: 0,
    lastSeenMs: now, state: 'CONFIRMED', confidence: 0.9 },
  label: 'chair', visualConfidence: 0.9, ultrasonicDistanceCm: null,
  side: occupiedSides[0], occupiedSides, evidence: 'confirmed', depth: 'NEAR',
  quality: 'good', freshnessMs: 0, hazardLevel: 'warning', ...overrides,
});
const scene = (objects: FusedObject[] = [], frameTimestamp: number | null = now, frameSensorContext?: SensorContext): DetectionSnapshot => ({
  timestamp: now, frameTimestamp, processingLatencyMs: 40, sensorContext: context(),
  ...(frameSensorContext ? { frameSensorContext } : {}),
  objects: [], tracks: objects.map(o => o.track), fusedObjects: objects,
  pathState: { left: 'UNKNOWN', center: 'UNKNOWN', right: 'UNKNOWN' }, overallQuality: 'good',
});
type Input = Parameters<typeof evaluateWalkingGuidance>[0];
const evaluate = (overrides: Partial<Input> = {}) => evaluateWalkingGuidance({
  context: context(), snapshot: null, thresholds, linked: true, walking: true,
  sensorRequired: true, now, ...overrides,
});
const previousHold = (): WalkingGuidance => evaluate({ context: context(20) });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  useWalkingGuidance.setState(emptyWalkingGuidance());
});
afterEach(() => vi.useRealTimers());

describe('walking guidance preserves separate local obstacle evidence', () => {
  it('stops for a sudden raw 20 cm obstacle before any camera inference finishes', () => {
    expect(evaluate({ context: context(20), snapshot: null })).toMatchObject({
      severity: 'danger', plan: 'STOP_AND_SCAN', frontDistanceCm: 20,
      routeHold: true, observedObjects: [], inspectionCandidates: [],
    });
  });

  it('retains stronger independently confirmed board warning at its hysteresis boundary', () => {
    expect(evaluate({ context: context(120), boardZone: 'warning' }).severity).toBe('warning');
    expect(evaluate({ context: context(70), boardZone: 'danger' }).severity).toBe('danger');
    expect(evaluate({ context: context(null), boardZone: 'danger' })).toMatchObject({
      severity: 'danger', frontDistanceCm: null, routeHold: true,
    });
  });

  it('issues conservative look-ahead beyond awareness only from a confident measured-range trend', () => {
    const approach: NonNullable<SensorContext['ultrasonicApproach']> = {
      trend: 'APPROACHING', closingSpeedCmS: 100, timeToWarningMs: 1000,
      warningDistanceCm: 100, confidence: 'good', sampleCount: 3, spanMs: 1000, resetReason: null,
    };
    expect(evaluate({ context: context(200, { ultrasonicApproach: approach }) })).toMatchObject({
      severity: 'awareness', plan: 'SLOW_AND_CHECK', approaching: true,
      frontDistanceCm: 200, routeHold: false, timeToWarningMs: 1000,
    });
    expect(evaluate({ context: context(200, { ultrasonicApproach: { ...approach, confidence: 'degraded' } }) }).severity).toBe('none');
    expect(evaluate({ context: context(15_000, { ultrasonicApproach: approach }) }).approaching).toBe(false);
  });

  it('treats a left observation and unknown right side as a stopped inspection candidate only', () => {
    const result = evaluate({ context: context(70), snapshot: scene([object(['LEFT'])]) });
    expect(result).toMatchObject({ severity: 'warning', routeHold: true, plan: 'STOP_AND_SCAN', inspectionCandidates: ['RIGHT'] });
    expect(result.observedObjects).toEqual([{ label: 'chair', side: 'LEFT', occupiedSides: ['LEFT'] }]);
    useWalkingGuidance.setState(result);
    expect(routeManeuverAllowed()).toBe(false);
    expect(JSON.stringify(result)).not.toContain('FREE');
  });

  it('does not suggest either side when a broad obstacle overlaps all image bands', () => {
    const result = evaluate({ context: context(70), snapshot: scene([object(['LEFT', 'CENTER', 'RIGHT'])]) });
    expect(result.inspectionCandidates).toEqual([]);
    expect(result.routeHold).toBe(true);
  });

  it.each(['SWINGING', 'RAPID_MOTION', 'UNKNOWN'] as const)('withholds directional inspection during %s while retaining the raw warning', (motion) => {
    const result = evaluate({ context: context(70, { motion }), snapshot: scene([object(['LEFT'])]) });
    expect(result).toMatchObject({ severity: 'warning', routeHold: true, directionsReliable: false, inspectionCandidates: [] });
  });

  it.each(['orientation', 'gyro'] as const)('withholds directional inspection when current %s pose evidence has become stale', (field) => {
    const ctx = context(70);
    ctx[field] = { ...ctx[field], state: 'stale', ageMs: THRESHOLDS.IMU_STALE_MS + 1 };
    expect(evaluate({ context: ctx, snapshot: scene([object(['LEFT'])]) })).toMatchObject({
      severity: 'warning', directionsReliable: false, inspectionCandidates: [], routeHold: true,
    });
  });

  it('does not use a later stable pose to certify image direction during a capture-time sweep', () => {
    const capturedWhileSweeping = context(70, { motion: 'SWINGING' });
    expect(evaluate({ context: context(70), snapshot: scene([object(['LEFT'])], now, capturedWhileSweeping) })).toMatchObject({
      severity: 'warning', directionsReliable: false, inspectionCandidates: [],
    });
  });

  it('withholds directional inspection for stale capture-time orientation even with a fresh current pose', () => {
    const capturedWithStaleOrientation = context(70, {
      orientation: { value: { pitch: 0, roll: 0 }, state: 'stale', ageMs: THRESHOLDS.IMU_STALE_MS + 1 },
    });
    expect(evaluate({ context: context(70), snapshot: scene([object(['LEFT'])], now, capturedWithStaleOrientation) })).toMatchObject({
      severity: 'warning', directionsReliable: false, inspectionCandidates: [],
    });
  });

  it('does not assign distance or declare safety from a central camera observation alone', () => {
    const result = evaluate({ context: context(null), snapshot: scene([object(['CENTER'])]) });
    expect(result).toMatchObject({ severity: 'warning', frontDistanceCm: null, routeHold: true });
    expect(result.observedObjects[0].occupiedSides).toEqual(['CENTER']);
  });
});

describe('route hold and data freshness', () => {
  it('does not clear an earlier obstacle hold from a no-echo measurement', () => {
    expect(evaluate({ context: context(null), snapshot: scene(), previous: previousHold() })).toMatchObject({
      routeHold: true, plan: 'STOP_AND_SCAN', frontDistanceCm: null,
    });
  });

  it('does not clear a hold from stale ultrasonic data, even with an apparently newer clear scene', () => {
    const stale = context(250, { ultrasonic: { value: 250, state: 'stale', ageMs: 1600 } });
    expect(evaluate({ context: stale, snapshot: scene(), previous: previousHold() })).toMatchObject({
      routeHold: true, severity: 'unavailable', plan: 'SENSING_UNAVAILABLE', frontDistanceCm: null,
    });
  });

  it.each([null, now - VISION_OBSERVATION_STALE_MS - 1, now + 1])('does not clear a hold from missing, stale, or future frames (%s)', (frameTimestamp) => {
    expect(evaluate({ context: context(250), snapshot: scene([], frameTimestamp), previous: previousHold() }).routeHold).toBe(true);
  });

  it.each(['lost', 'stale', 'tentative', 'invalid'] as const)('does not clear a visual hold while central obstacle evidence is unresolved (%s)', (evidence) => {
    const old = evaluate({ context: context(null), snapshot: scene([object(['CENTER'])]) });
    const unconfirmed = object(['CENTER'], { evidence, hazardLevel: 'unknown' });
    expect(evaluate({ context: context(250), snapshot: scene([unconfirmed]), previous: old }).routeHold).toBe(true);
  });

  it('releases map hold only after both fresh greater forward range and a fresh resolved scene', () => {
    const previous = previousHold();
    expect(evaluate({ context: context(250), snapshot: null, previous }).routeHold).toBe(true);
    expect(evaluate({ context: context(null), snapshot: scene(), previous }).routeHold).toBe(true);
    expect(evaluate({ context: context(20), snapshot: scene(), previous }).routeHold).toBe(true);
    const resolved = evaluate({ context: context(250), snapshot: scene(), previous });
    expect(resolved).toMatchObject({ routeHold: false, severity: 'none', plan: 'OBSERVE' });
    expect(JSON.stringify(resolved)).not.toContain('FREE');
  });

  it('expires required-sensor route permission at actual measurement freshness without waiting for a timer', () => {
    const result = evaluate({ context: context(250, {
      timestamp: now - 200, ultrasonic: { value: 250, state: 'valid', ageMs: 100 },
    }), snapshot: scene() });
    expect(result.validUntil).toBe(now + THRESHOLDS.US_STALE_MS - 300);
    useWalkingGuidance.setState(result);
    expect(routeManeuverAllowed()).toBe(true);
    vi.setSystemTime(result.validUntil + 1);
    expect(routeManeuverAllowed()).toBe(false);
  });

  it('holds required sensing immediately on link loss regardless of cached distance or scene', () => {
    const result = evaluate({ linked: false, snapshot: scene() });
    expect(result).toMatchObject({ severity: 'unavailable', routeHold: true, plan: 'SENSING_UNAVAILABLE' });
  });
});
