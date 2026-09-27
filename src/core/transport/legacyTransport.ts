import type { CommandAck, DeviceCommand, LegacyDataPacket, TelemetryPacket } from '../../../shared/deviceProtocol';
import { Emitter, newCommandId, validateJpeg, type CapturedFrame, type StickEvents, type StickTransport } from './types';

/**
 * HARDWARE TEST ONLY: talks to the current test firmware (/data, /motor, /stream).
 * It has NO authentication, so the app labels it "Unverified test firmware" and never
 * treats it as a paired, trusted stick. Remove once the firmware speaks protocol v1.
 *
 * Mapping: distance_cm → ultrasonic, pitch/roll → IMU, button_state (level) → press/release
 * edges, battery_pct → NOT trusted (no voltage/current is exposed), is_charging → hint only.
 */
export class LegacyTransport implements StickTransport {
  readonly kind = 'http' as const;
  private em = new Emitter<StickEvents>();
  private ctrl: AbortController | null = null;
  private seq = 0;
  private boot = Date.now();
  private lastButton = false;
  private eventId = 0;

  constructor(private host: string) {}

  on<E extends keyof StickEvents>(event: E, cb: StickEvents[E]) {
    return this.em.on(event, cb);
  }

  async connect() {
    this.ctrl = new AbortController();
    const signal = this.ctrl.signal;
    this.em.emit('link', 'connecting', 'Unverified test firmware');
    this.em.emit('identity', { deviceId: `LEGACY-${this.host}`, model: 'test-firmware', firmware: 'legacy', protocolVersion: 0 });
    let misses = 0;
    while (!signal.aborted) {
      try {
        const d = (await (await fetch(`http://${this.host}/data`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) })).json()) as LegacyDataPacket;
        if (misses || this.seq === 0) this.em.emit('link', 'connected', 'Unverified test firmware');
        misses = 0;
        this.em.emit('packet', this.map(d), Date.now());
      } catch {
        if (signal.aborted) return;
        if (++misses === 3) this.em.emit('link', 'reconnecting', 'Test firmware stopped answering');
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  private map(d: LegacyDataPacket): TelemetryPacket {
    const now = Date.now() - this.boot;
    const pressed = d.button_state === true || d.button_state === 1;
    const button = [];
    if (pressed !== this.lastButton) button.push({ id: ++this.eventId, kind: pressed ? ('press' as const) : ('release' as const), atMs: now });
    this.lastButton = pressed;
    const dist = typeof d.distance_cm === 'number' ? d.distance_cm : null;
    return {
      v: 1,
      deviceId: `LEGACY-${this.host}`,
      seq: ++this.seq,
      uptimeMs: now,
      // Percent from the test firmware is not a measurement we can validate: withheld.
      battery: { busV: null, shuntMv: null, currentMa: null, charging: d.is_charging == null ? null : !!d.is_charging, chargeSource: 'none', ok: false },
      imu: { ax: null, ay: null, az: null, gx: null, gy: null, gz: null, pitch: d.pitch ?? null, roll: d.roll ?? null, ok: d.pitch != null && d.roll != null },
      ultrasonic: { distanceCm: dist && dist > 0 ? dist : null, echoUs: null, status: dist == null ? 'error' : dist <= 0 ? 'no_echo' : 'ok', sampleAgeMs: 0 },
      button,
      rssi: null,
      health: { camera: 'ok', i2c: 'ok', motor: 'idle' },
    };
  }

  disconnect() {
    this.ctrl?.abort();
    this.em.emit('link', 'disconnected');
  }

  /** Grabs the first complete JPEG from the MJPEG /stream and closes it. */
  async captureFrame(): Promise<CapturedFrame> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(`http://${this.host}/stream`, { signal: ctrl.signal });
      const reader = res.body!.getReader();
      let buf = new Uint8Array(0);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const next = new Uint8Array(buf.length + value.length);
        next.set(buf);
        next.set(value, buf.length);
        buf = next;
        const start = findMarker(buf, 0xd8, 0);
        const end = start >= 0 ? findMarker(buf, 0xd9, start + 2) : -1;
        if (start >= 0 && end > start) {
          ctrl.abort();
          const blob = new Blob([buf.slice(start, end + 2)], { type: 'image/jpeg' });
          const bad = await validateJpeg(blob);
          if (bad) throw new Error(`camera: ${bad}`);
          return { blob, width: null, height: null, capturedAt: Date.now() };
        }
        if (buf.length > 3_000_000) break;
      }
      throw new Error('camera: no frame');
    } finally {
      clearTimeout(timer);
    }
  }

  /** Legacy firmware only understands /motor (no ids, no ack): everything else is rejected honestly. */
  async send(cmd: DeviceCommand, opts: { commandId?: string } = {}): Promise<CommandAck> {
    const commandId = opts.commandId ?? newCommandId();
    if (cmd.type !== 'haptic' && cmd.type !== 'locate' && cmd.type !== 'nudge') return { commandId, status: 'rejected', error: 'not supported by the test firmware' };
    const r = await fetch(`http://${this.host}/motor`, { signal: AbortSignal.timeout(3000) });
    return { commandId, status: r.ok ? 'completed' : 'failed' };
  }
}

function findMarker(b: Uint8Array, second: number, from: number) {
  for (let i = from; i < b.length - 1; i++) if (b[i] === 0xff && b[i + 1] === second) return i;
  return -1;
}
