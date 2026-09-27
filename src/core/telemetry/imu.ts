import type { ImuState } from './types';

/**
 * MPU6050 orientation: pitch/roll from the firmware (or from raw accel if missing),
 * calibrated against a stored zero reference and smoothed for a steady StickVisual.
 */
export interface ImuRaw {
  ax: number | null;
  ay: number | null;
  az: number | null;
  pitch: number | null;
  roll: number | null;
  ok: boolean;
  at: number;
}

export interface ImuCalibration {
  pitch0: number;
  roll0: number;
}

const DEG = 180 / Math.PI;

export function orientationFromAccel(ax: number, ay: number, az: number) {
  return {
    pitch: Math.atan2(-ax, Math.sqrt(ay * ay + az * az)) * DEG,
    roll: Math.atan2(ay, az) * DEG,
  };
}

const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

export class ImuFilter {
  private p: number | null = null;
  private r: number | null = null;
  constructor(private cal: ImuCalibration | null = null, private alpha = 0.25, private deadband = 0.4) {}

  setCalibration(cal: ImuCalibration | null) {
    this.cal = cal;
  }

  reset() {
    this.p = null;
    this.r = null;
  }

  /** Returns the zero reference that makes the current raw reading 0/0. */
  calibrateFrom(raw: ImuRaw): ImuCalibration | null {
    const o = this.rawAngles(raw);
    return o ? { pitch0: o.pitch, roll0: o.roll } : null;
  }

  private rawAngles(raw: ImuRaw) {
    if (!raw.ok) return null;
    if (raw.pitch != null && raw.roll != null && Number.isFinite(raw.pitch) && Number.isFinite(raw.roll)) return { pitch: raw.pitch, roll: raw.roll };
    if (raw.ax != null && raw.ay != null && raw.az != null) {
      const g = Math.sqrt(raw.ax ** 2 + raw.ay ** 2 + raw.az ** 2);
      // Units may be g or m/s²; accept both, reject nonsense.
      if (!(g > 0.2 && g < 40)) return null;
      return orientationFromAccel(raw.ax, raw.ay, raw.az);
    }
    return null;
  }

  update(raw: ImuRaw): ImuState {
    const o = this.rawAngles(raw);
    if (!o || Math.abs(o.pitch) > 180 || Math.abs(o.roll) > 180) {
      return { status: 'error', pitch: null, roll: null, measuredAt: raw.at, calibrated: !!this.cal };
    }
    const pitch = wrap(o.pitch - (this.cal?.pitch0 ?? 0));
    const roll = wrap(o.roll - (this.cal?.roll0 ?? 0));
    const step = (prev: number | null, next: number) => {
      if (prev == null) return next;
      const d = wrap(next - prev);
      if (Math.abs(d) < this.deadband) return prev;
      // Faster response to large moves (a fall), gentle on jitter.
      const a = Math.abs(d) > 25 ? 0.6 : this.alpha;
      return wrap(prev + a * d);
    };
    this.p = step(this.p, pitch);
    this.r = step(this.r, roll);
    return { status: 'ok', pitch: Math.round(this.p * 10) / 10, roll: Math.round(this.r * 10) / 10, measuredAt: raw.at, calibrated: !!this.cal };
  }
}
