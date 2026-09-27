import type { ButtonEvent } from '../../../shared/deviceProtocol';
import type { ButtonPattern } from '../types';

/**
 * The ONE button timing model. Used for the physical stick button (edges or firmware gestures)
 * and by the on-screen orb (hooks/usePressPatterns.ts imports these constants).
 */
export const BUTTON_TIMING = {
  /** Max gap between releases and the next press to count as the same multi-press. */
  multiPressWindowMs: 350,
  /** Hold this long for SOS. */
  longPressMs: 3000,
} as const;

/**
 * Classifies button edges using DEVICE timestamps (uptime ms), so network jitter between
 * polls cannot turn a double press into two singles. Deterministic and unit-tested.
 */
export class ButtonClassifier {
  private lastId = -1;
  private pressAt: number | null = null;
  private longFired = false;
  private taps = 0;
  private lastReleaseAt: number | null = null;

  reset() {
    this.lastId = -1;
    this.pressAt = null;
    this.longFired = false;
    this.taps = 0;
    this.lastReleaseAt = null;
  }

  /** Feed events from one telemetry packet plus the packet's device time. Returns gestures to act on. */
  ingest(events: ButtonEvent[], deviceNowMs: number): ButtonPattern[] {
    const out: ButtonPattern[] = [];
    const sorted = [...events].sort((a, b) => a.id - b.id);
    for (const e of sorted) {
      if (e.id <= this.lastId) continue; // duplicate from an overlapping poll
      this.lastId = e.id;
      if (e.kind === 'gesture' && e.gesture) {
        out.push(...this.flush(e.atMs, true));
        out.push(mapGesture(e.gesture));
        continue;
      }
      if (e.kind === 'press') {
        if (this.lastReleaseAt != null && e.atMs - this.lastReleaseAt > BUTTON_TIMING.multiPressWindowMs) out.push(...this.flush(e.atMs, true));
        this.pressAt = e.atMs;
        this.longFired = false;
      } else if (e.kind === 'release') {
        const held = this.pressAt != null ? e.atMs - this.pressAt : (e.durationMs ?? 0);
        this.pressAt = null;
        if (this.longFired || held >= BUTTON_TIMING.longPressMs) {
          if (!this.longFired) out.push('hold');
          this.longFired = false;
          this.taps = 0;
          this.lastReleaseAt = null;
        } else {
          this.taps++;
          this.lastReleaseAt = e.atMs;
        }
      }
    }
    // Long press fires while still held (SOS feedback must not wait for release).
    if (this.pressAt != null && !this.longFired && deviceNowMs - this.pressAt >= BUTTON_TIMING.longPressMs) {
      this.longFired = true;
      this.taps = 0;
      this.lastReleaseAt = null;
      out.push('hold');
    }
    out.push(...this.flush(deviceNowMs, false));
    return out;
  }

  private flush(now: number, force: boolean): ButtonPattern[] {
    if (!this.taps || this.lastReleaseAt == null || this.pressAt != null) return [];
    if (!force && now - this.lastReleaseAt <= BUTTON_TIMING.multiPressWindowMs) return [];
    const n = this.taps;
    this.taps = 0;
    this.lastReleaseAt = null;
    return [n === 1 ? 'single' : n === 2 ? 'double' : 'triple'];
  }
}

function mapGesture(g: NonNullable<ButtonEvent['gesture']>): ButtonPattern {
  switch (g) {
    case 'single':
      return 'single';
    case 'double':
      return 'double';
    case 'triple':
      return 'triple';
    case 'long':
      return 'hold';
    case 'setup':
      return 'setup-hold';
  }
}
