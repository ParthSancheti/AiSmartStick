import { create } from 'zustand';
import { emptyWalkingGuidance, walkingRouteManeuverAllowed, type WalkingGuidance } from '../perception/walkingCore';

// Runtime binding only. App and replay execute the same pure decision reducer.
export { emptyWalkingGuidance, guidanceRank, WALKING_GUIDANCE_POLICY, walkingRouteManeuverAllowed } from '../perception/walkingCore';
export type { GuidanceSeverity, LocalObstaclePlan, WalkingGuidance } from '../perception/walkingCore';
export { evaluateWalkingGuidance } from '../perception/walkingEvidence';
export const useWalkingGuidance = create<WalkingGuidance>(() => emptyWalkingGuidance());

/** Called at location updates, delayed haptic taps and speech dequeue. */
export function routeManeuverAllowed() {
  return walkingRouteManeuverAllowed(useWalkingGuidance.getState(), Date.now());
}
