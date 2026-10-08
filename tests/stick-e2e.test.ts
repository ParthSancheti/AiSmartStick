/**
 * STICK ⇄ APP, END TO END, the way it runs on the phone.
 *
 *  - The REAL @capacitor/core is loaded as on Android (window.androidBridge present, a PluginHeaders
 *    entry for "AissNative", calls routed through Capacitor.nativePromise). So `AissNative` is the
 *    real registerPlugin() Proxy — with the same quirk the phone has: EVERY property, including
 *    `then`, is a "plugin method". (A plain-object mock hides exactly that.)
 *  - "Java" below mirrors AissNativePlugin.java (connectToSetupNetwork order: bound → existing Wi-Fi
 *    on 192.168.4.x → onlyIfVisible → requestNetwork with waiters; stickRoute()/NotBound; onLost;
 *    releaseSetup) and sends REAL HTTP to …
 *  - … a fake stick that mirrors firmware/ai_smart_stick_v1/Api.cpp (routes, status codes, JSON field
 *    names/types/nesting, num() → null for NaN, seq increments per telemetry request, headers).
 *  - The app code is the real one: searchForStick() → provisioning → savePairedDevice →
 *    attachPairedDevice → bridge → HttpTransport → telemetry pipeline → useDevice (what Home reads).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// ── Android WebView globals, BEFORE any module (and @capacitor/core) loads ─────────────────────
const H = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.androidBridge = { postMessage() {} };
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  const mem = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  };
  const impl: Record<string, Record<string, (o: Record<string, unknown>) => Promise<unknown>>> = {};
  const AISS_METHODS = [
    'scanForSetupNetworks', 'connectToSetupNetwork', 'getCurrentWifiSsid', 'setupRequest', 'requestBinary', 'releaseSetupNetwork',
    'setProcessBinding', 'startDiscovery', 'stopDiscovery', 'secureGet', 'secureSet', 'secureRemove', 'requestPermissions', 'checkPermissions',
    'openWifiSettings', 'openAppSettings', 'getFontScale',
  ];
  g.Capacitor = {
    PluginHeaders: [
      { name: 'AissNative', methods: AISS_METHODS.map((name) => ({ name, rtype: 'promise' })) },
      { name: 'Preferences', methods: ['get', 'set', 'remove', 'keys', 'clear'].map((name) => ({ name, rtype: 'promise' })) },
    ],
    // What the Android bridge does: dispatch to the Java method; unknown → rejected (never resolved).
    nativePromise: (plugin: string, method: string, options: Record<string, unknown>) => {
      const f = impl[plugin]?.[method];
      if (!f) return Promise.reject(new Error(`"${plugin}.${method}()" is not implemented on android`));
      return f(options ?? {});
    },
    nativeCallback: () => 'cb-1',
  };
  return { impl, mem };
});

// ── Minimal stand-ins for things that are not part of the data link ────────────────────────────
vi.mock('firebase/firestore', () => ({ doc: vi.fn(() => ({})), setDoc: vi.fn(async () => undefined), deleteDoc: vi.fn(async () => undefined), updateDoc: vi.fn(async () => undefined) }));
vi.mock('../src/core/firebase/app', () => ({ fb: () => ({ db: {} }) }));
vi.mock('../src/core/runtime/mode', async (orig) => ({ ...(await orig<typeof import('../src/core/runtime/mode')>()), isDemo: () => false, isReal: () => true }));
vi.mock('../src/core/ai/voiceOut', () => ({ announce: vi.fn(), speak: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock('../src/core/feedback/earcons', () => ({ earcon: vi.fn() }));
vi.mock('../src/core/feedback/haptics', () => ({ haptics: { play: vi.fn() } }));
vi.mock('../src/core/ai/assistant', () => ({ startListening: vi.fn(), runDirect: vi.fn() }));
vi.mock('../src/core/safety/sos', () => ({ startSos: vi.fn(), cancelSos: vi.fn(), deliverQueuedSos: vi.fn() }));
vi.mock('../src/core/phone', () => ({ endCall: vi.fn() }));
vi.mock('../src/core/vision/sensorConditioning', () => ({ sensorConditioning: { ingest: vi.fn() } }));

// ── The fake stick: firmware 1.2 Api.cpp, over real HTTP ───────────────────────────────────────
const DEVICE_ID = 'AISS-4F2A1B';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(6000, 0x22), Buffer.from([0xff, 0xd9])]);
const stick = {
  bootAt: Date.now(),
  telemetrySeq: 0,
  frameSeq: 0,
  /** Answer delay (ms) for every request: a slow stick / weak Wi-Fi. */
  delayMs: 0,
  /** Access point up (false = switched off / rebooting). */
  apUp: true,
  requests: [] as string[],
  s: {
    batOk: true, busV: 3.912, shuntMv: 14.5, currentMa: 145.2, powerMw: 567, charging: -1,
    imuOk: true, ax: 0.012, ay: -0.02, az: 0.998, gx: 0.4, gy: -0.1, gz: 0.0, pitch: 3.4, roll: -1.2,
    usStatus: 'ok', usCm: 87.3, echoUs: 5063, usSampleAgo: 30, zone: 'warning',
    i2cOk: true, camOk: true, camBusy: false, motorRunning: false,
  },
};
const millis = () => Date.now() - stick.bootAt;
/** Api.cpp num(): NaN/Inf → null, else serialized(String(v, dp)). */
const num = (v: number, dp: number) => (Number.isFinite(v) ? Number(v.toFixed(dp)) : null);
const fillHealth = () => ({
  camera: !stick.s.camOk ? 'error' : stick.s.camBusy ? 'busy' : 'ok',
  i2c: stick.s.i2cOk ? 'ok' : 'error',
  motor: stick.s.motorRunning ? 'running' : 'idle',
  heapFree: 182000, heapMin: 150000, psramFree: 4000000, resetReason: 'poweron', bootCount: 3,
  mode: 'normal', configVersion: 0, firmware: '1.2.0', wifi: 'setup_ap', errors: [] as string[],
});

let server: http.Server;
let port = 0;
function startStick() {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const go = () => {
        // send(): JSON, no-store, CORS *
        const send = (status: number, d: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(d));
        };
        // esp_http_server matches the URI without the query string.
        const path = (req.url ?? '/').split('?')[0];
        stick.requests.push(`${req.method} ${path}`);
        const routes: Record<string, string> = {
          '/api/v1/device': 'GET', '/api/v1/status': 'GET', '/api/v1/telemetry': 'GET', '/api/v1/config': 'GET', '/api/v1/capture': 'GET',
          '/api/v1/command': 'POST', '/api/v1/provision': 'POST', '/api/v1/ota/status': 'GET', '/api/v1/ota': 'POST', '/': 'GET',
        };
        if (!routes[path]) {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          return res.end('Nothing matches the given URI');
        }
        if (routes[path] !== req.method) {
          res.writeHead(405, { 'Content-Type': 'text/html' });
          return res.end('Request method for this URI is not handled by server');
        }
        const s = stick.s;
        switch (path) {
          case '/api/v1/device':
            return send(200, { deviceId: DEVICE_ID, model: 'AISS-ESP32CAM-1', firmware: '1.2.0', protocolVersion: 1, paired: false, auth: false, uptimeMs: millis() });
          case '/api/v1/telemetry': {
            const now = millis();
            return send(200, {
              v: 1, deviceId: DEVICE_ID, seq: ++stick.telemetrySeq, uptimeMs: now,
              battery: { busV: num(s.busV, 3), shuntMv: num(s.shuntMv, 2), currentMa: num(s.currentMa, 1), powerMw: num(s.powerMw, 0), charging: s.charging < 0 ? null : s.charging === 1, chargeSource: 'current', ok: s.batOk },
              imu: { ax: num(s.ax, 3), ay: num(s.ay, 3), az: num(s.az, 3), gx: num(s.gx, 1), gy: num(s.gy, 1), gz: num(s.gz, 1), pitch: num(s.pitch, 1), roll: num(s.roll, 1), ok: s.imuOk },
              ultrasonic: { distanceCm: num(s.usCm, 1), echoUs: s.echoUs, status: s.usStatus, sampleAgeMs: s.usSampleAgo, zone: s.zone },
              button: [], safety: [],
              rssi: -48,
              health: fillHealth(),
            });
          }
          case '/api/v1/status':
            return send(200, { deviceId: DEVICE_ID, protocolVersion: 1, uptimeMs: millis(), rssi: -48, health: fillHealth() });
          case '/api/v1/config':
            return send(200, { configVersion: 0, obstacle: { enabled: true, awarenessCm: 150, warningCm: 100, dangerCm: 50, hysteresisCm: 15, confirmSamples: 2 } });
          case '/api/v1/capture':
            if (!s.camOk) return send(503, { error: 'camera_error', message: 'camera not available' });
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'x-aiss-width': '640', 'x-aiss-height': '480', 'x-aiss-seq': String(++stick.frameSeq), 'x-aiss-ts': String(millis()) });
            return res.end(JPEG);
          case '/api/v1/command': {
            let env: { commandId?: string; type?: string };
            try {
              env = JSON.parse(body);
            } catch {
              return send(400, { error: 'bad_request', message: 'malformed JSON' });
            }
            if (!env.commandId || !env.type) return send(400, { error: 'bad_request', message: 'commandId and type required' });
            return send(200, env.type === 'setConfig' ? { commandId: env.commandId, status: 'completed', result: { configVersion: 1 } } : { commandId: env.commandId, status: 'completed' });
          }
          case '/':
            res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
            return res.end(`AI SmartStick ${DEVICE_ID}\nfirmware 1.2.0, protocol v1, auth off, uptime ${Math.floor(millis() / 1000)} s\n`);
          default:
            return send(409, { error: 'provision_failed', message: 'not in setup mode' });
        }
      };
      if (stick.delayMs) setTimeout(go, stick.delayMs);
      else go();
    });
  });
  return new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
}
function rebootStick() {
  stick.bootAt = Date.now();
  stick.telemetrySeq = 0;
}

// ── "Java": AissNativePlugin.java, the parts the link depends on ───────────────────────────────
type Net = { id: number; alive: boolean; kind: 'request' | 'manual' };
type Cb = { onAvailable(n: Net): void; onUnavailable(): void; onLost(n: Net): void };
let netIds = 0;
const java = {
  wifiEnabled: true,
  /** The user approves Android's "Connect to device" sheet (or Android auto-approves a known SSID). */
  approve: true,
  /** ssidVisible(): true / false / null (Android won't say). */
  scanVisible: true as boolean | null,
  /** The phone's own Wi-Fi joined to SmartStick_AI in Android settings. */
  manual: null as Net | null,
  /** Mobile data off: the process default route is the stick's Wi-Fi. */
  defaultIsStick: false,
  setupNetwork: null as Net | null,
  setupCallback: null as Cb | null,
  connecting: false,
  waiters: [] as ((r: unknown) => void)[],
  processBound: false,
  /** Every setupRequest / requestBinary rejects (a broken or outdated native plugin). */
  pluginBroken: false,
  calls: [] as string[],
};
function resetJava() {
  Object.assign(java, { wifiEnabled: true, approve: true, scanVisible: true, manual: null, defaultIsStick: false, setupNetwork: null, setupCallback: null, connecting: false, waiters: [], processBound: false, pluginBroken: false, calls: [] });
}
const alive = (n: Net | null) => !!n && n.alive;
const reachable = (n: Net | null) => alive(n) && stick.apUp;
function settleConnect(connected: boolean, reason?: string) {
  java.connecting = false;
  const w = java.waiters.splice(0);
  for (const r of w) r({ connected, ...(reason ? { reason } : {}), ...(connected ? { via: 'request' } : {}) });
}
function releaseSetup() {
  settleConnect(false, 'CANCELLED');
  java.setupCallback = null;
  if (java.setupNetwork && java.setupNetwork.kind === 'request') java.setupNetwork.alive = false; // Android tears the specifier network down
  java.setupNetwork = null;
}
/** The stick network is lost (out of range / stick off): Android calls onLost. */
function loseStickWifi() {
  const n = java.setupNetwork;
  if (n) n.alive = false;
  if (java.manual) java.manual.alive = false;
  if (n && java.setupCallback) java.setupCallback.onLost(n);
}
class NotBound extends Error {
  constructor() {
    super('not bound to the stick network (connection lost)');
  }
}
function stickRoute(): Net | null {
  const net = java.setupNetwork;
  if (net && alive(net)) return net;
  if (java.manual && alive(java.manual)) {
    java.setupNetwork = java.manual;
    return java.manual;
  }
  if (net) java.setupNetwork = null;
  if (java.setupCallback || net) throw new NotBound();
  return null;
}
async function httpToStick(net: Net | null, o: { method?: string; path: string; body?: string; timeoutMs?: number }, binary: boolean) {
  const timeout = (o.timeoutMs as number) ?? 8000;
  // Default route (nothing bound): reaches the stick only when the phone's default network IS the stick.
  const ok = net ? reachable(net) : (java.defaultIsStick || java.processBound) && stick.apUp;
  if (!ok) {
    await new Promise((r) => setTimeout(r, Math.min(timeout, 250)));
    throw new Error(net ? 'failed to connect to /192.168.4.1 (port 80)' : 'connect timed out');
  }
  const r = await fetch(`http://127.0.0.1:${port}${o.path}`, {
    method: o.method ?? 'GET',
    headers: { Connection: 'close', ...(o.body ? { 'content-type': 'application/json' } : {}) },
    body: o.body,
    signal: AbortSignal.timeout(timeout),
  });
  if (binary) {
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, body: r.status >= 400 ? '' : buf.toString('base64'), contentType: r.headers.get('content-type') };
  }
  return { status: r.status, body: await r.text() };
}
const viaOf = (net: Net | null) => (net ? (net.kind === 'manual' ? 'wifi' : 'bound') : 'default');

H.impl.AissNative = {
  requestPermissions: async () => ({ location: 'granted', nearbyWifi: 'granted', phone: 'denied', sms: 'denied' }),
  checkPermissions: async () => ({ location: 'granted', nearbyWifi: 'granted', phone: 'denied', sms: 'denied' }),
  getFontScale: async () => ({ fontScale: 1 }),
  openWifiSettings: async () => undefined,
  openAppSettings: async () => undefined,
  startDiscovery: async () => undefined,
  stopDiscovery: async () => undefined,
  secureGet: async () => ({ value: null }),
  secureSet: async () => undefined,
  secureRemove: async () => undefined,
  scanForSetupNetworks: async () => ({ networks: java.scanVisible && stick.apUp ? [{ ssid: 'SmartStick_AI', rssi: -45 }] : [] }),
  getCurrentWifiSsid: async () => ({
    wifiEnabled: java.wifiEnabled,
    ...(java.manual && alive(java.manual) ? { ssid: 'SmartStick_AI' } : {}),
    stickNetwork: alive(java.manual) || alive(java.setupNetwork),
    bound: java.setupNetwork != null,
    requested: java.setupCallback != null,
    processBound: java.processBound,
    locationEnabled: true,
  }),
  releaseSetupNetwork: async () => {
    java.calls.push('releaseSetupNetwork');
    releaseSetup();
  },
  setProcessBinding: async (o) => {
    java.calls.push(`setProcessBinding:${o.on}`);
    if (!o.on) {
      java.processBound = false;
      return { bound: false };
    }
    const n = alive(java.setupNetwork) ? java.setupNetwork : alive(java.manual) ? java.manual : null;
    java.processBound = !!n;
    return n ? { bound: true } : { bound: false, reason: 'NO_STICK_NETWORK' };
  },
  connectToSetupNetwork: (o) =>
    new Promise((resolve) => {
      java.calls.push(`connect${o.onlyIfVisible ? ':ifVisible' : ''}`);
      if (!java.wifiEnabled) return resolve({ connected: false, reason: 'WIFI_DISABLED' });
      if (alive(java.setupNetwork)) return resolve({ connected: true, via: 'bound' });
      if (java.connecting) return void java.waiters.push(resolve);
      if (alive(java.manual)) {
        java.setupNetwork = java.manual;
        return resolve({ connected: true, via: 'existing' });
      }
      if (o.onlyIfVisible && java.scanVisible !== true) return resolve({ connected: false, reason: java.scanVisible == null ? 'RANGE_UNKNOWN' : 'NOT_IN_RANGE' });
      releaseSetup();
      const cb: Cb = {
        onAvailable(n) {
          if (java.setupCallback !== cb) return;
          java.setupNetwork = n;
          settleConnect(true);
        },
        onUnavailable() {
          if (java.setupCallback !== cb) return;
          settleConnect(false, 'UNAVAILABLE');
        },
        onLost(n) {
          if (java.setupCallback !== cb) return;
          if (java.setupNetwork === n) java.setupNetwork = null;
        },
      };
      java.setupCallback = cb;
      java.connecting = true;
      java.waiters.push(resolve);
      // cm.requestNetwork(req, cb, timeout): Android scans, (auto-)approves, joins.
      const timeout = Math.min((o.timeoutMs as number) ?? 30000, 600);
      if (stick.apUp && java.approve) setTimeout(() => cb.onAvailable({ id: ++netIds, alive: true, kind: 'request' }), 80);
      else setTimeout(() => cb.onUnavailable(), timeout);
    }),
  setupRequest: async (o) => {
    if (java.pluginBroken) throw new Error('Setup request failed: plugin error');
    let net: Net | null = null;
    if (o.route !== 'default') {
      try {
        net = stickRoute();
      } catch (e) {
        throw new Error(`Setup request failed: ${(e as Error).message}`);
      }
    }
    try {
      const r = await httpToStick(net, o as { path: string }, false);
      return { ...r, via: viaOf(net) };
    } catch (e) {
      throw new Error(`Setup request failed: ${(e as Error).message}`);
    }
  },
  requestBinary: async (o) => {
    if (java.pluginBroken) throw new Error('requestBinary failed: plugin error');
    let net: Net | null = null;
    if (o.route !== 'default') {
      try {
        net = stickRoute();
      } catch (e) {
        throw new Error(`requestBinary failed: ${(e as Error).message}`);
      }
    }
    try {
      const r = await httpToStick(net, o as { path: string }, true);
      return { ...r, via: viaOf(net) };
    } catch (e) {
      throw new Error(`requestBinary failed: ${(e as Error).message}`);
    }
  },
};
H.impl.Preferences = {
  get: async (o) => ({ value: H.mem.get(`prefs:${o.key}`) ?? null }),
  set: async (o) => void H.mem.set(`prefs:${o.key}`, String(o.value)),
  remove: async (o) => void H.mem.delete(`prefs:${o.key}`),
};
// The WebView itself cannot reach 192.168.4.1 in these tests unless the default route is the stick.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('http://192.168.4.1')) {
    if (!((java.defaultIsStick || java.processBound) && stick.apUp)) throw new TypeError('Failed to fetch');
    return realFetch(url.replace('http://192.168.4.1', `http://127.0.0.1:${port}`), init);
  }
  return realFetch(input, init);
}) as typeof fetch;

// ── The app (real modules) ─────────────────────────────────────────────────────────────────────
import { searchForStick, useProvisioning } from '../src/core/provisioning/provisioning';
import { startRealDevice } from '../src/core/device/realDevice';
import { disconnectStick } from '../src/core/device/bridge';
import { initialDevice, useDevice } from '../src/core/store/device';
import { useAuth } from '../src/core/auth/authStore';
import { loadPairedDevice } from '../src/core/device/pairedDevice';
import { looksLikeStick, resetStickRoute, setWholeAppOnStick, useStickRoute } from '../src/core/transport/stickHttp';
import { getTransport } from '../src/core/device/bridge';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

async function until(what: string, ok: () => boolean, ms = 6000) {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) {
      const d = useDevice.getState();
      throw new Error(`timed out waiting for: ${what} (link=${d.link}, detail=${d.linkDetail}, lastPacketAt=${d.lastPacketAt}, provisioning=${useProvisioning.getState().step}, calls=${java.calls.join(',')})`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  if (process.env.E2E_TIMING) console.log(`[e2e] ${what}: ${Date.now() - t0} ms`);
  return Date.now() - t0;
}
/** Exactly what Home's StickCard / Battery / ObstacleView read. */
const homeHasLiveData = () => {
  const d = useDevice.getState();
  return (d.link === 'connected' || d.link === 'degraded') && d.battery.status === 'ok' && d.battery.voltage != null && d.ultrasonic.status === 'ok' && d.ultrasonic.distanceCm != null && d.imu.status === 'ok' && d.imu.pitch != null;
};

beforeAll(async () => {
  await startStick();
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  disconnectStick();
  server.close();
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  disconnectStick();
  resetJava();
  Object.assign(stick, { delayMs: 0, apUp: true, requests: [] });
  rebootStick();
  H.mem.clear();
  resetStickRoute();
  useStickRoute.setState({ wholeApp: false });
  useDevice.setState(initialDevice());
  useProvisioning.setState({ step: 'idle', error: null, errorKind: null, diagnostics: [] });
  useAuth.setState({ status: 'signedIn', user: { uid: 'uid-1', displayName: 'Test', email: null, photoURL: null } });
});
afterEach(() => disconnectStick());

describe('Stick ⇄ app data link (real Capacitor proxy, fake Android, fake firmware 1.2)', { timeout: 20000 }, () => {
  it('USER SYMPTOM: setup completes, then Home goes Connected with real battery / distance / tilt', async () => {
    void searchForStick();
    await until('setup completed', () => useProvisioning.getState().step === 'completed');
    expect(useProvisioning.getState().diagnostics.join('\n')).toMatch(/first telemetry packet #1 received[\s\S]*stick saved on this phone/);
    // StickSetup: phase connected → finished = true → onDone after 1.1 s (no cancelProvisioning on unmount).
    await until('Home shows live stick data', homeHasLiveData, 5000);
    const d = useDevice.getState();
    expect(d.battery.voltage).toBeCloseTo(3.912, 3);
    expect(d.ultrasonic.distanceCm).toBeCloseTo(87.3, 0);
    expect(d.imu.pitch).not.toBeNull();
    expect(d.zone).toBe('warning');
    expect(d.identity?.deviceId).toBe(DEVICE_ID);
    // Still bound, nothing released after success.
    expect(java.calls).not.toContain('releaseSetupNetwork');
    expect(java.setupNetwork?.alive).toBe(true);
  });

  it('cold app start with a saved stick record (no binding yet) → Connected with data', async () => {
    void searchForStick();
    await until('setup completed', () => useProvisioning.getState().step === 'completed');
    await until('live', homeHasLiveData);
    // App killed and opened again: the process lost its binding, the record is on disk.
    disconnectStick();
    resetJava();
    useDevice.setState(initialDevice());
    expect((await loadPairedDevice())?.deviceId).toBe(DEVICE_ID);
    await startRealDevice();
    await until('live after cold start', homeHasLiveData, 5000);
  });

  it('cold start while Android’s scan is stale (NOT_IN_RANGE) still asks Android once and connects', async () => {
    void searchForStick();
    await until('setup completed', () => useProvisioning.getState().step === 'completed');
    disconnectStick();
    resetJava();
    java.scanVisible = false;
    useDevice.setState(initialDevice());
    await startRealDevice();
    await until('live after stale-scan cold start', homeHasLiveData, 5000);
  });

  it('phone joined SmartStick_AI by hand (no binding request at all) → Connected', async () => {
    java.manual = { id: ++netIds, alive: true, kind: 'manual' };
    void searchForStick();
    await until('setup completed', () => useProvisioning.getState().step === 'completed');
    await until('live over the hand-joined Wi-Fi', homeHasLiveData, 5000);
    expect(java.calls.filter((c) => c === 'connect').length).toBe(0); // no system sheet
  });

  it('mobile data off, the stick is the default route and Android lists no 192.168.4.x network → Connected', async () => {
    java.defaultIsStick = true;
    java.approve = false; // no specifier network either
    java.scanVisible = null;
    void searchForStick();
    await until('setup completed', () => useProvisioning.getState().step === 'completed', 8000);
    await until('live over the default route', homeHasLiveData, 5000);
  });

  it('Wi-Fi lost mid-session → Reconnecting (with a reason) → re-bound → data flows again', async () => {
    void searchForStick();
    await until('setup completed', () => useProvisioning.getState().step === 'completed');
    await until('live', homeHasLiveData);
    loseStickWifi();
    await until('reconnecting', () => useDevice.getState().link === 'reconnecting', 4000);
    expect(useDevice.getState().linkDetail).toBeTruthy();
    const before = useDevice.getState().lastPacketAt!;
    await until('fresh packets after re-bind', () => homeHasLiveData() && useDevice.getState().lastPacketAt! > before, 8000);
  });

  it('stick reboots mid-session (AP down 2 s, seq and uptime restart) → recovers with fresh data', async () => {
    void searchForStick();
    await until('setup completed', () => useProvisioning.getState().step === 'completed');
    await until('live', homeHasLiveData);
    stick.apUp = false;
    loseStickWifi();
    await new Promise((r) => setTimeout(r, 2000));
    rebootStick();
    stick.apUp = true;
    const at = Date.now();
    await until('fresh packets after reboot', () => homeHasLiveData() && (useDevice.getState().lastPacketAt ?? 0) > at, 10000);
    expect(stick.telemetrySeq).toBeGreaterThan(0);
  }, 20000);

  it('slow stick (1.5 s per answer) → still Connected (maybe "weak") with data', async () => {
    stick.delayMs = 1500;
    void searchForStick();
    await until('setup completed', () => useProvisioning.getState().step === 'completed', 12000);
    await until('live on a slow link', homeHasLiveData, 8000);
  }, 25000);

  it('FALLBACK: binding lost but the stick is the default route → data keeps flowing over it', async () => {
    void searchForStick();
    await until('setup completed', () => useProvisioning.getState().step === 'completed');
    await until('live', homeHasLiveData);
    java.defaultIsStick = true; // e.g. mobile data off, the phone's Wi-Fi stays on SmartStick_AI
    java.approve = false; // and Android will not hand out a new binding
    loseStickWifi();
    const at = Date.now();
    await until('fresh packets over the default route', () => homeHasLiveData() && (useDevice.getState().lastPacketAt ?? 0) > at, 8000);
    expect(useStickRoute.getState().preferred).toBe('native-default');
  });

  it('FALLBACK: the native HTTP call is broken → the WebView fetch path carries the link', async () => {
    java.manual = { id: ++netIds, alive: true, kind: 'manual' };
    java.defaultIsStick = true;
    void searchForStick();
    await until('setup completed', () => useProvisioning.getState().step === 'completed');
    await until('live', homeHasLiveData);
    java.pluginBroken = true;
    const at = Date.now();
    await until('fresh packets over the WebView', () => homeHasLiveData() && (useDevice.getState().lastPacketAt ?? 0) > at, 8000);
    expect(useStickRoute.getState().preferred).toBe('webview');
    // The camera uses the same chain.
    const frame = await getTransport()!.captureFrame();
    expect(frame.blob.size).toBe(JPEG.length);
  });

  it('"Use stick Wi-Fi for the whole app" binds the process to the stick network and releases it', async () => {
    void searchForStick();
    await until('setup completed', () => useProvisioning.getState().step === 'completed');
    expect(await setWholeAppOnStick(true)).toEqual({ bound: true });
    expect(java.processBound).toBe(true);
    expect(useStickRoute.getState().wholeApp).toBe(true);
    expect(await setWholeAppOnStick(false)).toEqual({ bound: false });
    expect(java.processBound).toBe(false);
    expect(useStickRoute.getState().wholeApp).toBe(false);
  });

  it('a router / proxy at 192.168.4.1 answering 403 with a web page is never taken for the stick', () => {
    expect(looksLikeStick(403, '<html><body>Forbidden</body></html>')).toBe(false);
    expect(looksLikeStick(401, '{"error":"unauthorized"}')).toBe(true);
    expect(looksLikeStick(200, '{"v":1}')).toBe(true);
    expect(looksLikeStick(200, '<html>router login</html>')).toBe(false);
    expect(looksLikeStick(200, 'AI SmartStick AISS-1\nfirmware 1.2.0')).toBe(true);
    expect(looksLikeStick(404, 'Nothing matches the given URI')).toBe(false);
  });

  it('SOURCE GUARD: no Promise anywhere resolves with a Capacitor plugin object', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f)) files.push(p);
      }
    };
    walk(join(__dirname, '../src'));
    const bad = files.filter((f) => /\.then\(\(?\w+\)?\s*=>\s*\w+\.(AissNative|AissLocation|Preferences|Geolocation|Network|App|Device|FirebaseMessaging|FirebaseAuthentication|LocalNotifications|TextToSpeech|SpeechRecognition|StatusBar)\s*\)/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });

  it('never stuck on "Connecting": a stick that stops answering shows a state change and a reason', async () => {
    void searchForStick();
    await until('setup completed', () => useProvisioning.getState().step === 'completed');
    await until('live', homeHasLiveData);
    stick.apUp = false; // AP gone without Android noticing (no onLost)
    await until('not connected any more', () => !['connected', 'degraded'].includes(useDevice.getState().link), 10000);
    expect(useDevice.getState().linkDetail).toBeTruthy();
  }, 15000);
});
