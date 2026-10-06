/**
 * The Android path of HttpTransport: every request goes through the AissNative plugin
 * (setupRequest / requestBinary), which must carry the HMAC headers to the stick. The plugin is
 * replaced by a shim with the same contract as AissNativePlugin.java (headers map, base64 JPEG
 * body) talking to a local server that authorizes exactly like firmware Identity.cpp.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';

const KEY = Buffer.alloc(32, 9);
const DEVICE_ID = 'AISS-NATIVE1';
const hmac = (m: string) => createHmac('sha256', KEY).update(m).digest('hex');
const nonces = new Set<string>();
let port = 0;
let server: http.Server;
const seen = { unsigned: 0, signed: 0, connectCalls: 0 };

// A 2.5 KB "JPEG": SOI … EOI, like an OV2640 frame.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2500, 0x11), Buffer.from([0xff, 0xd9])]);

function authorized(req: http.IncomingMessage, body: string) {
  const h = req.headers;
  const ts = String(h['x-aiss-ts'] ?? ''), nonce = String(h['x-aiss-nonce'] ?? ''), sig = String(h['x-aiss-sig'] ?? '');
  if (h['x-aiss-device'] !== DEVICE_ID || nonce.length < 16 || nonces.has(nonce)) return false;
  const canon = `${req.method}\n${req.url}\n${ts}\n${nonce}\n${createHash('sha256').update(body).digest('hex')}`;
  if (hmac(canon) !== sig) return false;
  nonces.add(nonce);
  return true;
}

vi.mock('../src/core/native/aissNative', () => {
  const base = () => `http://127.0.0.1:${port}`;
  return {
    AissNative: {
      connectToSetupNetwork: async () => {
        seen.connectCalls++;
        return { connected: true };
      },
      setupRequest: async (o: { method: string; path: string; body?: string; headers?: Record<string, string> }) => {
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
      const json = (status: number, o: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/api/v1/device') {
        const ch = url.searchParams.get('challenge');
        return json(200, { deviceId: DEVICE_ID, model: 'AISS-ESP32CAM-1', firmware: '1.1.0-ecu', protocolVersion: 1, paired: true, uptimeMs: 1, proof: ch ? hmac(ch + DEVICE_ID) : undefined });
      }
      if (!authorized(req, body)) {
        seen.unsigned++;
        return json(401, { error: 'unauthorized' });
      }
      seen.signed++;
      if (url.pathname === '/api/v1/capture') {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        return res.end(JPEG);
      }
      if (url.pathname === '/api/v1/telemetry') {
        return json(200, {
          v: 1, deviceId: DEVICE_ID, seq: seen.signed, uptimeMs: 1000 + seen.signed,
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

async function waitFor<T>(fn: () => T | undefined, ms = 4000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('HttpTransport over the native bridge (Android path)', () => {
  it('binds the stick network, proves the key, streams signed telemetry and real JPEG frames', async () => {
    const { HttpTransport } = await import('../src/core/transport/httpTransport');
    const t = new HttpTransport({ deviceId: DEVICE_ID, model: 'm', firmware: 'f', protocolVersion: 1, keyB64: KEY.toString('base64'), host: '192.168.4.1', ownerUid: 'u', pairedAt: 0 }, 40);
    const links: string[] = [];
    let packets = 0;
    t.on('link', (s) => links.push(s));
    t.on('packet', () => packets++);
    await t.connect();
    await waitFor(() => (packets >= 3 ? true : undefined));
    expect(seen.connectCalls).toBeGreaterThanOrEqual(1);
    expect(links).toContain('connected');
    expect(seen.unsigned).toBe(0);

    const frame = await t.captureFrame();
    const bytes = new Uint8Array(await frame.blob.arrayBuffer());
    expect(frame.blob.type).toBe('image/jpeg');
    expect(bytes.length).toBe(JPEG.length);
    expect([bytes[0], bytes[1], bytes[bytes.length - 2], bytes[bytes.length - 1]]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    t.disconnect();
  });
});
