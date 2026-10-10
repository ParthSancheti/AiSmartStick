import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { TelemetryPacket } from '../shared/deviceProtocol';
import { getCurrentSensorContext, sensorConditioning, THRESHOLDS, ULTRASONIC_APPROACH_POLICY } from '../src/core/vision/sensorConditioning';

/** Synthetic traces validate software behavior, not physical HC-SR04 accuracy or safe speeds. */
describe('forward ultrasonic approach conditioning', () => {
  const packet = (cm: number | null, elapsedMs = 0): TelemetryPacket => ({
    v: 1, deviceId: 'AISS-TEST', seq: elapsedMs + 1, uptimeMs: 1000 + elapsedMs,
    battery: { busV: null, shuntMv: null, currentMa: null, charging: null, chargeSource: 'none', ok: false },
    imu: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, pitch: 0, roll: 0, ok: true },
    ultrasonic: { distanceCm: cm, echoUs: null, status: cm === null ? 'no_echo' : 'ok', sampleAgeMs: 0 },
    button: [], rssi: null, health: { camera: 'ok', i2c: 'ok', motor: 'idle' },
  });
  const ingest = (p: TelemetryPacket, receivedAt = 9000 + p.uptimeMs) => {
    vi.setSystemTime(receivedAt);
    sensorConditioning.ingest(p, receivedAt);
    return getCurrentSensorContext();
  };
  const approachTrace = () => {
    ingest(packet(150));
    ingest(packet(140, 500));
    return ingest(packet(130, 1000));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    sensorConditioning.reset();
  });
  afterEach(() => vi.useRealTimers());

  it('recognizes 150 to 140 centimetres as preliminary approach without inventing an ETA', () => {
    ingest(packet(150));
    const ctx = ingest(packet(140, 500));
    expect(ctx.ultrasonicApproach).toMatchObject({
      trend: 'APPROACHING', closingSpeedCmS: 20, confidence: 'degraded',
      sampleCount: 2, spanMs: 500, timeToWarningMs: null,
    });
  });

  it('projects a consistent approach to the existing configured warning distance', () => {
    const ctx = approachTrace();
    expect(ctx.ultrasonicApproach).toMatchObject({
      trend: 'APPROACHING', closingSpeedCmS: 20, confidence: 'good',
      warningDistanceCm: 100, timeToWarningMs: 1500, sampleCount: 3, spanMs: 1000,
    });
    expect(getCurrentSensorContext(75).ultrasonicApproach?.timeToWarningMs).toBe(2750);
    expect(getCurrentSensorContext(140).ultrasonicApproach?.timeToWarningMs).toBe(0);
    expect(getCurrentSensorContext(Number.NaN).ultrasonicApproach?.timeToWarningMs).toBeNull();
  });

  it('advances advisory warning ETA as the latest valid sample ages without inventing new range data', () => {
    ingest(packet(450));
    ingest(packet(425, 250));
    const fresh = ingest(packet(400, 500));
    expect(fresh.ultrasonicApproach).toMatchObject({ confidence: 'good', closingSpeedCmS: 100, timeToWarningMs: 3000 });
    vi.setSystemTime(11700); // 1200 ms since the same raw 400 cm sample.
    const aged = getCurrentSensorContext();
    expect(aged.ultrasonic).toMatchObject({ value: 400, state: 'valid', ageMs: 1200 });
    expect(aged.ultrasonicApproach).toMatchObject({ closingSpeedCmS: 100, timeToWarningMs: 1800, sampleCount: 3 });
    vi.setSystemTime(10500 + THRESHOLDS.US_STALE_MS + 1);
    expect(getCurrentSensorContext().ultrasonicApproach).toMatchObject({ trend: 'UNKNOWN', timeToWarningMs: null, sampleCount: 0 });
  });

  it('bounds aged advisory time at zero without projecting a current physical distance', () => {
    approachTrace(); // Latest raw range 130 cm; 1500 ms from measurement to warning boundary.
    vi.setSystemTime(12500);
    const aged = getCurrentSensorContext();
    expect(aged.ultrasonic).toMatchObject({ value: 130, state: 'valid', ageMs: 1500 });
    expect(aged.ultrasonicApproach?.timeToWarningMs).toBe(0);
    vi.setSystemTime(12501);
    expect(getCurrentSensorContext().ultrasonicApproach?.timeToWarningMs).toBeNull();
  });

  it('uses actual firmware sample intervals rather than network arrival intervals', () => {
    ingest(packet(150));
    const second = packet(140, 600);
    second.ultrasonic.sampleAgeMs = 100;
    ingest(second, 10400); // The second measurement was made at device uptime 1500 ms.
    const ctx = ingest(packet(130, 1000), 11300); // A later response experiences different delay.
    expect(ctx.ultrasonicApproach).toMatchObject({ closingSpeedCmS: 20, spanMs: 1000, timeToWarningMs: 1500 });
  });

  it('keeps a sudden near obstacle immediately available without smoothing delay', () => {
    approachTrace();
    const ctx = ingest(packet(20, 1500));
    expect(ctx.ultrasonic).toMatchObject({ value: 20, state: 'valid', ageMs: 0 });
    expect(ctx.ultrasonicApproach).toMatchObject({
      trend: 'UNKNOWN', timeToWarningMs: null, sampleCount: 1, resetReason: 'inconsistent',
    });
  });

  it('does not extrapolate through reversing, noisy, or abruptly changed beam targets', () => {
    ingest(packet(150));
    ingest(packet(140, 500));
    const ctx = ingest(packet(150, 1000));
    expect(ctx.ultrasonic.value).toBe(150);
    expect(ctx.ultrasonicApproach?.resetReason).toBe('inconsistent');
    expect(ctx.ultrasonicApproach?.timeToWarningMs).toBeNull();
  });

  it('distinguishes steady and receding range without predicting approach', () => {
    ingest(packet(150));
    ingest(packet(150, 500));
    expect(ingest(packet(150, 1000)).ultrasonicApproach).toMatchObject({ trend: 'STABLE', timeToWarningMs: null });
    sensorConditioning.reset();
    ingest(packet(130));
    ingest(packet(140, 500));
    expect(ingest(packet(150, 1000)).ultrasonicApproach).toMatchObject({ trend: 'RECEDING', closingSpeedCmS: -20, timeToWarningMs: null });
  });

  it('does not refresh measurement age or accumulate trend from repeated sample IDs', () => {
    ingest(packet(150));
    const repeated = packet(150, 500); // New HTTP seq and uptime, same physical measurement.
    repeated.ultrasonic.sampleAgeMs = 500;
    const ctx = ingest(repeated);
    expect(ctx.ultrasonic.ageMs).toBe(500);
    expect(ctx.ultrasonicApproach).toMatchObject({ trend: 'UNKNOWN', sampleCount: 0, resetReason: 'duplicate' });
    repeated.seq++;
    repeated.uptimeMs = 2501;
    repeated.ultrasonic.sampleAgeMs = 1501;
    expect(ingest(repeated).ultrasonic.state).toBe('stale');
  });

  it('invalidates a reported sensor error even when its sample timestamp did not advance', () => {
    ingest(packet(80));
    const failed = packet(null, 500);
    failed.ultrasonic.status = 'timeout';
    failed.ultrasonic.sampleAgeMs = 500;
    expect(ingest(failed).ultrasonic).toMatchObject({ state: 'invalid', value: null });
  });

  it('ignores older physical measurements without rejuvenating the previous raw value', () => {
    ingest(packet(150));
    const delayed = packet(140, 500);
    delayed.ultrasonic.sampleAgeMs = 600;
    const ctx = ingest(delayed);
    expect(ctx.ultrasonic).toMatchObject({ value: 150, ageMs: 500 });
    expect(ctx.ultrasonicApproach?.resetReason).toBe('out_of_order');
  });

  it('no echo and out of range remove estimates without claiming any clear path', () => {
    approachTrace();
    const p = packet(null, 1500);
    const ctx = ingest(p);
    expect(ctx.ultrasonic).toMatchObject({ value: null, state: 'valid' });
    expect(ctx.ultrasonicApproach).toMatchObject({ trend: 'UNKNOWN', timeToWarningMs: null, resetReason: 'no_range' });
    p.uptimeMs += 500;
    p.ultrasonic.status = 'out_of_range';
    expect(ingest(p).ultrasonicApproach?.timeToWarningMs).toBeNull();
  });

  it('resets on invalid readings, malformed ages, and the metre example beyond actual sonar range', () => {
    approachTrace();
    const ctx = ingest(packet(15000, 1500)); // 150 metres cannot be measured by this HC-SR04.
    expect(ctx.ultrasonic).toMatchObject({ state: 'invalid', value: null });
    expect(ctx.ultrasonicApproach?.resetReason).toBe('invalid');
    const malformed = packet(140, 2000);
    malformed.ultrasonic.sampleAgeMs = Number.NaN;
    expect(ingest(malformed).ultrasonic.state).toBe('invalid');
  });

  it('drops projections on staleness or missing-poll gaps and re-establishes fresh evidence', () => {
    approachTrace();
    vi.setSystemTime(11000 + THRESHOLDS.US_STALE_MS + 1);
    expect(getCurrentSensorContext().ultrasonicApproach).toMatchObject({ trend: 'UNKNOWN', timeToWarningMs: null, resetReason: 'stale' });
    sensorConditioning.reset();
    ingest(packet(150));
    expect(ingest(packet(100, 2000)).ultrasonicApproach).toMatchObject({ sampleCount: 1, trend: 'UNKNOWN', resetReason: 'gap' });
  });

  it('rejects already stale packet data from the trend even when just received', () => {
    const stale = packet(150, 4000);
    stale.ultrasonic.sampleAgeMs = 2000;
    const ctx = ingest(stale);
    expect(ctx.ultrasonic.state).toBe('stale');
    expect(ctx.ultrasonicApproach?.sampleCount).toBe(0);
  });

  it('bounds range history both by sample count and observation time', () => {
    let ctx = getCurrentSensorContext();
    for (let i = 0; i < 40; i++) ctx = ingest(packet(200 - i, i * 100));
    expect(ctx.ultrasonicApproach?.sampleCount).toBe(ULTRASONIC_APPROACH_POLICY.maxSamples);
    expect(ctx.ultrasonicApproach?.spanMs).toBeLessThanOrEqual(ULTRASONIC_APPROACH_POLICY.windowMs);
    sensorConditioning.reset();
    for (let i = 0; i < 8; i++) ctx = ingest(packet(200 - i * 5, i * 1000));
    expect(ctx.ultrasonicApproach?.sampleCount).toBe(3);
    expect(ctx.ultrasonicApproach?.spanMs).toBe(2000);
  });

  it('cannot promote rapid duplicate-frequency updates into a mature projection', () => {
    ingest(packet(150));
    ingest(packet(149, 10));
    expect(ingest(packet(148, 20)).ultrasonicApproach).toMatchObject({ sampleCount: 1, trend: 'UNKNOWN', timeToWarningMs: null });
  });

  it('suppresses swept-beam projections while preserving raw emergency range', () => {
    approachTrace();
    const swinging = packet(20, 1500);
    swinging.imu.gx = 100;
    const ctx = ingest(swinging);
    expect(ctx.motion).toBe('SWINGING');
    expect(ctx.ultrasonic.value).toBe(20);
    expect(ctx.ultrasonicApproach).toMatchObject({ timeToWarningMs: null, resetReason: 'unstable_motion' });
  });

  it('does not infer movement or reuse fresh confidence after an IMU error or incomplete vectors', () => {
    approachTrace();
    const failed = packet(20, 1500);
    failed.imu.ok = false;
    expect(ingest(failed)).toMatchObject({ motion: 'UNKNOWN', accel: { state: 'invalid' }, ultrasonic: { value: 20 } });
    const incomplete = packet(20, 2000);
    incomplete.imu.ax = null;
    expect(ingest(incomplete).motion).toBe('UNKNOWN');
  });

  it('resets approach history and raw sensor state across device changes, reboot, and explicit reset', () => {
    approachTrace();
    const switched = packet(200, 1500);
    switched.deviceId = 'AISS-OTHER';
    expect(ingest(switched).ultrasonicApproach).toMatchObject({ sampleCount: 1, timeToWarningMs: null, resetReason: 'device_changed' });
    const rebooted = packet(300);
    rebooted.deviceId = 'AISS-OTHER';
    expect(ingest(rebooted).ultrasonicApproach?.sampleCount).toBe(1);
    sensorConditioning.reset();
    expect(getCurrentSensorContext().ultrasonic.state).toBe('unknown');
    expect(getCurrentSensorContext().ultrasonicApproach?.sampleCount).toBe(0);
  });
});
