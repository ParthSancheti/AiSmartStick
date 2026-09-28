import { AUTH_HEADERS, CAPTURE_HEADERS, DEVICE_API, PROTOCOL_VERSION, type CommandAck, type CommandEnvelope, type DeviceCommand, type DeviceInfoPacket, type TelemetryPacket } from '../../../shared/deviceProtocol';
import { canonicalRequest, hmacHex, randomBytes, safeEqual, sha256Hex, toHex } from '../device/crypto';
import type { PairedDevice } from '../device/pairedDevice';
import { log } from '../log';
import { Emitter, MAX_TELEMETRY_BYTES, newCommandId, toEnvelopeParts, validateJpeg, type CapturedFrame, type StickEvents, type StickTransport } from './types';

/**
 * Real transport: ESP32 ECU on the phone's hotspot, protocol v1, every request HMAC-signed with
 * the key created during provisioning. The stick must prove it holds the same key before the app
 * shows "Connected". The IP address is only an address, never an identity.
 *
 * States: connecting → connected ⇄ degraded → reconnecting (exponential backoff 1 s … 30 s) →
 * disconnected; auth_failed and protocol_mismatch are terminal until the user re-pairs/updates.
 */
type State = 'idle' | 'connecting' | 'connected' | 'degraded' | 'reconnecting' | 'disconnected' | 'auth_failed' | 'protocol_mismatch';

class AuthError extends Error {}
class ProtocolError extends Error {}

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

  constructor(private dev: PairedDevice, private pollMs = 300) {
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
      this.setState('connecting', 'Waiting for the stick to announce itself on the hotspot');
      return;
    }
    if (this.state !== 'reconnecting' && this.state !== 'disconnected') this.setState('connecting');
    try {
      await this.authenticate(signal);
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof AuthError) {
        log.security('stick failed key proof', { deviceId: this.dev.deviceId });
        this.setState('auth_failed', 'The stick did not prove it has this phone’s key. Pair it again.');
        return;
      }
      if (e instanceof ProtocolError) {
        this.setState('protocol_mismatch', e.message);
        return;
      }
      this.scheduleRetry(signal, 'The stick is not answering');
      return;
    }
    this.attempt = 0;
    this.misses = 0;
    this.setState('connected');
    this.onConnected?.();
    void this.poll(signal);
  }

  private async sign(method: string, path: string, body = '') {
    const ts = Date.now();
    const nonce = toHex(randomBytes(12));
    const sig = await hmacHex(this.dev.keyB64, canonicalRequest(method, path, ts, nonce, await sha256Hex(body)));
    return {
      [AUTH_HEADERS.device]: this.dev.deviceId,
      [AUTH_HEADERS.ts]: String(ts),
      [AUTH_HEADERS.nonce]: nonce,
      [AUTH_HEADERS.sig]: sig,
    };
  }

  private async request(method: 'GET' | 'POST', path: string, opts: { body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}) {
    const body = opts.body === undefined ? '' : JSON.stringify(opts.body);
    const headers: Record<string, string> = await this.sign(method, path, body);
    if (body) headers['content-type'] = 'application/json';
    
    // Instead of web fetch, we MUST use the native Android plugin to route traffic specifically 
    // over the Wi-Fi network while leaving Mobile Data active for Gemini AI! (Dashcam Protocol)
    const { AissNative } = await import('../native/aissNative');
    try {
      const res = await AissNative.setupRequest({ method, path, body: body || undefined, timeoutMs: opts.timeoutMs ?? 1500 });
      if (res.status === 401 || res.status === 403) throw new AuthError('auth');
      if (res.status >= 400 && res.status !== 409 && res.status !== 503) throw new Error(`HTTP ${res.status}`);
      return {
        status: res.status,
        text: async () => res.body,
        json: async () => JSON.parse(res.body),
        ok: res.status < 400,
      };
    } catch (err: any) {
      if (err instanceof AuthError) throw err;
      throw new Error(`Native request failed: ${err.message}`);
    }
  }

  private async authenticate(signal: AbortSignal) {
    const challenge = toHex(randomBytes(16));
    const path = `${DEVICE_API.device}?challenge=${challenge}`;
    const res = await this.request('GET', path, { signal, timeoutMs: 2500 });
    const info = (await res.json()) as DeviceInfoPacket;
    if (info.deviceId !== this.dev.deviceId) throw new AuthError('device id');
    if (info.protocolVersion !== PROTOCOL_VERSION) throw new ProtocolError(`The stick firmware speaks protocol v${info.protocolVersion}; this app needs v${PROTOCOL_VERSION}. Update the stick firmware.`);
    const expect = await hmacHex(this.dev.keyB64, challenge + info.deviceId);
    if (!info.proof || !safeEqual(info.proof, expect)) throw new AuthError('proof');
    this.em.emit('identity', { deviceId: info.deviceId, model: info.model, firmware: info.firmware, protocolVersion: info.protocolVersion });
  }

  private async poll(signal: AbortSignal) {
    while (!signal.aborted) {
      const started = performance.now();
      try {
        const res = await this.request('GET', DEVICE_API.telemetry, { signal });
        const text = await res.text();
        if (text.length > MAX_TELEMETRY_BYTES) throw new Error('telemetry too large');
        const packet = JSON.parse(text) as TelemetryPacket;
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
          this.setState('auth_failed', 'The stick rejected this phone’s key.');
          return;
        }
        this.misses++;
        if (this.misses === 2) this.setState('degraded', 'Missed telemetry');
        if (this.misses >= 6) {
          // Stale connection: re-authenticate from scratch with backoff (address may have changed).
          this.scheduleRetry(signal, 'The stick stopped answering');
          return;
        }
      }
      const wait = this.misses ? Math.min(2000, 300 * this.misses) : this.pollMs;
      await new Promise((r) => setTimeout(r, Math.max(0, wait - (performance.now() - started))));
    }
  }

  async captureFrame(opts: { timeoutMs?: number } = {}): Promise<CapturedFrame> {
    if (this.state !== 'connected' && this.state !== 'degraded') throw new Error('stick-offline');
    
    const { AissNative } = await import('../native/aissNative');
    const res = await AissNative.requestBinary({ path: DEVICE_API.capture, timeoutMs: opts.timeoutMs ?? 6000 });
    
    if (res.status === 409) throw new Error('camera: busy');
    if (res.status === 503) throw new Error('camera: unavailable');
    if (res.status >= 400 || !res.body) throw new Error(`HTTP ${res.status}`);
    
    // Convert Base64 back to a Blob
    const binaryString = atob(res.body);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    
    const bad = await validateJpeg(blob);
    if (bad) throw new Error(`camera: ${bad}`);
    return { blob, width: null, height: null, capturedAt: Date.now() };
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
        const ack = (await res.json()) as CommandAck;
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
    const ts = Date.now();
    const nonce = toHex(randomBytes(12));
    const body = new Uint8Array(await blob.arrayBuffer());
    const bodySha = await sha256Hex(body);
    const sig = await hmacHex(this.dev.keyB64, canonicalRequest('POST', path, ts, nonce, bodySha));
    const headers: Record<string, string> = {
      [AUTH_HEADERS.device]: this.dev.deviceId,
      [AUTH_HEADERS.ts]: String(ts),
      [AUTH_HEADERS.nonce]: nonce,
      [AUTH_HEADERS.sig]: sig,
      'x-aiss-content-sha256': sha256.toLowerCase(),
      'content-type': 'application/octet-stream',
    };
    const res = await fetch(`http://${this.host}${path}`, {
      method: 'POST',
      headers,
      body,
    });
    if (!res.ok) throw new Error(`OTA failed: HTTP ${res.status}`);
  }
}
