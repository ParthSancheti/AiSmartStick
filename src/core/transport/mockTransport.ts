import type { ButtonEvent, CommandAck, DeviceCommand, DeviceConfig, EcuSafetyEvent, TelemetryPacket } from '../../../shared/deviceProtocol';
import type { ButtonPattern } from '../types';
import { getSettings } from '../store/session';
import { wait } from '../util';
import { Emitter, newCommandId, type CapturedFrame, type StickEvents, type StickTransport } from './types';
import { renderFrame } from './frameArt';

/** DEMO MODE ONLY. Emits protocol-shaped packets so the real pipeline (filters, button model) runs in demos too. */
const APPROACH = [240, 190, 150, 115, 85, 62, 48, 44, 58, 95, 160, 230];

// Inverse of the OCV curve, coarse: good enough to feed the real estimator.
function busVoltageFor(soc: number, currentMa: number) {
  const pts: [number, number][] = [[0, 3.27], [10, 3.69], [20, 3.73], [40, 3.8], [60, 3.87], [80, 4.02], [100, 4.2]];
  let v = 4.2;
  for (let i = 1; i < pts.length; i++) {
    if (soc <= pts[i][0]) {
      const [s0, v0] = pts[i - 1];
      const [s1, v1] = pts[i];
      v = v0 + ((soc - s0) / (s1 - s0)) * (v1 - v0);
      break;
    }
  }
  return v - (currentMa / 1000) * 0.15 + (Math.random() - 0.5) * 0.006;
}

export class MockTransport implements StickTransport {
  readonly kind = 'mock' as const;
  private em = new Emitter<StickEvents>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private linked = false;
  private soc = 82;
  private charging = false;
  private seq = 0;
  private boot = Date.now();
  private approach = -1;
  private pitch = 2;
  private buttonQueue: ButtonEvent[] = [];
  private safetyQueue: EcuSafetyEvent[] = [];
  private eventId = 0;
  private n = 0;

  constructor(private opts: { startLinked: boolean }) {}

  on<E extends keyof StickEvents>(event: E, cb: StickEvents[E]) {
    return this.em.on(event, cb);
  }

  async connect() {
    if (this.opts.startLinked) this.setLinked(true);
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 700);
  }

  disconnect() {
    clearInterval(this.timer);
    this.em.clear();
  }

  private uptime() {
    return Date.now() - this.boot;
  }

  private tick() {
    if (!this.linked) return;
    this.n++;
    const speed = getSettings().simSpeed;
    if (this.n % Math.max(3, Math.round(70 / speed)) === 0) this.soc = Math.max(1, Math.min(100, this.soc + (this.charging ? 1 : -1)));

    let distance: number | null = null;
    let status: TelemetryPacket['ultrasonic']['status'] = 'no_echo';
    if (this.approach >= 0) {
      distance = APPROACH[this.approach];
      status = 'ok';
      this.approach = this.approach + 1 < APPROACH.length ? this.approach + 1 : -1;
    } else if (Math.random() < 0.035) this.approach = 0;

    this.pitch += (Math.random() - 0.5) * 1.2;
    this.pitch = Math.max(-8, Math.min(12, this.pitch));
    const currentMa = this.charging ? -450 : 170 + Math.random() * 30;
    const packet: TelemetryPacket = {
      v: 1,
      deviceId: 'DEMO-4F2A',
      seq: ++this.seq,
      uptimeMs: this.uptime(),
      battery: { busV: busVoltageFor(this.soc, currentMa), shuntMv: currentMa * 0.1, currentMa, charging: null, chargeSource: 'current', ok: true },
      imu: { ax: null, ay: null, az: null, gx: null, gy: null, gz: null, pitch: this.pitch, roll: (Math.random() - 0.5) * 2, ok: true },
      ultrasonic: { distanceCm: distance, echoUs: distance ? distance * 58 : null, status, sampleAgeMs: 40, zone: distance == null ? 'normal' : distance < 50 ? 'danger' : distance < 100 ? 'warning' : distance < 150 ? 'awareness' : 'normal' },
      button: this.buttonQueue.splice(0),
      safety: this.safetyQueue.splice(0),
      rssi: -48 - Math.round(Math.random() * 9),
      health: { camera: 'ok', i2c: 'ok', motor: 'idle', firmware: '1.1.0-demo', mode: 'normal', configVersion: this.config?.configVersion ?? 0, resetReason: 'power_on', errors: [] },
    };
    this.em.emit('packet', packet, Date.now());
  }

  // ── demo controls ──
  isLinked() {
    return this.linked;
  }
  setLinked(on: boolean) {
    this.linked = on;
    if (on) this.em.emit('identity', { deviceId: 'DEMO-4F2A', model: 'AISS-ESP32CAM-1', firmware: '1.0.0-demo', protocolVersion: 1 });
    this.em.emit('link', on ? 'connected' : 'disconnected');
  }
  pressButton(p: ButtonPattern) {
    if (!this.linked && p !== 'setup-hold') return;
    const gesture = p === 'hold' ? 'long' : p === 'setup-hold' ? 'setup' : p;
    this.buttonQueue.push({ id: ++this.eventId, kind: 'gesture', gesture, atMs: this.uptime() });
    if (!this.linked) this.em.emit('packet', { ...this.emptyPacket(), button: this.buttonQueue.splice(0) }, Date.now());
  }
  simulateFall() {
    if (this.linked) this.safetyQueue.push({ id: ++this.eventId, type: 'fall', atMs: this.uptime(), value: 2.7, confidence: 0.9 });
  }
  setBattery(pct: number) {
    this.soc = pct;
  }
  setCharging(on: boolean) {
    this.charging = on;
  }
  forceObstacle() {
    if (this.linked) this.approach = 0;
  }

  private emptyPacket(): TelemetryPacket {
    return {
      v: 1,
      deviceId: 'DEMO-4F2A',
      seq: ++this.seq,
      uptimeMs: this.uptime(),
      battery: { busV: null, shuntMv: null, currentMa: null, charging: null, chargeSource: 'none', ok: false },
      imu: { ax: null, ay: null, az: null, gx: null, gy: null, gz: null, pitch: null, roll: null, ok: false },
      ultrasonic: { distanceCm: null, echoUs: null, status: 'error', sampleAgeMs: 0 },
      button: [],
      rssi: null,
      health: { camera: 'ok', i2c: 'ok', motor: 'idle' },
    };
  }

  async captureFrame(opts: { sceneHint?: number } = {}): Promise<CapturedFrame> {
    if (!this.linked) throw new Error('stick-offline');
    await wait(420 + Math.random() * 260);
    const scene = opts.sceneHint ?? Math.floor(Math.random() * 3);
    return { blob: await renderFrame(scene), width: 640, height: 480, capturedAt: Date.now(), scene };
  }

  private config: DeviceConfig | null = null;
  private seen = new Set<string>();

  /** DEMO: same ack semantics as the ECU (idempotent, versioned config). */
  async send(cmd: DeviceCommand, opts: { commandId?: string } = {}): Promise<CommandAck> {
    await wait(120);
    const commandId = opts.commandId ?? newCommandId();
    if (!this.linked) throw new Error('stick-offline');
    if (this.seen.has(commandId)) return { commandId, status: 'duplicate' };
    this.seen.add(commandId);
    if (cmd.type === 'setConfig') {
      if (this.config && cmd.config.configVersion <= this.config.configVersion) return { commandId, status: 'rejected', error: 'stale configVersion' };
      this.config = cmd.config;
      return { commandId, status: 'completed', result: { configVersion: cmd.config.configVersion } };
    }
    if (cmd.type === 'getConfig') return { commandId, status: 'completed', result: (this.config ?? { configVersion: 0 }) as unknown as Record<string, unknown> };
    if (cmd.type === 'selfTest') return { commandId, status: 'completed', result: { imu: 'ok', battery: { ok: true }, ultrasonic: { status: 'no_echo' }, camera: { ok: true, bytes: 18000 }, motor: 'pulsed', note: 'demo' } };
    return { commandId, status: 'completed' };
  }
}
