import type { TelemetryPacket } from '../../../shared/deviceProtocol';
import type { ButtonPattern } from '../types';
import { useDevice } from '../store/device';
import { BatteryEstimator } from './battery';
import { ImuFilter, type ImuCalibration } from './imu';
import { UltrasonicFilter } from './ultrasonic';
import { ButtonClassifier } from './button';
import { STALE_MS } from './types';
import { sensorConditioning } from '../vision/sensorConditioning';
import { trace } from '../device/deviceTrace';
import type { PacketTiming } from '../transport/types';

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
  /** A packet was rejected (reason), or data is accepted again after a rejection (null). */
  onRejected?: (reason: string | null) => void;
}
let handlers: Handlers = { onButton: () => {}, onFall: () => {} };

export function configurePipeline(h: Handlers) {
  handlers = h;
}

export function setImuCalibration(cal: ImuCalibration | null) {
  imu.setCalibration(cal);
}

let lastRawImu: TelemetryPacket['imu'] | null = null;
let rejecting = false;
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
  sensorConditioning.reset?.();
  lastSeq = -1;
  lastUptime = -1;
  lastSafetyId = -1;
  lastRawImu = null;
}

const US_STATUS = ['ok', 'no_echo', 'out_of_range', 'invalid', 'timeout', 'error'];
const ZONES = [undefined, 'unknown', 'normal', 'awareness', 'warning', 'danger'];

const ok = (v: unknown) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v));
const inRange = (v: unknown, lo: number, hi: number) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi);
const show = (v: unknown) => {
  try {
    return JSON.stringify(v)?.slice(0, 40) ?? String(v);
  } catch {
    return String(v);
  }
};

/**
 * Shape AND plausibility, with the reason. Malformed packets never reach the stores: impossible
 * distances, voltages, angles, NaN/Infinity, unknown enums, oversized event lists, bad ids.
 * Returns null when the packet is fine, else WHICH field failed (shown in the Connection test and
 * the rejection trace, so a firmware/app mismatch is visible at once instead of "no data").
 */
export function explainPacket(p: unknown): string | null {
  const x = p as TelemetryPacket;
  if (!x || typeof x !== 'object') return 'packet is not an object';
  if (x.v !== 1) return `v = ${show(x.v)} (expected 1)`;
  if (typeof x.deviceId !== 'string' || !/^[A-Za-z0-9._:-]{3,40}$/.test(x.deviceId)) return `deviceId = ${show(x.deviceId)}`;
  if (!Number.isInteger(x.seq) || x.seq < 0) return `seq = ${show(x.seq)}`;
  if (typeof x.uptimeMs !== 'number' || !Number.isFinite(x.uptimeMs) || x.uptimeMs < 0) return `uptimeMs = ${show(x.uptimeMs)}`;
  if (!x.battery || typeof x.battery !== 'object') return 'battery missing';
  if (!inRange(x.battery.busV, 0, 30)) return `battery.busV = ${show(x.battery.busV)}`;
  if (!inRange(x.battery.currentMa, -10000, 10000)) return `battery.currentMa = ${show(x.battery.currentMa)}`;
  if (!x.imu || typeof x.imu !== 'object') return 'imu missing';
  if (!inRange(x.imu.pitch, -180, 180)) return `imu.pitch = ${show(x.imu.pitch)}`;
  if (!inRange(x.imu.roll, -180, 180)) return `imu.roll = ${show(x.imu.roll)}`;
  if (!ok(x.imu.ax)) return `imu.ax = ${show(x.imu.ax)}`;
  if (!x.ultrasonic || typeof x.ultrasonic !== 'object') return 'ultrasonic missing';
  if (!inRange(x.ultrasonic.distanceCm, 0, 1000)) return `ultrasonic.distanceCm = ${show(x.ultrasonic.distanceCm)}`;
  if (!US_STATUS.includes(x.ultrasonic.status)) return `ultrasonic.status = ${show(x.ultrasonic.status)}`;
  if (typeof x.ultrasonic.sampleAgeMs !== 'number' || !Number.isFinite(x.ultrasonic.sampleAgeMs) || x.ultrasonic.sampleAgeMs < 0)
    return `ultrasonic.sampleAgeMs = ${show(x.ultrasonic.sampleAgeMs)}`;
  if (!ZONES.includes(x.ultrasonic.zone)) return `ultrasonic.zone = ${show(x.ultrasonic.zone)}`;
  if (!Array.isArray(x.button)) return 'button is not a list';
  if (x.button.length > 32) return `button has ${x.button.length} events (max 32)`;
  const badBtn = x.button.findIndex((b) => !b || !Number.isInteger(b.id) || !['press', 'release', 'gesture'].includes(b.kind));
  if (badBtn >= 0) return `button[${badBtn}] = ${show(x.button[badBtn])}`;
  if (x.safety !== undefined && (!Array.isArray(x.safety) || x.safety.length > 16)) return `safety = ${show(x.safety)}`;
  if (!x.health || typeof x.health !== 'object') return 'health missing';
  return null;
}

export function validatePacket(p: unknown): p is TelemetryPacket {
  return explainPacket(p) === null;
}

export function ingestPacket(p: TelemetryPacket, receivedAt: number, timing?: PacketTiming) {
  const now = Date.now();
  const sensorAt = timing ? Math.min(timing.requestStartedAt, receivedAt - timing.roundTripMs) : receivedAt;
  const timingError = !Number.isFinite(receivedAt) || receivedAt < 0 || receivedAt > now ? 'invalid telemetry receipt time'
    : timing && (!Number.isFinite(timing.requestStartedAt) || timing.requestStartedAt < 0 || timing.requestStartedAt > receivedAt
      || !Number.isFinite(timing.roundTripMs) || timing.roundTripMs < 0
      || !Number.isFinite(sensorAt) || sensorAt < 0) ? 'invalid telemetry request timing' : null;
  const why = explainPacket(p) ?? timingError;
  if (why) {
    trace('packet_rejected', { error: `malformed packet: ${why}` });
    rejecting = true;
    handlers.onRejected?.(`Stick data rejected: ${why}`);
    return;
  }
  if (rejecting) {
    rejecting = false;
    handlers.onRejected?.(null);
  }
  const id = useDevice.getState().identity;
  if (id && p.deviceId !== id.deviceId) {
    trace('packet_rejected', { error: 'unexpected device' });
    handlers.onRejected?.(`packet from unexpected device ${p.deviceId}`);
    return;
  }
  trace('packet_valid', { seq: p.seq });
  if (p.uptimeMs < lastUptime) {
    // Stick rebooted: sequence and button ids restart.
    resetPipeline();
  } else if (p.seq <= lastSeq) {
    return; // duplicate or out-of-order poll
  }
  lastSeq = p.seq;
  lastUptime = p.uptimeMs;
  lastRawImu = p.imu;

  // The stick's sampleAgeMs is measured when it builds the response, before transport delay.
  // Charge the full request duration conservatively: response-generation time is not known.
  // Preserve the firmware age/uptime unchanged so distinct sample identity and rate stay correct.
  sensorConditioning.ingest(p, sensorAt);

  const b = battery.update({ busV: p.battery.busV, currentMa: p.battery.currentMa, charging: p.battery.charging, ok: p.battery.ok, at: sensorAt });
  const i = imu.update({ ...p.imu, at: sensorAt });
  const u = ultrasonic.update(p.ultrasonic, sensorAt);
  trace('telemetry_parsed', { batteryPct: b.percent, distanceCm: u.distanceCm, pitch: i.pitch });
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

  trace('store_updated', { seq: p.seq });

  for (const g of buttons.ingest(p.button, p.uptimeMs)) {
    trace('button_event', { gesture: g });
    handlers.onButton(g);
  }
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
