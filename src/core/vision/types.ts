import type { SensorContext } from './sensorConditioning';

export interface BoundingBox {
  x: number; // normalized 0..1
  y: number;
  w: number;
  h: number;
}

export interface ObjectObservation {
  label: string;
  confidence: number;
  box: BoundingBox;
  centerX: number;
  centerY: number;
  bottomCenterX: number;
  bottomCenterY: number;
  timestamp: number;
}

export type TrackState = 'TENTATIVE' | 'CONFIRMED' | 'LOST' | 'REMOVED';

export interface Vector2D {
  x: number;
  y: number;
}

export interface ObjectTrack {
  trackId: number;
  label: string;
  currentBox: BoundingBox;
  previousBox: BoundingBox | null;
  velocity: Vector2D; // normalized units per second
  ageFrames: number;
  hits: number;
  misses: number;
  lastSeenMs: number;
  state: TrackState;
  confidence: number; // EMA of observation confidences
}

export type SpatialSide = 'LEFT' | 'CENTER' | 'RIGHT';
/** Existing frame-freshness budget; this is a software age limit, not a validated walking speed. */
export const VISION_OBSERVATION_STALE_MS = 1500;
/** Legacy image-position categories. These do not measure physical range or traversable space. */
export type SpatialDepth = 'NEAR' | 'MID' | 'FAR' | 'UNKNOWN';
export type VisualEvidenceState = 'confirmed' | 'tentative' | 'lost' | 'stale' | 'invalid';

export interface FusedObject {
  track: ObjectTrack;
  label: string;
  visualConfidence: number;
  /** A single front ultrasonic beam cannot identify a monocular object. Kept null for compatibility. */
  ultrasonicDistanceCm: number | null;
  side: SpatialSide;
  /** Image bands overlapped by the box; neither physical lane width nor measured clearance. */
  occupiedSides: SpatialSide[];
  evidence: VisualEvidenceState;
  depth: SpatialDepth;
  quality: 'good' | 'degraded' | 'unknown';
  freshnessMs: number;
  hazardLevel: 'unknown' | 'safe' | 'awareness' | 'warning' | 'danger';
}

export type OccupancyState = 'FREE' | 'BLOCKED' | 'UNKNOWN';

export interface PathState {
  left: OccupancyState;
  center: OccupancyState;
  right: OccupancyState;
}

export interface DetectionSnapshot {
  timestamp: number;
  frameTimestamp: number | null;
  frameWidth?: number | null;
  frameHeight?: number | null;
  processingLatencyMs: number | null;
  sensorContext: SensorContext;
  /** Telemetry available before requesting this frame; pose timing is still a phone-side proxy. */
  frameSensorContext?: SensorContext;
  objects: ObjectObservation[];
  tracks: ObjectTrack[];
  fusedObjects: FusedObject[];
  pathState: PathState;
  overallQuality: 'good' | 'degraded' | 'poor';
}
