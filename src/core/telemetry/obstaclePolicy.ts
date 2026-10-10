import type { Settings } from '../store/session';

/** Existing app/ECU configuration, in centimetres. Advisory code must not invent new motor thresholds. */
export const SENSITIVITY: Record<Settings['obstacleSensitivity'], { awarenessCm: number; warningCm: number; dangerCm: number }> = {
  low: { awarenessCm: 110, warningCm: 75, dangerCm: 40 },
  medium: { awarenessCm: 150, warningCm: 100, dangerCm: 50 },
  high: { awarenessCm: 200, warningCm: 140, dangerCm: 70 },
};
