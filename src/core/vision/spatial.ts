import type { BoundingBox, SpatialSide, SpatialDepth } from './types';

/** A finite positive box must have some visible area before it can supply directional evidence. */
export function isValidBoundingBox(box: BoundingBox): boolean {
  return [box.x, box.y, box.w, box.h].every(Number.isFinite)
    && box.w > 0 && box.h > 0
    && box.x < 1 && box.y < 1 && box.x + box.w > 0 && box.y + box.h > 0;
}

/** Use the existing image bands, including every positive overlap for broad objects. */
export function getOccupiedSides(box: BoundingBox): SpatialSide[] {
  if (!isValidBoundingBox(box)) return [];
  const left = Math.max(0, box.x);
  const right = Math.min(1, box.x + box.w);
  const sides: SpatialSide[] = [];
  if (left < 0.35 && right > 0) sides.push('LEFT');
  if (left < 0.65 && right > 0.35) sides.push('CENTER');
  if (left < 1 && right > 0.65) sides.push('RIGHT');
  return sides;
}

// Normalized screen coordinates (0 to 1)
export function getSpatialSide(box: BoundingBox): SpatialSide {
  const cx = box.x + box.w / 2;
  // Use a wide center band since cane users care mostly about direct path
  if (cx < 0.35) return 'LEFT';
  if (cx > 0.65) return 'RIGHT';
  return 'CENTER';
}

// Highly qualitative depth estimation based on bounding box vertical position and size.
// Assumes phone is mounted on stick, looking slightly downwards.
export function getSpatialDepth(box: BoundingBox): SpatialDepth {
  if (!isValidBoundingBox(box)) return 'UNKNOWN';
  // Bounding box bottom edge (y = 0 is top, y = 1 is bottom)
  const bottom = box.y + box.h;
  
  if (bottom > 0.85) {
    return 'NEAR'; // Bottom of object is very low in the frame (close to user)
  }
  if (bottom > 0.5) {
    return 'MID';
  }
  if (bottom > 0.2) {
    return 'FAR';
  }
  return 'UNKNOWN';
}
