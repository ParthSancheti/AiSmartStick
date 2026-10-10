import { create } from 'zustand';
import type { SensorContext } from '../vision/sensorConditioning';
import { THRESHOLDS } from '../vision/sensorConditioning';
import { VISION_OBSERVATION_STALE_MS, type DetectionSnapshot, type FusedObject, type SpatialSide } from '../vision/types';
import type { ObstacleZone } from '../../../shared/deviceProtocol';

export type GuidanceSeverity = 'unavailable' | 'none' | 'awareness' | 'warning' | 'danger';
export type LocalObstaclePlan = 'OBSERVE' | 'SLOW_AND_CHECK' | 'STOP_AND_SCAN' | 'SENSING_UNAVAILABLE';
export const WALKING_GUIDANCE_POLICY = {
  /** Advisory look-ahead only, relative to the configured warning range; not a motor threshold. */
  approachLookAheadMs: 2000,
  freshnessCheckMs: 400,
  alertRepeatMs: 2500,
  warningRepeatMs: 3500,
  awarenessRepeatMs: 10_000,
} as const;

export interface WalkingGuidance {
  severity: GuidanceSeverity;
  plan: LocalObstaclePlan;
  frontDistanceCm: number | null;
  approaching: boolean;
  timeToWarningMs: number | null;
  /** Image observations; these are not free-space, map lanes, or measured clearance. */
  observedObjects: { label: string; side: SpatialSide; occupiedSides: SpatialSide[] }[];
  directionsReliable: boolean;
  /** Candidate sides to inspect while stopped. Never permission to move or a measured bypass. */
  inspectionCandidates: SpatialSide[];
  routeHold: boolean;
  sensorRequired: boolean;
  evaluatedAt: number;
  validUntil: number;
}

export const emptyWalkingGuidance = (): WalkingGuidance => ({
  severity: 'none', plan: 'OBSERVE', frontDistanceCm: null, approaching: false,
  timeToWarningMs: null, observedObjects: [], directionsReliable: false, inspectionCandidates: [], routeHold: false,
  sensorRequired: false, evaluatedAt: 0, validUntil: 0,
});
export const useWalkingGuidance = create<WalkingGuidance>(() => emptyWalkingGuidance());

const rank: Record<GuidanceSeverity, number> = { unavailable: 0, none: 0, awareness: 1, warning: 2, danger: 3 };
export function guidanceRank(severity: GuidanceSeverity) { return rank[severity]; }

/** Pure, bounded local advisory. Raw sonar and visual observations remain separate evidence. */
export function evaluateWalkingGuidance(input: {
  context: SensorContext;
  snapshot: DetectionSnapshot | null;
  thresholds: { awarenessCm: number; warningCm: number; dangerCm: number };
  boardZone?: ObstacleZone;
  linked: boolean;
  walking: boolean;
  sensorRequired: boolean;
  previous?: WalkingGuidance;
  now: number;
}): WalkingGuidance {
  const { context: ctx, snapshot, thresholds, now, previous } = input;
  const freshRange = input.linked && ctx.timestamp <= now && now - ctx.timestamp <= THRESHOLDS.US_STALE_MS
    && ctx.ultrasonic.state === 'valid' && ctx.ultrasonic.ageMs >= 0
    && ctx.ultrasonic.ageMs + now - ctx.timestamp <= THRESHOLDS.US_STALE_MS;
  const distance = freshRange && ctx.ultrasonic.value != null && Number.isFinite(ctx.ultrasonic.value)
    && ctx.ultrasonic.value >= 2 && ctx.ultrasonic.value <= 450 ? ctx.ultrasonic.value : null;
  const visualFresh = input.linked && snapshot?.frameTimestamp != null
    && snapshot.frameTimestamp <= now && now - snapshot.frameTimestamp <= VISION_OBSERVATION_STALE_MS;
  const objects: FusedObject[] = visualFresh ? snapshot!.fusedObjects.filter(o => o.evidence === 'confirmed'
    && Number.isFinite(o.track.lastSeenMs) && o.freshnessMs >= 0
    && now >= o.track.lastSeenMs && now - o.track.lastSeenMs <= VISION_OBSERVATION_STALE_MS) : [];
  const usablePose = (c: SensorContext) => (c.motion === 'STABLE' || c.motion === 'WALKING')
    && c.timestamp <= now && now - c.timestamp <= THRESHOLDS.IMU_STALE_MS
    && c.orientation?.state === 'valid' && c.gyro?.state === 'valid'
    && c.orientation.ageMs >= 0 && c.orientation.ageMs + now - c.timestamp <= THRESHOLDS.IMU_STALE_MS
    && c.gyro.ageMs >= 0 && c.gyro.ageMs + now - c.timestamp <= THRESHOLDS.IMU_STALE_MS;
  const directionsReliable = !!visualFresh && usablePose(ctx) && usablePose(snapshot!.frameSensorContext ?? snapshot!.sensorContext);
  let severity: GuidanceSeverity = 'none';
  if (distance != null) {
    if (distance < thresholds.dangerCm) severity = 'danger';
    else if (distance < thresholds.warningCm) severity = 'warning';
    else if (distance <= thresholds.awarenessCm) severity = 'awareness';
  }
  // The MCU can retain its stronger warning during no-echo de-escalation confirmation.
  if (freshRange && input.boardZone && input.boardZone in rank && rank[input.boardZone as GuidanceSeverity] > rank[severity]) {
    severity = input.boardZone as GuidanceSeverity;
  }
  const visualCenterWarning = objects.some(o => o.occupiedSides.includes('CENTER')
    && (o.hazardLevel === 'warning' || o.hazardLevel === 'danger'));
  if (visualCenterWarning && rank[severity] < rank.warning) severity = 'warning';
  else if (input.walking && objects.length && rank[severity] < rank.awareness) severity = 'awareness';

  const approach = ctx.ultrasonicApproach;
  const approaching = distance != null && approach?.confidence === 'good' && approach.trend === 'APPROACHING';
  const timeToWarningMs = approaching ? approach.timeToWarningMs : null;
  // A shrinking forward range warrants attention before the warning boundary, within measured range only.
  const imminent = approaching && timeToWarningMs != null && timeToWarningMs <= WALKING_GUIDANCE_POLICY.approachLookAheadMs;
  if (input.walking && imminent && rank[severity] < rank.awareness) severity = 'awareness';
  const sensingUnavailable = input.sensorRequired && !freshRange;
  if (sensingUnavailable && severity === 'none') severity = 'unavailable';
  const hazardHold = severity === 'warning' || severity === 'danger';
  // Missing echoes/frames cannot clear a previously observed obstruction. A fresh greater range and
  // a fresh scene without a center warning allow map instructions again, never a 'path is clear' claim.
  const uncertainCenter = visualFresh && snapshot!.fusedObjects.some(o => o.occupiedSides.includes('CENTER')
    && (o.evidence !== 'confirmed' || !Number.isFinite(o.track.lastSeenMs) || now < o.track.lastSeenMs
      || now - o.track.lastSeenMs > VISION_OBSERVATION_STALE_MS));
  const canReleaseHold = distance != null && distance >= thresholds.warningCm && visualFresh && !visualCenterWarning && !uncertainCenter;
  const routeHold = hazardHold || sensingUnavailable || !!(previous?.routeHold && !canReleaseHold);
  if (routeHold && severity === 'none') severity = 'unavailable';
  const sideOccupied = (side: SpatialSide) => objects.some(o => o.occupiedSides.includes(side));
  const inspectionCandidates: SpatialSide[] = hazardHold && directionsReliable
    ? (['LEFT', 'RIGHT'] as SpatialSide[]).filter(side => !sideOccupied(side)) : [];
  const validUntil = freshRange ? now + Math.max(0, THRESHOLDS.US_STALE_MS - ctx.ultrasonic.ageMs - (now - ctx.timestamp)) : now;
  return {
    severity, plan: routeHold ? sensingUnavailable && !hazardHold ? 'SENSING_UNAVAILABLE' : 'STOP_AND_SCAN'
      : severity === 'awareness' ? 'SLOW_AND_CHECK' : 'OBSERVE',
    frontDistanceCm: distance, approaching, timeToWarningMs,
    observedObjects: objects.slice(0, 12).map(o => ({ label: o.label, side: o.side, occupiedSides: [...o.occupiedSides] })), directionsReliable,
    inspectionCandidates, routeHold, sensorRequired: input.sensorRequired, evaluatedAt: now, validUntil,
  };
}

/** Called again at location updates, delayed haptic taps and speech dequeue. */
export function routeManeuverAllowed() {
  const s = useWalkingGuidance.getState();
  const now = Date.now();
  return !s.routeHold && now >= s.evaluatedAt && (!s.sensorRequired || now <= s.validUntil);
}
