import type { BoundingBox, SpatialSide, SpatialDepth } from './types';

/** A finite positive box must have some visible area before it can supply directional evidence. */
export function isValidBoundingBox(box: BoundingBox): boolean {
  return [box.x, box.y, box.w, box.h, box.x + box.w, box.y + box.h].every(Number.isFinite)
    && box.w > 0 && box.h > 0
    && box.x < 1 && box.y < 1 && box.x + box.w > 0 && box.y + box.h > 0
    && (Math.min(1, box.x + box.w) - Math.max(0, box.x))
      * (Math.min(1, box.y + box.h) - Math.max(0, box.y)) > 0;
}

/** Only visible image geometry can support overlap, position, or size-change evidence. */
export function getVisibleBoundingBox(box: BoundingBox): BoundingBox | null {
  if (!isValidBoundingBox(box)) return null;
  if (box.x >= 0 && box.y >= 0 && box.x + box.w <= 1 && box.y + box.h <= 1) return { ...box };
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const w = Math.min(1, box.x + box.w) - x;
  const h = Math.min(1, box.y + box.h) - y;
  return w * h > 0 ? { x, y, w, h } : null;
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
  const visible = getVisibleBoundingBox(box);
  // Invalid input supplies no occupied sides; CENTER here is a compatibility placeholder.
  const cx = visible ? visible.x + visible.w / 2 : 0.5;
  // Use a wide center band since cane users care mostly about direct path
  if (cx < 0.35) return 'LEFT';
  if (cx > 0.65) return 'RIGHT';
  return 'CENTER';
}

// Highly qualitative depth estimation based on bounding box vertical position and size.
// Assumes phone is mounted on stick, looking slightly downwards.
export function getSpatialDepth(box: BoundingBox): SpatialDepth {
  const visible = getVisibleBoundingBox(box);
  if (!visible) return 'UNKNOWN';
  // Bounding box bottom edge (y = 0 is top, y = 1 is bottom)
  const bottom = visible.y + visible.h;
  
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
