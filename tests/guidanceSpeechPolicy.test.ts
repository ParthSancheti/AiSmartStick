import { describe, expect, it } from 'vitest';
import { GuidanceSpeechPolicy } from '../src/core/guidance/speechPolicy';
import { emptyWalkingGuidance, type WalkingGuidance } from '../src/core/guidance/guidanceState';
import type { SensorContext } from '../src/core/vision/sensorConditioning';
const context = (now: number, motion: SensorContext['motion'] = 'STABLE'): SensorContext => ({
  timestamp: now, motion, quality: 'good', ultrasonic: { value: 75, state: 'valid', ageMs: 0 },
  accel: { value: { x: 0, y: 0, z: 1, mag: 1 }, state: 'valid', ageMs: 0 },
  gyro: { value: { x: 0, y: 0, z: 0, mag: 0 }, state: 'valid', ageMs: 0 },
  orientation: { value: { pitch: 0, roll: 0 }, state: 'valid', ageMs: 0 },
});
const hazard = (extra: Partial<WalkingGuidance> = {}): WalkingGuidance => ({ ...emptyWalkingGuidance(), severity: 'warning', frontDistanceCm: 75, routeHold: true, ...extra });
const gps = (now: number, speedMps: number) => ({ lat: 18, lng: 73, accuracyM: 5, ts: now, speedMps, altitude: null, headingDeg: null });

describe('movement-aware obstacle speech', () => {
  it('ignores brief repeated sensor gaps but announces a sustained loss', () => {
    const p = new GuidanceSpeechPolicy();
    const bad = hazard({ severity: 'unavailable', frontDistanceCm: null });
    const clear = hazard({ severity: 'none', frontDistanceCm: 250, routeHold: false });
    expect(p.decide(bad, context(0), null, '', 0).speak).toBe(false);
    p.decide(clear, context(500), null, '', 500);
    expect(p.decide(bad, context(5000), null, '', 5000).speak).toBe(false);
    expect(p.decide(bad, context(7000), null, '', 7000).speak).toBe(true);
  });
  it('announces a stable new camera hazard while stopped, without claiming distance', () => {
    const p = new GuidanceSpeechPolicy();
    const visual = hazard({ frontDistanceCm: null });
    for (let now = 0; now <= 10000; now += 500) p.decide(visual, context(now), null, 'chair:CENTER', now);
    expect(p.decide(visual, context(10500), null, 'person:CENTER', 10500).speak).toBe(false);
    expect(p.decide(visual, context(12500), null, 'person:CENTER', 12500).speak).toBe(true);
  });
  it('announces an unchanged stationary obstacle once over two minutes, even with range jitter', () => {
    const p = new GuidanceSpeechPolicy(); let count = 0;
    for (let now = 0; now < 120000; now += 500) count += +p.decide(hazard({ frontDistanceCm: now % 1000 ? 74 : 76 }), context(now), null, 'chair', now).speak;
    expect(count).toBe(1);
  });
  it('renews the warning when the user begins moving', () => {
    const p = new GuidanceSpeechPolicy();
    for (let now = 0; now <= 5000; now += 500) p.decide(hazard(), context(now), null, 'chair', now);
    expect(p.decide(hazard(), context(5500, 'WALKING'), null, 'chair', 5500).speak).toBe(true);
    expect(p.decide(hazard(), context(5600, 'WALKING'), null, 'chair', 5600).speak).toBe(false);
  });
  it('never suppresses escalation or a sudden newly close obstacle', () => {
    const p = new GuidanceSpeechPolicy();
    p.decide(hazard(), context(0), null, '', 0);
    expect(p.decide(hazard({ severity: 'danger', frontDistanceCm: 20 }), context(100), null, '', 100).speak).toBe(true);
    p.decide(hazard({ severity: 'none', frontDistanceCm: 250, routeHold: false }), context(200), null, '', 200);
    expect(p.decide(hazard({ severity: 'danger', frontDistanceCm: 20 }), context(300), null, '', 300).speak).toBe(true);
  });
  it('alerts for closing range while stationary and does not repeat the same approach', () => {
    const p = new GuidanceSpeechPolicy();
    for (let now = 0; now <= 4000; now += 500) p.decide(hazard(), context(now), null, '', now);
    expect(p.decide(hazard({ approaching: true, frontDistanceCm: 58 }), context(4500), null, '', 4500).speak).toBe(true);
    expect(p.decide(hazard({ approaching: true, frontDistanceCm: 58 }), context(9000), null, '', 9000).speak).toBe(false);
  });
  it('reports a sensor outage once, including repeated bad frames', () => {
    const p = new GuidanceSpeechPolicy(); let count = 0;
    for (let now = 0; now < 120000; now += 500) count += +p.decide(hazard({ severity: 'unavailable', frontDistanceCm: null }), context(now), null, '', now).speak;
    expect(count).toBe(1);
  });
  it('rearms an outage only after sustained good range, not a single recovering packet', () => {
    const p = new GuidanceSpeechPolicy(); const bad = hazard({ severity: 'unavailable', frontDistanceCm: null });
    p.decide(bad, context(0), null, '', 0);
    expect(p.decide(bad, context(2000), null, '', 2000).speak).toBe(true);
    p.decide(hazard(), context(2500), null, '', 2500);
    expect(p.decide(bad, context(3000), null, '', 3000).speak).toBe(false);
    for (let now = 3500; now <= 7000; now += 500) p.decide(hazard(), context(now), null, '', now);
    p.decide(bad, context(7500), null, '', 7500);
    expect(p.decide(bad, context(9500), null, '', 9500).speak).toBe(true);
  });
  it('uses speed to shorten moving reminders without changing hazard severity', () => {
    const countAt = (speed: number) => { const p = new GuidanceSpeechPolicy(); let n = 0;
      for (let now = 0; now < 60000; now += 500) n += +p.decide(hazard(), context(now), gps(now, speed), '', now).speak;
      return n;
    };
    expect(countAt(2)).toBeGreaterThan(countAt(0.4));
    expect(countAt(2)).toBeLessThanOrEqual(11);
  });
  it('does not repeat a static camera-only scene and ignores label flicker while stopped', () => {
    const p = new GuidanceSpeechPolicy(); let count = 0;
    for (let now = 0; now < 60000; now += 500) count += +p.decide(hazard({ frontDistanceCm: null }), context(now), null, now % 1000 ? 'chair' : 'sofa', now).speak;
    expect(count).toBe(1);
  });
  it('does not use stale GPS speed to infer movement', () => {
    const p = new GuidanceSpeechPolicy();
    for (let now = 10000; now <= 20000; now += 500) p.decide(hazard(), context(now), gps(0, 2), '', now);
    expect(p.decide(hazard(), context(20500), gps(0, 2), '', 20500)).toEqual({ speak: false, movement: 'stationary' });
  });
  it('rearms after five seconds of resolved evidence', () => {
    const p = new GuidanceSpeechPolicy(); p.decide(hazard(), context(0), null, '', 0);
    for (let now = 500; now <= 6000; now += 500) p.decide(hazard({ severity: 'none', frontDistanceCm: 250, routeHold: false }), context(now), null, '', now);
    expect(p.decide(hazard(), context(6500), null, '', 6500).speak).toBe(true);
  });

  it.each([
    { name: 'missing accelerometer', mutate: (ctx: SensorContext) => { ctx.accel.value = null; } },
    { name: 'missing gyroscope', mutate: (ctx: SensorContext) => { ctx.gyro.value = null; } },
    { name: 'nonfinite acceleration', mutate: (ctx: SensorContext) => { ctx.accel.value!.x = NaN; } },
    { name: 'nonfinite gyroscope', mutate: (ctx: SensorContext) => { ctx.gyro.value!.z = Infinity; } },
    { name: 'nonfinite magnitude', mutate: (ctx: SensorContext) => { ctx.accel.value!.mag = Infinity; } },
    { name: 'negative magnitude', mutate: (ctx: SensorContext) => { ctx.gyro.value!.mag = -1; } },
  ])('does not silence reminders as stationary from valid-tagged $name', ({ mutate }) => {
    const p = new GuidanceSpeechPolicy();
    for (const now of [0, 1500, 3000]) {
      const ctx = context(now);
      mutate(ctx);
      const result = p.decide(hazard(), ctx, null, '', now);
      expect(result.movement).toBe('unknown');
      if (now === 0) expect(result.speak).toBe(true); // The raw warning still escalates immediately.
    }
    const later = context(30000);
    mutate(later);
    expect(p.decide(hazard(), later, null, '', 30000)).toEqual({ speak: true, movement: 'unknown' });
  });

  it.each([-1, NaN, Infinity, 1001])('rejects malformed/future context timestamp %s as movement evidence', (timestamp) => {
    const p = new GuidanceSpeechPolicy();
    const ctx = context(timestamp, 'WALKING');
    expect(p.decide(hazard(), ctx, null, '', 1000)).toEqual({ speak: true, movement: 'unknown' });
  });

  it.each([-1, NaN, Infinity, 1001])('rejects malformed/future GPS timestamp %s as movement evidence', (timestamp) => {
    const p = new GuidanceSpeechPolicy();
    const ctx = context(1000);
    ctx.accel.state = 'unknown';
    ctx.gyro.state = 'unknown';
    expect(p.decide(hazard(), ctx, gps(timestamp, 2), '', 1000)).toEqual({ speak: true, movement: 'unknown' });
  });

  it.each([NaN, Infinity, -Infinity, -1])('returns unknown without emission and resets poisoned current time %s', (now) => {
    const p = new GuidanceSpeechPolicy();
    for (let at = 0; at <= 3000; at += 500) p.decide(hazard(), context(at), null, '', at);
    expect(p.decide(hazard(), context(3000), null, '', 3000).movement).toBe('stationary');
    expect(p.decide(hazard({ severity: 'danger', frontDistanceCm: 20 }), context(4000), null, '', now))
      .toEqual({ speak: false, movement: 'unknown' });
    expect(p.decide(hazard({ severity: 'danger', frontDistanceCm: 20 }), context(4000), null, '', 4000))
      .toEqual({ speak: true, movement: 'unknown' });
  });

  it('does not treat before-origin inertial measurements as fresh in a replay', () => {
    const p = new GuidanceSpeechPolicy();
    const ctx = context(0, 'WALKING');
    ctx.accel.ageMs = ctx.gyro.ageMs = 1;
    expect(p.decide(hazard(), ctx, null, '', 0)).toEqual({ speak: true, movement: 'unknown' });
  });
});
