/**
 * The Android path of HttpTransport: every request goes through the AissNative plugin
 * (connectToSetupNetwork / setupRequest / requestBinary). The plugin is replaced by a shim with the
 * same contract as AissNativePlugin.java (headers map, base64 JPEG body, "not bound" fast-fail,
 * onlyIfVisible reconnects) talking to a local server that behaves like firmware 1.2 (no auth).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const DEVICE_ID = 'AISS-NATIVE1';
let port = 0;
let server: http.Server;
const seen = { signed: 0, requests: 0 };
const nat = {
  bound: true,
  /** Next connect results to hand out (then: connected). */
  connectQueue: [] as { connected: boolean; reason?: string }[],
  connectCalls: [] as { onlyIfVisible?: boolean; openWifiPanelIfOff?: boolean }[],
  /** Next setupRequest calls that fail with "not bound". */
  notBound: 0,
};

// A 2.5 KB "JPEG": SOI … EOI, like an OV2640 frame.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2500, 0x11), Buffer.from([0xff, 0xd9])]);

vi.mock('../src/core/native/aissNative', () => {
  const base = () => `http://127.0.0.1:${port}`;
  return {
    AissNative: {
      connectToSetupNetwork: async (o: { onlyIfVisible?: boolean; openWifiPanelIfOff?: boolean }) => {
        nat.connectCalls.push({ onlyIfVisible: o.onlyIfVisible, openWifiPanelIfOff: o.openWifiPanelIfOff });
        const r = nat.connectQueue.shift() ?? { connected: true };
        if (r.connected) nat.bound = true;
        return r;
      },
      setupRequest: async (o: { method: string; path: string; body?: string; headers?: Record<string, string> }) => {
        if (nat.notBound > 0) {
          nat.notBound--;
          nat.bound = false;
          throw new Error('Setup request failed: not bound to the stick network (connection lost)');
        }
        if (!nat.bound) throw new Error('Setup request failed: not bound to the stick network (connection lost)');
        const r = await fetch(base() + o.path, { method: o.method, headers: { ...(o.headers ?? {}), ...(o.body ? { 'content-type': 'application/json' } : {}) }, body: o.body });
        return { status: r.status, body: await r.text() };
      },
      requestBinary: async (o: { path: string; headers?: Record<string, string> }) => {
        const r = await fetch(base() + o.path, { headers: o.headers });
        const buf = Buffer.from(await r.arrayBuffer());
        return { status: r.status, body: r.status < 400 ? buf.toString('base64') : '' };
      },
    },
  };
});

beforeAll(async () => {
  (globalThis as { window?: unknown }).window = { Capacitor: { isNativePlatform: () => true } };
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.requests++;
      if (req.headers['x-aiss-sig'] || req.headers['x-aiss-nonce']) seen.signed++;
      const json = (status: number, o: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/api/v1/device') return json(200, { deviceId: DEVICE_ID, model: 'AISS-ESP32CAM-1', firmware: '1.2.0', protocolVersion: 1, paired: false, auth: false, uptimeMs: 1 });
      if (url.pathname === '/api/v1/capture') {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        return res.end(JPEG);
      }
      if (url.pathname === '/api/v1/telemetry') {
        return json(200, {
          v: 1, deviceId: DEVICE_ID, seq: seen.requests, uptimeMs: 1000 + seen.requests,
          battery: { busV: 3.9, shuntMv: 10, currentMa: 120, charging: false, chargeSource: 'current', ok: true },
          imu: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, pitch: 1, roll: 0, ok: true },
          ultrasonic: { distanceCm: 120, echoUs: 7000, status: 'ok', sampleAgeMs: 5, zone: 'normal' },
          button: [], safety: [], rssi: -40,
          health: { camera: 'ok', i2c: 'ok', motor: 'idle', errors: [] },
        });
      }
      json(404, { error: 'not_found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.close();
  delete (globalThis as { window?: unknown }).window;
});
beforeEach(() => {
  Object.assign(nat, { bound: true, connectQueue: [], connectCalls: [], notBound: 0 });
  seen.signed = 0;
});

async function waitFor<T>(fn: () => T | undefined, ms = 4000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const dev = { deviceId: DEVICE_ID, model: 'm', firmware: 'f', protocolVersion: 1, host: '192.168.4.1', ownerUid: 'u', pairedAt: 0 };

describe('HttpTransport over the native bridge (Android path, v1 simple link)', () => {
  it('reaches the stick Wi-Fi silently, streams unsigned telemetry and real JPEG frames', async () => {
    const { HttpTransport } = await import('../src/core/transport/httpTransport');
    const t = new HttpTransport(dev, 40);
    const links: string[] = [];
    let packets = 0;
    t.on('link', (s) => links.push(s));
    t.on('packet', () => packets++);
    await t.connect();
    await waitFor(() => (packets >= 3 ? true : undefined));
    expect(nat.connectCalls[0]).toEqual({ onlyIfVisible: true, openWifiPanelIfOff: false });
    expect(links).toContain('connected');
    expect(seen.signed).toBe(0);

    const frame = await t.captureFrame();
    const bytes = new Uint8Array(await frame.blob.arrayBuffer());
    expect(frame.blob.type).toBe('image/jpeg');
    expect(bytes.length).toBe(JPEG.length);
    expect([bytes[0], bytes[1], bytes[bytes.length - 2], bytes[bytes.length - 1]]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    t.disconnect();
  });

  it('when Android will not say whether the stick is near, asks once directly (foreground)', async () => {
    const { HttpTransport } = await import('../src/core/transport/httpTransport');
    nat.connectQueue = [{ connected: false, reason: 'RANGE_UNKNOWN' }];
    const t = new HttpTransport(dev, 40);
    const links: string[] = [];
    t.on('link', (s) => links.push(s));
    await t.connect();
    await waitFor(() => (links.includes('connected') ? true : undefined));
    expect(nat.connectCalls.length).toBe(2);
    expect(nat.connectCalls[1].onlyIfVisible).toBeUndefined();
    t.disconnect();
  });

  it('stick out of range → reconnecting (no system sheet), then connects when it is back', async () => {
    const { HttpTransport } = await import('../src/core/transport/httpTransport');
    nat.connectQueue = [{ connected: false, reason: 'NOT_IN_RANGE' }];
    const t = new HttpTransport(dev, 40);
    const links: [string, string | undefined][] = [];
    t.on('link', (s, d) => links.push([s, d]));
    await t.connect();
    expect(links.find(([s]) => s === 'reconnecting')?.[1]).toMatch(/SmartStick_AI/);
    expect(nat.connectCalls.every((c) => c.onlyIfVisible === true)).toBe(true);
    await waitFor(() => (links.some(([s]) => s === 'connected') ? true : undefined), 5000);
    t.disconnect();
  });

  it('"not bound" (Wi-Fi lost) triggers an immediate re-bind instead of waiting for missed packets', async () => {
    const { HttpTransport } = await import('../src/core/transport/httpTransport');
    const t = new HttpTransport(dev, 40);
    const links: string[] = [];
    t.on('link', (s) => links.push(s));
    await t.connect();
    await waitFor(() => (links.includes('connected') ? true : undefined));
    const before = nat.connectCalls.length;
    nat.notBound = 1;
    await waitFor(() => (links.includes('reconnecting') ? true : undefined));
    await waitFor(() => (links.lastIndexOf('connected') > links.indexOf('reconnecting') ? true : undefined), 5000);
    expect(nat.connectCalls.length).toBeGreaterThan(before);
    t.disconnect();
  });
});
