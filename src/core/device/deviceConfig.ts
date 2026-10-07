import type { DeviceConfig } from '../../../shared/deviceProtocol';
import { useDevice, isLinked } from '../store/device';
import { useSession, type Settings } from '../store/session';
import { getTransport } from './bridge';
import { logEvent } from '../store/activity';
import { log } from '../log';

/**
 * ONE configuration model for app + ECU (shared/deviceProtocol.ts DeviceConfig ⇄ DeviceConfig.h).
 * App settings are the source; the ECU validates, applies, persists and ACKNOWLEDGES.
 * The UI only says "applied" after the acknowledgement (configSync.state === 'applied').
 */
export const SENSITIVITY: Record<Settings['obstacleSensitivity'], { awarenessCm: number; warningCm: number; dangerCm: number }> = {
  low: { awarenessCm: 110, warningCm: 75, dangerCm: 40 },
  medium: { awarenessCm: 150, warningCm: 100, dangerCm: 50 },
  high: { awarenessCm: 200, warningCm: 140, dangerCm: 70 },
};

export function buildDeviceConfig(s: Settings, version: number): DeviceConfig {
  const z = SENSITIVITY[s.obstacleSensitivity] ?? SENSITIVITY.medium;
  return {
    configVersion: version,
    obstacle: { enabled: true, ...z, hysteresisCm: 15, confirmSamples: 2 },
    haptics: { intensity: Math.max(20, Math.min(100, Math.round(s.hapticStrength))), obstacleAlerts: s.obstacleVibration },
    fall: { enabled: s.sosTriggers.fall, impactG: 2.5, freeFallG: 0.45, tiltDeg: 55, inactivityMs: 2000 },
    power: { autoSleepMin: Math.max(0, Math.min(240, Math.round(s.autoSleepMin))) },
  };
}

const key = (s: Settings) => JSON.stringify([s.obstacleSensitivity, s.hapticStrength, s.obstacleVibration, s.autoSleepMin, s.sosTriggers.fall]);
let lastKey = '';
let busy = false;
let dirty = false;

/** Pushes the desired config if the stick's active version differs. Safe to call often. */
export async function syncDeviceConfig(force = false) {
  const t = getTransport();
  const d = useDevice.getState();
  const s = useSession.getState().settings;
  const k = key(s);
  if (!t || !isLinked(d.link)) {
    if (k !== lastKey) useDevice.setState({ configSync: { ...d.configSync, state: 'offline' } });
    return;
  }
  const active = d.health?.configVersion ?? null;
  const desired = d.configSync.desiredVersion;
  if (!force && k === lastKey && desired != null && active === desired) return;
  if (busy) {
    // A change while the previous push is in flight (e.g. dragging a slider) is applied right after it.
    dirty = true;
    return;
  }
  busy = true;
  dirty = false;
  // Monotonic across restarts: seconds since epoch, strictly above what the stick has.
  const version = Math.max(Math.floor(Date.now() / 1000), (active ?? 0) + 1);
  useDevice.setState({ configSync: { desiredVersion: version, appliedVersion: active, state: 'pending', error: null } });
  try {
    const ack = await t.send({ type: 'setConfig', config: buildDeviceConfig(s, version) }, { ttlMs: 15_000 });
    if (ack.status === 'completed' || ack.status === 'duplicate') {
      lastKey = k;
      useDevice.setState({ configSync: { desiredVersion: version, appliedVersion: version, state: 'applied', error: null } });
      logEvent({ kind: 'device', severity: 'info', title: 'Stick settings applied', detail: `Configuration v${version} acknowledged by the stick` });
    } else {
      useDevice.setState({ configSync: { desiredVersion: version, appliedVersion: active, state: 'rejected', error: ack.error ?? ack.status } });
      log.warn('stick rejected config', { status: ack.status, error: ack.error });
    }
  } catch (e) {
    useDevice.setState({ configSync: { desiredVersion: version, appliedVersion: active, state: 'offline', error: (e as Error).message } });
  } finally {
    busy = false;
    if (dirty) {
      dirty = false;
      if (key(useSession.getState().settings) !== lastKey) void syncDeviceConfig(true);
    }
  }
}

let started = false;
export function startDeviceConfigSync() {
  if (started) return;
  started = true;
  let prevLink = useDevice.getState().link;
  useDevice.subscribe((st) => {
    const linkedNow = isLinked(st.link);
    if (linkedNow && !isLinked(prevLink)) void syncDeviceConfig(true); // after (re)connect: sync config
    prevLink = st.link;
  });
  let prevKey = key(useSession.getState().settings);
  useSession.subscribe((st) => {
    const k = key(st.settings);
    if (k !== prevKey) {
      prevKey = k;
      void syncDeviceConfig(true);
    }
  });
}
