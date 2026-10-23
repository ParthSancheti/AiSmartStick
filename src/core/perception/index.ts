/** Portable perception entry point: callers provide measurements, clocks and effect execution. */
export * from './evidencePolicy';
export * from './sensorCore';
export * from './walkingCore';
export * from './walkingEvidence';
export { ObjectTracker } from '../vision/objectTracker';
export { fuseSensors } from '../vision/fusionEngine';
export { GuidanceSpeechPolicy, type WalkingSpeedFix } from '../guidance/speechPolicy';
export { measureImageMotion, IMAGE_MOTION_POLICY } from '../vision/imageMotion';
export type { ObjectObservation, ObjectTrack, DetectionSnapshot, FusedObject, PathState } from '../vision/types';
