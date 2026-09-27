import { describe, expect, it } from 'vitest';
import { BatteryEstimator, socFromOcv } from '../src/core/telemetry/battery';

const feed = (e: BatteryEstimator, v: number, mA: number, n: number, t0: number, dt = 1000, charging: boolean | null = null) => {
  let s = e.update({ busV: v, currentMa: mA, charging, ok: true, at: t0 });
  for (let i = 1; i < n; i++) s = e.update({ busV: v, currentMa: mA, charging, ok: true, at: t0 + i * dt });
  return s;
};

describe('BatteryEstimator', () => {
  it('maps the OCV curve monotonically with clamping', () => {
    expect(socFromOcv(3.0)).toBe(0);
    expect(socFromOcv(4.3)).toBe(100);
    expect(socFromOcv(3.84)).toBeCloseTo(50, 0);
    expect(socFromOcv(3.9)).toBeGreaterThan(socFromOcv(3.85));
  });

  it('rejects impossible voltages instead of turning them into a percentage', () => {
    const e = new BatteryEstimator();
    expect(e.update({ busV: 0, currentMa: 0, charging: null, ok: true, at: 0 }).status).toBe('sensor_error');
    expect(e.update({ busV: 5.1, currentMa: 0, charging: null, ok: true, at: 1 }).status).toBe('sensor_error');
    expect(e.update({ busV: null, currentMa: null, charging: null, ok: false, at: 2 }).status).toBe('sensor_error');
  });

  it('does not show a 3% → 84% jump from one noisy sample', () => {
    const e = new BatteryEstimator();
    const low = feed(e, 3.62, 170, 10, 0);
    expect(low.percent).toBeLessThan(10);
    // One absurd high sample (loose contact), then back to reality.
    const spike = e.update({ busV: 4.05, currentMa: 170, charging: null, ok: true, at: 11_000 });
    expect(spike.percent).toBe(low.percent);
    const after = feed(e, 3.62, 170, 5, 12_000);
    expect(after.percent).toBeLessThan(10);
  });

  it('does not rise while discharging (voltage recovery after load)', () => {
    const e = new BatteryEstimator();
    const a = feed(e, 3.8, 400, 5, 0);
    const b = feed(e, 3.86, 20, 30, 5000); // load removed → voltage recovers
    expect(b.percent).toBeLessThanOrEqual(a.percent!);
  });

  it('infers charging from sustained negative current and labels it inferred', () => {
    const e = new BatteryEstimator();
    const s = feed(e, 3.9, -450, 4, 0);
    expect(s.charging).toBe(true);
    expect(s.chargingSource).toBe('inferred');
  });

  it('prefers the hardware charge pin when present', () => {
    const e = new BatteryEstimator();
    const s = feed(e, 3.9, 150, 2, 0, 1000, true);
    expect(s.charging).toBe(true);
    expect(s.chargingSource).toBe('hardware');
  });

  it('while charging, rises gradually (rate-limited)', () => {
    const e = new BatteryEstimator();
    const start = feed(e, 3.75, 170, 3, 0).percent!;
    const s = feed(e, 3.95, -450, 30, 3000); // 30 s of charging
    expect(s.percent! - start).toBeLessThanOrEqual(3);
  });

  it('a persistent disagreement without reboot is accepted only after a minute, in steps', () => {
    const e = new BatteryEstimator();
    const start = feed(e, 3.62, 170, 3, 0).percent!;
    const early = feed(e, 4.1, 170, 30, 3000); // 30 s at a much higher voltage
    expect(early.percent).toBe(start);
    const later = feed(e, 4.1, 170, 70, 33_000); // keeps disagreeing for > 60 s
    expect(later.percent!).toBeGreaterThan(start);
    expect(later.percent! - start).toBeLessThanOrEqual(20);
  });
});
