import type { FusedObject, FusedScene, SensorContext, VisionResult } from '../../../shared/assistantContract';
import { useDevice } from '../store/device';
import { useLocation } from '../location/locationService';

/**
 * Sensor fusion (not a buzzword): combine what the camera model SAYS with what the stick MEASURES.
 *   vision      → what + left/centre/right + confidence
 *   ultrasonic  → how far, centre beam only (the HC-SR04 has a ~15° cone straight ahead)
 *   IMU         → how the stick is held (pitch/roll)
 *   GPS         → speed/heading
 * Only a CENTRE object gets a measured distance, and only if the reading is fresh (< 1 s).
 */
const CONF = { low: 0.4, medium: 0.7, high: 0.9 } as const;

export function sensorContext(now = Date.now()): SensorContext {
  const d = useDevice.getState();
  const fix = useLocation.getState().fix;
  const fresh = d.ultrasonic.measuredAt != null && now - d.ultrasonic.measuredAt < 1000;
  return {
    forwardDistanceCm: fresh && d.ultrasonic.status === 'ok' ? d.ultrasonic.distanceCm : null,
    ultrasonicStatus: fresh ? d.ultrasonic.status : 'stale',
    zone: d.zone,
    pitchDeg: d.imu.status === 'ok' ? d.imu.pitch : null,
    rollDeg: d.imu.status === 'ok' ? d.imu.roll : null,
    headingDeg: fix?.headingDeg ?? null,
    speedMps: fix?.speedMps ?? null,
    measuredAt: now,
  };
}

export function fuseScene(v: Pick<VisionResult, 'hazards'>, s: SensorContext, now = Date.now()): FusedScene {
  const objects: FusedObject[] = v.hazards.map((h) => {
    const ranged = h.position === 'center' && s.forwardDistanceCm != null;
    return {
      label: h.type === 'other' && h.note ? h.note : h.type,
      position: h.position,
      bbox: null,
      confidence: CONF[h.confidence] ?? 0.4,
      radarDistanceCm: ranged ? Math.round(s.forwardDistanceCm!) : null,
      source: ranged ? ['vision', 'ultrasonic'] : ['vision'],
      timestamp: now,
    };
  });
  // The stick measured something straight ahead that the photo did not explain: report it anyway.
  const measuredClose = s.forwardDistanceCm != null && (s.zone === 'danger' || s.zone === 'warning');
  if (measuredClose && !objects.some((o) => o.position === 'center')) {
    objects.push({ label: 'unidentified obstacle', position: 'center', bbox: null, confidence: 0.6, radarDistanceCm: Math.round(s.forwardDistanceCm!), source: ['ultrasonic'], timestamp: now });
  }
  return { objects, pose: { pitchDeg: s.pitchDeg, rollDeg: s.rollDeg }, motion: { speedMps: s.speedMps, headingDeg: s.headingDeg }, timestamp: now };
}

/** One short measured fact appended to the spoken answer (never a safety claim). */
export function measuredSuffix(f: FusedScene): string {
  const c = f.objects.find((o) => o.position === 'center' && o.radarDistanceCm != null);
  if (!c) return '';
  const m = c.radarDistanceCm! >= 100 ? `${(c.radarDistanceCm! / 100).toFixed(1)} meters` : `${c.radarDistanceCm} centimeters`;
  return c.source.length === 1 ? ` The stick measures something about ${m} straight ahead.` : ` The stick measures it about ${m} ahead.`;
}
