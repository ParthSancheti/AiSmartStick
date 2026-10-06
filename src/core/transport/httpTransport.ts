import { AUTH_HEADERS, DEVICE_API, PROTOCOL_VERSION, STICK_AP_PASSPHRASE, STICK_AP_SSID, type CommandAck, type CommandEnvelope, type DeviceCommand, type DeviceInfoPacket, type TelemetryPacket } from '../../../shared/deviceProtocol';
import { canonicalRequest, hmacHex, randomBytes, safeEqual, sha256Hex, toB64, toHex } from '../device/crypto';
import type { PairedDevice } from '../device/pairedDevice';
import { trace } from '../device/deviceTrace';
import { log } from '../log';
import { Emitter, MAX_TELEMETRY_BYTES, newCommandId, toEnvelopeParts, validateJpeg, type CapturedFrame, type StickEvents, type StickTransport } from './types';

/**
 * Real transport: ESP32 ECU, protocol v1, every request HMAC-signed with the key created during
 * provisioning (DEVICE_PROTOCOL.md §Authentication; firmware Identity.cpp `authorized`). The stick
 * must prove it holds the same key before the app shows "Connected". The IP is never an identity.
 *
 * Topology (dashcam firmware): the stick is always its own access point (SmartStick_AI,
 * 192.168.4.1). On Android every request goes through the native plugin, which binds the socket to
 * that Wi-Fi network while mobile data stays the default route for Firebase, Maps and Gemini.
 *
 * States: connecting → connected ⇄ degraded → reconnecting (exponential backoff 1 s … 30 s) →
 * disconnected; auth_failed and protocol_mismatch are terminal until the user re-pairs/updates.
 */
type State = 'idle' | 'connecting' | 'connected' | 'degraded' | 'reconnecting' | 'disconnected' | 'auth_failed' | 'protocol_mismatch';

class AuthError extends Error {}
class ProtocolError extends Error {}
class LinkError extends Error {}

interface RawResponse {
  status: number;
  text: string;
}

const isNative = () => typeof window !== 'undefined' && (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() === true;
const native = () => import('../native/aissNative').then((m) => m.AissNative);

/** Telemetry poll period. Safety never waits on it (obstacle → motor runs on the stick). */
export const DEFAULT_POLL_MS = 500;

export class HttpTransport implements StickTransport {
  readonly kind = 'http' as const;
  private em = new Emitter<StickEvents>();
  private ctrl: AbortController | null = null;
  private misses = 0;
  private attempt = 0;
  private state: State = 'idle';
  private host: string | null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private onConnected: (() => void) | null = null;

  constructor(private dev: PairedDevice, private pollMs = DEFAULT_POLL_MS) {
    this.host = dev.host;
  }

  on<E extends keyof StickEvents>(event: E, cb: StickEvents[E]) {
    return this.em.on(event, cb);
  }

  /** Called after every successful (re)authentication, e.g. to sync device configuration. */
  setOnConnected(cb: () => void) {
    this.onConnected = cb;
  }

  setHost(ip: string) {
    if (ip === this.host && (this.state === 'connected' || this.state === 'degraded')) return;
    this.host = ip;
    if (this.state === 'auth_failed' || this.state === 'protocol_mismatch') return;
    if (this.ctrl) {
      this.attempt = 0;
      void this.restart();
    }
  }

  getHost() {
    return this.host;
  }

  async connect() {
    await this.restart();
  }

  disconnect() {
    clearTimeout(this.retryTimer);
    this.ctrl?.abort();
    this.ctrl = null;
    this.setState('disconnected');
  }

  private setState(s: State, detail?: string) {
    if (s === this.state) return;
    this.state = s;
    if (s !== 'idle') this.em.emit('link', s, detail);
  }

  private scheduleRetry(signal: AbortSignal, detail: string) {
    // Exponential backoff with jitter: 1, 2, 4, 8, 16, 30 s … — no reconnect storms.
    const base = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5));
    const wait = base * (0.8 + Math.random() * 0.4);
    this.attempt++;
    this.setState(this.attempt > 6 ? 'disconnected' : 'reconnecting', detail);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => !signal.aborted && void this.restart(), wait);
  }

  private async restart() {
    this.ctrl?.abort();
    clearTimeout(this.retryTimer);
    this.ctrl = new AbortController();
    const signal = this.ctrl.signal;
    if (!this.host) {
      this.setState('connecting', 'Waiting for the stick');
      return;
    }
    if (this.state !== 'reconnecting' && this.state !== 'disconnected') this.setState('connecting');
    try {
      await this.ensureStickNetwork();
      if (signal.aborted) return;
      await this.authenticate(signal);
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof AuthError) {
        log.security('stick failed key proof', { deviceId: this.dev.deviceId });
        trace('auth_failed', { error: 'key proof' });
        this.setState('auth_failed', 'The stick did not prove it has this phone’s key. Pair it again.');
        return;
      }
      if (e instanceof ProtocolError) {
        this.setState('protocol_mismatch', e.message);
        return;
      }
      this.scheduleRetry(signal, e instanceof LinkError ? e.message : 'The stick is not answering');
      return;
    }
    this.attempt = 0;
    this.misses = 0;
    this.setState('connected');
    trace('connected', { deviceId: this.dev.deviceId });
    this.onConnected?.();
    void this.poll(signal);
  }

  /**
   * Android: (re)binds the stick's Wi-Fi network. After an app restart the previous binding is gone
   * and requests would otherwise leave over mobile data, where 192.168.4.1 does not exist.
   * Android remembers the user's approval for this SSID, so this is silent after first setup.
   */
  private async ensureStickNetwork() {
    if (!isNative()) return;
    const n = await native();
    const { connected, reason } = await n.connectToSetupNetwork({ ssid: STICK_AP_SSID, passphrase: STICK_AP_PASSPHRASE, timeoutMs: 15_000 });
    if (!connected) throw new LinkError(reason === 'WIFI_DISABLED' ? 'Wi-Fi is off. Turn it on to reach the stick.' : 'The stick’s Wi-Fi is not in range');
  }

  private async sign(method: string, path: string, bodySha: string) {
    const ts = Date.now();
    const nonce = toHex(randomBytes(12));
    const sig = await hmacHex(this.dev.keyB64, canonicalRequest(method, path, ts, nonce, bodySha));
    return {
      [AUTH_HEADERS.device]: this.dev.deviceId,
      [AUTH_HEADERS.ts]: String(ts),
      [AUTH_HEADERS.nonce]: nonce,
      [AUTH_HEADERS.sig]: sig,
    } as Record<string, string>;
  }

  /** Every request is signed; the firmware rejects unsigned telemetry/capture/command with 401. */
  private async request(method: 'GET' | 'POST', path: string, opts: { body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<RawResponse> {
    const body = opts.body === undefined ? '' : JSON.stringify(opts.body);
    const headers = await this.sign(method, path, await sha256Hex(body));
    let res: RawResponse;
    if (isNative()) {
      try {
        const r = await (await native()).setupRequest({ method, path, body: body || undefined, headers, timeoutMs: opts.timeoutMs ?? 2000 });
        res = { status: r.status, text: r.body };
      } catch (err) {
        throw new Error(`Native request failed: ${(err as Error).message}`);
      }
    } else {
      if (body) headers['content-type'] = 'application/json';
      const signal = opts.signal && opts.timeoutMs ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]) : opts.signal;
      const r = await fetch(`http://${this.host}${path}`, { method, headers, body: body || undefined, signal });
      res = { status: r.status, text: await r.text() };
    }
    if (res.status === 401 || res.status === 403) throw new AuthError('auth');
    if (res.status >= 400 && res.status !== 409 && res.status !== 503) throw new Error(`HTTP ${res.status}`);
    return res;
  }

  private async authenticate(signal: AbortSignal) {
    const challenge = toHex(randomBytes(16));
    const res = await this.request('GET', `${DEVICE_API.device}?challenge=${challenge}`, { signal, timeoutMs: 2500 });
    const info = JSON.parse(res.text) as DeviceInfoPacket;
    if (info.deviceId !== this.dev.deviceId) throw new AuthError('device id');
    if (info.protocolVersion !== PROTOCOL_VERSION) throw new ProtocolError(`The stick firmware speaks protocol v${info.protocolVersion}; this app needs v${PROTOCOL_VERSION}. Update the stick firmware.`);
    // Key proof: HMAC(key, challenge || deviceId). An unprovisioned or different stick cannot answer.
    const expect = await hmacHex(this.dev.keyB64, challenge + this.dev.deviceId);
    if (!info.proof || !safeEqual(info.proof, expect)) throw new AuthError('proof');
    this.em.emit('identity', { deviceId: info.deviceId, model: info.model, firmware: info.firmware, protocolVersion: info.protocolVersion });
  }

  private async poll(signal: AbortSignal) {
    while (!signal.aborted) {
      const started = performance.now();
      try {
        const res = await this.request('GET', DEVICE_API.telemetry, { signal, timeoutMs: 2000 });
        if (res.text.length > MAX_TELEMETRY_BYTES) throw new Error('telemetry too large');
        const packet = JSON.parse(res.text) as TelemetryPacket;
        trace('packet_received', { seq: packet.seq });
        const latency = performance.now() - started;
        this.misses = 0;
        const errors = packet.health?.errors?.length ?? 0;
        // Degraded: answering, but slow or reporting hardware errors. Safety still runs on the stick.
        this.setState(latency > 1200 || errors > 0 ? 'degraded' : 'connected', errors ? `Stick reports: ${packet.health.errors!.join(', ')}` : latency > 1200 ? 'Slow link' : undefined);
        this.em.emit('packet', packet, Date.now());
      } catch (e) {
        if (signal.aborted) return;
        if (e instanceof AuthError) {
          log.security('stick rejected request signature', { deviceId: this.dev.deviceId });
          trace('auth_failed', { error: 'telemetry 401' });
          this.setState('auth_failed', 'The stick rejected this phone’s key.');
          return;
        }
        this.misses++;
        if (this.misses === 2) this.setState('degraded', 'Missed telemetry');
        if (this.misses >= 6) {
          // Stale connection: re-bind the network and re-authenticate from scratch with backoff.
          this.scheduleRetry(signal, 'The stick stopped answering');
          return;
        }
      }
      const wait = this.misses ? Math.max(this.pollMs, 1000) : this.pollMs;
      await new Promise((r) => setTimeout(r, Math.max(0, wait - (performance.now() - started))));
    }
  }

  async captureFrame(opts: { timeoutMs?: number } = {}): Promise<CapturedFrame> {
    if (this.state !== 'connected' && this.state !== 'degraded') throw new Error('stick-offline');
    trace('frame_requested');
    // Exposure time ≈ request start (the stick captures on request); download + decode come after.
    const capturedAt = Date.now();
    const headers = await this.sign('GET', DEVICE_API.capture, await sha256Hex(''));
    let status: number;
    let blob: Blob | null = null;
    if (isNative()) {
      const res = await (await native()).requestBinary({ path: DEVICE_API.capture, headers, timeoutMs: opts.timeoutMs ?? 6000 });
      status = res.status;
      if (status < 400 && res.body) {
        const bin = atob(res.body);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        blob = new Blob([bytes], { type: 'image/jpeg' });
      }
    } else {
      const r = await fetch(`http://${this.host}${DEVICE_API.capture}`, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 6000) });
      status = r.status;
      if (r.ok) blob = await r.blob();
    }
    if (status === 401 || status === 403) {
      trace('frame_rejected', { error: 'capture 401' });
      throw new Error('camera: unauthorized');
    }
    if (status === 409) throw new Error('camera: busy');
    if (status === 503) throw new Error('camera: unavailable');
    if (status >= 400 || !blob) throw new Error(`HTTP ${status}`);
    const bad = await validateJpeg(blob);
    if (bad) {
      trace('frame_rejected', { error: bad, bytes: blob.size });
      throw new Error(`camera: ${bad}`);
    }
    trace('frame_received', { bytes: blob.size });
    return { blob, width: null, height: null, capturedAt };
  }

  async send(cmd: DeviceCommand, opts: { commandId?: string; ttlMs?: number } = {}): Promise<CommandAck> {
    if (this.state !== 'connected' && this.state !== 'degraded') throw new Error('stick-offline');
    const { type, payload } = toEnvelopeParts(cmd);
    const now = Date.now();
    const env: CommandEnvelope = { commandId: opts.commandId ?? newCommandId(), type: type as CommandEnvelope['type'], payload, issuedAt: now, expiresAt: now + (opts.ttlMs ?? 10_000) };
    // One retry with the SAME commandId is safe: the ECU acknowledges a repeat as "duplicate".
    for (let tryNo = 0; ; tryNo++) {
      try {
        const res = await this.request('POST', DEVICE_API.command, { body: env, timeoutMs: type === 'selfTest' ? 8000 : 2500 });
        const ack = JSON.parse(res.text) as CommandAck;
        if (ack.commandId !== env.commandId) throw new Error('ack mismatch');
        return ack;
      } catch (e) {
        if (e instanceof AuthError || tryNo >= 1) throw e;
      }
    }
  }

  async pushOTA(blob: Blob, sha256: string): Promise<void> {
    if (this.state !== 'connected' && this.state !== 'degraded') throw new Error('stick-offline');
    const path = DEVICE_API.ota;
    const body = new Uint8Array(await blob.arrayBuffer());
    // The firmware streams the image and checks the signature against this declared body hash.
    const headers = { ...(await this.sign('POST', path, sha256.toLowerCase())), 'x-aiss-content-sha256': sha256.toLowerCase() };
    if (isNative()) {
      const r = await (await native()).setupRequest({ method: 'POST', path, bodyBase64: toB64(body), headers, timeoutMs: 120_000 });
      if (r.status >= 400) throw new Error(`OTA failed: HTTP ${r.status}`);
      return;
    }
    const res = await fetch(`http://${this.host}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body });
    if (!res.ok) throw new Error(`OTA failed: HTTP ${res.status}`);
  }
}
