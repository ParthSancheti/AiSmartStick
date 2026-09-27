import { getSettings } from '../store/session';

/**
 * Haptic vocabulary. One name per meaning, used everywhere, so the whole
 * product "feels" consistent. Web: Vibration API (Android Chrome only).
 * Native: call setHapticAdapter() at startup with @capacitor/haptics.
 */
export type HapticName =
  | 'tap' | 'tick' | 'success' | 'warning' | 'error' | 'listen'
  | 'connect' | 'disconnect' | 'sos' | 'countdown' | 'left' | 'right' | 'arrive';

const PATTERNS: Record<HapticName, number[]> = {
  tap: [10],
  tick: [6],
  success: [14, 70, 22],
  warning: [34, 90, 34],
  error: [60, 60, 60, 60, 60],
  listen: [16, 40, 16],
  connect: [12, 60, 12, 60, 28],
  disconnect: [80, 120, 30],
  sos: [420, 160, 420, 160, 420],
  countdown: [70],
  // Left = two pulses, right = three pulses. Easy to learn without looking.
  left: [40, 110, 40],
  right: [40, 110, 40, 110, 40],
  arrive: [30, 70, 30, 70, 160],
};

type Adapter = (name: HapticName, pattern: number[]) => void;

let adapter: Adapter = (_name, pattern) => {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(pattern);
  } catch {
    /* unsupported (iOS Safari) */
  }
};

export function setHapticAdapter(a: Adapter) {
  adapter = a;
}

export const haptics = {
  play(name: HapticName) {
    if (!getSettings().haptics) return;
    adapter(name, PATTERNS[name]);
  },
  supported: typeof navigator !== 'undefined' && 'vibrate' in navigator,
};
