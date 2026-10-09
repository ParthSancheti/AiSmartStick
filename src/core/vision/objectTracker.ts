import type { BoundingBox, ObjectObservation, ObjectTrack } from './types';

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

  constructor(config: Partial<TrackerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  public update(observations: ObjectObservation[], nowMs: number): ObjectTrack[] {
    const unassignedTracks = new Set(this.tracks.map((t) => t.trackId));
    const unassignedObs = new Set(observations.map((_, i) => i));

    // Greedy IoU matching per label
    for (const track of this.tracks) {
      if (track.state === 'REMOVED') continue;

      let bestIoU = 0;
      let bestObsIdx = -1;

      for (const obsIdx of unassignedObs) {
        const obs = observations[obsIdx];
        if (obs.label !== track.label) continue;

        const iou = computeIoU(track.currentBox, obs.box);
        if (iou > bestIoU && iou > this.config.iouThreshold) {
          bestIoU = iou;
          bestObsIdx = obsIdx;
        }
      }

      if (bestObsIdx !== -1) {
        // Matched
        const obs = observations[bestObsIdx];
        const dt = (nowMs - track.lastSeenMs) / 1000.0;
        
        track.previousBox = { ...track.currentBox };
        track.currentBox = { ...obs.box };
        track.hits += 1;
        track.misses = 0;
        track.ageFrames += 1;
        track.lastSeenMs = nowMs;
        track.confidence = track.confidence * 0.7 + obs.confidence * 0.3; // EMA
        
        if (dt > 0 && dt < 1.0) {
          const cX1 = track.previousBox.x + track.previousBox.w / 2;
          const cY1 = track.previousBox.y + track.previousBox.h / 2;
          const cX2 = track.currentBox.x + track.currentBox.w / 2;
          const cY2 = track.currentBox.y + track.currentBox.h / 2;
          track.velocity = { x: (cX2 - cX1) / dt, y: (cY2 - cY1) / dt };
        }

        if (track.state === 'TENTATIVE' && track.hits >= this.config.hitsToConfirm) {
          track.state = 'CONFIRMED';
        } else if (track.state === 'LOST') {
          track.state = 'CONFIRMED'; // recovered
        }

        unassignedTracks.delete(track.trackId);
        unassignedObs.delete(bestObsIdx);
      }
    }

    // Process unassigned tracks (misses)
    for (const trackId of unassignedTracks) {
      const track = this.tracks.find((t) => t.trackId === trackId);
      if (!track) continue;

      track.misses += 1;
      track.ageFrames += 1;

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
      const obs = observations[obsIdx];
      this.tracks.push({
        trackId: this.nextTrackId++,
        label: obs.label,
        currentBox: { ...obs.box },
        previousBox: null,
        velocity: { x: 0, y: 0 },
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
    return [...this.tracks];
  }

  public getTracks(): ObjectTrack[] {
    return [...this.tracks];
  }
}
