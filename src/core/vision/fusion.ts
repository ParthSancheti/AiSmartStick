import type { FusedObject, FusedScene, SensorContext, VisionResult } from '../../../shared/assistantContract';
import { useDevice, isLinked } from '../store/device';
import { useLocation, LOCATION_STALE_MS } from '../location/locationService';

/**
 * Sensor fusion (not a buzzword): combine what the camera model SAYS with what the stick MEASURES.
 *   vision      → what + left/centre/right + confidence
 *   ultrasonic  → a separate measured forward reflection, without a visual identity
 *   IMU         → how the stick is held (pitch/roll)
 *   GPS         → speed/heading
 * A single beam cannot determine which camera object returned its echo, or side clearance.
 */
const CONF = { low: 0.4, medium: 0.7, high: 0.9 } as const;
export const SPOKEN_SENSOR_FRESH_MS = 1000;

function freshAge(at: number | null, now: number, maxAgeMs: number): boolean {
  return at !== null && Number.isFinite(at) && Number.isFinite(now)
    && now - at >= 0 && now - at < maxAgeMs;
}

function usableForwardRange(s: SensorContext, now: number): boolean {
  const cm = s.forwardDistanceCm;
  return s.ultrasonicStatus === 'ok' && freshAge(s.measuredAt, now, SPOKEN_SENSOR_FRESH_MS)
    && cm !== null && Number.isFinite(cm) && cm >= 2 && cm <= 450;
}

export function sensorContext(now = Date.now()): SensorContext {
  const d = useDevice.getState();
  const fix = useLocation.getState().fix;
  const fresh = isLinked(d.link) && freshAge(d.ultrasonic.measuredAt, now, SPOKEN_SENSOR_FRESH_MS);
  const cm = d.ultrasonic.distanceCm;
  const rangeValid = cm !== null && Number.isFinite(cm) && cm >= 2 && cm <= 450;
  const imuFresh = isLinked(d.link) && d.imu.status === 'ok'
    && freshAge(d.imu.measuredAt, now, SPOKEN_SENSOR_FRESH_MS);
  const gpsFresh = fix && freshAge(fix.ts, now, LOCATION_STALE_MS);
  return {
    forwardDistanceCm: fresh && d.ultrasonic.status === 'ok' && rangeValid ? cm : null,
    ultrasonicStatus: fresh ? d.ultrasonic.status : 'stale',
    zone: fresh ? d.zone : 'unknown',
    pitchDeg: imuFresh && Number.isFinite(d.imu.pitch) ? d.imu.pitch : null,
    rollDeg: imuFresh && Number.isFinite(d.imu.roll) ? d.imu.roll : null,
    headingDeg: gpsFresh && Number.isFinite(fix.headingDeg) ? fix.headingDeg : null,
    speedMps: gpsFresh && Number.isFinite(fix.speedMps) ? fix.speedMps : null,
    measuredAt: d.ultrasonic.measuredAt ?? now,
  };
}

export function fuseScene(v: Pick<VisionResult, 'hazards'>, s: SensorContext, now = Date.now(), photoAt = now): FusedScene {
  const objects: FusedObject[] = v.hazards.map((h) => {
    return {
      label: h.type === 'other' && h.note ? h.note : h.type,
      position: h.position,
      bbox: null,
      confidence: CONF[h.confidence] ?? 0.4,
      radarDistanceCm: null,
      source: ['vision'],
      timestamp: photoAt,
    };
  });
  // Preserve measured evidence even when a center visual object exists; the association is unknown.
  if (usableForwardRange(s, now)) {
    objects.push({ label: 'unidentified obstacle', position: 'center', bbox: null, confidence: 0.6, radarDistanceCm: Math.round(s.forwardDistanceCm!), source: ['ultrasonic'], timestamp: s.measuredAt });
  }
  return { objects, pose: { pitchDeg: s.pitchDeg, rollDeg: s.rollDeg }, motion: { speedMps: s.speedMps, headingDeg: s.headingDeg }, timestamp: photoAt };
}

/** One short measured fact appended to the spoken answer (never a safety claim). */
export function measuredSuffix(f: FusedScene, now = Date.now()): string {
  const c = f.objects.find((o) => o.position === 'center' && o.source.length === 1
    && o.source[0] === 'ultrasonic' && o.radarDistanceCm !== null
    && Number.isFinite(o.radarDistanceCm) && o.radarDistanceCm >= 2 && o.radarDistanceCm <= 450
    && freshAge(o.timestamp, now, SPOKEN_SENSOR_FRESH_MS));
  if (!c) return '';
  const m = c.radarDistanceCm! >= 100 ? `${(c.radarDistanceCm! / 100).toFixed(1)} meters` : `${c.radarDistanceCm} centimeters`;
  return ` The separate stick reading was about ${m} straight ahead; its identity is uncertain.`;
}
