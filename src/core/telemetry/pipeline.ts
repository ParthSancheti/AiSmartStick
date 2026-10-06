import type { TelemetryPacket } from '../../../shared/deviceProtocol';
import type { ButtonPattern } from '../types';
import { useDevice } from '../store/device';
import { BatteryEstimator } from './battery';
import { ImuFilter, type ImuCalibration } from './imu';
import { UltrasonicFilter } from './ultrasonic';
import { ButtonClassifier } from './button';
import { STALE_MS } from './types';
import { sensorConditioning } from '../vision/sensorConditioning';

/**
 * RAW HARDWARE → VALIDATION → NORMALIZATION → FILTER → QUALITY → DOMAIN STATE (device store).
 * Everything downstream (UI, cloud sync, Guardian) sees only the domain state.
 */
const battery = new BatteryEstimator();
const imu = new ImuFilter();
const ultrasonic = new UltrasonicFilter();
const buttons = new ButtonClassifier();

let lastSeq = -1;
let lastUptime = -1;
let lastSafetyId = -1;

interface Handlers {
  onButton: (p: ButtonPattern) => void;
  onFall: (peakG: number | undefined, confidence: number | undefined) => void;
  onRejected?: (reason: string) => void;
}
let handlers: Handlers = { onButton: () => {}, onFall: () => {} };

export function configurePipeline(h: Handlers) {
  handlers = h;
}

export function setImuCalibration(cal: ImuCalibration | null) {
  imu.setCalibration(cal);
}

let lastRawImu: TelemetryPacket['imu'] | null = null;
/** Zero the stick orientation at the current pose (user holds it upright, then taps Calibrate). */
export function calibrateImuFromLatest(): ImuCalibration | null {
  if (!lastRawImu) return null;
  return imu.calibrateFrom({ ...lastRawImu, at: Date.now() });
}

export function resetPipeline() {
  battery.reset();
  imu.reset();
  ultrasonic.reset();
  buttons.reset();
  lastSeq = -1;
  lastUptime = -1;
  lastSafetyId = -1;
  lastRawImu = null;
}

const num = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v));
const range = (v: unknown, lo: number, hi: number) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi);
const US_STATUS = ['ok', 'no_echo', 'out_of_range', 'invalid', 'timeout', 'error'];
const ZONES = [undefined, 'unknown', 'normal', 'awareness', 'warning', 'danger'];

/**
 * Shape AND plausibility. Malformed packets never reach the stores: impossible distances,
 * voltages, angles, NaN/Infinity, unknown enums, oversized event lists, bad ids.
 */
export function validatePacket(p: unknown): p is TelemetryPacket {
  const x = p as TelemetryPacket;
  return (
    !!x &&
    x.v === 1 &&
    typeof x.deviceId === 'string' &&
    /^[A-Za-z0-9._:-]{3,40}$/.test(x.deviceId) &&
    Number.isInteger(x.seq) &&
    x.seq >= 0 &&
    typeof x.uptimeMs === 'number' &&
    Number.isFinite(x.uptimeMs) &&
    x.uptimeMs >= 0 &&
    !!x.battery &&
    range(x.battery.busV, 0, 30) &&
    range(x.battery.currentMa, -10000, 10000) &&
    !!x.imu &&
    range(x.imu.pitch, -180, 180) &&
    range(x.imu.roll, -180, 180) &&
    num(x.imu.ax ?? null) &&
    !!x.ultrasonic &&
    range(x.ultrasonic.distanceCm, 0, 1000) &&
    US_STATUS.includes(x.ultrasonic.status) &&
    ZONES.includes(x.ultrasonic.zone) &&
    Array.isArray(x.button) &&
    x.button.length <= 32 &&
    x.button.every((b) => Number.isInteger(b.id) && ['press', 'release', 'gesture'].includes(b.kind)) &&
    (x.safety === undefined || (Array.isArray(x.safety) && x.safety.length <= 16)) &&
    !!x.health
  );
}

export function ingestPacket(p: TelemetryPacket, receivedAt: number) {
  if (!validatePacket(p)) {
    handlers.onRejected?.('malformed packet');
    return;
  }
  const id = useDevice.getState().identity;
  if (id && p.deviceId !== id.deviceId) {
    handlers.onRejected?.(`packet from unexpected device ${p.deviceId}`);
    return;
  }
  if (p.uptimeMs < lastUptime) {
    // Stick rebooted: sequence and button ids restart.
    resetPipeline();
  } else if (p.seq <= lastSeq) {
    return; // duplicate or out-of-order poll
  }
  lastSeq = p.seq;
  lastUptime = p.uptimeMs;
  lastRawImu = p.imu;

  sensorConditioning.ingest(p, receivedAt);

  const b = battery.update({ busV: p.battery.busV, currentMa: p.battery.currentMa, charging: p.battery.charging, ok: p.battery.ok, at: receivedAt });
  const i = imu.update({ ...p.imu, at: receivedAt });
  const u = ultrasonic.update(p.ultrasonic, receivedAt);
  const cam = useDevice.getState().camera;
  useDevice.setState({
    battery: b,
    imu: i,
    ultrasonic: u,
    zone: p.ultrasonic.zone ?? 'unknown',
    health: p.health,
    rssi: p.rssi,
    lastPacketAt: receivedAt,
    camera: { ...cam, status: p.health.camera === 'error' ? 'error' : cam.status === 'capturing' ? 'capturing' : 'idle' },
  });

  for (const g of buttons.ingest(p.button, p.uptimeMs)) handlers.onButton(g);
  for (const e of p.safety ?? []) {
    if (e.id <= lastSafetyId) continue;
    lastSafetyId = e.id;
    if (e.type === 'fall') handlers.onFall(e.value, e.confidence);
  }
}

let staleTimer: ReturnType<typeof setInterval> | undefined;

/** Readings age into "stale" on their own; nothing stays "live" because nobody updated it. */
export function startStalenessWatch() {
  clearInterval(staleTimer);
  staleTimer = setInterval(() => {
    const s = useDevice.getState();
    const now = Date.now();
    const patch: Partial<typeof s> = {};
    if (s.battery.status === 'ok' && s.battery.measuredAt && now - s.battery.measuredAt > STALE_MS.battery) patch.battery = { ...s.battery, status: 'stale' };
    if (s.imu.status === 'ok' && s.imu.measuredAt && now - s.imu.measuredAt > STALE_MS.imu) patch.imu = { ...s.imu, status: 'stale' };
    if (['ok', 'no_echo', 'out_of_range'].includes(s.ultrasonic.status) && s.ultrasonic.measuredAt && now - s.ultrasonic.measuredAt > STALE_MS.ultrasonic)
      patch.ultrasonic = { ...s.ultrasonic, status: 'stale', distanceCm: null };
    if (Object.keys(patch).length) useDevice.setState(patch);
  }, 1000);
}
