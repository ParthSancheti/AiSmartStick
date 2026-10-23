import type { BoundingBox, ObjectObservation, ObjectTrack } from './types';
import { VISION_OBSERVATION_STALE_MS } from './types';
import { getVisibleBoundingBox } from './spatial';
import { IMAGE_MOTION_POLICY, measureImageMotion, touchesImageEdge, unknownImageMotion, type ImageBoxSample } from './imageMotion';

function computeIoU(box1: BoundingBox, box2: BoundingBox): number {
  const x1 = Math.max(box1.x, box2.x);
  const y1 = Math.max(box1.y, box2.y);
  const x2 = Math.min(box1.x + box1.w, box2.x + box2.w);
  const y2 = Math.min(box1.y + box1.h, box2.y + box2.h);

  if (x2 < x1 || y2 < y1) return 0;

  const intersection = (x2 - x1) * (y2 - y1);
  const area1 = box1.w * box1.h;
  const area2 = box2.w * box2.h;
  return intersection / (area1 + area2 - intersection);
}

export interface TrackerConfig {
  iouThreshold: number;
  maxMissesBeforeLost: number;
  maxMissesBeforeRemoved: number;
  hitsToConfirm: number;
}

const DEFAULT_CONFIG: TrackerConfig = {
  iouThreshold: 0.3,
  maxMissesBeforeLost: 2,
  maxMissesBeforeRemoved: 5,
  hitsToConfirm: 2,
};

export class ObjectTracker {
  private tracks: ObjectTrack[] = [];
  private nextTrackId = 1;
  private config: TrackerConfig;
  private lastUpdateMs = -Infinity;
  private imageHistory = new Map<number, ImageBoxSample[]>();

  constructor(config: Partial<TrackerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  public update(observations: ObjectObservation[], nowMs: number): ObjectTrack[] {
    // Replayed or out-of-order frames cannot confirm a track or repeatedly count a miss.
    if (!Number.isFinite(nowMs) || nowMs <= this.lastUpdateMs) return this.getTracks();
    this.lastUpdateMs = nowMs;
    // Do not carry confirmation through a gap longer than the existing frame freshness budget.
    this.tracks = this.tracks.filter((track) => nowMs - track.lastSeenMs <= VISION_OBSERVATION_STALE_MS);
    const visibleObservations = observations.flatMap((obs) => {
      const visible = getVisibleBoundingBox(obs.box);
      if (!visible || typeof obs.label !== 'string' || !obs.label.trim()
        || !Number.isFinite(obs.confidence) || obs.confidence <= 0 || obs.confidence > 1) return [];
      return [{ ...obs, box: visible, edgeClipped: touchesImageEdge(obs.box) }];
    });
    // Deterministic geometric order also makes equal-overlap tie breaks independent of detector order.
    visibleObservations.sort((a, b) => a.label.localeCompare(b.label) || a.box.x - b.box.x
      || a.box.y - b.box.y || a.box.w - b.box.w || a.box.h - b.box.h || b.confidence - a.confidence);
    // An exact repeated detection in a frame is still one observation, never a second identity.
    const uniqueObservations = visibleObservations.filter((obs, index) => index === 0
      || obs.label !== visibleObservations[index - 1].label
      || ['x', 'y', 'w', 'h'].some(key => obs.box[key as keyof BoundingBox] !== visibleObservations[index - 1].box[key as keyof BoundingBox]));
    const unassignedTracks = new Set(this.tracks.map((t) => t.trackId));
    const unassignedObs = new Set(uniqueObservations.map((_, i) => i));

    // Choose the strongest overlaps across the whole frame. Iterating tracks first allowed an
    // older, weaker candidate to steal a detection from its substantially better overlapping track.
    const candidates: { track: ObjectTrack; obsIndex: number; iou: number }[] = [];
    for (const track of this.tracks) {
      if (track.state === 'REMOVED') continue;
      for (const obsIdx of unassignedObs) {
        const obs = uniqueObservations[obsIdx];
        if (obs.label !== track.label) continue;
        const iou = computeIoU(track.currentBox, obs.box);
        if (iou > this.config.iouThreshold) candidates.push({ track, obsIndex: obsIdx, iou });
      }
    }
    candidates.sort((a, b) => b.iou - a.iou || a.track.trackId - b.track.trackId || a.obsIndex - b.obsIndex);
    for (const { track, obsIndex } of candidates) {
      if (unassignedTracks.has(track.trackId) && unassignedObs.has(obsIndex)) {
        // Matched
        const obs = uniqueObservations[obsIndex];
        const dt = (nowMs - track.lastSeenMs) / 1000.0;
        const uninterrupted = track.misses === 0 && dt > 0 && dt < IMAGE_MOTION_POLICY.maximumIntervalMs / 1000;
        
        track.previousBox = { ...track.currentBox };
        track.currentBox = { ...obs.box };
        track.hits += 1;
        track.misses = 0;
        track.ageFrames += 1;
        track.lastSeenMs = nowMs;
        track.confidence = track.confidence * 0.7 + obs.confidence * 0.3; // EMA
        
        if (uninterrupted) {
          const cX1 = track.previousBox.x + track.previousBox.w / 2;
          const cY1 = track.previousBox.y + track.previousBox.h / 2;
          const cX2 = track.currentBox.x + track.currentBox.w / 2;
          const cY2 = track.currentBox.y + track.currentBox.h / 2;
          track.velocity = { x: (cX2 - cX1) / dt, y: (cY2 - cY1) / dt };
        } else track.velocity = { x: 0, y: 0 };

        if (obs.edgeClipped) {
          this.imageHistory.delete(track.trackId);
          track.imageMotion = unknownImageMotion('edge_clipped');
        } else {
          const history = uninterrupted ? this.imageHistory.get(track.trackId) ?? [] : [];
          history.push({ box: { ...obs.box }, at: nowMs });
          while (history.length > IMAGE_MOTION_POLICY.maximumSamples
            || (history.length > 1 && nowMs - history[0].at > IMAGE_MOTION_POLICY.maximumSpanMs)) history.shift();
          this.imageHistory.set(track.trackId, history);
          track.imageMotion = !uninterrupted ? unknownImageMotion('gap', 1) : measureImageMotion(history);
        }

        if (track.state === 'TENTATIVE' && track.hits >= this.config.hitsToConfirm) {
          track.state = 'CONFIRMED';
        } else if (track.state === 'LOST') {
          track.state = 'CONFIRMED'; // recovered
        }

        unassignedTracks.delete(track.trackId);
        unassignedObs.delete(obsIndex);
      }
    }

    // Process unassigned tracks (misses)
    for (const trackId of unassignedTracks) {
      const track = this.tracks.find((t) => t.trackId === trackId);
      if (!track) continue;

      track.misses += 1;
      track.ageFrames += 1;
      track.velocity = { x: 0, y: 0 };
      track.imageMotion = unknownImageMotion('missed');
      this.imageHistory.delete(track.trackId);

      if (track.state === 'TENTATIVE' && track.misses > 0) {
        track.state = 'REMOVED'; // drop noisy tentative tracks fast
      } else if (track.state === 'CONFIRMED' && track.misses > this.config.maxMissesBeforeLost) {
        track.state = 'LOST';
      } else if (track.state === 'LOST' && track.misses > this.config.maxMissesBeforeRemoved) {
        track.state = 'REMOVED';
      }
    }

    // Create new tracks
    for (const obsIdx of unassignedObs) {
      const obs = uniqueObservations[obsIdx];
      const trackId = this.nextTrackId++;
      if (!obs.edgeClipped) this.imageHistory.set(trackId, [{ box: { ...obs.box }, at: nowMs }]);
      this.tracks.push({
        trackId,
        label: obs.label,
        currentBox: { ...obs.box },
        previousBox: null,
        velocity: { x: 0, y: 0 },
        imageMotion: unknownImageMotion(obs.edgeClipped ? 'edge_clipped' : 'insufficient_history', obs.edgeClipped ? 0 : 1),
        ageFrames: 1,
        hits: 1,
        misses: 0,
        lastSeenMs: nowMs,
        state: 'TENTATIVE',
        confidence: obs.confidence,
      });
    }

    // Filter out removed tracks
    this.tracks = this.tracks.filter((t) => t.state !== 'REMOVED');
    const liveTrackIds = new Set(this.tracks.map(track => track.trackId));
    for (const trackId of this.imageHistory.keys()) {
      if (!liveTrackIds.has(trackId)) this.imageHistory.delete(trackId);
    }
    return this.getTracks();
  }

  public getTracks(): ObjectTrack[] {
    // Published snapshots must not change when a later frame updates the internal tracks.
    return this.tracks.map((track) => ({
      ...track,
      currentBox: { ...track.currentBox },
      previousBox: track.previousBox ? { ...track.previousBox } : null,
      velocity: { ...track.velocity },
      ...(track.imageMotion ? { imageMotion: { ...track.imageMotion } } : {}),
    }));
  }
}
