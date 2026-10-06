/** Processed (domain) sensor states. The UI reads only these, never raw packets. */
export type Quality = 'good' | 'fair' | 'poor' | 'unknown';

export interface BatteryState {
  status: 'unknown' | 'ok' | 'stale' | 'sensor_error' | 'unavailable';
  /** Filtered state-of-charge estimate (integer %), or null when there is no trustworthy reading. */
  percent: number | null;
  voltage: number | null;
  currentMa: number | null;
  charging: boolean | null;
  /** 'hardware' = charger status pin; 'inferred' = from current direction (see battery.ts). */
  chargingSource: 'hardware' | 'inferred' | null;
  measuredAt: number | null;
  quality: Quality;
}

export interface ImuState {
  status: 'unknown' | 'ok' | 'stale' | 'error' | 'unavailable';
  /** Degrees, calibrated (zero reference applied) and smoothed. */
  pitch: number | null;
  roll: number | null;
  measuredAt: number | null;
  calibrated: boolean;
}

export interface UltrasonicState {
  status: 'unknown' | 'ok' | 'no_echo' | 'out_of_range' | 'invalid' | 'stale' | 'error' | 'unavailable';
  distanceCm: number | null;
  measuredAt: number | null;
  quality: Quality;
}

export interface CameraState {
  status: 'unknown' | 'idle' | 'capturing' | 'error' | 'unavailable';
  lastCaptureAt: number | null;
}

export const unknownBattery = (): BatteryState => ({ status: 'unknown', percent: null, voltage: null, currentMa: null, charging: null, chargingSource: null, measuredAt: null, quality: 'unknown' });
export const unknownImu = (): ImuState => ({ status: 'unknown', pitch: null, roll: null, measuredAt: null, calibrated: false });
export const unknownUltrasonic = (): UltrasonicState => ({ status: 'unknown', distanceCm: null, measuredAt: null, quality: 'unknown' });
export const unknownCamera = (): CameraState => ({ status: 'unknown', lastCaptureAt: null });

/** Freshness limits (ms) after which a reading is shown as stale, not live. */
export const STALE_MS = { battery: 15_000, imu: 3_000, ultrasonic: 2_000 } as const;
