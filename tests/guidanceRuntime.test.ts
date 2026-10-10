import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelemetryPacket } from '../shared/deviceProtocol';
import type { DetectionSnapshot, FusedObject, SpatialSide } from '../src/core/vision/types';

const h = vi.hoisted(() => ({
  announce: vi.fn(), cancelInvalid: vi.fn(), earcon: vi.fn(), play: vi.fn(),
  vision: { latestSnapshot: null as DetectionSnapshot | null,
    onSnapshot: null as ((s: DetectionSnapshot) => void) | null },
}));
vi.mock('../src/core/vision/visionLoop', () => ({ visionEngine: h.vision }));
vi.mock('../src/core/ai/voiceOut', () => ({ announce: h.announce, cancelInvalidAnnouncements: h.cancelInvalid }));
vi.mock('../src/core/feedback/earcons', () => ({ earcon: h.earcon }));
vi.mock('../src/core/feedback/haptics', () => ({ haptics: { play: h.play } }));

import { GuidanceEngine } from '../src/core/guidance/guidanceEngine';
import { emptyWalkingGuidance, routeManeuverAllowed, useWalkingGuidance, WALKING_GUIDANCE_POLICY } from '../src/core/guidance/guidanceState';
import { initialDevice, useDevice } from '../src/core/store/device';
import { defaultSettings, useSession } from '../src/core/store/session';
import { emptyNav, useNavView } from '../src/core/navigation/navView';
import { resetWalkTracker, useWalking } from '../src/core/walking/walkTracker';
import { getCurrentSensorContext } from '../src/core/vision/sensorConditioning';
import { ingestPacket, resetPipeline } from '../src/core/telemetry/pipeline';

let seq = 0;
const engines: GuidanceEngine[] = [];
const engine = () => { const e = new GuidanceEngine(); engines.push(e); return e; };
const send = (cm: number | null, imuOverrides: Partial<TelemetryPacket['imu']> = {}, zone: NonNullable<TelemetryPacket['ultrasonic']['zone']> = 'normal', status?: TelemetryPacket['ultrasonic']['status']) => {
  const p: TelemetryPacket = {
    v: 1, deviceId: 'AISS-TEST', seq: ++seq, uptimeMs: 1000 + Date.now() - 10000,
    battery: { busV: 4, shuntMv: 1, currentMa: 100, charging: false, chargeSource: 'current', ok: true },
    imu: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, pitch: 0, roll: 0, ok: true, ...imuOverrides },
    ultrasonic: { distanceCm: cm, echoUs: cm === null ? null : cm * 58,
      status: status ?? (cm === null ? 'no_echo' : 'ok'), sampleAgeMs: 0, zone },
    button: [], rssi: -50, health: { camera: 'ok', i2c: 'ok', motor: 'idle' },
  };
  ingestPacket(p, Date.now());
};
const scene = (occupiedSides: SpatialSide[] | null = null): DetectionSnapshot => {
  const t = Date.now();
  const object: FusedObject | null = occupiedSides === null ? null : {
    track: { trackId: 1, label: 'chair', currentBox: { x: 0.1, y: 0.7, w: 0.2, h: 0.2 },
      previousBox: null, velocity: { x: 0, y: 0 }, ageFrames: 2, hits: 2, misses: 0,
      lastSeenMs: t, state: 'CONFIRMED', confidence: 0.9 },
    label: 'chair', visualConfidence: 0.9, ultrasonicDistanceCm: null, side: occupiedSides[0],
    occupiedSides, evidence: 'confirmed', depth: 'NEAR', quality: 'good', freshnessMs: 0, hazardLevel: 'warning',
  };
  return { timestamp: t, frameTimestamp: t, processingLatencyMs: 20,
    sensorContext: getCurrentSensorContext(), objects: [], tracks: object ? [object.track] : [],
    fusedObjects: object ? [object] : [], pathState: { left: 'UNKNOWN', center: 'UNKNOWN', right: 'UNKNOWN' }, overallQuality: 'good' };
};
const publish = (s: DetectionSnapshot) => { h.vision.latestSnapshot = s; h.vision.onSnapshot?.(s); };
const setupWalk = (cm = 250) => {
  useDevice.setState({ link: 'connected', source: 'http' });
  useNavView.setState({ active: true, state: 'NAVIGATING' });
  send(cm);
  const e = engine();
  e.start();
  return e;
};
const lastOptions = () => h.announce.mock.calls.at(-1)![1] as { critical?: boolean; high?: boolean; isCurrent: () => boolean };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  seq = 0;
  h.announce.mockReset(); h.cancelInvalid.mockReset(); h.earcon.mockReset(); h.play.mockReset();
  h.vision.latestSnapshot = null; h.vision.onSnapshot = null;
  useDevice.setState(initialDevice());
  useNavView.setState(emptyNav());
  resetWalkTracker();
  useSession.setState({ settings: { ...defaultSettings, obstacleSensitivity: 'medium' } });
  useWalkingGuidance.setState(emptyWalkingGuidance());
  resetPipeline();
});
afterEach(() => {
  engines.splice(0).forEach(e => e.stop());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('walking guidance runtime and existing telemetry integration', () => {
  it('warns immediately on raw sudden obstacle despite median-filtered UI data and unavailable inference', () => {
    setupWalk();
    expect(h.announce).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    send(20);
    expect(useDevice.getState().ultrasonic.distanceCm).toBe(250); // Existing median filter retains UI history.
    expect(useWalkingGuidance.getState()).toMatchObject({ severity: 'danger', frontDistanceCm: 20, routeHold: true });
    expect(h.vision.latestSnapshot).toBeNull();
    expect(h.earcon).toHaveBeenCalledWith('alert');
    expect(h.play).toHaveBeenCalledWith('error');
    expect(lastOptions().critical).toBe(true);
    expect(h.announce).toHaveBeenCalledTimes(1);
  });

  it('bypasses cooldown for warning-to-danger escalation and invalidates the earlier queued warning', () => {
    setupWalk();
    vi.advanceTimersByTime(100); send(70);
    const warning = lastOptions();
    expect(warning.high).toBe(true);
    expect(warning.isCurrent()).toBe(true);
    vi.advanceTimersByTime(100); send(20);
    expect(h.announce).toHaveBeenCalledTimes(2);
    expect(lastOptions().critical).toBe(true);
    expect(warning.isCurrent()).toBe(false);
  });

  it('retains a MCU danger during no echo without claiming a current close distance or camera observation', () => {
    useDevice.setState({ link: 'connected', source: 'http' });
    useNavView.setState({ active: true, state: 'NAVIGATING' });
    send(null);
    useDevice.setState({ zone: 'danger' });
    const e = engine();
    e.start();
    expect(useWalkingGuidance.getState()).toMatchObject({ severity: 'danger', frontDistanceCm: null, routeHold: true });
    expect(lastOptions().critical).toBe(true);
    const spoken = h.announce.mock.calls.at(-1)![0].en as string;
    expect(spoken).not.toMatch(/very close|camera shows/i);
    expect(spoken).toMatch(/warning.*active|cannot be confirmed/i);
  });

  it('announces a newly recurring danger promptly after a verified resolved interval', () => {
    setupWalk();
    vi.advanceTimersByTime(100); send(20);
    expect(h.announce).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100); send(250); publish(scene());
    expect(useWalkingGuidance.getState().routeHold).toBe(false);
    vi.advanceTimersByTime(100); send(20);
    // The intervening unresolved range/scene may also prompt a sensing announcement.
    expect(h.announce.mock.calls.filter(call => call[1].critical)).toHaveLength(2);
    expect(lastOptions().critical).toBe(true);
  });

  it('uses the real conditioned approach trace for look-ahead before reaching the awareness distance', () => {
    setupWalk(400);
    vi.advanceTimersByTime(500); send(300);
    vi.advanceTimersByTime(500); send(200);
    expect(useWalkingGuidance.getState()).toMatchObject({
      severity: 'awareness', approaching: true, frontDistanceCm: 200, timeToWarningMs: 500,
    });
    expect(h.earcon).toHaveBeenCalledWith('warning');
    expect(h.announce.mock.calls.at(-1)![0].en).toMatch(/range is decreasing/);
  });

  it('invalidates queued approach speech when range recedes at the same awareness severity', () => {
    setupWalk(200);
    vi.advanceTimersByTime(500); send(170);
    vi.advanceTimersByTime(500); send(140);
    const approaching = lastOptions();
    expect(h.announce.mock.calls.at(-1)![0].en).toMatch(/range is decreasing/);
    expect(approaching.isCurrent()).toBe(true);
    vi.advanceTimersByTime(500); send(141); // Changed direction resets the former target trend.
    vi.advanceTimersByTime(500); send(144);
    vi.advanceTimersByTime(500); send(147);
    expect(getCurrentSensorContext().ultrasonicApproach).toMatchObject({ trend: 'RECEDING', confidence: 'good' });
    expect(useWalkingGuidance.getState()).toMatchObject({ severity: 'awareness', approaching: false, frontDistanceCm: 147 });
    expect(approaching.isCurrent()).toBe(false);
    expect(h.announce).toHaveBeenCalledTimes(1); // Preserve the existing same-severity cooldown.
  });

  it('invalidates measured-close speech when no echo retains the MCU danger', () => {
    setupWalk();
    vi.advanceTimersByTime(100); send(20, {}, 'danger');
    const measured = lastOptions();
    expect(h.announce.mock.calls.at(-1)![0].en).toMatch(/very close/);
    expect(measured.isCurrent()).toBe(true);
    vi.advanceTimersByTime(100); send(null, {}, 'danger');
    expect(useWalkingGuidance.getState()).toMatchObject({ severity: 'danger', frontDistanceCm: null, routeHold: true });
    expect(measured.isCurrent()).toBe(false);
    expect(h.announce).toHaveBeenCalledTimes(1);
    expect(h.cancelInvalid).toHaveBeenCalled();
  });

  it('uses a generic latched warning when newer far range no longer supports very-close speech', () => {
    setupWalk();
    vi.advanceTimersByTime(100); send(20, {}, 'danger');
    const close = lastOptions();
    expect(h.announce.mock.calls.at(-1)![0].en).toMatch(/very close/);
    vi.advanceTimersByTime(100); send(250, {}, 'danger');
    expect(useWalkingGuidance.getState()).toMatchObject({ severity: 'danger', frontDistanceCm: 250, routeHold: true });
    expect(close.isCurrent()).toBe(false);
    // Keep the board's de-escalation warning fresh through the existing repeat cooldown.
    for (let n = 0; n < 5; n++) { vi.advanceTimersByTime(500); send(250, {}, 'danger'); }
    expect(h.announce).toHaveBeenCalledTimes(2);
    expect(lastOptions().critical).toBe(true);
    expect(lastOptions().isCurrent()).toBe(true);
    expect(h.announce.mock.calls.at(-1)![0].en).toMatch(/warning is active/);
    expect(h.announce.mock.calls.at(-1)![0].en).not.toMatch(/very close/);
  });

  it('invalidates a queued camera-warning claim when forward measured evidence takes precedence', () => {
    setupWalk();
    publish(scene(['CENTER']));
    const visual = lastOptions();
    expect(h.announce.mock.calls.at(-1)![0].en).toMatch(/camera shows/);
    expect(visual.isCurrent()).toBe(true);
    vi.advanceTimersByTime(100); send(70);
    expect(useWalkingGuidance.getState()).toMatchObject({ severity: 'warning', frontDistanceCm: 70 });
    expect(visual.isCurrent()).toBe(false);
    expect(h.announce).toHaveBeenCalledTimes(1);
  });

  it('preserves valid danger speech across ordinary raw-range changes in the same danger zone', () => {
    setupWalk();
    vi.advanceTimersByTime(100); send(20);
    const danger = lastOptions();
    vi.advanceTimersByTime(100); send(35);
    expect(useWalkingGuidance.getState()).toMatchObject({ severity: 'danger', frontDistanceCm: 35 });
    expect(danger.isCurrent()).toBe(true);
    expect(h.announce).toHaveBeenCalledTimes(1);
  });

  it('does not revive a queued warning after the wall clock moves before its evaluation', () => {
    setupWalk();
    vi.advanceTimersByTime(100); send(20);
    const danger = lastOptions();
    expect(danger.isCurrent()).toBe(true);
    vi.setSystemTime(Date.now() - 1);
    expect(useWalkingGuidance.getState().severity).toBe('danger');
    expect(danger.isCurrent()).toBe(false);
  });

  it('expires a measured warning between freshness checks at dequeue time', () => {
    setupWalk();
    vi.advanceTimersByTime(100); send(20);
    const measured = lastOptions();
    const deadline = useWalkingGuidance.getState().validUntil;
    vi.setSystemTime(deadline + 1); // The freshness interval has not run yet.
    expect(useWalkingGuidance.getState()).toMatchObject({ severity: 'danger', frontDistanceCm: 20 });
    expect(measured.isCurrent()).toBe(false);
  });

  it('expires a visual-warning claim at frame freshness even while sonar remains fresh', () => {
    setupWalk();
    publish(scene(['CENTER']));
    const visual = lastOptions();
    vi.setSystemTime(11400); send(250);
    expect(visual.isCurrent()).toBe(true);
    vi.setSystemTime(11501); // No new callback/timer; the 10000-ms camera frame is now stale.
    expect(useWalkingGuidance.getState().validUntil).toBeGreaterThan(Date.now());
    expect(useWalkingGuidance.getState().severity).toBe('warning');
    expect(visual.isCurrent()).toBe(false);
  });

  it('preserves a fresh independent MCU warning without any camera evidence', () => {
    setupWalk();
    vi.advanceTimersByTime(100); send(null, {}, 'danger');
    const boardWarning = lastOptions();
    expect(h.vision.latestSnapshot).toBeNull();
    expect(useWalkingGuidance.getState()).toMatchObject({ severity: 'danger', frontDistanceCm: null });
    vi.setSystemTime(11000); // Still before the actual no-echo sample freshness deadline.
    expect(boardWarning.isCurrent()).toBe(true);
    expect(h.announce.mock.calls.at(-1)![0].en).toMatch(/warning is active/);
  });

  it('expires a side hint when its pre-request pose becomes stale before the frame itself', () => {
    setupWalk();
    const captured = scene(['LEFT']);
    captured.frameSensorContext = {
      ...captured.sensorContext,
      orientation: { ...captured.sensorContext.orientation, ageMs: 1000 },
      gyro: { ...captured.sensorContext.gyro, ageMs: 1000 },
    };
    publish(captured);
    vi.advanceTimersByTime(100); send(70);
    const sideHint = lastOptions();
    expect(h.announce.mock.calls.at(-1)![0].en).toMatch(/right side/);
    expect(sideHint.isCurrent()).toBe(true);
    vi.setSystemTime(10501);
    expect(useWalkingGuidance.getState().validUntil).toBeGreaterThan(Date.now());
    expect(Date.now() - captured.frameTimestamp!).toBeLessThan(1500);
    expect(sideHint.isCurrent()).toBe(false);
  });

  it('preserves a fresh camera-only warning and stopped inspection hint during a sonar fault', () => {
    setupWalk();
    publish(scene(['LEFT', 'CENTER']));
    const visual = lastOptions();
    expect(h.announce.mock.calls.at(-1)![0].en).toMatch(/camera shows.*right side/);
    vi.advanceTimersByTime(100); send(null, {}, 'normal', 'error');
    expect(useWalkingGuidance.getState()).toMatchObject({
      severity: 'warning', frontDistanceCm: null, routeHold: true,
      directionsReliable: true, inspectionCandidates: ['RIGHT'],
    });
    vi.setSystemTime(11000); // The camera and IMU are fresh; no sonar deadline can authorize a turn.
    expect(Date.now()).toBeGreaterThan(useWalkingGuidance.getState().validUntil);
    expect(visual.isCurrent()).toBe(true);
    expect(routeManeuverAllowed()).toBe(false);
  });

  it('keeps map hold across no echo and camera loss and releases only after fresh resolved evidence', () => {
    setupWalk();
    vi.advanceTimersByTime(100); send(20);
    vi.advanceTimersByTime(100); send(null);
    expect(routeManeuverAllowed()).toBe(false);
    vi.advanceTimersByTime(100); send(250);
    expect(routeManeuverAllowed()).toBe(false); // Range alone does not resolve a visual/sensor hold.
    publish(scene());
    expect(routeManeuverAllowed()).toBe(true);
  });

  it('retains required sensing through link loss and expires route permission before the freshness timer runs', () => {
    setupWalk();
    const validUntil = useWalkingGuidance.getState().validUntil;
    expect(routeManeuverAllowed()).toBe(true);
    vi.setSystemTime(validUntil + 1); // Simulate dequeue between timer ticks.
    expect(routeManeuverAllowed()).toBe(false);
    useDevice.setState({ link: 'reconnecting' });
    expect(useWalkingGuidance.getState()).toMatchObject({ routeHold: true, sensorRequired: true, severity: 'unavailable' });
  });

  it('invalidates queued directional speech when its inspection candidate becomes obstructed', () => {
    setupWalk();
    publish(scene(['LEFT']));
    vi.advanceTimersByTime(100); send(70);
    const warning = lastOptions();
    expect(h.announce.mock.calls.at(-1)![0].en).toMatch(/right side/);
    expect(warning.isCurrent()).toBe(true);
    publish(scene(['LEFT', 'CENTER', 'RIGHT']));
    expect(useWalkingGuidance.getState().inspectionCandidates).toEqual([]);
    expect(warning.isCurrent()).toBe(false);
  });

  it('invalidates a queued side hint during a fast stick sweep without weakening the obstacle warning', () => {
    setupWalk();
    publish(scene(['LEFT']));
    vi.advanceTimersByTime(100); send(70);
    const warning = lastOptions();
    expect(h.announce.mock.calls.at(-1)![0].en).toMatch(/right side/);
    expect(warning.isCurrent()).toBe(true);
    vi.advanceTimersByTime(100); send(70, { gx: 100 });
    expect(getCurrentSensorContext().motion).toBe('SWINGING');
    expect(useWalkingGuidance.getState()).toMatchObject({
      severity: 'warning', frontDistanceCm: 70, routeHold: true,
      directionsReliable: false, inspectionCandidates: [],
    });
    expect(warning.isCurrent()).toBe(false);
  });

  it('clears conditioning state on pipeline reset rather than reusing an earlier device sample', () => {
    setupWalk(20);
    expect(getCurrentSensorContext().ultrasonic.value).toBe(20);
    resetPipeline();
    expect(getCurrentSensorContext().ultrasonic.state).toBe('unknown');
    vi.advanceTimersByTime(WALKING_GUIDANCE_POLICY.freshnessCheckMs);
    expect(useWalkingGuidance.getState()).toMatchObject({ routeHold: true, severity: 'unavailable' });
  });

  it('owns one freshness timer and one subscription per store, and tears everything down on stop', () => {
    const unsubscribers: ReturnType<typeof vi.fn>[] = [];
    const deviceSubscribe = useDevice.subscribe;
    const navSubscribe = useNavView.subscribe;
    const walkingSubscribe = useWalking.subscribe;
    const sessionSubscribe = useSession.subscribe;
    const subscriptions = [
      vi.spyOn(useDevice, 'subscribe').mockImplementation(listener => { const off = vi.fn(deviceSubscribe(listener)); unsubscribers.push(off); return off; }),
      vi.spyOn(useNavView, 'subscribe').mockImplementation(listener => { const off = vi.fn(navSubscribe(listener)); unsubscribers.push(off); return off; }),
      vi.spyOn(useWalking, 'subscribe').mockImplementation(listener => { const off = vi.fn(walkingSubscribe(listener)); unsubscribers.push(off); return off; }),
      vi.spyOn(useSession, 'subscribe').mockImplementation(listener => { const off = vi.fn(sessionSubscribe(listener)); unsubscribers.push(off); return off; }),
    ];
    const e = setupWalk();
    e.start(); e.start();
    expect(vi.getTimerCount()).toBe(1);
    subscriptions.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
    vi.advanceTimersByTime(100); send(20);
    const queued = lastOptions();
    e.stop();
    expect(queued.isCurrent()).toBe(false);
    expect(h.vision.onSnapshot).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    unsubscribers.forEach(off => expect(off).toHaveBeenCalledTimes(1));
    const announcements = h.announce.mock.calls.length;
    useDevice.setState({ zone: 'danger' });
    useNavView.setState({ active: false });
    useWalking.setState({ paused: true });
    vi.advanceTimersByTime(10000);
    expect(h.announce).toHaveBeenCalledTimes(announcements);
    e.start();
    expect(vi.getTimerCount()).toBe(1);
    expect(queued.isCurrent()).toBe(false); // A restarted generation cannot resurrect queued speech.
  });
});
