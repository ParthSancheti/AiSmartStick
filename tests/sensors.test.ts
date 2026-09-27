import { describe, expect, it } from 'vitest';
import { UltrasonicFilter } from '../src/core/telemetry/ultrasonic';
import { ImuFilter, orientationFromAccel } from '../src/core/telemetry/imu';

describe('UltrasonicFilter', () => {
  it('median-of-3 removes a single spike', () => {
    const f = new UltrasonicFilter();
    f.update({ distanceCm: 120, status: 'ok', sampleAgeMs: 0 }, 0);
    f.update({ distanceCm: 122, status: 'ok', sampleAgeMs: 0 }, 70);
    const s = f.update({ distanceCm: 12, status: 'ok', sampleAgeMs: 0 }, 140);
    expect(s.distanceCm).toBe(120);
  });
  it('no echo is reported as no_echo with no distance — never as clear', () => {
    const f = new UltrasonicFilter();
    const s = f.update({ distanceCm: null, status: 'no_echo', sampleAgeMs: 0 }, 0);
    expect(s.status).toBe('no_echo');
    expect(s.distanceCm).toBeNull();
  });
  it('flags invalid and out-of-range readings', () => {
    const f = new UltrasonicFilter();
    expect(f.update({ distanceCm: 1, status: 'ok', sampleAgeMs: 0 }, 0).status).toBe('invalid');
    expect(f.update({ distanceCm: 900, status: 'ok', sampleAgeMs: 0 }, 1).status).toBe('out_of_range');
    expect(f.update({ distanceCm: null, status: 'timeout', sampleAgeMs: 0 }, 2).status).toBe('error');
  });
});

describe('ImuFilter', () => {
  it('computes orientation from gravity', () => {
    const o = orientationFromAccel(0, 0, 1);
    expect(o.pitch).toBeCloseTo(0);
    expect(o.roll).toBeCloseTo(0);
    expect(orientationFromAccel(-1, 0, 0).pitch).toBeCloseTo(90);
  });
  it('applies calibration and suppresses jitter', () => {
    const f = new ImuFilter({ pitch0: 10, roll0: -5 });
    const a = f.update({ ax: null, ay: null, az: null, pitch: 10, roll: -5, ok: true, at: 0 });
    expect(a.pitch).toBe(0);
    const b = f.update({ ax: null, ay: null, az: null, pitch: 10.2, roll: -5.1, ok: true, at: 50 });
    expect(b.pitch).toBe(0); // inside dead-band
    expect(f.update({ ax: null, ay: null, az: null, pitch: null, roll: null, ok: false, at: 100 }).status).toBe('error');
  });
});
