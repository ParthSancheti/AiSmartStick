import type { SensorContext } from './sensorConditioning';
import type { ObjectTrack, FusedObject, PathState } from './types';
import { getSpatialSide, getSpatialDepth } from './spatial';

/**
 * Sensor Fusion: Combines temporal visual tracks with the physical ultrasonic sensor data.
 */
export function fuseSensors(tracks: ObjectTrack[], ctx: SensorContext, nowMs: number): { fusedObjects: FusedObject[], pathState: PathState } {
  const fusedObjects: FusedObject[] = [];
  
  // Path state initialization
  const pathState: PathState = { left: 'FREE', center: 'FREE', right: 'FREE' };
  if (ctx.quality === 'unknown') {
    pathState.left = 'UNKNOWN';
    pathState.center = 'UNKNOWN';
    pathState.right = 'UNKNOWN';
  }
  
  let centerTrackWithDistance: number | null = null;
  
  // Find the largest, most confident CENTER track to associate the ultrasonic distance with.
  // Ultrasonic beam width is roughly +/- 15 degrees, so it strongly aligns with CENTER.
  if (ctx.ultrasonic.state === 'valid' && ctx.ultrasonic.value !== null) {
    let bestTrack: ObjectTrack | null = null;
    let maxArea = 0;
    
    for (const track of tracks) {
      if (track.state !== 'CONFIRMED') continue;
      const side = getSpatialSide(track.currentBox);
      // The beam only reaches a few metres: a FAR (or unknown-depth) box cannot be what it measured.
      const depth = getSpatialDepth(track.currentBox);
      const plausible = (depth === 'NEAR' && ctx.ultrasonic.value <= 250) || (depth === 'MID' && ctx.ultrasonic.value <= 450);
      if (side === 'CENTER' && plausible) {
        const area = track.currentBox.w * track.currentBox.h;
        if (area > maxArea) {
          maxArea = area;
          bestTrack = track;
        }
      }
    }
    
    if (bestTrack) {
      centerTrackWithDistance = bestTrack.trackId;
    }
  }
  
  for (const track of tracks) {
    if (track.state === 'REMOVED') continue;
    
    const side = getSpatialSide(track.currentBox);
    const depth = getSpatialDepth(track.currentBox);
    
    // Associate ultrasonic distance only if logic permits
    const hasDistance = centerTrackWithDistance === track.trackId;
    const distanceCm = hasDistance ? ctx.ultrasonic.value : null;
    
    let hazardLevel: FusedObject['hazardLevel'] = 'safe';
    if (track.state === 'CONFIRMED') {
      if (distanceCm !== null) {
        if (distanceCm < 50) hazardLevel = 'danger';
        else if (distanceCm < 100) hazardLevel = 'warning';
        else if (distanceCm < 150) hazardLevel = 'awareness';
      } else {
        // purely visual hazard estimation
        if (depth === 'NEAR') hazardLevel = 'warning';
        else if (depth === 'MID') hazardLevel = 'awareness';
      }
    }
    
    fusedObjects.push({
      track,
      label: track.label,
      visualConfidence: track.confidence,
      ultrasonicDistanceCm: distanceCm,
      side,
      depth,
      quality: ctx.quality === 'good' && track.state === 'CONFIRMED' ? 'good' : 'degraded',
      freshnessMs: nowMs - track.lastSeenMs,
      hazardLevel
    });
    
    // Update simple path occupancy
    if (track.state === 'CONFIRMED' && (hazardLevel === 'danger' || hazardLevel === 'warning' || hazardLevel === 'awareness')) {
      if (side === 'LEFT') pathState.left = 'BLOCKED';
      else if (side === 'CENTER') pathState.center = 'BLOCKED';
      else if (side === 'RIGHT') pathState.right = 'BLOCKED';
    }
  }
  
  // If ultrasonic detected something but no visual track claimed it, still block the center.
  if (ctx.ultrasonic.state === 'valid' && ctx.ultrasonic.value !== null && ctx.ultrasonic.value < 150) {
    pathState.center = 'BLOCKED';
  }
  
  return { fusedObjects, pathState };
}
