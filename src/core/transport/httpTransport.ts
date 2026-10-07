import { DEVICE_API, MIN_STICK_FIRMWARE, PROTOCOL_VERSION, SETUP_AP_HOST, STICK_AP_PASSPHRASE, STICK_AP_SSID, type CommandAck, type CommandEnvelope, type DeviceCommand, type DeviceInfoPacket, type TelemetryPacket } from '../../../shared/deviceProtocol';
import { toB64 } from '../device/crypto';
import type { PairedDevice } from '../device/pairedDevice';
import { trace } from '../device/deviceTrace';
import { log } from '../log';
import { Emitter, MAX_TELEMETRY_BYTES, newCommandId, toEnvelopeParts, validateJpeg, type CapturedFrame, type StickEvents, type StickTransport } from './types';

/**
 * Real transport, v1 SIMPLE LINK (firmware 1.2+, REQUIRE_AUTH 0): plain unsigned HTTP to the stick's
 * own access point (SmartStick_AI, 192.168.4.1). Joining that Wi-Fi is the only "pairing".
 *
 * On Android every request goes through the native plugin, which sends it over the stick's Wi-Fi
 * (bound with WifiNetworkSpecifier, or the Wi-Fi the user joined by hand) while mobile data stays
 * the default route for Firebase, Maps and Gemini.
 *
 * States: connecting → (first telemetry packet) connected ⇄ degraded → reconnecting (backoff
 * 1 s … 30 s) → disconnected. auth_failed = the stick still runs the old secure firmware (401);
 * protocol_mismatch = another protocol version. Both are terminal until the user acts.
 * "Connected" is only ever shown after a real telemetry packet arrived.
 */
type State = 'idle' | 'connecting' | 'connected' | 'degraded' | 'reconnecting' | 'disconnected' | 'auth_failed' | 'protocol_mismatch';

/** Shown when the stick answers 401: it runs firmware 1.1 (signed requests). */
export const OLD_FIRMWARE_MESSAGE = `This stick runs the old secure firmware. Flash firmware ${MIN_STICK_FIRMWARE} on the stick, then run “Set up SmartStick” again.`;

class AuthError extends Error {}
class ProtocolError extends Error {}
class LinkError extends Error {}

interface RawResponse {
  status: number;
  text: string;
}

/** What the transport needs. Old records (with a keyB64 from the HMAC era) are accepted as they are. */
export type StickTarget = Pick<PairedDevice, 'deviceId' | 'host'> & Partial<PairedDevice>;

const isNative = () => typeof window !== 'undefined' && (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() === true;
const native = () => import('../native/aissNative').then((m) => m.AissNative);
const foreground = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/** Telemetry poll period. Safety never waits on it (obstacle → motor runs on the stick). */
export const DEFAULT_POLL_MS = 500;
/** A request that may show Android's "Connect to device" sheet is made at most this often on reconnects. */
const FULL_REQUEST_EVERY_MS = 120_000;

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
  private lastFullRequest = 0;
  /** Connected at least once since this link started (after that, a missing stick never pops the system sheet). */
  private hasConnected = false;

  constructor(private dev: StickTarget, private pollMs = DEFAULT_POLL_MS) {
    this.host = dev.host ?? SETUP_AP_HOST;
  }

  on<E extends keyof StickEvents>(event: E, cb: StickEvents[E]) {
    return this.em.on(event, cb);
  }

  /** Called after every (re)connection, i.e. the first telemetry packet, e.g. to sync device configuration. */
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

  getState() {
    return this.state;
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

  private up() {
    return this.state === 'connected' || this.state === 'degraded';
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
    this.misses = 0;
    if (!this.host) {
      this.setState('connecting', 'Waiting for the stick');
      return;
    }
    if (this.state !== 'reconnecting' && this.state !== 'disconnected') this.setState('connecting');
    try {
      await this.ensureStickNetwork();
      if (signal.aborted) return;
      await this.readIdentity(signal);
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof AuthError) return this.failAuth('device 401');
      if (e instanceof ProtocolError) {
        this.setState('protocol_mismatch', e.message);
        return;
      }
      this.scheduleRetry(signal, e instanceof LinkError ? e.message : 'The stick is not answering');
      return;
    }
    if (signal.aborted) return;
    void this.poll(signal);
  }

  private failAuth(where: string) {
    log.warn('stick requires signed requests (old firmware)', { deviceId: this.dev.deviceId, where });
    trace('auth_failed', { error: `${where}: old firmware` });
    this.setState('auth_failed', OLD_FIRMWARE_MESSAGE);
  }

  /**
   * Android: makes the stick's Wi-Fi reachable. After an app restart the previous binding is gone and
   * requests would otherwise leave over mobile data, where 192.168.4.1 does not exist. Android
   * remembers the user's approval for this SSID, so this is silent after the first setup.
   * Reconnects only ask Android when the last Wi-Fi scan saw the stick (or, when Android will not
   * say, at most every 2 minutes while the app is open), so a switched-off stick never makes the
   * system sheet pop up again and again.
   */
  private async ensureStickNetwork() {
    if (!isNative()) return;
    const n = await native();
    // Live binding / Wi-Fi joined by hand / stick seen in the last scan → (silent) connect.
    let res = await n.connectToSetupNetwork({ ssid: STICK_AP_SSID, passphrase: STICK_AP_PASSPHRASE, timeoutMs: 15_000, openWifiPanelIfOff: false, onlyIfVisible: true });
    // A stale or throttled Wi-Fi scan often misses the stick (NOT_IN_RANGE) even when it is right here
    // (right after setup, or at app start): until the first connection, ask Android directly
    // (silent once approved; rate-limited).
    const askDirect = res.reason === 'RANGE_UNKNOWN' || (res.reason === 'NOT_IN_RANGE' && !this.hasConnected);
    if (!res.connected && askDirect && foreground() && Date.now() - this.lastFullRequest > FULL_REQUEST_EVERY_MS) {
      // Android will not say whether the stick is near (location off / no permission): ask directly.
      this.lastFullRequest = Date.now();
      res = await n.connectToSetupNetwork({ ssid: STICK_AP_SSID, passphrase: STICK_AP_PASSPHRASE, timeoutMs: 15_000, openWifiPanelIfOff: false });
    }
    if (!res.connected) {
      const msg =
        res.reason === 'WIFI_DISABLED'
          ? 'Wi-Fi is off. Turn it on to reach the stick.'
          : res.reason === 'UNSUPPORTED'
            ? `Join ${STICK_AP_SSID} in Android Wi-Fi settings to reach the stick.`
            : `Looking for the stick’s Wi-Fi (${STICK_AP_SSID}). Switch the stick on and keep it close.`;
      throw new LinkError(msg);
    }
  }

  /** Plain request: no keys, no signatures (firmware 1.2 REQUIRE_AUTH 0). */
  private async request(method: 'GET' | 'POST', path: string, opts: { body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<RawResponse> {
    const body = opts.body === undefined ? '' : JSON.stringify(opts.body);
    let res: RawResponse;
    if (isNative()) {
      try {
        const r = await (await native()).setupRequest({ method, path, body: body || undefined, timeoutMs: opts.timeoutMs ?? 2000 });
        res = { status: r.status, text: r.body };
      } catch (err) {
        throw new Error(`Native request failed: ${(err as Error).message}`);
      }
    } else {
      const headers: Record<string, string> = body ? { 'content-type': 'application/json' } : {};
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? 2000);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      const r = await fetch(`http://${this.host}${path}`, { method, headers, body: body || undefined, signal });
      res = { status: r.status, text: await r.text() };
    }
    if (res.status === 401 || res.status === 403) throw new AuthError('auth');
    if (res.status >= 400 && res.status !== 409 && res.status !== 503) throw new Error(`HTTP ${res.status}`);
    return res;
  }

  /** GET /device: is this a SmartStick speaking our protocol? (No key proof in v1.) */
  private async readIdentity(signal: AbortSignal) {
    const res = await this.request('GET', DEVICE_API.device, { signal, timeoutMs: 3000 });
    let info: DeviceInfoPacket;
    try {
      info = JSON.parse(res.text) as DeviceInfoPacket;
    } catch {
      throw new Error('not a SmartStick answer');
    }
    if (!info || typeof info.deviceId !== 'string') throw new Error('not a SmartStick answer');
    if (info.protocolVersion !== PROTOCOL_VERSION) throw new ProtocolError(`The stick firmware speaks protocol v${info.protocolVersion}; this app needs v${PROTOCOL_VERSION}. Update the stick firmware.`);
    if (info.deviceId !== this.dev.deviceId) log.info('stick: a different SmartStick answered', { saved: this.dev.deviceId, now: info.deviceId });
    this.em.emit('identity', { deviceId: info.deviceId, model: info.model, firmware: info.firmware, protocolVersion: info.protocolVersion });
  }

  private async poll(signal: AbortSignal) {
    while (!signal.aborted) {
      const started = performance.now();
      try {
        const res = await this.request('GET', DEVICE_API.telemetry, { signal, timeoutMs: 2000 });
        if (signal.aborted) return;
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        if (res.text.length > MAX_TELEMETRY_BYTES) throw new Error('telemetry too large');
        const packet = JSON.parse(res.text) as TelemetryPacket;
        if (!packet || typeof packet !== 'object' || typeof packet.seq !== 'number') throw new Error('malformed telemetry');
        trace('packet_received', { seq: packet.seq });
        const latency = performance.now() - started;
        this.misses = 0;
        if (!this.up()) {
          // CONNECTED only now: real data arrived.
          this.attempt = 0;
          this.hasConnected = true;
          this.setState('connected');
          trace('connected', { deviceId: packet.deviceId ?? this.dev.deviceId });
          this.em.emit('packet', packet, Date.now());
          this.onConnected?.();
        } else {
          // Degraded is about the LINK (slow answers). Hardware faults (e.g. a sensor not wired) are
          // shown by the battery / health cards from the packet itself; the stick is still connected.
          this.setState(latency > 1200 ? 'degraded' : 'connected', latency > 1200 ? 'Slow link' : undefined);
          this.em.emit('packet', packet, Date.now());
        }
      } catch (e) {
        if (signal.aborted) return;
        if (e instanceof AuthError) return this.failAuth('telemetry 401');
        // The phone lost the stick's Wi-Fi (Android reports it at once): re-bind now, not after 6 misses.
        if (/not bound/i.test((e as Error).message)) {
          this.scheduleRetry(signal, 'Reconnecting to the stick’s Wi-Fi');
          return;
        }
        this.misses++;
        if (this.misses === 2 && this.up()) this.setState('degraded', 'Missed telemetry');
        if (this.misses >= (this.up() ? 6 : 4)) {
          // Stale connection: re-bind the network and start over with backoff.
          this.scheduleRetry(signal, 'The stick stopped answering');
          return;
        }
      }
      const wait = this.misses ? Math.max(this.pollMs, 1000) : this.pollMs;
      await new Promise((r) => setTimeout(r, Math.max(0, wait - (performance.now() - started))));
    }
  }

  async captureFrame(opts: { timeoutMs?: number } = {}): Promise<CapturedFrame> {
    if (!this.up()) throw new Error('stick-offline');
    trace('frame_requested');
    // Exposure time ≈ request start (the stick captures on request); download + decode come after.
    const capturedAt = Date.now();
    let status: number;
    let blob: Blob | null = null;
    if (isNative()) {
      const res = await (await native()).requestBinary({ path: DEVICE_API.capture, timeoutMs: opts.timeoutMs ?? 6000 });
      status = res.status;
      if (status < 400 && res.body) {
        const bin = atob(res.body);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        blob = new Blob([bytes], { type: 'image/jpeg' });
      }
    } else {
      const r = await fetch(`http://${this.host}${DEVICE_API.capture}`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 6000) });
      status = r.status;
      if (r.ok) blob = await r.blob();
    }
    if (status === 401 || status === 403) {
      trace('frame_rejected', { error: 'capture 401 (old firmware)' });
      throw new Error('camera: unauthorized (old firmware)');
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
    if (!this.up()) throw new Error('stick-offline');
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
        if (e instanceof AuthError) throw new Error(OLD_FIRMWARE_MESSAGE);
        if (tryNo >= 1) throw e;
      }
    }
  }

  async pushOTA(blob: Blob, sha256: string): Promise<void> {
    if (!this.up()) throw new Error('stick-offline');
    const path = DEVICE_API.ota;
    const body = new Uint8Array(await blob.arrayBuffer());
    const headers = { 'x-aiss-content-sha256': sha256.toLowerCase() };
    if (isNative()) {
      const r = await (await native()).setupRequest({ method: 'POST', path, bodyBase64: toB64(body), headers, timeoutMs: 120_000 });
      if (r.status >= 400) throw new Error(`OTA failed: HTTP ${r.status}`);
      return;
    }
    const res = await fetch(`http://${this.host}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body });
    if (!res.ok) throw new Error(`OTA failed: HTTP ${res.status}`);
  }
}
