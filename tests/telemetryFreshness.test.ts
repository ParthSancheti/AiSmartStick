import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelemetryPacket } from '../shared/deviceProtocol';
import type { PacketTiming } from '../src/core/transport/types';
import { configurePipeline, explainPacket, ingestPacket, resetPipeline } from '../src/core/telemetry/pipeline';
import { initialDevice, useDevice } from '../src/core/store/device';
import { getCurrentSensorContext, sensorConditioning } from '../src/core/vision/sensorConditioning';
import { emptyWalkingGuidance, evaluateWalkingGuidance, routeManeuverAllowed, useWalkingGuidance } from '../src/core/guidance/guidanceState';

const packet = (seq: number, uptimeMs: number, cm = 200): TelemetryPacket => ({
  v: 1, deviceId: 'AISS-FRESH', seq, uptimeMs,
  battery: { busV: 4, shuntMv: 1, currentMa: 100, charging: false, chargeSource: 'current', ok: true },
  imu: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, pitch: 0, roll: 0, ok: true },
  ultrasonic: { distanceCm: cm, echoUs: cm * 58, status: 'ok', sampleAgeMs: 0, zone: 'normal' },
  button: [], rssi: -50, health: { camera: 'ok', i2c: 'ok', motor: 'idle' },
});

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  resetPipeline(); useDevice.setState({ ...initialDevice(), link: 'connected' });
  configurePipeline({ onButton: () => {}, onFall: () => {} });
  useWalkingGuidance.setState(emptyWalkingGuidance());
});
afterEach(() => vi.useRealTimers());

describe('conservative telemetry freshness and clock corrections', () => {
  it('charges request duration and firmware sample age independently while preserving arrival diagnostics', () => {
    const p = packet(1, 1000);
    p.ultrasonic.sampleAgeMs = 100;
    ingestPacket(p, 10000, { requestStartedAt: 9700, roundTripMs: 300 });
    expect(getCurrentSensorContext().ultrasonic.ageMs).toBe(400);
    expect(getCurrentSensorContext().gyro.ageMs).toBe(300);
    expect(useDevice.getState().lastPacketAt).toBe(10000);
    expect(useDevice.getState().ultrasonic.measuredAt).toBe(9600);
    expect(p.ultrasonic.sampleAgeMs).toBe(100);
  });

  it('does not release a route hold from a delayed far reading, despite a freshly received clear frame', () => {
    ingestPacket(packet(1, 1000, 20), 10000);
    const thresholds = { awarenessCm: 150, warningCm: 100, dangerCm: 50 };
    const previous = evaluateWalkingGuidance({ context: getCurrentSensorContext(), snapshot: null,
      thresholds, linked: true, walking: true, sensorRequired: true, now: 10000 });
    vi.setSystemTime(12000);
    ingestPacket(packet(2, 1500, 250), 12000, { requestStartedAt: 10000, roundTripMs: 2000 });
    const context = getCurrentSensorContext();
    const result = evaluateWalkingGuidance({ context, snapshot: {
      timestamp: 12000, frameTimestamp: 12000, processingLatencyMs: 0, sensorContext: context,
      objects: [], tracks: [], fusedObjects: [], pathState: { left: 'UNKNOWN', center: 'UNKNOWN', right: 'UNKNOWN' }, overallQuality: 'good',
    }, thresholds, linked: true, walking: true, sensorRequired: true, previous, now: 12000 });
    expect(context.ultrasonic.state).toBe('stale');
    expect(result.routeHold).toBe(true);
  });

  it('never adds already delayed stale samples to a trusted trend even without intermediate snapshots', () => {
    vi.setSystemTime(12000);
    ingestPacket(packet(1, 1000, 150), 12000, { requestStartedAt: 10000, roundTripMs: 2000 });
    vi.setSystemTime(12500); ingestPacket(packet(2, 1500, 140), 12500);
    vi.setSystemTime(13000); ingestPacket(packet(3, 2000, 130), 13000);
    expect(getCurrentSensorContext().ultrasonicApproach).toMatchObject({ sampleCount: 2, confidence: 'degraded', timeToWarningMs: null });
  });

  it('keeps firmware sample identity and range rate independent of differing request durations', () => {
    ingestPacket(packet(1, 1000, 150), 10000, { requestStartedAt: 9900, roundTripMs: 100 });
    vi.setSystemTime(10600); ingestPacket(packet(2, 1500, 140), 10600, { requestStartedAt: 10300, roundTripMs: 300 });
    vi.setSystemTime(11100); ingestPacket(packet(3, 2000, 130), 11100, { requestStartedAt: 11000, roundTripMs: 100 });
    // Device elapsed time still yields 20 cm/s; the 100 ms request age advances only advisory ETA.
    expect(getCurrentSensorContext().ultrasonicApproach).toMatchObject({ confidence: 'good', closingSpeedCmS: 20, spanMs: 1000, timeToWarningMs: 1400 });
  });

  it('accounts for request delay plus post-receipt elapsed time in anticipatory advice, then expires it', () => {
    ingestPacket(packet(1, 1000, 450), 10000, { requestStartedAt: 9950, roundTripMs: 50 });
    vi.setSystemTime(10250);
    ingestPacket(packet(2, 1250, 425), 10250, { requestStartedAt: 10000, roundTripMs: 250 });
    vi.setSystemTime(10500);
    ingestPacket(packet(3, 1500, 400), 10500, { requestStartedAt: 10250, roundTripMs: 250 });
    expect(getCurrentSensorContext().ultrasonicApproach?.timeToWarningMs).toBe(2750);
    vi.setSystemTime(11450); // 250 ms request bound + 950 ms since receipt = 1200 ms sample age.
    const context = getCurrentSensorContext();
    expect(context.ultrasonic).toMatchObject({ value: 400, state: 'valid', ageMs: 1200 });
    expect(context.ultrasonicApproach).toMatchObject({ closingSpeedCmS: 100, timeToWarningMs: 1800 });
    const guidance = evaluateWalkingGuidance({ context, snapshot: null,
      thresholds: { awarenessCm: 150, warningCm: 100, dangerCm: 50 },
      linked: true, walking: true, sensorRequired: true, now: 11450 });
    expect(guidance).toMatchObject({ severity: 'awareness', approaching: true, frontDistanceCm: 400 });
    vi.setSystemTime(11751);
    expect(getCurrentSensorContext().ultrasonicApproach?.timeToWarningMs).toBeNull();
  });

  it.each([
    { requestStartedAt: 10001, roundTripMs: 1 },
    { requestStartedAt: Number.NaN, roundTripMs: 1 },
    { requestStartedAt: 9999, roundTripMs: Number.POSITIVE_INFINITY },
    { requestStartedAt: 9999, roundTripMs: -1 },
    { requestStartedAt: -1, roundTripMs: 1 },
    { requestStartedAt: 9999, roundTripMs: Number.MAX_VALUE },
  ])('rejects invalid request timing before refreshing sensor state: %s', (timing: PacketTiming) => {
    ingestPacket(packet(1, 1000), 10000, timing);
    expect(getCurrentSensorContext().ultrasonic.state).toBe('unknown');
    expect(useDevice.getState().lastPacketAt).toBeNull();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('rejects malformed firmware sample age %s', (sampleAgeMs) => {
    const p = packet(1, 1000);
    p.ultrasonic.sampleAgeMs = sampleAgeMs;
    expect(explainPacket(p)).toMatch(/sampleAgeMs/);
    ingestPacket(p, 10000);
    expect(getCurrentSensorContext().ultrasonic.state).toBe('unknown');
  });

  it('rejects future receipt times and retains compatibility with untimed legacy/mock callers', () => {
    ingestPacket(packet(1, 1000), 10001);
    expect(getCurrentSensorContext().ultrasonic.state).toBe('unknown');
    ingestPacket(packet(1, 1000), -1);
    expect(getCurrentSensorContext().ultrasonic.state).toBe('unknown');
    ingestPacket(packet(2, 1500), 10000);
    expect(getCurrentSensorContext().ultrasonic.state).toBe('valid');
  });

  it('invalidates sensor confidence on wall-clock rollback and cannot resurrect the old measurement', () => {
    ingestPacket(packet(1, 1000), 10000);
    expect(getCurrentSensorContext().ultrasonic.state).toBe('valid');
    vi.setSystemTime(9990);
    expect(getCurrentSensorContext()).toMatchObject({ ultrasonic: { state: 'invalid', value: null }, motion: 'UNKNOWN' });
    vi.setSystemTime(10000);
    expect(getCurrentSensorContext().ultrasonic.state).toBe('invalid');
    sensorConditioning.ingest(packet(2, 1500, 100), 10000);
    expect(getCurrentSensorContext().ultrasonic.value).toBe(100);
  });

  it('rejects route permission during a clock rollback before a freshness timer can run', () => {
    useWalkingGuidance.setState({ ...emptyWalkingGuidance(), sensorRequired: true, evaluatedAt: 10000, validUntil: 11500 });
    expect(routeManeuverAllowed()).toBe(true);
    vi.setSystemTime(9999);
    expect(routeManeuverAllowed()).toBe(false);
  });
});
