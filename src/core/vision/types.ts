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
export type SpatialDepth = 'NEAR' | 'MID' | 'FAR' | 'UNKNOWN';

export interface FusedObject {
  track: ObjectTrack;
  label: string;
  visualConfidence: number;
  /** Associated only if geometry and timing allow. DO NOT assume visual object is exactly this distance unless confirmed. */
  ultrasonicDistanceCm: number | null;
  side: SpatialSide;
  depth: SpatialDepth;
  quality: 'good' | 'degraded' | 'unknown';
  freshnessMs: number;
  hazardLevel: 'safe' | 'awareness' | 'warning' | 'danger';
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
  processingLatencyMs: number | null;
  sensorContext: SensorContext;
  objects: ObjectObservation[];
  tracks: ObjectTrack[];
  fusedObjects: FusedObject[];
  pathState: PathState;
  overallQuality: 'good' | 'degraded' | 'poor';
}
