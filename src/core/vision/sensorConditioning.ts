import type { TelemetryPacket } from '../../../shared/deviceProtocol';

export type SensorQuality = 'good' | 'degraded' | 'unknown';
export type MotionState = 'UNKNOWN' | 'STABLE' | 'WALKING' | 'SWINGING' | 'RAPID_MOTION';
export type ValueState = 'valid' | 'stale' | 'invalid' | 'unknown';

export interface SensorValue<T> {
  value: T | null;
  state: ValueState;
  ageMs: number;
}

export interface SensorContext {
  /** The time this snapshot was requested. */
  timestamp: number;
  
  /** 
   * Ultrasonic distance in cm. 
   * Valid range: 2.0 to 450.0 cm. Stale after 500ms.
   */
  ultrasonic: SensorValue<number>;
  
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
  // Pre-allocated flat state to avoid garbage collection pressure during 50Hz ingestion
  private usDistance: number | null = null;
  private usAt = 0;
  private usValid = false;
  
  private ax = 0; private ay = 0; private az = 0; private aMag = 0;
  private gx = 0; private gy = 0; private gz = 0; private gMag = 0;
  private pitch = 0; private roll = 0;
  private imuAt = 0;
  private imuValid = false;

  public ingest(p: TelemetryPacket, receivedAt: number) {
    if (p.ultrasonic) {
      const u = p.ultrasonic;
      // Measurement time on the phone's clock: the stick reports how old its last sample was.
      const at = receivedAt - Math.max(0, Math.min(5000, u.sampleAgeMs ?? 0));
      if (u.status === 'ok' && u.distanceCm !== null) {
        const d = u.distanceCm;
        // Firmware valid range: 2.0 to 450.0 cm
        this.usValid = Number.isFinite(d) && d >= 2.0 && d <= 450.0;
        this.usDistance = this.usValid ? d : null;
        this.usAt = at;
      } else if (u.status === 'no_echo' || u.status === 'out_of_range') {
        // A real measurement: nothing inside the sensor's range. Valid, with no distance.
        this.usDistance = null;
        this.usValid = true;
        this.usAt = at;
      } else {
        this.usValid = false;
        this.usDistance = null;
        this.usAt = at;
      }
    }

    if (p.imu && p.imu.ok) {
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
      
      this.imuValid = true;
      this.imuAt = receivedAt;
    }
  }

  public getContext(): SensorContext {
    const now = Date.now();
    
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

  // Exposed for tests
  public _reset() {
    this.usAt = 0;
    this.usDistance = null;
    this.usValid = false;
    this.imuAt = 0;
    this.imuValid = false;
    this.ax = 0; this.ay = 0; this.az = 0; this.aMag = 0;
    this.gx = 0; this.gy = 0; this.gz = 0; this.gMag = 0;
    this.pitch = 0; this.roll = 0;
  }
}

export const sensorConditioning = new SensorConditioningEngine();

/**
 * Returns a snapshot of the latest conditioned sensor state for the Vision Engine.
 * Computed purely from ingested telemetry; independent of motor logic or UI.
 */
export function getCurrentSensorContext(): SensorContext {
  return sensorConditioning.getContext();
}
