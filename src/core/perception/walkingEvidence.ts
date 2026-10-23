import type { SensorContext } from './sensorCore';
import type { DetectionSnapshot } from '../vision/types';
import { advanceWalkingGuidance, type WalkingCoreInput, type WalkingGuidance, type WalkingPoseEvidence, type WalkingThresholds, type WalkingRangeEvidence } from './walkingCore';
export interface ConditionedWalkingInput {
  context: SensorContext; snapshot: DetectionSnapshot | null; thresholds: WalkingThresholds; boardZone?: WalkingRangeEvidence['boardZone'];
  linked: boolean; walking: boolean; sensorRequired: boolean; previous?: WalkingGuidance; now: number;
}
function normalizePose(context: SensorContext): WalkingPoseEvidence {
  const o = context.orientation, g = context.gyro;
  const finite = (n: number) => Number.isFinite(n);
  return { sampledAt: context.timestamp, orientationAt: context.timestamp - o.ageMs, angularRateAt: context.timestamp - g.ageMs,
    valid: o.state === 'valid' && g.state === 'valid' && finite(o.ageMs) && o.ageMs >= 0
      && finite(g.ageMs) && g.ageMs >= 0 && !!g.value && [g.value.x, g.value.y, g.value.z, g.value.mag].every(finite),
    motion: context.motion, pitchDegrees: o.value?.pitch ?? null, rollDegrees: o.value?.roll ?? null, angularRateDegreesPerSecond: g.value?.mag ?? null };
}
/** Pure adapter shared by runtime and replay; never reads a store, clock, or device. */
export function normalizeWalkingEvidence(input: ConditionedWalkingInput): WalkingCoreInput {
  const { context, snapshot } = input;
  const validRangeAge = Number.isFinite(context.timestamp) && context.timestamp <= input.now
    && Number.isFinite(context.ultrasonic.ageMs) && context.ultrasonic.ageMs >= 0;
  const approach = context.ultrasonicApproach;
  return { now: input.now, thresholds: { ...input.thresholds }, walking: input.walking, sensorRequired: input.sensorRequired,
    range: input.linked ? { state: validRangeAge && context.ultrasonic.state === 'valid' ? context.ultrasonic.value === null ? 'no_return' : 'measured' : 'invalid',
      measuredAt: validRangeAge ? context.timestamp - context.ultrasonic.ageMs : NaN, distanceCm: context.ultrasonic.value, boardZone: input.boardZone,
      ...(approach ? { approach: { confident: approach.confidence === 'good' && approach.trend === 'APPROACHING', closingSpeedCmS: approach.closingSpeedCmS,
        // Conditioning already subtracts age through context.timestamp; core subtracts total age.
        timeToWarningMs: approach.timeToWarningMs == null ? null : approach.timeToWarningMs + context.ultrasonic.ageMs,
        warningDistanceCm: approach.warningDistanceCm, sampleCount: approach.sampleCount, spanMs: approach.spanMs } } : {}),
    } : null,
    pose: input.linked ? normalizePose(context) : null,
    camera: input.linked && snapshot?.frameTimestamp != null ? { capturedAt: snapshot.frameTimestamp, completedAt: snapshot.timestamp,
      valid: snapshot.overallQuality !== 'poor' && (snapshot.processingLatencyMs === null || Number.isFinite(snapshot.processingLatencyMs) && snapshot.processingLatencyMs >= 0),
      pose: normalizePose(snapshot.frameSensorContext ?? snapshot.sensorContext),
      objects: snapshot.fusedObjects.map(o => ({ label: o.label, side: o.side, occupiedSides: [...o.occupiedSides], observedAt: o.track.lastSeenMs,
        confirmed: o.evidence === 'confirmed' && o.track.state === 'CONFIRMED' && o.track.misses === 0,
        valid: Number.isFinite(o.freshnessMs) && o.freshnessMs >= 0 && Number.isFinite(o.visualConfidence) && o.visualConfidence > 0 && o.visualConfidence <= 1
          && [o.track.currentBox.x, o.track.currentBox.y, o.track.currentBox.w, o.track.currentBox.h,
            o.track.currentBox.x + o.track.currentBox.w, o.track.currentBox.y + o.track.currentBox.h].every(Number.isFinite)
          && o.track.currentBox.w > 0 && o.track.currentBox.h > 0 && o.track.currentBox.x < 1 && o.track.currentBox.y < 1
          && o.track.currentBox.x + o.track.currentBox.w > 0 && o.track.currentBox.y + o.track.currentBox.h > 0,
        hazard: o.hazardLevel,
        ...(o.track.imageMotion ? { imageMotion: { trend: o.track.imageMotion.trend, samples: o.track.imageMotion.sampleCount, spanMs: o.track.imageMotion.spanMs } } : {}),
      })),
    } : null,
  };
}
export function evaluateWalkingGuidance(input: ConditionedWalkingInput): WalkingGuidance {
  return advanceWalkingGuidance(normalizeWalkingEvidence(input), input.previous);
}
