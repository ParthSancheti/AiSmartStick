import { describe, expect, it } from 'vitest';
import { advanceWalkingGuidance, emptyWalkingGuidance, walkingRouteManeuverAllowed,
  WALKING_GUIDANCE_POLICY, type WalkingCoreInput, type WalkingGuidance,
  type WalkingPoseEvidence, type WalkingVisualObject } from '../src/core/perception/walkingCore';
import { evaluateWalkingGuidance, normalizeWalkingEvidence } from '../src/core/perception/walkingEvidence';
import type { SensorContext } from '../src/core/vision/sensorConditioning';

const thresholds = { dangerCm: 50, warningCm: 100, awarenessCm: 150 };
const pose = (at: number, overrides: Partial<WalkingPoseEvidence> = {}): WalkingPoseEvidence => ({
  sampledAt: at, orientationAt: at, angularRateAt: at, valid: true,
  motion: 'WALKING', pitchDegrees: 0, rollDegrees: 0, angularRateDegreesPerSecond: 0, ...overrides,
});
const frame = (at: number, objects: WalkingVisualObject[] = [], overrides: Partial<WalkingCoreInput['camera']> = {}) => ({
  capturedAt: at, completedAt: at, valid: true, pose: pose(at), objects, ...overrides,
});
const input = (at = 10_000, cm = 250, overrides: Partial<WalkingCoreInput> = {}): WalkingCoreInput => ({
  now: at, thresholds, range: { state: 'measured', measuredAt: at, distanceCm: cm }, pose: pose(at),
  camera: frame(at), walking: true, sensorRequired: true, ...overrides,
});
const object = (at: number, overrides: Partial<WalkingVisualObject> = {}): WalkingVisualObject => ({
  label: 'person', side: 'CENTER', occupiedSides: ['CENTER'], observedAt: at,
  confirmed: true, valid: true, hazard: 'warning', ...overrides,
});
const hold = () => advanceWalkingGuidance(input(10_000, 20));
const step = (previous: WalkingGuidance, at: number, cm = 250, overrides: Partial<WalkingCoreInput> = {}) => advanceWalkingGuidance(input(at, cm, overrides), previous);
const confirmedRelease = (previous = hold()) => [10_200, 10_600, 11_000].reduce((s, at) => step(s, at), previous);

describe('device independent walking decision reducer', () => {
  it('is deterministic, does not mutate caller evidence/state, and survives JSON state replay', () => {
    const evidence = input();
    const original = JSON.stringify(evidence);
    const old = emptyWalkingGuidance();
    expect(advanceWalkingGuidance(evidence, old)).toEqual(advanceWalkingGuidance(evidence, old));
    expect(JSON.stringify(evidence)).toBe(original);
    expect(old).toEqual(emptyWalkingGuidance());
    const s = step(hold(), 10_200);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    expect(step(JSON.parse(JSON.stringify(s)), 10_600)).toEqual(step(s, 10_600));
  });

  it('emits immediate raw hazard and declarative hold effects without any camera or pose', () => {
    const s = advanceWalkingGuidance(input(10_000, 20, { pose: null, camera: null }));
    expect(s).toMatchObject({ severity: 'danger', routeHold: true, holdReason: 'obstacle', frontDistanceCm: 20 });
    expect(s.effects).toEqual([{ type: 'HOLD_ROUTE', reason: 'obstacle' }, { type: 'ESCALATE_ALERT', severity: 'danger' }]);
    expect(step(s, 10_100, 30).effects).toEqual([]);
  });

  it('does not release from one distant sample and empty frame, then releases after distinct sustained evidence', () => {
    const first = step(hold(), 10_200);
    expect(first).toMatchObject({ routeHold: true, holdReason: 'release_confirmation' });
    expect(first.temporal.release).toMatchObject({ rangeSamples: 1, sceneFrames: 1 });
    const second = step(first, 10_600);
    expect(second.routeHold).toBe(true);
    const released = step(second, 11_000);
    expect(released).toMatchObject({ severity: 'none', routeHold: false, holdReason: null, plan: 'OBSERVE' });
    expect(released.effects).toEqual([{ type: 'RELEASE_ROUTE' }]);
    expect(JSON.stringify(released)).not.toMatch(/FREE|clearance|safePath/);
  });

  it('counts a telemetry sample only once even when camera callbacks and freshness ticks reuse it', () => {
    let s = hold();
    for (const at of [10_200, 10_600, 11_000]) {
      s = step(s, at, 250, { range: { state: 'measured', measuredAt: 10_200, distanceCm: 250 } });
    }
    expect(s).toMatchObject({ routeHold: true, temporal: { release: { rangeSamples: 1, sceneFrames: 3 } } });
  });

  it('counts an empty frame only once even across distinct ranges and elapsed wall time', () => {
    let s = hold();
    for (const at of [10_200, 10_600, 11_000]) s = step(s, at, 250, { camera: frame(10_200) });
    expect(s).toMatchObject({ routeHold: true, temporal: { release: { rangeSamples: 3, sceneFrames: 1 } } });
  });

  it('cannot manufacture confirmation time by rerunning unchanged evidence on a timer', () => {
    let s = step(hold(), 10_200);
    const repeated = input(10_200);
    for (const at of [10_600, 11_000, 11_500]) s = advanceWalkingGuidance({ ...repeated, now: at }, s);
    expect(s).toMatchObject({ routeHold: true, temporal: { release: { rangeSamples: 1, sceneFrames: 1 } } });
  });

  it('requires sustained measurement duration even with many distinct rapid camera frames', () => {
    let s = hold();
    for (let at = 10_001; at < 10_100; at++) s = step(s, at);
    expect(s.routeHold).toBe(true);
    expect(s.temporal.release.rangeSamples).toBeGreaterThan(WALKING_GUIDANCE_POLICY.releaseRangeSamples);
    expect(step(s, 10_800).routeHold).toBe(false);
  });

  it('uses a release margin to prevent boundary jitter from resolving a hazard hold', () => {
    let s = hold();
    for (const at of [10_200, 10_600, 11_000]) s = step(s, at, 109);
    expect(s.routeHold).toBe(true);
    expect(s.temporal.release.rangeSamples).toBe(0);
    s = step(s, 11_200, 110);
    s = step(s, 11_600, 110);
    expect(step(s, 12_000, 110).routeHold).toBe(false);
  });

  it('resets partial release proof after a new obstacle, a missing frame, or invalid range', () => {
    for (const broken of [input(10_600, 20), input(10_600, 250, { camera: null }), input(10_600, 250, { range: null })]) {
      let s = advanceWalkingGuidance(broken, step(hold(), 10_200));
      expect(s.temporal.release.rangeSamples).toBe(0);
      s = step(s, 11_000);
      expect(step(s, 11_400).routeHold).toBe(true);
      expect(step(step(s, 11_400), 11_800).routeHold).toBe(false);
    }
  });

  it('starts release proof again after a long processing gap even when the next evidence is fresh', () => {
    let s = step(hold(), 10_200);
    s = step(s, 13_000);
    expect(s).toMatchObject({ routeHold: true, temporal: { release: { rangeSamples: 1, sceneFrames: 1, since: 13_000 } } });
    expect(step(s, 13_400).routeHold).toBe(true);
    expect(step(step(s, 13_400), 13_800).routeHold).toBe(false);
  });

  it('distinguishes fresh no-return from an unavailable receiver without inventing clearance', () => {
    const noReturn = input(10_200, 250, { range: { state: 'no_return', measuredAt: 10_200, distanceCm: null } });
    expect(advanceWalkingGuidance(noReturn)).toMatchObject({ routeHold: false, frontDistanceCm: null, severity: 'none' });
    expect(advanceWalkingGuidance(noReturn).reasonCodes).toContain('range_no_return');
    expect(advanceWalkingGuidance(noReturn, hold()).routeHold).toBe(true);
    expect(advanceWalkingGuidance({ ...noReturn, range: { ...noReturn.range!, state: 'invalid' } })).toMatchObject({ routeHold: true, holdReason: 'sensing' });
  });

  it.each([
    { motion: 'SWINGING' as const }, { motion: 'RAPID_MOTION' as const }, { motion: 'UNKNOWN' as const },
    { pitchDegrees: 90 }, { rollDegrees: 90 }, { pitchDegrees: NaN }, { rollDegrees: null },
    { angularRateDegreesPerSecond: 150 }, { angularRateDegreesPerSecond: -1 }, { valid: false },
  ])('never resolves a prior hazard or suggests sides with unusable current pose %j', (bad) => {
    let s = hold();
    for (const at of [10_200, 10_600, 11_000]) s = step(s, at, 250, { pose: pose(at, bad) });
    expect(s).toMatchObject({ routeHold: true, directionsReliable: false, inspectionCandidates: [] });
    expect(step(s, 11_100, 20, { pose: pose(11_100, bad) }).severity).toBe('danger');
  });

  it('rejects a tilted capture and a changed pose even if current motion and capture motion say stable', () => {
    const tilted = step(hold(), 10_200, 250, { camera: frame(10_200, [], { pose: pose(10_200, { pitchDegrees: 90, motion: 'STABLE' }) }) });
    expect(tilted).toMatchObject({ directionsReliable: false, routeHold: true });
    expect(tilted.reasonCodes).toContain('capture_pose_tilted');
    const changed = step(hold(), 10_200, 250, { pose: pose(10_200, { rollDegrees: 20, motion: 'STABLE' }) });
    expect(changed).toMatchObject({ directionsReliable: false, routeHold: true });
    expect(changed.reasonCodes).toContain('pose_changed');
  });

  it('withholds direction when capture pose time is too far from the camera frame', () => {
    const s = step(hold(), 10_600, 250, { camera: frame(10_600, [], { pose: pose(10_000) }) });
    expect(s).toMatchObject({ routeHold: true, directionsReliable: false });
    expect(s.reasonCodes).toContain('capture_pose_mismatch');
  });

  it('keeps a qualitative center-camera stop when pose is unavailable without claiming image direction', () => {
    const s = advanceWalkingGuidance(input(10_000, 250, { pose: null, camera: frame(10_000, [object(10_000)], { pose: null }) }));
    expect(s).toMatchObject({ severity: 'warning', routeHold: true, frontDistanceCm: 250, directionsReliable: false, inspectionCandidates: [] });
  });

  it('does not choose an inspection side already containing tentative or lost evidence', () => {
    const s = advanceWalkingGuidance(input(10_000, 70, { camera: frame(10_000, [
      object(10_000, { side: 'LEFT', occupiedSides: ['LEFT'] }),
      object(10_000, { side: 'RIGHT', occupiedSides: ['RIGHT'], confirmed: false, hazard: 'unknown' }),
    ]) }));
    expect(s.inspectionCandidates).toEqual([]);
  });

  it('does not resolve an uncertain center track or a confirmed expanding image to a map turn', () => {
    for (const o of [object(10_200, { confirmed: false, hazard: 'unknown' }),
      object(10_200, { hazard: 'awareness', imageMotion: { trend: 'EXPANDING', samples: 3, spanMs: 500 } })]) {
      const s = step(hold(), 10_200, 250, { camera: frame(10_200, [o]) });
      expect(s.routeHold).toBe(true);
      expect(s.temporal.release.rangeSamples).toBe(0);
    }
  });

  it('does not treat a malformed object outside the center band as a resolved camera scene', () => {
    const s = step(hold(), 10_200, 250, { camera: frame(10_200, [object(10_200,
      { valid: false, confirmed: false, side: 'LEFT', occupiedSides: [], hazard: 'unknown' })]) });
    expect(s).toMatchObject({ routeHold: true, temporal: { release: { rangeSamples: 0, sceneFrames: 0 } } });
    expect(s.reasonCodes).toContain('invalid_visual_evidence');
  });

  it('rejects backward evidence within the freshness window and cannot reuse partial confirmation', () => {
    let s = step(hold(), 10_600);
    s = step(s, 10_800, 250, { camera: frame(10_400) });
    expect(s.routeHold).toBe(true);
    expect(s.reasonCodes).toContain('evidence_out_of_order');
    expect(s.directionsReliable).toBe(false);
    expect(s.temporal.release.sceneFrames).toBe(0);
  });

  it('fails closed on a backward clock and requires fresh corroboration after the earlier clock instant', () => {
    const previous = advanceWalkingGuidance(input(10_000));
    let s = step(previous, 9000);
    expect(s).toMatchObject({ routeHold: true, holdReason: 'clock', frontDistanceCm: null });
    s = step(s, 9500);
    expect(s.routeHold).toBe(true);
    expect(s.frontDistanceCm).toBeNull();
    for (const at of [10_200, 10_600, 11_000]) s = step(s, at);
    expect(s.routeHold).toBe(false);
  });

  it('does not reuse a pre-correction pose even after fresh ranges and camera clocks recover', () => {
    let s = step(advanceWalkingGuidance(input(10_000)), 9000);
    for (const at of [10_010, 10_410, 10_810]) s = step(s, at, 250, {
      pose: pose(at, { orientationAt: 9990, angularRateAt: 9990 }),
      camera: frame(at, [], { pose: pose(at, { orientationAt: 9990, angularRateAt: 9990 }) }),
    });
    expect(s).toMatchObject({ routeHold: true, directionsReliable: false });
    expect(s.reasonCodes).toContain('pose_clock_invalid');
  });

  it.each([NaN, Infinity, -1])('fails closed for invalid evaluation time %s', (now) => {
    expect(advanceWalkingGuidance({ ...input(), now })).toMatchObject({ routeHold: true, holdReason: 'clock', frontDistanceCm: null });
  });

  it('rejects a negative range timestamp even if it falls within the numeric freshness budget', () => {
    const s = advanceWalkingGuidance(input(0, 250, {
      range: { state: 'measured', measuredAt: -1, distanceCm: 250 },
    }));
    expect(s).toMatchObject({ frontDistanceCm: null, routeHold: true, holdReason: 'sensing' });
    expect(walkingRouteManeuverAllowed(s, 0)).toBe(false);
  });

  it('rejects negative camera and pose evidence timestamps near the caller clock origin', () => {
    const camera = advanceWalkingGuidance(input(0, 70, { camera: frame(-1) }));
    expect(camera).toMatchObject({ directionsReliable: false, inspectionCandidates: [] });
    expect(camera.reasonCodes).toContain('camera_stale_or_clock_invalid');
    for (const field of ['sampledAt', 'orientationAt', 'angularRateAt'] as const) {
      const s = advanceWalkingGuidance(input(0, 70, { pose: pose(0, { [field]: -1 }) }));
      expect(s).toMatchObject({ directionsReliable: false, inspectionCandidates: [] });
      expect(s.reasonCodes).toContain('pose_stale');
    }
  });

  it.each([
    { dangerCm: 100, warningCm: 50, awarenessCm: 150 },
    { dangerCm: NaN, warningCm: 100, awarenessCm: 150 },
    { dangerCm: 50, warningCm: 100, awarenessCm: Infinity },
  ])('fails closed for invalid threshold configuration %j', (bad) => {
    expect(advanceWalkingGuidance(input(10_000, 250, { thresholds: bad }))).toMatchObject({ routeHold: true, holdReason: 'configuration' });
  });

  it('expires route cue permission at sample freshness, independently of a timer', () => {
    const s = advanceWalkingGuidance(input());
    expect(walkingRouteManeuverAllowed(s, s.validUntil)).toBe(true);
    expect(walkingRouteManeuverAllowed(s, s.validUntil + 1)).toBe(false);
    expect(walkingRouteManeuverAllowed(s, s.evaluatedAt - 1)).toBe(false);
    expect(walkingRouteManeuverAllowed(confirmedRelease(), 11_001)).toBe(true);
  });
});

describe('conditioned evidence adapter uses the same pure reducer', () => {
  const context = (): SensorContext => ({ timestamp: 10_000, ultrasonic: { state: 'valid', value: 200, ageMs: 200 },
    ultrasonicApproach: { trend: 'APPROACHING', closingSpeedCmS: 100, timeToWarningMs: 800, warningDistanceCm: 100,
      confidence: 'good', sampleCount: 3, spanMs: 1000, resetReason: null },
    accel: { state: 'valid', value: { x: 0, y: 0, z: 1, mag: 1 }, ageMs: 0 },
    gyro: { state: 'valid', value: { x: 0, y: 0, z: 0, mag: 0 }, ageMs: 0 },
    orientation: { state: 'valid', value: { pitch: 0, roll: 0 }, ageMs: 0 }, motion: 'WALKING', quality: 'good' });
  const base = () => ({ context: context(), snapshot: null, thresholds, linked: true, walking: true, sensorRequired: true, now: 10_100 });
  it('subtracts the elapsed prediction age exactly once', () => {
    const evidence = base();
    const result = evaluateWalkingGuidance(evidence);
    expect(result).toMatchObject({ approaching: true, timeToWarningMs: 700 });
    expect(result).toEqual(advanceWalkingGuidance(normalizeWalkingEvidence(evidence)));
  });
  it('rejects a future context even if its purported measurement time is in the past', () => {
    const evidence = base();
    evidence.context.timestamp = 10_200;
    expect(evaluateWalkingGuidance(evidence)).toMatchObject({ frontDistanceCm: null, routeHold: true });
  });
});
