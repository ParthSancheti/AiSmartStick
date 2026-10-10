import { describe, expect, it } from 'vitest';
import { fuseSensors } from '../src/core/vision/fusionEngine';
import { ObjectTracker } from '../src/core/vision/objectTracker';
import { getOccupiedSides } from '../src/core/vision/spatial';
import { VISION_OBSERVATION_STALE_MS, type BoundingBox, type ObjectObservation, type ObjectTrack } from '../src/core/vision/types';
import type { SensorContext } from '../src/core/vision/sensorConditioning';

const now = 10_000;
const ctx = (ultrasonic: Partial<SensorContext['ultrasonic']> = {}): SensorContext => ({
  timestamp: now,
  ultrasonic: { value: null, state: 'valid', ageMs: 0, ...ultrasonic },
  accel: { value: null, state: 'valid', ageMs: 0 },
  gyro: { value: null, state: 'valid', ageMs: 0 },
  orientation: { value: null, state: 'valid', ageMs: 0 },
  motion: 'STABLE', quality: 'good',
});
const box = (x: number, w = 0.2): BoundingBox => ({ x, y: 0.8, w, h: 0.1 });
const track = (currentBox = box(0.4), overrides: Partial<ObjectTrack> = {}): ObjectTrack => ({
  trackId: 1, label: 'person', currentBox, previousBox: null, velocity: { x: 0, y: 0 },
  ageFrames: 2, hits: 2, misses: 0, lastSeenMs: now, state: 'CONFIRMED', confidence: 0.9,
  ...overrides,
});
const observation = (currentBox = box(0.4)): ObjectObservation => ({
  label: 'person', confidence: 0.9, box: currentBox,
  centerX: currentBox.x + currentBox.w / 2, centerY: currentBox.y + currentBox.h / 2,
  bottomCenterX: currentBox.x + currentBox.w / 2, bottomCenterY: currentBox.y + currentBox.h,
  timestamp: now,
});

describe('honest directional obstacle evidence', () => {
  it('keeps all undetected directions unknown even with healthy sensors and no echo', () => {
    expect(fuseSensors([], ctx(), now).pathState).toEqual({ left: 'UNKNOWN', center: 'UNKNOWN', right: 'UNKNOWN' });
    expect(fuseSensors([], ctx({ value: 300 }), now).pathState).toEqual({ left: 'UNKNOWN', center: 'UNKNOWN', right: 'UNKNOWN' });
  });

  it.each([
    { box: box(0.05), sides: ['LEFT'], path: { left: 'BLOCKED', center: 'UNKNOWN', right: 'UNKNOWN' } },
    { box: box(0.4), sides: ['CENTER'], path: { left: 'UNKNOWN', center: 'BLOCKED', right: 'UNKNOWN' } },
    { box: box(0.75), sides: ['RIGHT'], path: { left: 'UNKNOWN', center: 'UNKNOWN', right: 'BLOCKED' } },
    { box: box(0.2, 0.3), sides: ['LEFT', 'CENTER'], path: { left: 'BLOCKED', center: 'BLOCKED', right: 'UNKNOWN' } },
    { box: box(0.55, 0.4), sides: ['CENTER', 'RIGHT'], path: { left: 'UNKNOWN', center: 'BLOCKED', right: 'BLOCKED' } },
    { box: box(0.05, 0.9), sides: ['LEFT', 'CENTER', 'RIGHT'], path: { left: 'BLOCKED', center: 'BLOCKED', right: 'BLOCKED' } },
  ])('accounts for every overlapping image band: $sides', ({ box, sides, path }) => {
    const fused = fuseSensors([track(box)], ctx(), now);
    expect(fused.fusedObjects[0].occupiedSides).toEqual(sides);
    expect(fused.pathState).toEqual(path);
    expect(fused.fusedObjects[0].evidence).toBe('confirmed');
  });

  it('does not count a box merely touching an image band boundary as occupying it', () => {
    expect(getOccupiedSides(box(0, 0.35))).toEqual(['LEFT']);
    expect(getOccupiedSides(box(0.35, 0.3))).toEqual(['CENTER']);
    expect(getOccupiedSides(box(0.65, 0.35))).toEqual(['RIGHT']);
  });

  it('retains independent front sonar obstruction without claiming the range of a left object', () => {
    const fused = fuseSensors([track(box(0.05))], ctx({ value: 65 }), now);
    expect(fused.pathState).toEqual({ left: 'BLOCKED', center: 'BLOCKED', right: 'UNKNOWN' });
    expect(fused.fusedObjects[0].ultrasonicDistanceCm).toBeNull();
    expect(fused.fusedObjects[0].hazardLevel).toBe('warning');
  });

  it('does not assign a single front sonar measurement to any of several central objects', () => {
    const fused = fuseSensors([
      track(box(0.4)), track(box(0.3, 0.4), { trackId: 2 }),
    ], ctx({ value: 40 }), now);
    expect(fused.pathState.center).toBe('BLOCKED');
    expect(fused.fusedObjects.every((object) => object.ultrasonicDistanceCm === null)).toBe(true);
    expect(fused.fusedObjects.every((object) => object.hazardLevel !== 'danger')).toBe(true);
  });

  it.each(['stale', 'invalid', 'unknown'] as const)('does not turn %s sonar data into obstruction evidence', (state) => {
    expect(fuseSensors([], ctx({ state, value: 40 }), now).pathState.center).toBe('UNKNOWN');
  });

  it.each([
    { overrides: { state: 'TENTATIVE' as const, hits: 1 }, evidence: 'tentative' },
    { overrides: { state: 'LOST' as const, misses: 3 }, evidence: 'lost' },
    { overrides: { misses: 1 }, evidence: 'lost' },
    { overrides: { lastSeenMs: now - VISION_OBSERVATION_STALE_MS - 1 }, evidence: 'stale' },
    { overrides: { lastSeenMs: now + 1 }, evidence: 'invalid' },
    { overrides: { currentBox: box(NaN) }, evidence: 'invalid' },
  ])('keeps $evidence observations from becoming current obstacle or clearance claims', ({ overrides, evidence }) => {
    const fused = fuseSensors([track(box(0.4), overrides)], ctx(), now);
    expect(fused.fusedObjects[0].evidence).toBe(evidence);
    expect(fused.fusedObjects[0].hazardLevel).toBe('unknown');
    expect(fused.pathState).toEqual({ left: 'UNKNOWN', center: 'UNKNOWN', right: 'UNKNOWN' });
  });

  it('never labels a confirmed upper-image object safe or derives a physical distance from its box', () => {
    const fused = fuseSensors([track({ x: 0.4, y: 0.1, w: 0.2, h: 0.2 })], ctx(), now);
    expect(fused.fusedObjects[0].depth).toBe('FAR');
    expect(fused.fusedObjects[0].hazardLevel).toBe('awareness');
    expect(fused.fusedObjects[0].ultrasonicDistanceCm).toBeNull();
  });
});

describe('temporal tracking evidence', () => {
  it('cannot confirm a track by processing the same frame timestamp twice', () => {
    const tracker = new ObjectTracker();
    tracker.update([observation()], now);
    expect(tracker.update([observation()], now)[0]).toMatchObject({ state: 'TENTATIVE', hits: 1 });
    expect(tracker.update([observation()], now - 10)[0]).toMatchObject({ state: 'TENTATIVE', hits: 1 });
    expect(tracker.update([observation()], now + 100)[0]).toMatchObject({ state: 'CONFIRMED', hits: 2 });
  });

  it('requires fresh confirmation again after a frame gap exceeds the freshness budget', () => {
    const tracker = new ObjectTracker();
    tracker.update([observation()], now);
    const old = tracker.update([observation()], now + 100)[0];
    const resumed = tracker.update([observation()], now + 100 + VISION_OBSERVATION_STALE_MS + 1)[0];
    expect(resumed.trackId).not.toBe(old.trackId);
    expect(resumed).toMatchObject({ state: 'TENTATIVE', hits: 1, velocity: { x: 0, y: 0 } });
  });

  it('makes one missed observation unavailable to guidance even before the track becomes LOST', () => {
    const tracker = new ObjectTracker();
    tracker.update([observation()], now - 100);
    tracker.update([observation()], now);
    const missed = tracker.update([], now + 100);
    expect(missed[0].state).toBe('CONFIRMED');
    const fused = fuseSensors(missed, ctx(), now + 100);
    expect(fused.fusedObjects[0].evidence).toBe('lost');
    expect(fused.pathState.center).toBe('UNKNOWN');
  });

  it('leaves earlier published snapshots unchanged when tracks update or a caller mutates its copy', () => {
    const tracker = new ObjectTracker();
    const first = tracker.update([observation()], now);
    tracker.update([observation(box(0.45))], now + 100);
    expect(first[0]).toMatchObject({ state: 'TENTATIVE', hits: 1, currentBox: box(0.4) });
    first[0].currentBox.x = 0.99;
    first[0].velocity.x = 100;
    expect(tracker.getTracks()[0].currentBox.x).toBe(0.45);
    expect(tracker.getTracks()[0].velocity.x).toBeCloseTo(0.5);
  });

  it('clears an old velocity when the observation interval cannot support that calculation', () => {
    const tracker = new ObjectTracker();
    tracker.update([observation()], now);
    expect(tracker.update([observation(box(0.45))], now + 100)[0].velocity.x).toBeCloseTo(0.5);
    expect(tracker.update([observation(box(0.45))], now + 1200)[0].velocity).toEqual({ x: 0, y: 0 });
  });

  it('does not create tracks from nonfinite or degenerate boxes', () => {
    const tracker = new ObjectTracker();
    expect(tracker.update([
      observation(box(NaN)), observation(box(0.4, 0)), observation(box(2)),
    ], now)).toEqual([]);
  });
});
