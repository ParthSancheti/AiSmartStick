import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ObjectTracker } from '../src/core/vision/objectTracker';
import { fuseSensors } from '../src/core/vision/fusionEngine';
import { getSpatialSide, getSpatialDepth } from '../src/core/vision/spatial';
import type { ObjectObservation, BoundingBox } from '../src/core/vision/types';

describe('Vision Engine - Object Tracker', () => {
  let tracker: ObjectTracker;
  
  beforeEach(() => {
    tracker = new ObjectTracker();
  });

  const makeObs = (label: string, box: BoundingBox): ObjectObservation => ({
    label, confidence: 0.9, box,
    centerX: box.x + box.w/2, centerY: box.y + box.h/2,
    bottomCenterX: box.x + box.w/2, bottomCenterY: box.y + box.h,
    timestamp: 1000
  });

  it('creates a new TENTATIVE track on first observation', () => {
    const obs = makeObs('person', { x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
    const tracks = tracker.update([obs], 1000);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].state).toBe('TENTATIVE');
    expect(tracks[0].hits).toBe(1);
  });

  it('CONFIRMs a track after consecutive hits', () => {
    const obs = makeObs('person', { x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
    tracker.update([obs], 1000);
    const tracks = tracker.update([obs], 1100); // 2nd hit
    expect(tracks[0].state).toBe('CONFIRMED');
    expect(tracks[0].hits).toBe(2);
  });

  it('removes noisy TENTATIVE tracks immediately on miss', () => {
    const obs = makeObs('person', { x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
    tracker.update([obs], 1000); // TENTATIVE
    const tracks = tracker.update([], 1100); // Miss
    expect(tracks).toHaveLength(0); // REMOVED
  });

  it('transitions CONFIRMED -> LOST -> REMOVED on misses', () => {
    const obs = makeObs('person', { x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
    tracker.update([obs], 1000);
    tracker.update([obs], 1100); // CONFIRMED
    
    tracker.update([], 1200); // Miss 1 (Still CONFIRMED)
    tracker.update([], 1300); // Miss 2 (Still CONFIRMED)
    
    let tracks = tracker.update([], 1400); // Miss 3 -> LOST
    expect(tracks[0].state).toBe('LOST');
    
    tracker.update([], 1500);
    tracker.update([], 1600);
    tracker.update([], 1700);
    tracker.update([], 1800);
    tracker.update([], 1900);
    tracks = tracker.update([], 2000); // Miss 9 -> REMOVED
    expect(tracks).toHaveLength(0);
  });
  
  it('computes velocity correctly on moving object', () => {
    const obs1 = makeObs('person', { x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
    tracker.update([obs1], 1000);
    
    // moved right by 0.1 in 100ms (1.0 units / sec)
    const obs2 = makeObs('person', { x: 0.5, y: 0.4, w: 0.2, h: 0.2 });
    const tracks = tracker.update([obs2], 1100);
    
    expect(tracks[0].velocity.x).toBeCloseTo(1.0);
    expect(tracks[0].velocity.y).toBeCloseTo(0);
  });
});

describe('Vision Engine - Spatial & Fusion', () => {
  it('correctly categorizes Left/Center/Right', () => {
    expect(getSpatialSide({ x: 0.0, y: 0, w: 0.2, h: 0.2 })).toBe('LEFT'); // cx = 0.1
    expect(getSpatialSide({ x: 0.4, y: 0, w: 0.2, h: 0.2 })).toBe('CENTER'); // cx = 0.5
    expect(getSpatialSide({ x: 0.8, y: 0, w: 0.2, h: 0.2 })).toBe('RIGHT'); // cx = 0.9
  });

  it('correctly categorizes Depth', () => {
    expect(getSpatialDepth({ x: 0.4, y: 0.8, w: 0.2, h: 0.1 })).toBe('NEAR'); // bottom = 0.9
    expect(getSpatialDepth({ x: 0.4, y: 0.5, w: 0.2, h: 0.1 })).toBe('MID'); // bottom = 0.6
    expect(getSpatialDepth({ x: 0.4, y: 0.1, w: 0.2, h: 0.2 })).toBe('FAR'); // bottom = 0.3
  });

  it('blocks path based on pure vision if ultrasonic is missing', () => {
    const tracker = new ObjectTracker();
    const obs = {
      label: 'person', confidence: 0.9, timestamp: 1000,
      box: { x: 0.4, y: 0.8, w: 0.2, h: 0.1 }, // CENTER, NEAR -> Warning
      centerX: 0.5, centerY: 0.85, bottomCenterX: 0.5, bottomCenterY: 0.9
    };
    tracker.update([obs], 1000);
    const tracks = tracker.update([obs], 1100); // CONFIRMED
    
    const ctx = {
      timestamp: 1100,
      ultrasonic: { value: null, state: 'invalid' as const, ageMs: 0 },
      accel: { value: null, state: 'valid' as const, ageMs: 0 },
      gyro: { value: null, state: 'valid' as const, ageMs: 0 },
      orientation: { value: null, state: 'valid' as const, ageMs: 0 },
      motion: 'STABLE' as const,
      quality: 'degraded' as const
    };
    
    const { fusedObjects, pathState } = fuseSensors(tracks, ctx, 1100);
    expect(fusedObjects).toHaveLength(1);
    expect(fusedObjects[0].hazardLevel).toBe('warning');
    expect(pathState.center).toBe('BLOCKED');
  });

  it('keeps the front ultrasonic range independent of monocular CENTER tracks', () => {
    const tracker = new ObjectTracker();
    // Small center object
    const obs1 = {
      label: 'chair', confidence: 0.9, timestamp: 1000,
      box: { x: 0.45, y: 0.4, w: 0.1, h: 0.1 }, // CENTER, MID (area 0.01)
      centerX: 0.5, centerY: 0.45, bottomCenterX: 0.5, bottomCenterY: 0.5
    };
    // Large center object
    const obs2 = {
      label: 'person', confidence: 0.9, timestamp: 1000,
      box: { x: 0.4, y: 0.4, w: 0.4, h: 0.4 }, // CENTER, NEAR (area 0.16)
      centerX: 0.6, centerY: 0.6, bottomCenterX: 0.6, bottomCenterY: 0.8
    };
    
    tracker.update([obs1, obs2], 1000);
    const tracks = tracker.update([obs1, obs2], 1100); // Both CONFIRMED
    
    const ctx = {
      timestamp: 1100,
      ultrasonic: { value: 65, state: 'valid' as const, ageMs: 0 }, // 65cm -> warning
      accel: { value: null, state: 'valid' as const, ageMs: 0 },
      gyro: { value: null, state: 'valid' as const, ageMs: 0 },
      orientation: { value: null, state: 'valid' as const, ageMs: 0 },
      motion: 'STABLE' as const,
      quality: 'good' as const
    };
    
    const { fusedObjects, pathState } = fuseSensors(tracks, ctx, 1100);
    
    const chair = fusedObjects.find(f => f.label === 'chair')!;
    const person = fusedObjects.find(f => f.label === 'person')!;
    
    expect(chair.ultrasonicDistanceCm).toBeNull();
    // One front beam cannot identify which visual object returned the echo.
    expect(person.ultrasonicDistanceCm).toBeNull();
    expect(person.hazardLevel).toBe('awareness');
    expect(person.evidence).toBe('confirmed');
    
    expect(pathState.center).toBe('BLOCKED');
    expect(pathState.left).toBe('UNKNOWN');
  });
  
  it('blocks center if ultrasonic detects but vision is empty', () => {
    const ctx = {
      timestamp: 1100,
      ultrasonic: { value: 45, state: 'valid' as const, ageMs: 0 }, // Danger!
      accel: { value: null, state: 'valid' as const, ageMs: 0 },
      gyro: { value: null, state: 'valid' as const, ageMs: 0 },
      orientation: { value: null, state: 'valid' as const, ageMs: 0 },
      motion: 'STABLE' as const,
      quality: 'good' as const
    };
    
    const { fusedObjects, pathState } = fuseSensors([], ctx, 1100);
    expect(fusedObjects).toHaveLength(0); // nothing visual
    expect(pathState.center).toBe('BLOCKED'); // but path is blocked by sonar
  });
});
