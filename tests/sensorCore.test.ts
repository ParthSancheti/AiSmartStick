import { describe, expect, it, vi } from 'vitest';
import { EVIDENCE_FRESHNESS } from '../src/core/perception/evidencePolicy';
import { SensorConditioningCore, THRESHOLDS, type SensorPacket } from '../src/core/perception/sensorCore';

const packet = (cm = 150, uptimeMs = 1000): SensorPacket => ({
  deviceId: 'synthetic-source', uptimeMs,
  ultrasonic: { distanceCm: cm, status: 'ok', sampleAgeMs: 0 },
  imu: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, pitch: 0, roll: 0, ok: true },
});

describe('device independent sensor conditioning core', () => {
  it('runs a deterministic range trace using only explicit timestamps', () => {
    const wallClock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Hidden wall clock dependency'); });
    try {
      const left = new SensorConditioningCore();
      const right = new SensorConditioningCore();
      for (let index = 0; index < 3; index++) {
        const now = index * 500;
        left.ingest(packet(150 - index * 10, 1000 + now), now, now);
        right.ingest(packet(150 - index * 10, 1000 + now), now, now);
        expect(left.getContext(now)).toEqual(right.getContext(now));
      }
      expect(left.getContext(1000).ultrasonicApproach).toMatchObject({
        trend: 'APPROACHING', closingSpeedCmS: 20, sampleCount: 3,
        spanMs: 1000, confidence: 'good', timeToWarningMs: 1500,
      });
    } finally { wallClock.mockRestore(); }
  });

  it('accepts a real sample at timestamp zero and applies shared evidence-age boundaries', () => {
    const core = new SensorConditioningCore();
    expect(core.getContext(0).ultrasonic.state).toBe('unknown');
    core.ingest(packet(80), 0, 0);
    expect(core.getContext(0)).toMatchObject({
      timestamp: 0, ultrasonic: { value: 80, state: 'valid', ageMs: 0 },
      accel: { state: 'valid', ageMs: 0 }, motion: 'STABLE', quality: 'good',
    });
    expect(THRESHOLDS.US_STALE_MS).toBe(EVIDENCE_FRESHNESS.rangeMs);
    expect(THRESHOLDS.IMU_STALE_MS).toBe(EVIDENCE_FRESHNESS.poseMs);
    expect(core.getContext(EVIDENCE_FRESHNESS.rangeMs).ultrasonic.state).toBe('valid');
    expect(core.getContext(EVIDENCE_FRESHNESS.rangeMs + 1).ultrasonic.state).toBe('stale');
  });

  it('supports independent range-only or pose-only input traces', () => {
    const range = new SensorConditioningCore();
    range.ingest({ deviceId: 'range', uptimeMs: 0, ultrasonic: { distanceCm: 20, status: 'ok', sampleAgeMs: 0 } }, 0, 0);
    expect(range.getContext(0)).toMatchObject({ ultrasonic: { state: 'valid', value: 20 }, accel: { state: 'unknown' }, motion: 'UNKNOWN' });
    const pose = new SensorConditioningCore();
    pose.ingest({ deviceId: 'pose', uptimeMs: 0, imu: packet().imu }, 0, 0);
    expect(pose.getContext(0)).toMatchObject({ ultrasonic: { state: 'unknown' }, accel: { state: 'valid' }, motion: 'STABLE', quality: 'degraded' });
  });

  it('preserves request delay and reported measurement age independently', () => {
    const core = new SensorConditioningCore();
    const delayed = packet(200, 2000);
    delayed.ultrasonic!.sampleAgeMs = 100;
    core.ingest(delayed, 700, 1000);
    expect(core.getContext(1000)).toMatchObject({ ultrasonic: { ageMs: 400, value: 200, state: 'valid' }, gyro: { ageMs: 300 } });
  });

  it('keeps a sudden close range immediately available before a mature trend exists', () => {
    const core = new SensorConditioningCore();
    core.ingest(packet(200, 1000), 0, 0);
    core.ingest(packet(20, 1500), 500, 500);
    expect(core.getContext(500).ultrasonic).toMatchObject({ value: 20, state: 'valid', ageMs: 0 });
  });

  it('isolates instances, snapshots, caller input, and explicit resets', () => {
    const first = new SensorConditioningCore();
    const second = new SensorConditioningCore();
    const p = packet(120);
    first.ingest(p, 0, 0);
    second.ingest(packet(300), 0, 0);
    const snapshot = first.getContext(0);
    p.ultrasonic!.distanceCm = 2;
    p.imu!.ax = 10;
    snapshot.accel.value!.x = 100;
    expect(first.getContext(0)).toMatchObject({ ultrasonic: { value: 120 }, accel: { value: { x: 0 } } });
    first.reset();
    expect(first.getContext(0).ultrasonic.state).toBe('unknown');
    expect(second.getContext(0).ultrasonic.value).toBe(300);
    first.ingest(packet(50), 0, 0);
    expect(first.getContext(0).ultrasonic.value).toBe(50);
  });

  it.each([NaN, Infinity, -Infinity, -1, 2001])('does not freshen stale samples from invalid/future receipt %s', (receivedAt) => {
    const core = new SensorConditioningCore();
    core.ingest(packet(80), 0, 0);
    core.getContext(2000);
    core.ingest(packet(300, 3000), receivedAt, 2000);
    expect(core.getContext(2000).ultrasonic).toMatchObject({ value: 80, state: 'stale', ageMs: 2000 });
    expect(core.getContext(2000).accel.state).toBe('stale');
  });

  it.each([NaN, Infinity, -Infinity, -1])('invalidates confidence from an invalid current time %s and never resurrects it', (now) => {
    const core = new SensorConditioningCore();
    core.ingest(packet(80), 0, 0);
    core.ingest(packet(300, 3000), 2000, now);
    expect(core.getContext(2000)).toMatchObject({ ultrasonic: { state: 'invalid', value: null }, motion: 'UNKNOWN' });
    core.ingest(packet(90, 3500), 2500, 2500);
    expect(core.getContext(2500).ultrasonic).toMatchObject({ state: 'valid', value: 90 });
  });

  it.each([NaN, Infinity, -Infinity, -1])('never labels a context fresh under malformed query time %s', (now) => {
    const core = new SensorConditioningCore();
    core.ingest(packet(), 0, 0);
    const result = core.getContext(now);
    expect(result).toMatchObject({ ultrasonic: { state: 'invalid', value: null }, motion: 'UNKNOWN' });
    expect(Number.isFinite(result.timestamp)).toBe(true);
    expect(core.getContext(0).ultrasonic.state).toBe('invalid');
  });

  it('invalidates old confidence on a clock rollback and requires a new physical range sample', () => {
    const core = new SensorConditioningCore();
    core.ingest(packet(80), 1000, 1000);
    expect(core.getContext(1500).ultrasonic.state).toBe('valid');
    expect(core.getContext(900).ultrasonic).toMatchObject({ state: 'invalid', value: null });
    expect(core.getContext(1500).ultrasonic.state).toBe('invalid');
    core.ingest(packet(90, 1500), 1600, 1600);
    expect(core.getContext(1600).ultrasonic).toMatchObject({ state: 'valid', value: 90 });
  });

  it('does not freshen a repeated physical sample even when delivery time advances', () => {
    const core = new SensorConditioningCore();
    core.ingest(packet(80), 0, 0);
    const repeated = packet(300, 3000);
    repeated.ultrasonic!.sampleAgeMs = 2000;
    core.ingest(repeated, 2000, 2000);
    expect(core.getContext(2000).ultrasonic).toMatchObject({ state: 'stale', value: 80, ageMs: 2000 });
    expect(core.getContext(2000).ultrasonicApproach).toMatchObject({ trend: 'UNKNOWN', timeToWarningMs: null });
  });

  it.each([NaN, Infinity, -1])('does not accept malformed source uptime %s as a new sample', (uptimeMs) => {
    const core = new SensorConditioningCore();
    core.ingest(packet(80), 0, 0);
    core.ingest(packet(300, uptimeMs), 2000, 2000);
    expect(core.getContext(2000).ultrasonic).toMatchObject({ state: 'stale', value: 80 });
  });

  it('rejects measurement times before the replay origin instead of treating them as fresh', () => {
    const core = new SensorConditioningCore();
    const beforeOrigin = packet(80);
    beforeOrigin.ultrasonic!.sampleAgeMs = 1;
    core.ingest(beforeOrigin, 0, 0);
    expect(core.getContext(0).ultrasonic).toMatchObject({ state: 'invalid', value: null });
  });

  it('resets all sensor evidence when a source changes or reboots', () => {
    const core = new SensorConditioningCore();
    core.ingest(packet(150, 2000), 1000, 1000);
    core.ingest({ deviceId: 'replacement', uptimeMs: 10 }, 1100, 1100);
    expect(core.getContext(1100)).toMatchObject({ ultrasonic: { state: 'unknown' }, accel: { state: 'unknown' } });
    core.ingest(packet(90, 2000), 1200, 1200);
    core.ingest({ deviceId: 'synthetic-source', uptimeMs: 0 }, 1300, 1300);
    expect(core.getContext(1300)).toMatchObject({ ultrasonic: { state: 'unknown' }, accel: { state: 'unknown' } });
  });
});
