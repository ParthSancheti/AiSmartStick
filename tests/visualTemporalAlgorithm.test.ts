import { describe, expect, it } from 'vitest';
import { ObjectTracker } from '../src/core/vision/objectTracker';
import { fuseSensors } from '../src/core/vision/fusionEngine';
import { measureImageMotion } from '../src/core/vision/imageMotion';
import { getOccupiedSides, getSpatialSide, getVisibleBoundingBox, isValidBoundingBox } from '../src/core/vision/spatial';
import type { BoundingBox, ObjectObservation, ObjectTrack } from '../src/core/vision/types';
import type { SensorContext } from '../src/core/vision/sensorConditioning';

const box = (x = 0.4, w = 0.2): BoundingBox => ({ x, y: 0.3, w, h: 0.3 });
const observation = (currentBox = box(), label = 'person', confidence = 0.9): ObjectObservation => ({
  label, confidence, box: currentBox, timestamp: 1000,
  centerX: currentBox.x + currentBox.w / 2, centerY: currentBox.y + currentBox.h / 2,
  bottomCenterX: currentBox.x + currentBox.w / 2, bottomCenterY: currentBox.y + currentBox.h,
});
const context = (now = 1000): SensorContext => ({
  timestamp: now,
  ultrasonic: { value: 50, state: 'valid', ageMs: 0 },
  accel: { value: null, state: 'unknown', ageMs: Infinity },
  gyro: { value: null, state: 'unknown', ageMs: Infinity },
  orientation: { value: null, state: 'unknown', ageMs: Infinity },
  motion: 'UNKNOWN', quality: 'unknown',
});
const growingBox = (width: number): BoundingBox => ({ x: 0.5 - width / 2, y: 0.3, w: width, h: 0.3 });

describe('rugged temporal image evidence', () => {
  it('reports consistent three-frame image growth without inventing physical range or TTC', () => {
    const tracker = new ObjectTracker();
    const first = tracker.update([observation(growingBox(0.2))], 1000)[0];
    const second = tracker.update([observation(growingBox(0.25))], 1250)[0];
    const third = tracker.update([observation(growingBox(0.3))], 1500)[0];
    expect(first).toMatchObject({ state: 'TENTATIVE', imageMotion: { trend: 'UNKNOWN', sampleCount: 1 } });
    expect(second).toMatchObject({ state: 'CONFIRMED', imageMotion: { trend: 'UNKNOWN', sampleCount: 2 } });
    expect(third.imageMotion).toMatchObject({ trend: 'EXPANDING', sampleCount: 3, spanMs: 500, reason: null });
    expect(third.imageMotion!.logAreaRatePerSecond).toBeCloseTo(Math.log(1.5) / 0.5);
    const fused = fuseSensors([third], context(1500), 1500).fusedObjects[0];
    expect(fused.ultrasonicDistanceCm).toBeNull();
    expect(fused.hazardLevel).toBe('awareness');
  });

  it('does not equate whole-scene translation with image expansion or object approach', () => {
    const tracker = new ObjectTracker();
    tracker.update([observation(box(0.1)), observation(box(0.5), 'bicycle')], 1000);
    tracker.update([observation(box(0.13)), observation(box(0.53), 'bicycle')], 1250);
    const tracks = tracker.update([observation(box(0.16)), observation(box(0.56), 'bicycle')], 1500);
    expect(tracks).toHaveLength(2);
    for (const track of tracks) {
      expect(track.velocity.x).toBeCloseTo(0.12);
      expect(track.imageMotion?.trend).toBe('STABLE');
      expect(track.imageMotion?.logAreaRatePerSecond).toBeCloseTo(0);
    }
  });

  it('rejects alternating detector box growth as consistent expansion', () => {
    const tracker = new ObjectTracker();
    tracker.update([observation(growingBox(0.2))], 1000);
    tracker.update([observation(growingBox(0.25))], 1250);
    expect(tracker.update([observation(growingBox(0.21))], 1500)[0].imageMotion)
      .toMatchObject({ trend: 'UNKNOWN', logAreaRatePerSecond: null, reason: 'inconsistent' });
  });

  it('clears motion on an occlusion and requires three new observations after recovery', () => {
    const tracker = new ObjectTracker();
    tracker.update([observation(growingBox(0.2))], 1000);
    tracker.update([observation(growingBox(0.24))], 1200);
    expect(tracker.update([observation(growingBox(0.28))], 1400)[0].imageMotion?.trend).toBe('EXPANDING');
    const missed = tracker.update([], 1600)[0];
    expect(missed).toMatchObject({ velocity: { x: 0, y: 0 }, imageMotion: { trend: 'UNKNOWN', reason: 'missed' } });
    const recovered = tracker.update([observation(growingBox(0.3))], 1800)[0];
    expect(recovered).toMatchObject({ velocity: { x: 0, y: 0 }, imageMotion: { trend: 'UNKNOWN', sampleCount: 1 } });
    expect(tracker.update([observation(growingBox(0.34))], 2000)[0].imageMotion?.trend).toBe('UNKNOWN');
    expect(tracker.update([observation(growingBox(0.38))], 2200)[0].imageMotion?.trend).toBe('EXPANDING');
  });

  it('cannot turn replayed or reversed frames into image growth samples', () => {
    const tracker = new ObjectTracker();
    tracker.update([observation(growingBox(0.2))], 1000);
    const second = tracker.update([observation(growingBox(0.24))], 1200);
    expect(tracker.update([observation(growingBox(0.3))], 1200)).toEqual(second);
    expect(tracker.update([observation(growingBox(0.4))], 1100)).toEqual(second);
    expect(tracker.update([observation(growingBox(0.28))], 1400)[0].imageMotion?.sampleCount).toBe(3);
  });

  it('does not derive expansion from an object entering through an image boundary', () => {
    const tracker = new ObjectTracker();
    tracker.update([observation(box(-0.1, 0.3))], 1000);
    tracker.update([observation(box(-0.05, 0.3))], 1200);
    const track = tracker.update([observation(box(0, 0.3))], 1400)[0];
    expect(track.currentBox.x).toBe(0);
    expect(track.imageMotion).toMatchObject({ trend: 'UNKNOWN', reason: 'edge_clipped' });
  });

  it('bounds the image history and isolates returned diagnostic objects from caller mutation', () => {
    const tracker = new ObjectTracker();
    let tracks: ObjectTrack[] = [];
    for (let index = 0; index < 50; index++) tracks = tracker.update([observation()], 1000 + index * 100);
    expect(tracks[0].imageMotion).toMatchObject({ sampleCount: 5, spanMs: 400, trend: 'STABLE' });
    tracks[0].imageMotion!.trend = 'EXPANDING';
    expect(tracker.getTracks()[0].imageMotion?.trend).toBe('STABLE');
  });

  it('does not extrapolate image motion across a long frame gap even inside track retention time', () => {
    const tracker = new ObjectTracker();
    tracker.update([observation(growingBox(0.2))], 1000);
    tracker.update([observation(growingBox(0.24))], 1200);
    expect(tracker.update([observation(growingBox(0.28))], 2400)[0])
      .toMatchObject({ velocity: { x: 0, y: 0 }, imageMotion: { trend: 'UNKNOWN', sampleCount: 1, reason: 'gap' } });
  });
});

describe('crowded image association', () => {
  it('gives a shared detection to its strongest overlap instead of the oldest track', () => {
    const tracker = new ObjectTracker();
    const detections = [observation(box(0.1, 0.4)), observation(box(0.3, 0.4))];
    tracker.update(detections, 1000);
    const confirmed = tracker.update([...detections].reverse(), 1200);
    const betterId = confirmed.find(track => track.currentBox.x === 0.3)!.trackId;
    const current = tracker.update([observation(box(0.3, 0.4))], 1400);
    expect(current.find(track => track.trackId === betterId)?.misses).toBe(0);
    expect(current.find(track => track.trackId !== betterId)?.misses).toBe(1);
    const visual = fuseSensors(current, context(1400), 1400).fusedObjects;
    expect(visual.filter(object => object.evidence === 'confirmed')).toHaveLength(1);
    expect(visual.filter(object => object.evidence === 'lost')).toHaveLength(1);
  });

  it('creates one tentative identity for an exact duplicate detection within one frame', () => {
    const tracker = new ObjectTracker();
    expect(tracker.update([observation(), observation()], 1000))
      .toMatchObject([{ state: 'TENTATIVE', hits: 1 }]);
  });

  it('does not inherit confirmation or growth when a detector changes category', () => {
    const tracker = new ObjectTracker();
    tracker.update([observation()], 1000);
    tracker.update([observation()], 1200);
    const tracks = tracker.update([observation(box(), 'dog')], 1400);
    expect(tracks.find(track => track.label === 'dog')).toMatchObject({ state: 'TENTATIVE', hits: 1, imageMotion: { trend: 'UNKNOWN' } });
    expect(fuseSensors(tracks, context(1400), 1400).fusedObjects.map(object => object.evidence).sort())
      .toEqual(['lost', 'tentative']);
  });

  it('does not accept empty labels or impossible/zero confidence as camera evidence', () => {
    const tracker = new ObjectTracker();
    expect(tracker.update([
      observation(box(), '', 0.9), observation(box(), 'person', 0),
      observation(box(), 'person', NaN), observation(box(), 'person', 1.1),
    ], 1000)).toEqual([]);
  });
});

describe('finite visible geometry and independent range freshness', () => {
  it('uses the visible part of a clipped box for side and overlap', () => {
    const partlyVisible = { x: -0.8, y: 0.3, w: 1.7, h: 0.2 };
    expect(getSpatialSide(partlyVisible)).toBe('CENTER');
    expect(getOccupiedSides(partlyVisible)).toEqual(['LEFT', 'CENTER', 'RIGHT']);
    expect(getVisibleBoundingBox(partlyVisible)).toMatchObject({ x: 0, y: 0.3 });
  });

  it.each([
    { x: Number.MAX_VALUE, y: 0.3, w: Number.MAX_VALUE, h: 0.2 },
    { x: -Number.MAX_VALUE, y: 0.3, w: Number.MAX_VALUE, h: 0.2 },
    { x: 0, y: 0, w: 1e-300, h: 1e-300 },
    { x: NaN, y: 0.3, w: 0.2, h: 0.2 },
  ])('rejects overflow or invisible/degenerate geometry: %o', (invalid) => {
    expect(isValidBoundingBox(invalid)).toBe(false);
    expect(getVisibleBoundingBox(invalid)).toBeNull();
    expect(getOccupiedSides(invalid)).toEqual([]);
  });

  it.each([
    { contextAt: 1000, now: 1000, ageMs: 1501 },
    { contextAt: 1000, now: 2601, ageMs: 0 },
    { contextAt: 1001, now: 1000, ageMs: 0 },
    { contextAt: 1000, now: 1000, ageMs: -1 },
    { contextAt: 1000, now: 1000, ageMs: NaN },
  ])('does not revive a valid-tagged range with stale/invalid timing: %o', ({ contextAt, now, ageMs }) => {
    const ctx = context(contextAt);
    ctx.ultrasonic.ageMs = ageMs;
    expect(fuseSensors([], ctx, now).pathState.center).toBe('UNKNOWN');
  });

  it.each([0, NaN, Infinity, 2])('rejects invalid track confidence %s during fusion', (confidence) => {
    const tracker = new ObjectTracker();
    tracker.update([observation()], 1000);
    const [track] = tracker.update([observation()], 1200);
    track.confidence = confidence;
    const fused = fuseSensors([track], { ...context(1200), ultrasonic: { state: 'unknown', value: null, ageMs: Infinity } }, 1200);
    expect(fused.fusedObjects[0].evidence).toBe('invalid');
    expect(fused.pathState.center).toBe('UNKNOWN');
  });

  it('returns finite unknown diagnostics for malformed standalone history timing', () => {
    const evidence = measureImageMotion([{ box: box(), at: NaN }, { box: box(), at: 1200 }, { box: box(), at: 1400 }]);
    expect(evidence).toMatchObject({ trend: 'UNKNOWN', spanMs: 0, reason: 'gap', logAreaRatePerSecond: null });
  });
});
