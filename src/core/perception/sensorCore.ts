import { EVIDENCE_FRESHNESS } from './evidencePolicy';

/** A structural subset accepted equally from a live adapter or an offline sensor trace. */
export interface SensorPacket {
  deviceId: string;
  uptimeMs: number;
  ultrasonic?: {
    distanceCm: number | null;
    status: 'ok' | 'no_echo' | 'out_of_range' | 'invalid' | 'timeout' | 'error';
    sampleAgeMs: number;
  };
  imu?: {
    ax: number | null; ay: number | null; az: number | null;
    gx: number | null; gy: number | null; gz: number | null;
    pitch: number | null; roll: number | null; ok: boolean;
  };
}

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
  IMU_STALE_MS: EVIDENCE_FRESHNESS.poseMs,
  US_STALE_MS: EVIDENCE_FRESHNESS.rangeMs,
  
  // Acceleration magnitude (g)
  MAG_STABLE_DEV: 0.25,  // |mag - 1.0| < 0.25g is stable (matches firmware stillBandG)
  MAG_RAPID_MIN: 2.0,    // mag > 2.0g is rapid motion/impact (firmware impactG is 2.5)
  
  // Angular velocity magnitude (deg/s)
  GYRO_STABLE_MAX: 45,   // < 45 deg/s is stable
  GYRO_SWING_MIN: 90,    // > 90 deg/s is swinging the stick
  GYRO_RAPID_MIN: 250,   // > 250 deg/s is rapid/erratic motion
};

export class SensorConditioningCore {
  // Phone telemetry is polled, not delivered at the firmware's 50 Hz IMU sampling rate.
  private usDistance: number | null = null;
  private usAt: number | null = null;
  private usValid = false;
  
  private ax = 0; private ay = 0; private az = 0; private aMag = 0;
  private gx = 0; private gy = 0; private gz = 0; private gMag = 0;
  private pitch = 0; private roll = 0;
  private imuAt: number | null = null;
  private imuValid = false;

  private rangeSamples: { cm: number; at: number }[] = [];
  private lastDeviceId: string | null = null;
  private lastUptimeMs: number | null = null;
  private lastRangeDeviceAt: number | null = null;
  private approachResetReason: ApproachResetReason | null = 'no_samples';
  private lastClockTime: number | null = null;

  private resetApproach(reason: ApproachResetReason) {
    this.rangeSamples.length = 0;
    this.approachResetReason = reason;
  }

  private observeClock(now: number): boolean {
    const valid = Number.isFinite(now) && now >= 0;
    if (!valid || (this.lastClockTime !== null && now < this.lastClockTime)) {
      // Invalid or rolled-back time cannot rejuvenate or later resurrect measurements.
      this.usValid = false;
      this.usDistance = null;
      this.imuValid = false;
      this.resetApproach('invalid');
    }
    if (valid) this.lastClockTime = now;
    return valid;
  }

  public ingest(p: SensorPacket, receivedAt: number, now: number) {
    if (!this.observeClock(now) || !Number.isFinite(receivedAt) || receivedAt < 0 || receivedAt > now
      || !Number.isFinite(p.uptimeMs) || p.uptimeMs < 0) return;
    if (this.lastDeviceId !== null && (p.deviceId !== this.lastDeviceId || p.uptimeMs < (this.lastUptimeMs ?? 0))) {
      this.reset();
      this.lastClockTime = now;
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
      const timingValid = ageValid && Number.isFinite(at) && at >= 0 && at <= now
        && Number.isFinite(deviceAt) && deviceAt >= 0;
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
        else if (now - at > THRESHOLDS.US_STALE_MS) this.resetApproach('stale');
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
        this.aMag = Math.hypot(this.ax, this.ay, this.az);
        this.gMag = Math.hypot(this.gx, this.gy, this.gz);
        this.imuValid = Number.isFinite(this.aMag) && Number.isFinite(this.gMag);
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

  public getContext(now: number, warningDistanceCm: number = ULTRASONIC_APPROACH_POLICY.defaultWarningDistanceCm): SensorContext {
    const clockValid = this.observeClock(now);
    const timestamp = clockValid ? now : this.lastClockTime ?? 0;
    
    // Ultrasonic state
    const usAge = clockValid && this.usAt !== null ? now - this.usAt : Infinity;
    let usState: ValueState = 'unknown';
    if (this.usAt !== null) {
      if (!this.usValid || !Number.isFinite(usAge) || usAge < 0) usState = 'invalid';
      else if (usAge > THRESHOLDS.US_STALE_MS) usState = 'stale';
      else usState = 'valid';
    }

    // IMU state
    const imuAge = clockValid && this.imuAt !== null ? now - this.imuAt : Infinity;
    let imuState: ValueState = 'unknown';
    if (this.imuAt !== null) {
      if (!this.imuValid || !Number.isFinite(imuAge) || imuAge < 0) imuState = 'invalid';
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
      timestamp,
      ultrasonic: {
        value: (usState === 'valid' || usState === 'stale') ? this.usDistance : null,
        state: usState,
        ageMs: usAge
      },
      ultrasonicApproach: this.getApproach(usState, motion, warningDistanceCm, usAge),
      accel: {
        value: (imuState === 'valid' || imuState === 'stale') ? { x: this.ax, y: this.ay, z: this.az, mag: this.aMag } : null,
        state: imuState,
        ageMs: imuAge
      },
      gyro: {
        value: (imuState === 'valid' || imuState === 'stale') ? { x: this.gx, y: this.gy, z: this.gz, mag: this.gMag } : null,
        state: imuState,
        ageMs: imuAge
      },
      orientation: {
        value: (imuState === 'valid' || imuState === 'stale') ? { pitch: this.pitch, roll: this.roll } : null,
        state: imuState,
        ageMs: imuAge
      },
      motion,
      quality
    };
  }

  /** Clear all state on disconnect, pipeline reset, changed device, or firmware reboot. */
  public reset() {
    this.usAt = null;
    this.usDistance = null;
    this.usValid = false;
    this.imuAt = null;
    this.imuValid = false;
    this.ax = 0; this.ay = 0; this.az = 0; this.aMag = 0;
    this.gx = 0; this.gy = 0; this.gz = 0; this.gMag = 0;
    this.pitch = 0; this.roll = 0;
    this.lastDeviceId = null;
    this.lastUptimeMs = null;
    this.lastRangeDeviceAt = null;
    this.lastClockTime = null;
    this.resetApproach('no_samples');
  }

}
