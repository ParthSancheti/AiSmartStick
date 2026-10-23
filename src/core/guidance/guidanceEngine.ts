import { visionEngine } from '../vision/visionLoop';
import { earcon } from '../feedback/earcons';
import { haptics } from '../feedback/haptics';
import { announce, cancelInvalidAnnouncements } from '../ai/voiceOut';
import { isLinked, useDevice } from '../store/device';
import { getSettings, useSession } from '../store/session';
import { useNavView } from '../navigation/navView';
import { useWalking } from '../walking/walkTracker';
import { getCurrentSensorContext } from '../vision/sensorConditioning';
import { SENSITIVITY } from '../telemetry/obstaclePolicy';
import { emptyWalkingGuidance, evaluateWalkingGuidance, useWalkingGuidance, WALKING_GUIDANCE_POLICY, type WalkingGuidance } from './guidanceState';
import { VISION_OBSERVATION_STALE_MS, type DetectionSnapshot } from '../vision/types';
import { useLocation } from '../location/locationService';
import { GuidanceSpeechPolicy } from './speechPolicy';

/** Include only the evidence stated aloud, so ordinary changes within one zone do not cancel it. */
function speechFact(state: WalkingGuidance, thresholds: { awarenessCm: number; warningCm: number; dangerCm: number }, boardWarning: boolean, walking: boolean) {
  const measured = state.frontDistanceCm !== null;
  if (state.severity === 'danger') return measured && state.frontDistanceCm! < thresholds.dangerCm ? 'danger-sensor' : 'danger-board';
  if (state.severity === 'warning') {
    if (measured && (state.frontDistanceCm! < thresholds.warningCm || boardWarning)) return 'warning-sensor';
    return !measured && boardWarning ? 'warning-board' : 'warning-visual';
  }
  if (state.severity === 'awareness') {
    if (state.approaching) return 'awareness-approach';
    if (!walking) return 'inactive';
    return measured && state.frontDistanceCm! <= thresholds.awarenessCm ? 'awareness-sensor' : 'awareness-visual';
  }
  return state.severity;
}

/** Phone guidance complements the independent ECU safety loop; it never controls sensor thresholds. */
export class GuidanceEngine {
  private isStarted = false;
  private generation = 0;
  private speechPolicy = new GuidanceSpeechPolicy();
  private lastSceneKey = '';
  private currentSpeechFact: ReturnType<typeof speechFact> = 'inactive';
  private requiredDuringWalk = false;
  private unsubs: (() => void)[] = [];
  private freshnessTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotHandler = (s: DetectionSnapshot) => this.process(s);

  public start() {
    if (this.isStarted) return;
    this.isStarted = true;
    this.generation++;
    visionEngine.onSnapshot = this.snapshotHandler;
    this.unsubs = [
      useDevice.subscribe(() => this.process()),
      useNavView.subscribe((s, prev) => { if (s.active !== prev.active || s.arrived !== prev.arrived) this.process(); }),
      useWalking.subscribe(() => this.process()),
      useSession.subscribe((s, prev) => { if (s.settings.obstacleSensitivity !== prev.settings.obstacleSensitivity) this.process(); }),
    ];
    // One bounded freshness timer. No camera/network work here: warnings do not wait for inference.
    this.freshnessTimer = setInterval(() => this.process(), WALKING_GUIDANCE_POLICY.freshnessCheckMs);
    this.process();
  }

  public stop() {
    this.isStarted = false;
    this.generation++;
    if (visionEngine.onSnapshot === this.snapshotHandler) visionEngine.onSnapshot = null;
    this.unsubs.splice(0).forEach(unsub => unsub());
    if (this.freshnessTimer) clearInterval(this.freshnessTimer);
    this.freshnessTimer = null;
    this.requiredDuringWalk = false;
    this.speechPolicy.reset();
    this.lastSceneKey = '';
    this.currentSpeechFact = 'inactive';
    useWalkingGuidance.setState(emptyWalkingGuidance());
    cancelInvalidAnnouncements();
  }

  private process(snapshot = visionEngine.latestSnapshot) {
    if (!this.isStarted) return;
    const now = Date.now();
    const d = useDevice.getState();
    const nav = useNavView.getState();
    const walk = useWalking.getState();
    const thresholds = SENSITIVITY[getSettings().obstacleSensitivity] ?? SENSITIVITY.medium;
    const ctx = getCurrentSensorContext(thresholds.warningCm);
    const walking = (nav.active && !nav.arrived) || (!!walk.current && !walk.paused)
      || ctx.motion === 'WALKING' || ctx.motion === 'SWINGING';
    if (!walking) this.requiredDuringWalk = false;
    else if (isLinked(d.link)) this.requiredDuringWalk = true;
    const previous = useWalkingGuidance.getState();
    const state = evaluateWalkingGuidance({ context: ctx, snapshot, thresholds,
      boardZone: d.zone, linked: isLinked(d.link), walking, sensorRequired: this.requiredDuringWalk,
      previous, now });
    this.currentSpeechFact = speechFact(state, thresholds, d.zone === 'warning' || d.zone === 'danger', walking);
    useWalkingGuidance.setState(state);
    cancelInvalidAnnouncements();
    const severity = state.severity;
    const sceneKey = `${state.directionsReliable}:` + state.observedObjects.map(o => `${o.label}:${o.occupiedSides.join(',')}`).sort().join('|');
    const eligible = severity === 'unavailable' ? walking : severity !== 'awareness' || walking || state.approaching;
    const decision = this.speechPolicy.decide(state, ctx, useLocation.getState().fix, sceneKey, now, eligible);
    if (severity === 'none') {
      return;
    }
    if (severity === 'unavailable' && !walking) return;
    if (severity === 'awareness' && ((!walking && !state.approaching) || (!state.approaching
      && !(state.frontDistanceCm != null && state.frontDistanceCm <= thresholds.awarenessCm)
      && !state.observedObjects.length))) return;
    const repeatMs = severity === 'danger' ? WALKING_GUIDANCE_POLICY.alertRepeatMs
      : severity === 'warning' ? WALKING_GUIDANCE_POLICY.warningRepeatMs : WALKING_GUIDANCE_POLICY.awarenessRepeatMs;
    const sceneChanged = severity === 'awareness' && sceneKey !== this.lastSceneKey;
    if (!decision.speak) return;
    this.lastSceneKey = sceneKey;
    const generation = this.generation;
    const fact = this.currentSpeechFact;
    const sensorFact = fact === 'danger-sensor' || fact === 'danger-board' || fact === 'warning-sensor'
      || fact === 'warning-board' || fact === 'awareness-approach' || fact === 'awareness-sensor';
    const visualFact = fact === 'warning-visual' || fact === 'awareness-visual';
    const isCurrent = () => {
      const at = Date.now();
      const current = useWalkingGuidance.getState();
      if (!this.isStarted || this.generation !== generation || this.currentSpeechFact !== fact
        || current.severity !== severity || at < now || at - now > repeatMs || at < current.evaluatedAt) return false;
      if (sensorFact && at > current.validUntil) return false;
      if (severity === 'awareness' && `${current.directionsReliable}:` + current.observedObjects.map(o => `${o.label}:${o.occupiedSides.join(',')}`).sort().join('|') !== sceneKey) return false;
      if (visualFact) {
        const latest = visionEngine.latestSnapshot;
        if (latest?.frameTimestamp == null || !Number.isFinite(latest.frameTimestamp)
          || at < latest.frameTimestamp || at - latest.frameTimestamp > VISION_OBSERVATION_STALE_MS) return false;
        // Telemetry/camera state may change before the next store callback or freshness tick.
        // Reuse the pure reducer's finite-value, tilt, capture-skew and pose-change checks;
        // this read-only validation executes none of its proposed route/alert effects.
        const device = useDevice.getState();
        const rechecked = evaluateWalkingGuidance({ context: getCurrentSensorContext(thresholds.warningCm), snapshot: latest,
          thresholds, boardZone: device.zone, linked: isLinked(device.link), walking,
          sensorRequired: current.sensorRequired, previous: current, now: at });
        if (speechFact(rechecked, thresholds, device.zone === 'warning' || device.zone === 'danger', walking) !== fact) return false;
        if (fact === 'awareness-visual' && (`${rechecked.directionsReliable}:`
          + rechecked.observedObjects.map(o => `${o.label}:${o.occupiedSides.join(',')}`).sort().join('|')) !== sceneKey) return false;
      }
      return true;
    };

    if (severity === 'danger' || severity === 'warning') {
      earcon(severity === 'danger' ? 'alert' : 'warning');
      haptics.play(severity === 'danger' ? 'error' : 'warning');
      const measured = state.frontDistanceCm != null;
      const measuredClose = measured && state.frontDistanceCm! < thresholds.dangerCm;
      const forwardWarning = measured && (state.frontDistanceCm! < thresholds.warningCm || d.zone === 'warning' || d.zone === 'danger');
      let en = severity === 'danger' ? measuredClose ? 'Stop. Obstacle very close ahead.' : 'Stop. The stick obstacle warning is active. Check ahead.'
        : forwardWarning ? 'Stop. The forward sensor detects an obstacle ahead.'
          : !measured && (d.zone === 'warning' || d.zone === 'danger') ? 'Stop. The stick obstacle warning is active. Current distance cannot be confirmed.'
          : 'Stop and check ahead. The camera shows an obstacle.';
      let hi = severity === 'danger' ? measuredClose ? 'रुकिए। सामने बहुत पास रुकावट है।' : 'रुकिए। स्टिक की रुकावट चेतावनी चालू है। सामने जाँचिए।'
        : forwardWarning ? 'रुकिए। सामने के सेंसर को रुकावट मिली है।'
          : !measured && (d.zone === 'warning' || d.zone === 'danger') ? 'रुकिए। स्टिक की रुकावट चेतावनी चालू है। अभी दूरी की पुष्टि नहीं है।'
          : 'रुकिए और सामने जाँचिए। कैमरे में रुकावट दिख रही है।';
      // Image bands have no calibrated yaw relationship to the user's body or cane.
      en += ' Check the surroundings with your cane.';
      hi += ' अपनी छड़ी से आसपास जाँचिए।';
      announce({ en, hi }, { critical: severity === 'danger', high: severity === 'warning', dedupeKey: 'walking-obstacle', isCurrent });
    } else if (severity === 'unavailable') {
      announce({ en: 'Obstacle distance cannot be confirmed. Pause and check with your cane.', hi: 'रुकावट की दूरी की पुष्टि नहीं हो रही है। रुककर अपनी छड़ी से जाँचिए।' },
        { high: true, dedupeKey: 'walking-sensing', isCurrent });
    } else if (walking || state.approaching) {
      if (state.approaching || (state.frontDistanceCm != null && state.frontDistanceCm <= thresholds.awarenessCm)) {
        earcon('warning');
        haptics.play('warning');
        announce({ en: state.approaching ? 'Forward sensor range is decreasing. Slow down and check ahead.' : 'The forward sensor detects something ahead. Slow down and check.',
          hi: state.approaching ? 'सामने की सेंसर दूरी घट रही है। धीमे चलिए और सामने जाँचिए।' : 'सामने के सेंसर को कुछ मिला है। धीमे चलिए और जाँचिए।' },
        { high: state.approaching, dedupeKey: 'walking-awareness', isCurrent });
      } else if (state.observedObjects.length && (sceneChanged || decision.speak)) {
        const objects = state.observedObjects.slice(0, 3);
        const enScene = objects.map(o => state.directionsReliable ? `${o.label} ${o.side === 'CENTER' ? 'in the center of the camera view' : `on the ${o.side.toLowerCase()} of the camera view`}` : o.label).join(', ');
        const hiScene = objects.map(o => state.directionsReliable ? `${o.side === 'CENTER' ? 'कैमरे के दृश्य के बीच में' : o.side === 'LEFT' ? 'कैमरे के बाईं ओर' : 'कैमरे के दाईं ओर'} ${o.label}` : o.label).join(', ');
        announce({ en: `Camera sees ${enScene}.`, hi: `कैमरे में ${hiScene} दिख रहे हैं।` },
          { dedupeKey: 'walking-scene', isCurrent });
      }
    }
  }
}

export const guidanceEngine = new GuidanceEngine();
