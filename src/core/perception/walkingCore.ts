import { EVIDENCE_FRESHNESS } from './evidencePolicy';

export type SpatialSide = 'LEFT' | 'CENTER' | 'RIGHT';
export type GuidanceSeverity = 'unavailable' | 'none' | 'awareness' | 'warning' | 'danger';
export type LocalObstaclePlan = 'OBSERVE' | 'SLOW_AND_CHECK' | 'STOP_AND_SCAN' | 'SENSING_UNAVAILABLE';
export type WalkingHoldReason = 'obstacle' | 'sensing' | 'release_confirmation' | 'clock' | 'configuration' | null;
export const WALKING_GUIDANCE_POLICY = {
  /** Advisory range-rate only; never an object speed, stopping guarantee, or motor threshold. */
  approachLookAheadMs: 2000, freshnessCheckMs: 400,
  alertRepeatMs: 2500, warningRepeatMs: 3500, awarenessRepeatMs: 10_000,
  releaseMarginCm: 10, releaseRangeSamples: 3, releaseSceneFrames: 2, releaseMinimumDurationMs: 700,
  /** Bounded pose proxies pending mounting calibration. Yaw is not measured. */
  maximumTiltDegrees: 35, maximumPoseChangeDegrees: 15,
  maximumAngularRateDegreesPerSecond: 90, maximumCapturePoseSkewMs: 500,
} as const;
export interface WalkingThresholds { awarenessCm: number; warningCm: number; dangerCm: number }
/** Normalized evidence on one caller-owned clock. No device or transport API is required. */
export interface WalkingRangeEvidence {
  state: 'measured' | 'no_return' | 'invalid' | 'unavailable'; measuredAt: number; distanceCm: number | null;
  boardZone?: 'unknown' | 'normal' | 'awareness' | 'warning' | 'danger';
  approach?: { confident: boolean; closingSpeedCmS: number | null; timeToWarningMs: number | null;
    warningDistanceCm: number; sampleCount: number; spanMs: number };
}
export interface WalkingPoseEvidence {
  sampledAt: number; orientationAt: number; angularRateAt: number; valid: boolean;
  motion: 'UNKNOWN' | 'STABLE' | 'WALKING' | 'SWINGING' | 'RAPID_MOTION';
  pitchDegrees: number | null; rollDegrees: number | null; angularRateDegreesPerSecond: number | null;
}
export interface WalkingVisualObject {
  label: string; side: SpatialSide; occupiedSides: SpatialSide[]; observedAt: number;
  confirmed: boolean; valid: boolean; hazard: 'unknown' | 'safe' | 'awareness' | 'warning' | 'danger';
  /** Image growth, never physical speed, depth, or time to collision. */
  imageMotion?: { trend: 'UNKNOWN' | 'STABLE' | 'EXPANDING' | 'SHRINKING'; samples: number; spanMs: number };
}
export interface WalkingCameraEvidence {
  capturedAt: number; completedAt: number; valid: boolean; pose: WalkingPoseEvidence | null; objects: WalkingVisualObject[];
}
export interface WalkingCoreInput {
  now: number; thresholds: WalkingThresholds; range: WalkingRangeEvidence | null;
  pose: WalkingPoseEvidence | null; camera: WalkingCameraEvidence | null; walking: boolean; sensorRequired: boolean;
}
export interface WalkingReleaseEvidence {
  since: number | null; rangeSamples: number; sceneFrames: number; lastRangeAt: number | null; lastSceneAt: number | null;
}
export interface WalkingTemporalState {
  holdSince: number | null;
  /** Evidence older than this instant cannot resolve an episode after a clock regression. */
  evidenceNotBefore: number | null; lastRangeAt: number | null; lastSceneAt: number | null;
  thresholdKey: string; release: WalkingReleaseEvidence;
}
export type WalkingEffect = { type: 'HOLD_ROUTE'; reason: Exclude<WalkingHoldReason, null> }
  | { type: 'RELEASE_ROUTE' } | { type: 'ESCALATE_ALERT'; severity: 'awareness' | 'warning' | 'danger' };
export interface WalkingGuidance {
  severity: GuidanceSeverity; plan: LocalObstaclePlan; frontDistanceCm: number | null;
  approaching: boolean; timeToWarningMs: number | null;
  /** Image observations, never free space, traversable lanes, or measured clearance. */
  observedObjects: { label: string; side: SpatialSide; occupiedSides: SpatialSide[] }[];
  directionsReliable: boolean;
  /** Sides to inspect while stopped, never permission to move or a measured bypass. */
  inspectionCandidates: SpatialSide[]; routeHold: boolean; sensorRequired: boolean;
  evaluatedAt: number; validUntil: number; holdReason: WalkingHoldReason; reasonCodes: string[];
  temporal: WalkingTemporalState;
  /** Declarative transitions. The caller owns effect execution. */
  effects: WalkingEffect[];
}
const emptyRelease = (): WalkingReleaseEvidence => ({ since: null, rangeSamples: 0, sceneFrames: 0, lastRangeAt: null, lastSceneAt: null });
export const emptyWalkingGuidance = (): WalkingGuidance => ({
  severity: 'none', plan: 'OBSERVE', frontDistanceCm: null, approaching: false, timeToWarningMs: null,
  observedObjects: [], directionsReliable: false, inspectionCandidates: [], routeHold: false, sensorRequired: false,
  evaluatedAt: 0, validUntil: 0, holdReason: null, reasonCodes: [], effects: [],
  temporal: { holdSince: null, evidenceNotBefore: null, lastRangeAt: null, lastSceneAt: null, thresholdKey: '', release: emptyRelease() },
});
const rank: Record<GuidanceSeverity, number> = { unavailable: 0, none: 0, awareness: 1, warning: 2, danger: 3 };
export function guidanceRank(severity: GuidanceSeverity) { return rank[severity]; }
const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
const freshAt = (at: number, now: number, limit: number) => finite(at) && at >= 0 && finite(now) && at <= now && now - at <= limit;
const circularDifference = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
function poseIssue(pose: WalkingPoseEvidence | null, now: number, evidenceNotBefore: number | null): string | null {
  if (!pose?.valid || ![pose.pitchDegrees, pose.rollDegrees, pose.angularRateDegreesPerSecond].every(finite)) return 'pose_invalid';
  if (![pose.sampledAt, pose.orientationAt, pose.angularRateAt].every(at => freshAt(at, now, EVIDENCE_FRESHNESS.poseMs))) return 'pose_stale';
  if (evidenceNotBefore !== null && [pose.sampledAt, pose.orientationAt, pose.angularRateAt].some(at => at < evidenceNotBefore)) return 'pose_clock_invalid';
  if (pose.orientationAt > pose.sampledAt || pose.angularRateAt > pose.sampledAt) return 'pose_clock_invalid';
  if (pose.motion !== 'STABLE' && pose.motion !== 'WALKING') return 'pose_unstable';
  if (pose.angularRateDegreesPerSecond! < 0 || pose.angularRateDegreesPerSecond! >= WALKING_GUIDANCE_POLICY.maximumAngularRateDegreesPerSecond) return 'pose_unstable';
  if (Math.abs(pose.pitchDegrees!) > WALKING_GUIDANCE_POLICY.maximumTiltDegrees || Math.abs(pose.rollDegrees!) > WALKING_GUIDANCE_POLICY.maximumTiltDegrees) return 'pose_tilted';
  return null;
}
/**
 * Pure deterministic reducer. Raw danger escalates immediately. A past hold needs sustained,
 * distinct range AND camera evidence with compatible usable pose to resolve. No echo, absence,
 * image growth, or unoccupied image bands never establish physical clearance.
 */
export function advanceWalkingGuidance(input: WalkingCoreInput, previous?: WalkingGuidance): WalkingGuidance {
  const { now, thresholds, range, camera } = input;
  const reasons = new Set<string>();
  const nowValid = finite(now) && now >= 0;
  const previousTemporal = previous?.temporal;
  const clockRegressed = !nowValid || !!(previous && now < previous.evaluatedAt);
  const thresholdKey = `${thresholds.dangerCm}:${thresholds.warningCm}:${thresholds.awarenessCm}`;
  const configurationValid = [thresholds.awarenessCm, thresholds.warningCm, thresholds.dangerCm].every(finite)
    && thresholds.dangerCm >= 2 && thresholds.dangerCm < thresholds.warningCm
    && thresholds.warningCm < thresholds.awarenessCm && thresholds.awarenessCm <= 450;
  const configurationChanged = !!previousTemporal?.thresholdKey && previousTemporal.thresholdKey !== thresholdKey;
  const evidenceNotBefore = clockRegressed ? Math.max(previous?.evaluatedAt ?? 0, previousTemporal?.evidenceNotBefore ?? -Infinity)
    : previousTemporal?.evidenceNotBefore ?? null;
  if (clockRegressed) reasons.add('clock_regressed');
  if (!configurationValid) reasons.add('invalid_thresholds');
  const rangeClockValid = !!range && freshAt(range.measuredAt, now, EVIDENCE_FRESHNESS.rangeMs)
    && range.measuredAt >= (evidenceNotBefore ?? -Infinity) && !clockRegressed;
  const rangeChannelFresh = rangeClockValid && (range!.state === 'measured' || range!.state === 'no_return');
  const distance = rangeChannelFresh && range!.state === 'measured' && finite(range!.distanceCm)
    && range!.distanceCm >= 2 && range!.distanceCm <= 450 ? range!.distanceCm : null;
  const malformedMeasuredRange = rangeChannelFresh && range!.state === 'measured' && distance === null;
  if (!range) reasons.add('range_unavailable');
  else if (!rangeClockValid) reasons.add('range_stale_or_clock_invalid');
  else if (range.state === 'no_return') reasons.add('range_no_return');
  else if (range.state !== 'measured' || malformedMeasuredRange) reasons.add('range_unavailable');
  const cameraFresh = !!camera && camera.valid && !clockRegressed
    && freshAt(camera.capturedAt, now, EVIDENCE_FRESHNESS.cameraMs)
    && finite(camera.completedAt) && camera.capturedAt <= camera.completedAt && camera.completedAt <= now
    && camera.capturedAt >= (evidenceNotBefore ?? -Infinity);
  const priorRangeAt = previousTemporal?.lastRangeAt ?? null;
  const priorSceneAt = previousTemporal?.lastSceneAt ?? null;
  const rangeInOrder = !rangeClockValid || priorRangeAt === null || range!.measuredAt >= priorRangeAt;
  const sceneInOrder = !cameraFresh || priorSceneAt === null || camera!.capturedAt >= priorSceneAt;
  if (!rangeInOrder || !sceneInOrder) reasons.add('evidence_out_of_order');
  if (!camera) reasons.add('camera_unavailable');
  else if (!cameraFresh) reasons.add('camera_stale_or_clock_invalid');
  const currentPoseIssue = poseIssue(input.pose, now, evidenceNotBefore);
  const capturedPoseIssue = poseIssue(camera?.pose ?? null, now, evidenceNotBefore);
  if (currentPoseIssue) reasons.add(currentPoseIssue);
  if (camera && capturedPoseIssue) reasons.add(`capture_${capturedPoseIssue}`);
  const poseSkew = camera?.pose ? Math.abs(camera.capturedAt - camera.pose.sampledAt) : Infinity;
  if (cameraFresh && poseSkew > WALKING_GUIDANCE_POLICY.maximumCapturePoseSkewMs) reasons.add('capture_pose_mismatch');
  const poseChanged = !!input.pose && !!camera?.pose && !currentPoseIssue && !capturedPoseIssue
    && (circularDifference(input.pose.pitchDegrees!, camera.pose.pitchDegrees!) > WALKING_GUIDANCE_POLICY.maximumPoseChangeDegrees
      || circularDifference(input.pose.rollDegrees!, camera.pose.rollDegrees!) > WALKING_GUIDANCE_POLICY.maximumPoseChangeDegrees);
  if (poseChanged) reasons.add('pose_changed');
  const directionsReliable = cameraFresh && sceneInOrder && !currentPoseIssue && !capturedPoseIssue && !poseChanged
    && poseSkew <= WALKING_GUIDANCE_POLICY.maximumCapturePoseSkewMs;
  const validObservation = (o: WalkingVisualObject) => o.valid && finite(o.observedAt) && cameraFresh
    && o.observedAt <= camera!.capturedAt && freshAt(o.observedAt, now, EVIDENCE_FRESHNESS.cameraMs);
  const objects = cameraFresh ? camera!.objects.filter(o => o.confirmed && validObservation(o)) : [];
  const visualCenterWarning = objects.some(o => o.occupiedSides.includes('CENTER') && (o.hazard === 'warning' || o.hazard === 'danger'));
  const uncertainCenter = cameraFresh && camera!.objects.some(o => o.occupiedSides.includes('CENTER') && (!o.confirmed || !validObservation(o)));
  if (uncertainCenter) reasons.add('unresolved_center');
  const uncertainScene = cameraFresh && camera!.objects.some(o => !validObservation(o));
  if (uncertainScene) reasons.add('invalid_visual_evidence');
  const imageExpansionCaution = directionsReliable && objects.some(o => o.occupiedSides.includes('CENTER')
    && o.imageMotion?.trend === 'EXPANDING' && o.imageMotion.samples >= 3 && o.imageMotion.spanMs > 0);
  if (imageExpansionCaution) reasons.add('image_expansion_caution');
  let severity: GuidanceSeverity = 'none';
  if (distance != null && configurationValid) {
    if (distance < thresholds.dangerCm) severity = 'danger';
    else if (distance < thresholds.warningCm) severity = 'warning';
    else if (distance <= thresholds.awarenessCm) severity = 'awareness';
  }
  if (rangeChannelFresh && range?.boardZone && range.boardZone in rank && rank[range.boardZone as GuidanceSeverity] > rank[severity]) severity = range.boardZone as GuidanceSeverity;
  // Image warnings remain qualitative when pose is unavailable. Unreliable pose cannot authorize
  // direction or prove an obstruction episode has ended.
  if (visualCenterWarning && rank[severity] < rank.warning) severity = 'warning';
  else if (input.walking && objects.length && rank[severity] < rank.awareness) severity = 'awareness';
  const approach = range?.approach;
  const approaching = distance != null && rangeInOrder && !currentPoseIssue && !!approach?.confident
    && finite(approach.closingSpeedCmS) && approach.closingSpeedCmS > 0
    && approach.sampleCount >= 3 && finite(approach.spanMs) && approach.spanMs >= 500
    && approach.warningDistanceCm === thresholds.warningCm && configurationValid
    && (approach.timeToWarningMs === null || finite(approach.timeToWarningMs) && approach.timeToWarningMs >= 0);
  const timeToWarningMs = approaching && finite(approach?.timeToWarningMs) ? Math.max(0, approach.timeToWarningMs - (now - range!.measuredAt)) : null;
  if (approaching && timeToWarningMs != null && timeToWarningMs <= WALKING_GUIDANCE_POLICY.approachLookAheadMs && rank[severity] < rank.awareness) severity = 'awareness';
  const sensingUnavailable = input.sensorRequired && (!rangeChannelFresh || malformedMeasuredRange);
  const hazardHold = severity === 'warning' || severity === 'danger';
  let release = emptyRelease();
  const previousHeld = !!previous?.routeHold;
  const releaseEligible = previousHeld && !hazardHold && !sensingUnavailable && !clockRegressed && configurationValid
    && distance != null && distance >= thresholds.warningCm + WALKING_GUIDANCE_POLICY.releaseMarginCm
    && directionsReliable && !uncertainCenter && !uncertainScene && !imageExpansionCaution && rangeInOrder && sceneInOrder;
  let releaseConfirmed = false;
  if (releaseEligible) {
    const oldRelease = previousTemporal?.release;
    const proofContinuous = oldRelease?.lastRangeAt != null && oldRelease.lastSceneAt != null
      && freshAt(oldRelease.lastRangeAt, now, EVIDENCE_FRESHNESS.rangeMs)
      && freshAt(oldRelease.lastSceneAt, now, EVIDENCE_FRESHNESS.cameraMs);
    const prior = !configurationChanged && proofContinuous ? oldRelease : undefined;
    release = prior?.since != null ? { ...prior } : emptyRelease();
    const newRange = (release.lastRangeAt ?? previousTemporal?.holdSince ?? -Infinity) < range!.measuredAt;
    const newScene = (release.lastSceneAt ?? previousTemporal?.holdSince ?? -Infinity) < camera!.capturedAt;
    if (newRange) { release.rangeSamples++; release.lastRangeAt = range!.measuredAt; }
    if (newScene) { release.sceneFrames++; release.lastSceneAt = camera!.capturedAt; }
    if (newRange || newScene) release.since ??= Math.max(range!.measuredAt, camera!.capturedAt);
    const latestCorroboratedAt = Math.min(release.lastRangeAt ?? -Infinity, release.lastSceneAt ?? -Infinity);
    releaseConfirmed = release.since != null && release.rangeSamples >= WALKING_GUIDANCE_POLICY.releaseRangeSamples
      && release.sceneFrames >= WALKING_GUIDANCE_POLICY.releaseSceneFrames
      && latestCorroboratedAt - release.since >= WALKING_GUIDANCE_POLICY.releaseMinimumDurationMs;
  }
  const routeHold = hazardHold || sensingUnavailable || clockRegressed || !configurationValid || (previousHeld && !releaseConfirmed);
  const holdReason: WalkingHoldReason = !configurationValid ? 'configuration' : clockRegressed ? 'clock'
    : hazardHold ? 'obstacle' : sensingUnavailable ? 'sensing' : routeHold ? 'release_confirmation' : null;
  if (holdReason === 'release_confirmation') reasons.add('release_confirmation_pending');
  if ((sensingUnavailable || routeHold) && severity === 'none') severity = 'unavailable';
  const inspectionCandidates: SpatialSide[] = hazardHold && directionsReliable && !uncertainScene
    ? (['LEFT', 'RIGHT'] as SpatialSide[]).filter(side => !camera!.objects.some(o => o.occupiedSides.includes(side))) : [];
  const effects: WalkingEffect[] = [];
  if (routeHold && !previousHeld) effects.push({ type: 'HOLD_ROUTE', reason: holdReason! });
  if (!routeHold && previousHeld) effects.push({ type: 'RELEASE_ROUTE' });
  if (rank[severity] > rank[previous?.severity ?? 'none']) effects.push({ type: 'ESCALATE_ALERT', severity: severity as 'awareness' | 'warning' | 'danger' });
  const validUntil = rangeChannelFresh && !malformedMeasuredRange ? range!.measuredAt + EVIDENCE_FRESHNESS.rangeMs : nowValid ? now : 0;
  return { severity, plan: routeHold ? holdReason === 'sensing' || holdReason === 'clock' || holdReason === 'configuration' ? 'SENSING_UNAVAILABLE' : 'STOP_AND_SCAN'
      : severity === 'awareness' ? 'SLOW_AND_CHECK' : 'OBSERVE',
    frontDistanceCm: distance, approaching, timeToWarningMs,
    observedObjects: objects.slice(0, 12).map(o => ({ label: o.label, side: o.side, occupiedSides: [...o.occupiedSides] })),
    directionsReliable, inspectionCandidates, routeHold, sensorRequired: input.sensorRequired,
    evaluatedAt: nowValid ? now : previous?.evaluatedAt ?? 0, validUntil, holdReason, reasonCodes: [...reasons], effects,
    temporal: { holdSince: routeHold ? previousTemporal?.holdSince ?? (nowValid ? now : 0) : null,
      evidenceNotBefore, lastRangeAt: rangeClockValid ? Math.max(priorRangeAt ?? -Infinity, range!.measuredAt) : priorRangeAt,
      lastSceneAt: cameraFresh ? Math.max(priorSceneAt ?? -Infinity, camera!.capturedAt) : priorSceneAt,
      thresholdKey, release: routeHold ? release : emptyRelease() },
  };
}
/** Recheck at route cue dequeue, including between periodic state updates. */
export function walkingRouteManeuverAllowed(state: WalkingGuidance, now: number): boolean {
  return finite(now) && !state.routeHold && now >= state.evaluatedAt && (!state.sensorRequired || now <= state.validUntil);
}
