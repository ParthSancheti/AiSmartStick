import type { BoundingBox, SpatialSide, SpatialDepth } from './types';

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
