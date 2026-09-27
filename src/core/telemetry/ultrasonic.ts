import type { UltrasonicRawStatus } from '../../../shared/deviceProtocol';
import type { UltrasonicState } from './types';

/**
 * HC-SR04: 2–400 cm usable range. Median-of-3 on valid samples removes single-sample spikes.
 * "No echo" is NOT "clear path": it can mean nothing in range, a soft/angled surface or a fault.
 */
export const US_RANGE = { minCm: 2, maxCm: 400 };

export class UltrasonicFilter {
  private window: number[] = [];

  reset() {
    this.window = [];
  }

  update(raw: { distanceCm: number | null; status: UltrasonicRawStatus; sampleAgeMs: number }, at: number): UltrasonicState {
    const measuredAt = at - Math.max(0, raw.sampleAgeMs || 0);
    if (raw.status === 'error' || raw.status === 'timeout') {
      this.window = [];
      return { status: 'error', distanceCm: null, measuredAt, quality: 'poor' };
    }
    if (raw.status === 'no_echo') {
      this.window = [];
      return { status: 'no_echo', distanceCm: null, measuredAt, quality: 'fair' };
    }
    const d = raw.distanceCm;
    if (raw.status === 'out_of_range' || (d != null && d > US_RANGE.maxCm)) {
      this.window = [];
      return { status: 'out_of_range', distanceCm: null, measuredAt, quality: 'fair' };
    }
    if (raw.status === 'invalid' || d == null || !Number.isFinite(d) || d < US_RANGE.minCm) {
      return { status: 'invalid', distanceCm: null, measuredAt, quality: 'poor' };
    }
    this.window.push(d);
    if (this.window.length > 3) this.window.shift();
    const sorted = [...this.window].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return { status: 'ok', distanceCm: Math.round(median), measuredAt, quality: this.window.length >= 3 ? 'good' : 'fair' };
  }
}
