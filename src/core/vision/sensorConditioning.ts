import type { TelemetryPacket } from '../../../shared/deviceProtocol';

export type SensorQuality = 'good' | 'degraded' | 'unknown';
export type MotionState = 'UNKNOWN' | 'STABLE' | 'WALKING' | 'SWINGING' | 'RAPID_MOTION';
export type ValueState = 'valid' | 'stale' | 'invalid' | 'unknown';

export interface SensorValue<T> {
  value: T | null;
  state: ValueState;
  ageMs: number;
}

export type UltrasonicTrend = 'UNKNOWN' | 'STABLE' | 'APPROACHING' | 'RECEDING';
export type ApproachResetReason = 'no_samples' | 'invalid' | 'no_range' | 'stale' | 'gap' | 'duplicate' | 'out_of_order' | 'device_changed' | 'unstable_motion' | 'inconsistent';

/** Advisory range-rate of the forward beam, not object velocity or collision/clearance proof. */
export interface UltrasonicApproach {
  trend: UltrasonicTrend;
  /** Positive means the measured range is shrinking; all distances are centimetres. */
  closingSpeedCmS: number | null;
  /**
   * Advisory remaining time from this snapshot to the existing warning distance.
   * Includes conservative measurement age; never a guarantee of future range/free space.
   */
  timeToWarningMs: number | null;
  warningDistanceCm: number;
  confidence: SensorQuality;
  sampleCount: number;
  spanMs: number;
  resetReason: ApproachResetReason | null;
}

/** These bound advisory estimation only. They do not change obstacle or motor thresholds. */
export const ULTRASONIC_APPROACH_POLICY = {
  maxSamples: 5,
  windowMs: 2000,
  minimumSampleIntervalMs: 50,
  minimumProjectionSamples: 3,
  minimumProjectionSpanMs: 500,
  minimumTrendCmS: 5,
  maximumRateRatio: 3,
  defaultWarningDistanceCm: 100, // Existing medium sensitivity; callers can pass applied policy.
} as const;

export interface SensorContext {
  /** The time this snapshot was requested. */
  timestamp: number;
  
  /** 
   * Ultrasonic distance in cm. 
   * Raw valid range: 2.0 to 450.0 cm. Stale after US_STALE_MS.
   * Never median-filtered here: a newly close obstacle remains immediately visible.
   */
  ultrasonic: SensorValue<number>;
  /** Optional for legacy fixtures/consumers; emitted by this conditioning engine. */
  ultrasonicApproach?: UltrasonicApproach;
  
  /** 
   * Accelerometer in multiples of g (9.8 m/s^2).
   * Firmware axis: x, y, z as transmitted from MPU6050.
   */
  accel: SensorValue<{ x: number; y: number; z: number; mag: number }>;
  
  /**
   * Gyroscope in degrees per second (deg/s).
   */
  gyro: SensorValue<{ x: number; y: number; z: number; mag: number }>;
  
  /**
   * Orientation in degrees.
   * Pitch: computed from accelerometer (-180 to 180).
   * Roll: computed from accelerometer (-180 to 180).
   */
  orientation: SensorValue<{ pitch: number; roll: number }>;
  
  motion: MotionState;
  quality: SensorQuality;
}

// Thresholds for motion classification based on firmware audit
export const THRESHOLDS = {
  // The phone sees sensors through the telemetry poll (DEFAULT_POLL_MS = 500 ms, httpTransport.ts),
  // not at the firmware rate (IMU 50 Hz, ultrasonic ~16 Hz). Stale = one missed poll plus margin.
  IMU_STALE_MS: 1500,
  US_STALE_MS: 1500,
  
  // Acceleration magnitude (g)
  MAG_STABLE_DEV: 0.25,  // |mag - 1.0| < 0.25g is stable (matches firmware stillBandG)
  MAG_RAPID_MIN: 2.0,    // mag > 2.0g is rapid motion/impact (firmware impactG is 2.5)
  
  // Angular velocity magnitude (deg/s)
  GYRO_STABLE_MAX: 45,   // < 45 deg/s is stable
  GYRO_SWING_MIN: 90,    // > 90 deg/s is swinging the stick
  GYRO_RAPID_MIN: 250,   // > 250 deg/s is rapid/erratic motion
};

class SensorConditioningEngine {
  // Phone telemetry is polled, not delivered at the firmware's 50 Hz IMU sampling rate.
  private usDistance: number | null = null;
  private usAt = 0;
  private usValid = false;
  
  private ax = 0; private ay = 0; private az = 0; private aMag = 0;
  private gx = 0; private gy = 0; private gz = 0; private gMag = 0;
  private pitch = 0; private roll = 0;
  private imuAt = 0;
  private imuValid = false;

  private rangeSamples: { cm: number; at: number }[] = [];
  private lastDeviceId: string | null = null;
  private lastUptimeMs: number | null = null;
  private lastRangeDeviceAt: number | null = null;
  private approachResetReason: ApproachResetReason | null = 'no_samples';
  private lastWallTime = 0;

  private resetApproach(reason: ApproachResetReason) {
    this.rangeSamples.length = 0;
    this.approachResetReason = reason;
  }

  private observeClock(now: number) {
    if (now < this.lastWallTime) {
      // A wall-clock correction must not rejuvenate measurements or later resurrect them.
      this.usValid = false;
      this.usDistance = null;
      this.imuValid = false;
      this.resetApproach('invalid');
    }
    this.lastWallTime = now;
  }

  public ingest(p: TelemetryPacket, receivedAt: number) {
    if (!Number.isFinite(receivedAt)) return;
    this.observeClock(Date.now());
    if (this.lastDeviceId !== null && (p.deviceId !== this.lastDeviceId || p.uptimeMs < (this.lastUptimeMs ?? 0))) {
      this._reset();
      this.approachResetReason = 'device_changed';
    }
    this.lastDeviceId = p.deviceId;
    this.lastUptimeMs = p.uptimeMs;

    if (p.ultrasonic) {
      const u = p.ultrasonic;
      // Measurement time on the phone's clock: the stick reports how old its last sample was.
      const ageValid = Number.isFinite(u.sampleAgeMs) && u.sampleAgeMs >= 0;
      const at = ageValid ? receivedAt - u.sampleAgeMs : receivedAt;
      // HTTP seq increments per request, so it does NOT identify a new sensor sample.
      // Device sample time also removes phone/network jitter from range-rate calculation.
      const deviceAt = p.uptimeMs - u.sampleAgeMs;
      const timingValid = ageValid && Number.isFinite(deviceAt) && deviceAt >= 0;
      const repeated = timingValid && this.lastRangeDeviceAt !== null && deviceAt <= this.lastRangeDeviceAt;
      if (repeated) {
        this.resetApproach(deviceAt === this.lastRangeDeviceAt ? 'duplicate' : 'out_of_order');
        // A repeated sample must not refresh the age of a previous good measurement.
        // A reported sensor error still invalidates a previous good value immediately.
        if (u.status !== 'ok' || u.distanceCm === null || !Number.isFinite(u.distanceCm) || u.distanceCm < 2 || u.distanceCm > 450) {
          this.usDistance = null;
          this.usValid = timingValid && (u.status === 'no_echo' || u.status === 'out_of_range');
        }
      } else {
        if (timingValid) this.lastRangeDeviceAt = deviceAt;
        if (u.status === 'ok' && u.distanceCm !== null) {
          const d = u.distanceCm;
          // Firmware valid range: 2.0 to 450.0 cm
          this.usValid = timingValid && Number.isFinite(d) && d >= 2.0 && d <= 450.0;
          this.usDistance = this.usValid ? d : null;
          this.usAt = at;
        } else if (u.status === 'no_echo' || u.status === 'out_of_range') {
          // A real reading without a range; no echo does not establish a clear path.
          this.usDistance = null;
          this.usValid = timingValid;
          this.usAt = at;
        } else {
          this.usValid = false;
          this.usDistance = null;
          this.usAt = at;
        }

        if (!this.usValid) this.resetApproach('invalid');
        else if (Date.now() - at > THRESHOLDS.US_STALE_MS) this.resetApproach('stale');
        else if (this.usDistance === null) this.resetApproach('no_range');
        else {
          const previous = this.rangeSamples[this.rangeSamples.length - 1];
          if (previous && deviceAt - previous.at > THRESHOLDS.US_STALE_MS) this.resetApproach('gap');
          const latest = this.rangeSamples[this.rangeSamples.length - 1];
          if (!latest || deviceAt - latest.at >= ULTRASONIC_APPROACH_POLICY.minimumSampleIntervalMs) {
            this.rangeSamples.push({ cm: this.usDistance, at: deviceAt });
            while (this.rangeSamples.length > ULTRASONIC_APPROACH_POLICY.maxSamples || deviceAt - this.rangeSamples[0].at > ULTRASONIC_APPROACH_POLICY.windowMs) {
              this.rangeSamples.shift();
            }
            if (this.rangeSamples.length > 1) this.approachResetReason = null;
          }
        }
      }
    }

    if (p.imu) {
      const i = p.imu;
      // Missing or nonfinite vectors cannot support motion/orientation confidence.
      this.imuValid = i.ok && [i.ax, i.ay, i.az, i.gx, i.gy, i.gz, i.pitch, i.roll]
        .every(value => typeof value === 'number' && Number.isFinite(value));
      this.imuAt = receivedAt;
      if (this.imuValid) {
        this.ax = p.imu.ax ?? 0;
        this.ay = p.imu.ay ?? 0;
        this.az = p.imu.az ?? 0;
        this.gx = p.imu.gx ?? 0;
        this.gy = p.imu.gy ?? 0;
        this.gz = p.imu.gz ?? 0;
        this.pitch = p.imu.pitch ?? 0;
        this.roll = p.imu.roll ?? 0;
        this.aMag = Math.sqrt(this.ax * this.ax + this.ay * this.ay + this.az * this.az);
        this.gMag = Math.sqrt(this.gx * this.gx + this.gy * this.gy + this.gz * this.gz);
      }
    }
    if (!this.imuValid || this.aMag >= THRESHOLDS.MAG_RAPID_MIN || this.gMag >= THRESHOLDS.GYRO_SWING_MIN) {
      // A sweeping beam can change target; it cannot support a reliable approach projection.
      this.resetApproach('unstable_motion');
    }
  }

  private getApproach(usState: ValueState, motion: MotionState, warningDistanceCm: number, sampleAgeMs: number): UltrasonicApproach {
    if (usState === 'stale') this.resetApproach('stale');
    else if (usState !== 'valid') this.resetApproach(usState === 'invalid' ? 'invalid' : 'no_samples');
    if (usState === 'valid' && this.usDistance !== null && (motion === 'UNKNOWN' || motion === 'SWINGING' || motion === 'RAPID_MOTION')) this.resetApproach('unstable_motion');
    const first = this.rangeSamples[0];
    const last = this.rangeSamples[this.rangeSamples.length - 1];
    const spanMs = first && last ? last.at - first.at : 0;
    const result: UltrasonicApproach = {
      trend: 'UNKNOWN', closingSpeedCmS: null, timeToWarningMs: null,
      warningDistanceCm, confidence: 'unknown', sampleCount: this.rangeSamples.length,
      spanMs, resetReason: this.approachResetReason,
    };
    if (this.rangeSamples.length < 2 || !last || this.usDistance === null) return result;
    const rates: number[] = [];
    for (let n = 1; n < this.rangeSamples.length; n++) {
      const previous = this.rangeSamples[n - 1];
      const current = this.rangeSamples[n];
      rates.push((previous.cm - current.cm) * 1000 / (current.at - previous.at));
    }
    const sorted = [...rates].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const speed = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const direction = (rate: number) => Math.abs(rate) < ULTRASONIC_APPROACH_POLICY.minimumTrendCmS ? 0 : Math.sign(rate);
    const consistentDirection = rates.every(rate => direction(rate) === direction(speed));
    const absoluteRates = rates.map(rate => Math.abs(rate));
    const consistentRate = Math.max(...absoluteRates) <= Math.max(Math.min(...absoluteRates), ULTRASONIC_APPROACH_POLICY.minimumTrendCmS) * ULTRASONIC_APPROACH_POLICY.maximumRateRatio;
    if (!consistentDirection || !consistentRate) {
      // Keep the newest raw range; do not extrapolate through an echo jump or changed target.
      this.resetApproach('inconsistent');
      this.rangeSamples.push(last);
      return { ...result, sampleCount: 1, spanMs: 0, confidence: 'degraded', resetReason: 'inconsistent' };
    }
    result.closingSpeedCmS = speed;
    result.trend = direction(speed) > 0 ? 'APPROACHING' : direction(speed) < 0 ? 'RECEDING' : 'STABLE';
    const confirmed = rates.length + 1 >= ULTRASONIC_APPROACH_POLICY.minimumProjectionSamples && spanMs >= ULTRASONIC_APPROACH_POLICY.minimumProjectionSpanMs;
    result.confidence = confirmed ? 'good' : 'degraded';
    if (confirmed && result.trend === 'APPROACHING' && Number.isFinite(warningDistanceCm) && warningDistanceCm >= 2 && warningDistanceCm <= 450
      && Number.isFinite(sampleAgeMs) && sampleAgeMs >= 0 && sampleAgeMs <= THRESHOLDS.US_STALE_MS) {
      // Range remains the raw measurement. Only the advisory time advances between samples.
      // Age includes a conservative full-request bound, so this may warn earlier than reality.
      result.timeToWarningMs = Math.max(0, (this.usDistance - warningDistanceCm) * 1000 / speed - sampleAgeMs);
    }
    return result;
  }

  public getContext(warningDistanceCm: number = ULTRASONIC_APPROACH_POLICY.defaultWarningDistanceCm): SensorContext {
    const now = Date.now();
    this.observeClock(now);
    
    // Ultrasonic state
    const usAge = now - this.usAt;
    let usState: ValueState = 'unknown';
    if (this.usAt > 0) {
      if (!this.usValid) usState = 'invalid';
      else if (usAge > THRESHOLDS.US_STALE_MS) usState = 'stale';
      else usState = 'valid';
    }

    // IMU state
    const imuAge = now - this.imuAt;
    let imuState: ValueState = 'unknown';
    if (this.imuAt > 0) {
      if (!this.imuValid) imuState = 'invalid';
      else if (imuAge > THRESHOLDS.IMU_STALE_MS) imuState = 'stale';
      else imuState = 'valid';
    }

    // Motion classification
    let motion: MotionState = 'UNKNOWN';
    let quality: SensorQuality = 'unknown';

    if (imuState === 'valid') {
      quality = usState === 'valid' ? 'good' : 'degraded';
      
      const accelDev = Math.abs(this.aMag - 1.0);
      
      if (this.aMag >= THRESHOLDS.MAG_RAPID_MIN || this.gMag >= THRESHOLDS.GYRO_RAPID_MIN) {
        motion = 'RAPID_MOTION';
        quality = 'degraded'; // Vision is likely blurry during rapid motion
      } else if (this.gMag >= THRESHOLDS.GYRO_SWING_MIN) {
        motion = 'SWINGING';
        quality = 'degraded'; // Vision might be smeared
      } else if (accelDev < THRESHOLDS.MAG_STABLE_DEV && this.gMag < THRESHOLDS.GYRO_STABLE_MAX) {
        motion = 'STABLE';
      } else {
        motion = 'WALKING';
      }
    }

    // Return a fresh snapshot
    return {
      timestamp: now,
      ultrasonic: {
        value: (usState === 'valid' || usState === 'stale') ? this.usDistance : null,
        state: usState,
        ageMs: this.usAt > 0 ? usAge : Infinity
      },
      ultrasonicApproach: this.getApproach(usState, motion, warningDistanceCm, usAge),
      accel: {
        value: (imuState === 'valid' || imuState === 'stale') ? { x: this.ax, y: this.ay, z: this.az, mag: this.aMag } : null,
        state: imuState,
        ageMs: this.imuAt > 0 ? imuAge : Infinity
      },
      gyro: {
        value: (imuState === 'valid' || imuState === 'stale') ? { x: this.gx, y: this.gy, z: this.gz, mag: this.gMag } : null,
        state: imuState,
        ageMs: this.imuAt > 0 ? imuAge : Infinity
      },
      orientation: {
        value: (imuState === 'valid' || imuState === 'stale') ? { pitch: this.pitch, roll: this.roll } : null,
        state: imuState,
        ageMs: this.imuAt > 0 ? imuAge : Infinity
      },
      motion,
      quality
    };
  }

  /** Clear all state on disconnect, pipeline reset, changed device, or firmware reboot. */
  public reset() {
    this.usAt = 0;
    this.usDistance = null;
    this.usValid = false;
    this.imuAt = 0;
    this.imuValid = false;
    this.ax = 0; this.ay = 0; this.az = 0; this.aMag = 0;
    this.gx = 0; this.gy = 0; this.gz = 0; this.gMag = 0;
    this.pitch = 0; this.roll = 0;
    this.lastDeviceId = null;
    this.lastUptimeMs = null;
    this.lastRangeDeviceAt = null;
    this.lastWallTime = 0;
    this.resetApproach('no_samples');
  }

  // Compatibility with existing tests.
  public _reset() { this.reset(); }
}

export const sensorConditioning = new SensorConditioningEngine();

/**
 * Returns a snapshot of the latest conditioned sensor state for the Vision Engine.
 * Computed purely from ingested telemetry; independent of motor logic or UI.
 */
export function getCurrentSensorContext(warningDistanceCm?: number): SensorContext {
  return sensorConditioning.getContext(warningDistanceCm);
}
