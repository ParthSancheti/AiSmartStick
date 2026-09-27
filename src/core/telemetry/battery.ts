import type { BatteryState, Quality } from './types';

/**
 * Battery state-of-charge estimator for a single-cell Li-ion/LiPo pack measured by an INA219.
 *
 * Why not "percent = (V - 3.0) / 1.2": cell voltage is non-linear in SoC, sags under load
 * and jumps when a charger is plugged in. We:
 *   1. validate the raw reading (physically possible range for 1S, sensor present),
 *   2. compensate load sag: V_ocv ≈ V_bus + I × R_internal (discharge current positive),
 *   3. look up SoC on a typical Li-ion open-circuit-voltage curve,
 *   4. smooth with an EMA and rate-limit changes so the display never jumps 3% → 84%,
 *   5. mark charging from the hardware pin when present, else infer it from current direction.
 * The result is an ESTIMATE; quality says how much to trust it. Tune CONFIG for the real pack.
 */
export const BATTERY_CONFIG = {
  minValidV: 2.8,
  maxValidV: 4.4,
  internalOhm: 0.15,
  /** INA219 wiring convention: +1 if positive current = discharging. Flip if your shunt is reversed. */
  currentSign: 1,
  chargeCurrentMa: -40,
  dischargeCurrentMa: 15,
  inferSamples: 3,
  emaAlpha: 0.15,
  /** Max displayed change per minute in normal operation. */
  maxDropPerMin: 2,
  maxRisePerMinCharging: 3,
  /** A disagreement larger than this must persist (not charging) before we move faster than the rate limit. */
  jumpPct: 20,
  jumpConfirmMs: 60_000,
};

// Typical Li-ion OCV curve (V → %). Piecewise linear.
const OCV: [number, number][] = [
  [3.27, 0], [3.61, 5], [3.69, 10], [3.71, 15], [3.73, 20], [3.75, 25], [3.77, 30], [3.79, 35], [3.8, 40], [3.82, 45],
  [3.84, 50], [3.85, 55], [3.87, 60], [3.91, 65], [3.95, 70], [3.98, 75], [4.02, 80], [4.08, 85], [4.11, 90], [4.15, 95], [4.2, 100],
];

export function socFromOcv(v: number): number {
  if (v <= OCV[0][0]) return 0;
  if (v >= OCV[OCV.length - 1][0]) return 100;
  for (let i = 1; i < OCV.length; i++) {
    const [v1, p1] = OCV[i];
    const [v0, p0] = OCV[i - 1];
    if (v <= v1) return p0 + ((v - v0) / (v1 - v0)) * (p1 - p0);
  }
  return 100;
}

export interface BatteryRaw {
  busV: number | null;
  currentMa: number | null;
  charging: boolean | null;
  ok: boolean;
  at: number;
}

export class BatteryEstimator {
  private ema: number | null = null;
  private shown: number | null = null;
  private shownAt = 0;
  private chargeVotes = 0;
  private dischargeVotes = 0;
  private inferredCharging: boolean | null = null;
  private jumpSince = 0;
  private last: BatteryState | null = null;

  reset() {
    this.ema = null;
    this.shown = null;
    this.shownAt = 0;
    this.chargeVotes = 0;
    this.dischargeVotes = 0;
    this.inferredCharging = null;
    this.jumpSince = 0;
    this.last = null;
  }

  update(raw: BatteryRaw): BatteryState {
    const C = BATTERY_CONFIG;
    if (!raw.ok || raw.busV == null || !Number.isFinite(raw.busV)) {
      return this.remember({ status: 'sensor_error', percent: this.shown, voltage: null, currentMa: null, charging: null, chargingSource: null, measuredAt: raw.at, quality: 'poor' });
    }
    if (raw.busV < C.minValidV || raw.busV > C.maxValidV) {
      // 0 V = sensor/battery disconnected; >4.4 V = measuring the wrong rail. Never turn this into a percentage.
      return this.remember({ status: 'sensor_error', percent: this.shown, voltage: raw.busV, currentMa: raw.currentMa, charging: null, chargingSource: null, measuredAt: raw.at, quality: 'poor' });
    }

    const i = raw.currentMa == null ? null : raw.currentMa * C.currentSign;
    // Charging: prefer hardware; else infer from sustained current direction.
    if (i != null) {
      if (i <= C.chargeCurrentMa) {
        this.chargeVotes++;
        this.dischargeVotes = 0;
      } else if (i >= C.dischargeCurrentMa) {
        this.dischargeVotes++;
        this.chargeVotes = 0;
      }
      if (this.chargeVotes >= C.inferSamples) this.inferredCharging = true;
      if (this.dischargeVotes >= C.inferSamples) this.inferredCharging = false;
    }
    const charging = raw.charging ?? this.inferredCharging;
    const chargingSource: BatteryState['chargingSource'] = raw.charging != null ? 'hardware' : this.inferredCharging != null ? 'inferred' : null;

    const ocv = raw.busV + ((i ?? 0) / 1000) * C.internalOhm;
    this.ema = this.ema == null ? ocv : this.ema + C.emaAlpha * (ocv - this.ema);
    const target = Math.round(socFromOcv(this.ema));

    if (this.shown == null) {
      this.shown = target;
      this.shownAt = raw.at;
    } else {
      const diff = target - this.shown;
      const minutes = Math.max(0.05, (raw.at - this.shownAt) / 60000);
      if (Math.abs(diff) >= C.jumpPct && !charging) {
        // Big disagreement while not charging: a single sample is never believed. Only if it
        // persists for a minute (e.g. pack swapped without a reboot) do we step towards it, gradually.
        if (!this.jumpSince) this.jumpSince = raw.at;
        if (raw.at - this.jumpSince >= C.jumpConfirmMs) {
          this.shown += Math.sign(diff) * Math.round(C.jumpPct / 2);
          this.shownAt = raw.at;
          this.jumpSince = raw.at;
        }
      } else {
        this.jumpSince = 0;
        if (diff < 0 && !charging) {
          const step = Math.min(-diff, Math.floor(C.maxDropPerMin * minutes));
          if (step >= 1) {
            this.shown -= step;
            this.shownAt = raw.at;
          }
        } else if (diff > 0 && charging) {
          const step = Math.min(diff, Math.floor(C.maxRisePerMinCharging * minutes));
          if (step >= 1) {
            this.shown += step;
            this.shownAt = raw.at;
          }
        }
        // Rising while discharging (voltage recovery after load) and falling while charging are ignored.
      }
    }
    this.shown = Math.max(0, Math.min(100, this.shown));

    const quality: Quality = i == null ? 'fair' : charging ? 'fair' : 'good';
    return this.remember({
      status: 'ok',
      percent: this.shown,
      voltage: Math.round(raw.busV * 1000) / 1000,
      currentMa: raw.currentMa,
      charging,
      chargingSource,
      measuredAt: raw.at,
      quality,
    });
  }

  private remember(s: BatteryState) {
    this.last = s;
    return s;
  }

  get state() {
    return this.last;
  }
}
