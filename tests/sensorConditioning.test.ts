import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { sensorConditioning, getCurrentSensorContext, THRESHOLDS } from '../src/core/vision/sensorConditioning';
import type { TelemetryPacket } from '../shared/deviceProtocol';

describe('Sensor Conditioning Engine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    sensorConditioning._reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const basePacket = (): TelemetryPacket => ({
    v: 1, deviceId: 'test', seq: 1, uptimeMs: 1000,
    battery: { busV: null, shuntMv: null, currentMa: null, charging: null, chargeSource: 'none', ok: true },
    imu: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, pitch: 0, roll: 0, ok: true },
    ultrasonic: { distanceCm: 150, echoUs: 1000, status: 'ok', sampleAgeMs: 0 },
    button: [], rssi: null,
    health: { camera: 'ok', i2c: 'ok', motor: 'idle' }
  });

  it('initially reports unknown missing data', () => {
    const ctx = getCurrentSensorContext();
    expect(ctx.motion).toBe('UNKNOWN');
    expect(ctx.quality).toBe('unknown');
    expect(ctx.ultrasonic.state).toBe('unknown');
    expect(ctx.accel.state).toBe('unknown');
  });

  it('exposes valid ultrasonic distance within bounds', () => {
    const p = basePacket();
    p.ultrasonic.distanceCm = 150.5;
    sensorConditioning.ingest(p, 10000);
    
    const ctx = getCurrentSensorContext();
    expect(ctx.ultrasonic.state).toBe('valid');
    expect(ctx.ultrasonic.value).toBe(150.5);
    expect(ctx.ultrasonic.ageMs).toBe(0);
  });

  it('rejects invalid ultrasonic distance out of bounds (firmware 2-450cm)', () => {
    const p = basePacket();
    p.ultrasonic.distanceCm = 1.0; // Too close
    sensorConditioning.ingest(p, 10000);
    
    let ctx = getCurrentSensorContext();
    expect(ctx.ultrasonic.state).toBe('invalid');
    expect(ctx.ultrasonic.value).toBe(null);

    p.ultrasonic.distanceCm = 500.0; // Too far
    sensorConditioning.ingest(p, 10010);
    ctx = getCurrentSensorContext();
    expect(ctx.ultrasonic.state).toBe('invalid');
  });

  it('ages sensor data into stale states accurately', () => {
    sensorConditioning.ingest(basePacket(), 10000);
    let ctx = getCurrentSensorContext();
    expect(ctx.ultrasonic.state).toBe('valid');
    expect(ctx.accel.state).toBe('valid');

    // Fast forward just before the stale threshold
    vi.setSystemTime(10000 + THRESHOLDS.US_STALE_MS - 1);
    ctx = getCurrentSensorContext();
    expect(ctx.ultrasonic.state).toBe('valid');
    expect(ctx.accel.state).toBe('valid');

    // Fast forward past threshold
    vi.setSystemTime(10000 + THRESHOLDS.US_STALE_MS + 1);
    ctx = getCurrentSensorContext();
    expect(ctx.ultrasonic.state).toBe('stale');
    expect(ctx.accel.state).toBe('stale');
    // Value is preserved for stale state, but flagged
    expect(ctx.ultrasonic.value).toBe(150);
  });

  it('treats no_echo as a real "nothing in range" reading, not as missing data', () => {
    const p = basePacket();
    p.ultrasonic = { distanceCm: null, echoUs: null, status: 'no_echo', sampleAgeMs: 40 };
    sensorConditioning.ingest(p, 10000);
    const ctx = getCurrentSensorContext();
    expect(ctx.ultrasonic.state).toBe('valid');
    expect(ctx.ultrasonic.value).toBe(null);
    expect(ctx.ultrasonic.ageMs).toBe(40);
  });

  it('calculates IMU magnitudes and defaults to STABLE motion', () => {
    const p = basePacket();
    p.imu = { ax: 0.1, ay: -0.2, az: 0.98, gx: 10, gy: -5, gz: 0, pitch: 10, roll: -5, ok: true };
    sensorConditioning.ingest(p, 10000);

    const ctx = getCurrentSensorContext();
    expect(ctx.accel.value?.x).toBe(0.1);
    expect(ctx.accel.value?.mag).toBeCloseTo(1.0, 1);
    expect(ctx.gyro.value?.mag).toBeCloseTo(11.18, 1);
    
    // Near 1g and low gyro -> STABLE
    expect(ctx.motion).toBe('STABLE');
    expect(ctx.quality).toBe('good');
  });

  it('classifies WALKING when accel varies but gyro is moderate', () => {
    const p = basePacket();
    p.imu.ax = 0.5; p.imu.ay = 0.5; p.imu.az = 0.8; // mag = 1.06 (within 0.25)
    // Wait, let's make it clearly outside STABLE mag deviation, e.g. 1.3g
    p.imu.ax = 0; p.imu.ay = 0; p.imu.az = 1.3;
    sensorConditioning.ingest(p, 10000);

    const ctx = getCurrentSensorContext();
    expect(ctx.motion).toBe('WALKING');
  });

  it('classifies SWINGING on high gyro', () => {
    const p = basePacket();
    p.imu.gx = 100; p.imu.gy = 0; p.imu.gz = 0; // > 90 deg/s
    sensorConditioning.ingest(p, 10000);

    const ctx = getCurrentSensorContext();
    expect(ctx.motion).toBe('SWINGING');
    expect(ctx.quality).toBe('degraded'); // Vision degraded during swinging
  });

  it('classifies RAPID_MOTION on impact/fall levels', () => {
    const p = basePacket();
    // High acceleration (e.g. 2.1g)
    p.imu.ax = 2.1; p.imu.ay = 0; p.imu.az = 0;
    sensorConditioning.ingest(p, 10000);

    let ctx = getCurrentSensorContext();
    expect(ctx.motion).toBe('RAPID_MOTION');

    // High gyro (e.g. 300 deg/s)
    p.imu.ax = 0; p.imu.ay = 0; p.imu.az = 1.0;
    p.imu.gx = 300;
    sensorConditioning.ingest(p, 10010);

    ctx = getCurrentSensorContext();
    expect(ctx.motion).toBe('RAPID_MOTION');
  });

  it('maintains pure computations, not modifying original packet', () => {
    const p = basePacket();
    const cloned = JSON.parse(JSON.stringify(p));
    sensorConditioning.ingest(p, 10000);
    expect(p).toEqual(cloned);
  });
});
