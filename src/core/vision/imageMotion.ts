import { getVisibleBoundingBox } from './spatial';
import type { BoundingBox, ImageMotionEvidence } from './types';

/** Software stability limits for an advisory image statistic, not hardware/safety calibration. */
export const IMAGE_MOTION_POLICY = {
  maximumIntervalMs: 1000,
  maximumSpanMs: 1000,
  maximumSamples: 5,
  minimumSamples: 3,
  // Ignore tiny changes in box area from detector rounding/jitter.
  relativeAreaDeadband: 0.02,
} as const;

export interface ImageBoxSample {
  box: BoundingBox;
  at: number;
}

export function unknownImageMotion(reason: ImageMotionEvidence['reason'], sampleCount = 0, spanMs = 0): ImageMotionEvidence {
  return { trend: 'UNKNOWN', logAreaRatePerSecond: null, sampleCount, spanMs, reason };
}

export function touchesImageEdge(box: BoundingBox): boolean {
  return box.x <= 0 || box.y <= 0 || box.x + box.w >= 1 || box.y + box.h >= 1;
}

/**
 * Consecutive boxes can describe expansion in the image only. Entry through an image edge,
 * missed detections and long intervals invalidate the estimate instead of implying approach.
 */
export function measureImageMotion(samples: readonly ImageBoxSample[]): ImageMotionEvidence {
  if (samples.length === 0) return unknownImageMotion('insufficient_history');
  samples = samples.slice(-IMAGE_MOTION_POLICY.maximumSamples);
  const spanMs = samples[samples.length - 1].at - samples[0].at;
  const base = { sampleCount: samples.length, spanMs: Number.isFinite(spanMs) ? Math.max(0, spanMs) : 0 };
  if (!Number.isFinite(spanMs) || spanMs < 0 || spanMs > IMAGE_MOTION_POLICY.maximumSpanMs) {
    return unknownImageMotion('gap', base.sampleCount, base.spanMs);
  }
  const areas: number[] = [];
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    const visible = getVisibleBoundingBox(sample.box);
    if (!visible || touchesImageEdge(sample.box)) return unknownImageMotion('edge_clipped', base.sampleCount, base.spanMs);
    if (!Number.isFinite(sample.at) || (index > 0 && (sample.at <= samples[index - 1].at
      || sample.at - samples[index - 1].at >= IMAGE_MOTION_POLICY.maximumIntervalMs))) {
      return unknownImageMotion('gap', base.sampleCount, base.spanMs);
    }
    areas.push(visible.w * visible.h);
  }
  if (samples.length < IMAGE_MOTION_POLICY.minimumSamples) return unknownImageMotion('insufficient_history', base.sampleCount, base.spanMs);
  const directions: number[] = [];
  const rates: number[] = [];
  for (let index = 1; index < samples.length; index++) {
    const ratio = areas[index] / areas[index - 1];
    directions.push(Math.abs(ratio - 1) <= IMAGE_MOTION_POLICY.relativeAreaDeadband ? 0 : Math.sign(ratio - 1));
    rates.push(Math.log(ratio) * 1000 / (samples[index].at - samples[index - 1].at));
  }
  const direction = directions[0];
  if (!directions.every(value => value === direction) || rates.some(rate => !Number.isFinite(rate))) {
    return unknownImageMotion('inconsistent', base.sampleCount, base.spanMs);
  }
  // The median avoids a single interval dominating the diagnostic; all intervals must agree.
  rates.sort((a, b) => a - b);
  const mid = Math.floor(rates.length / 2);
  const rate = rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
  return {
    ...base,
    trend: direction > 0 ? 'EXPANDING' : direction < 0 ? 'SHRINKING' : 'STABLE',
    logAreaRatePerSecond: rate,
    reason: null,
  };
}
