import { THRESHOLDS, type SensorContext } from '../perception/sensorCore';
import { guidanceRank, type WalkingGuidance } from '../perception/walkingCore';

export type Movement = 'stationary' | 'moving' | 'unknown';
/** Optional caller-supplied speed evidence; no GPS service or device is required. */
export interface WalkingSpeedFix { ts: number; accuracyM: number; speedMps?: number | null }
/** Speech policy only. Never changes route holds, raw sensor warnings or ECU vibration. */
export class GuidanceSpeechPolicy {
  private movement: Movement = 'unknown';
  private stationarySince: number | null = null;
  private lastAt = -Infinity;
  private lastNow = -Infinity;
  private maxRank = 0;
  private clearSince: number | null = null;
  private distance: number | null = null;
  private lastObservedDistance: number | null = null;
  private approachAnnounced = false;
  private unavailableAnnounced = false;
  private unavailableSince: number | null = null;
  private healthySince: number | null = null;
  private scene = '';
  private candidateScene = '';
  private sceneSince = 0;

  decide(state: WalkingGuidance, ctx: SensorContext, fix: WalkingSpeedFix | null, sceneKey: string, now: number, eligible = true) {
    if (!Number.isFinite(now) || now < 0) {
      this.reset();
      return { speak: false, movement: this.movement };
    }
    sceneKey = sceneKey.replace(/^(true|false):/, '');
    if (now < this.lastNow) this.reset();
    this.lastNow = now;
    const imuFresh = Number.isFinite(ctx.timestamp) && ctx.timestamp >= 0 && ctx.timestamp <= now && now - ctx.timestamp <= THRESHOLDS.IMU_STALE_MS
      && [ctx.accel, ctx.gyro].every(v => v.state === 'valid' && Number.isFinite(v.ageMs) && v.ageMs >= 0
        && v.ageMs <= ctx.timestamp && v.ageMs + now - ctx.timestamp <= THRESHOLDS.IMU_STALE_MS
        && v.value !== null && [v.value.x, v.value.y, v.value.z, v.value.mag].every(Number.isFinite) && v.value.mag >= 0);
    const gpsFresh = fix && Number.isFinite(fix.ts) && fix.ts >= 0 && fix.ts <= now && now - fix.ts <= 5000
      && Number.isFinite(fix.accuracyM) && fix.accuracyM >= 0 && fix.accuracyM <= 20;
    const speed = gpsFresh && fix.speedMps != null && Number.isFinite(fix.speedMps) && fix.speedMps >= 0 && fix.speedMps <= 3.5 ? fix.speedMps : null;
    const moving = (speed != null && speed >= 0.35) || (imuFresh && ['WALKING', 'SWINGING', 'RAPID_MOTION'].includes(ctx.motion));
    const previousMovement = this.movement;
    if (moving) { this.stationarySince = null; this.movement = 'moving'; }
    else if (imuFresh && ctx.motion === 'STABLE' && (speed == null || speed <= 0.15)) {
      this.stationarySince ??= now;
      if (now - this.stationarySince >= 3000) this.movement = 'stationary';
    } else { this.stationarySince = null; this.movement = 'unknown'; }
    const resumed = previousMovement === 'stationary' && this.movement === 'moving';
    const rank = guidanceRank(state.severity);
    const elapsed = now - this.lastAt;
    const suddenDanger = rank === 3 && this.lastObservedDistance != null && state.frontDistanceCm != null
      && this.lastObservedDistance - state.frontDistanceCm >= Math.max(20, this.lastObservedDistance * 0.3);
    this.lastObservedDistance = state.frontDistanceCm;

    if (sceneKey !== this.candidateScene) { this.candidateScene = sceneKey; this.sceneSince = now; }
    const newScene = !!sceneKey && sceneKey !== this.scene && now - this.sceneSince >= 2000;
    // Only sustained resolved evidence ends an episode; a missed frame or no-echo
    // cannot repeatedly re-arm the same warning.
    if (state.severity === 'none' && !state.routeHold) {
      this.clearSince ??= now;
      if (now - this.clearSince >= 5000) { this.maxRank = 0; this.distance = null; this.approachAnnounced = false; this.scene = ''; }
    } else this.clearSince = null;
    if (state.severity !== 'unavailable' && state.frontDistanceCm != null) {
      this.healthySince ??= now;
      if (now - this.healthySince >= 3000) this.unavailableAnnounced = false;
    } else this.healthySince = null;
    const unavailable = state.severity === 'unavailable';
    if (unavailable) this.unavailableSince ??= now;
    else this.unavailableSince = null;
    if (state.severity === 'none' || !eligible) return { speak: false, movement: this.movement };
    const closer = this.distance != null && state.frontDistanceCm != null
      && this.distance - state.frontDistanceCm >= Math.max(10, this.distance * 0.2);
    const approaching = state.approaching && !this.approachAnnounced;
    const interval = this.movement === 'moving'
      ? state.severity === 'danger' ? Math.max(3000, 8000 - (speed ?? 0.8) * 2000)
        : state.severity === 'warning' ? Math.max(5000, 14000 - (speed ?? 0.8) * 4000) : 15000
      : this.movement === 'unknown' ? 30000 : Infinity;
    const pureVisual = state.frontDistanceCm == null && !state.approaching;
    const repeat = elapsed >= interval && (!pureVisual || newScene);
    const speak = unavailable ? now - this.unavailableSince! >= 2000 && (!this.unavailableAnnounced || (resumed && elapsed >= 3000))
      : rank > this.maxRank || suddenDanger || (elapsed >= 1500 && (closer || approaching))
        || (resumed && elapsed >= 3000) || repeat
        || (newScene && elapsed >= 10000 && (this.movement === 'moving' || rank >= 2));
    if (speak) {
      this.lastAt = now;
      this.maxRank = Math.max(this.maxRank, rank);
      this.scene = sceneKey;
      if (state.frontDistanceCm != null) this.distance = state.frontDistanceCm;
      this.approachAnnounced ||= state.approaching;
      if (unavailable) this.unavailableAnnounced = true;
    }
    return { speak, movement: this.movement };
  }

  reset() {
    this.movement = 'unknown'; this.stationarySince = null; this.lastAt = -Infinity; this.lastNow = -Infinity;
    this.maxRank = 0; this.clearSince = null; this.distance = null; this.lastObservedDistance = null; this.approachAnnounced = false;
    this.unavailableAnnounced = false; this.unavailableSince = null; this.healthySince = null; this.scene = ''; this.candidateScene = ''; this.sceneSince = 0;
  }
}
