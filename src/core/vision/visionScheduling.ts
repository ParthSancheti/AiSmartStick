import type { SensorContext } from './sensorConditioning';
import { THRESHOLDS } from './sensorConditioning';

/** Retain the existing maximum 4 FPS. Physical walking responsiveness still requires validation. */
export const VISION_SCHEDULING = { frameIntervalMs: 250, idleCheckMs: 400, approachLookAheadMs: 2000 } as const;

/** Navigation/walking needs scene awareness before sonar range; page visibility is deliberately irrelevant. */
export function visionCaptureRequired(input: {
  context: SensorContext;
  navigationActive: boolean;
  walkingSessionActive: boolean;
  awarenessCm: number;
}) {
  if (input.navigationActive || input.walkingSessionActive) return true;
  const ctx = input.context;
  if (ctx.motion === 'WALKING' || ctx.motion === 'SWINGING' || ctx.motion === 'RAPID_MOTION') return true;
  const freshRange = ctx.ultrasonic.state === 'valid' && ctx.ultrasonic.ageMs >= 0
    && ctx.ultrasonic.ageMs <= THRESHOLDS.US_STALE_MS && ctx.ultrasonic.value != null
    && Number.isFinite(ctx.ultrasonic.value) && ctx.ultrasonic.value >= 2 && ctx.ultrasonic.value <= 450;
  if (!freshRange) return false;
  if (ctx.ultrasonic.value! <= input.awarenessCm) return true;
  const a = ctx.ultrasonicApproach;
  return a?.confidence === 'good' && a.trend === 'APPROACHING' && a.timeToWarningMs != null
    && a.timeToWarningMs >= 0 && a.timeToWarningMs <= VISION_SCHEDULING.approachLookAheadMs;
}
