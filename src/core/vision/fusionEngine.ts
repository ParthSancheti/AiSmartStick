import type { SensorContext } from './sensorConditioning';
import { VISION_OBSERVATION_STALE_MS, type ObjectTrack, type FusedObject, type PathState } from './types';
import { getOccupiedSides, getSpatialSide, getSpatialDepth, isValidBoundingBox } from './spatial';

/**
 * Sensor Fusion: Combines temporal visual tracks with the physical ultrasonic sensor data.
 */
export function fuseSensors(tracks: ObjectTrack[], ctx: SensorContext, nowMs: number): { fusedObjects: FusedObject[], pathState: PathState } {
  const fusedObjects: FusedObject[] = [];
  
  // Detection absence and a single narrow sonar beam cannot certify a traversable lane.
  const pathState: PathState = { left: 'UNKNOWN', center: 'UNKNOWN', right: 'UNKNOWN' };
  
  for (const track of tracks) {
    if (track.state === 'REMOVED') continue;
    
    const side = getSpatialSide(track.currentBox);
    const depth = getSpatialDepth(track.currentBox);
    const occupiedSides = getOccupiedSides(track.currentBox);
    const ageMs = nowMs - track.lastSeenMs;
    let evidence: FusedObject['evidence'];
    if (!isValidBoundingBox(track.currentBox) || !Number.isFinite(ageMs) || ageMs < 0) evidence = 'invalid';
    else if (ageMs > VISION_OBSERVATION_STALE_MS) evidence = 'stale';
    else if (track.state === 'LOST' || track.misses > 0) evidence = 'lost';
    else if (track.state === 'CONFIRMED') evidence = 'confirmed';
    else evidence = 'tentative';

    // Vertical image position supplies only a qualitative visual caution, never metric distance.
    let hazardLevel: FusedObject['hazardLevel'] = 'unknown';
    if (evidence === 'confirmed') {
      if (depth === 'NEAR') hazardLevel = 'warning';
      else if (depth === 'MID' || depth === 'FAR') hazardLevel = 'awareness';
    }
    
    fusedObjects.push({
      track,
      label: track.label,
      visualConfidence: track.confidence,
      ultrasonicDistanceCm: null,
      side,
      occupiedSides,
      evidence,
      depth,
      quality: evidence === 'confirmed' ? (ctx.quality === 'good' ? 'good' : 'degraded')
        : evidence === 'tentative' ? 'degraded' : 'unknown',
      freshnessMs: Number.isFinite(ageMs) ? Math.max(0, ageMs) : Infinity,
      hazardLevel
    });
    
    // Update simple path occupancy
    if (evidence === 'confirmed' && (hazardLevel === 'warning' || hazardLevel === 'awareness')) {
      for (const occupiedSide of occupiedSides) {
        if (occupiedSide === 'LEFT') pathState.left = 'BLOCKED';
        else if (occupiedSide === 'CENTER') pathState.center = 'BLOCKED';
        else if (occupiedSide === 'RIGHT') pathState.right = 'BLOCKED';
      }
    }
  }
  
  // Preserve independent forward obstacle evidence even when vision has no usable tracks.
  if (ctx.ultrasonic.state === 'valid' && ctx.ultrasonic.value !== null
    && Number.isFinite(ctx.ultrasonic.value) && ctx.ultrasonic.value >= 2 && ctx.ultrasonic.value < 150) {
    pathState.center = 'BLOCKED';
  }
  
  return { fusedObjects, pathState };
}
