/**
 * Protocol conformance: HttpTransport (the app's real device transport) against a local HTTP server
 * that implements DEVICE_PROTOCOL.md exactly as the ECU firmware does (HMAC request auth, nonce
 * replay protection, challenge proof, telemetry, command envelope + idempotent ack).
 * This is the "device ↔ Android" integration test that can run without hardware.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { HttpTransport } from '../src/core/transport/httpTransport';
import type { LinkState } from '../src/core/types';

const KEY = Buffer.alloc(32, 7);
const KEY_B64 = KEY.toString('base64');
const DEVICE_ID = 'AISS-E2E001';
const hmac = (m: string) => createHmac('sha256', KEY).update(m).digest('hex');

let server: http.Server;
let port = 0;
let protocolVersion = 1;
let requireAuth = true;
const nonces = new Set<string>();
const executed = new Map<string, number>();
let seq = 0;

function authorized(req: http.IncomingMessage, body: string) {
  const h = req.headers;
  const ts = String(h['x-aiss-ts'] ?? ''), nonce = String(h['x-aiss-nonce'] ?? ''), sig = String(h['x-aiss-sig'] ?? '');
  if (h['x-aiss-device'] !== DEVICE_ID || !nonce || nonces.has(nonce)) return false;
  const canon = `${req.method}\n${req.url}\n${ts}\n${nonce}\n${createHash('sha256').update(body).digest('hex')}`;
  if (hmac(canon) !== sig) return false;
  nonces.add(nonce);
  return true;
}

beforeAll(async () => {
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
        return json(200, { deviceId: DEVICE_ID, model: 'AISS-ESP32CAM-1', firmware: '1.1.0-ecu', protocolVersion, paired: true, uptimeMs: 1, proof: ch ? hmac(ch + DEVICE_ID) : undefined });
      }
      if (requireAuth && !authorized(req, body)) return json(401, { error: 'unauthorized' });
      if (url.pathname === '/api/v1/telemetry') {
        return json(200, {
          v: 1, deviceId: DEVICE_ID, seq: ++seq, uptimeMs: 1000 + seq,
          battery: { busV: 3.95, shuntMv: 15, currentMa: 150, charging: null, chargeSource: 'current', ok: true },
          imu: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, pitch: 2, roll: 0, ok: true },
          ultrasonic: { distanceCm: 80, echoUs: 4640, status: 'ok', sampleAgeMs: 10, zone: 'warning' },
          button: [], safety: [], rssi: -50,
          health: { camera: 'ok', i2c: 'ok', motor: 'idle', firmware: '1.1.0-ecu', configVersion: 0, errors: [] },
        });
      }
      if (url.pathname === '/api/v1/command') {
        const env = JSON.parse(body);
        const n = executed.get(env.commandId) ?? 0;
        executed.set(env.commandId, n + 1);
        if (n > 0) return json(200, { commandId: env.commandId, status: 'duplicate' });
        if (env.expiresAt < Number(req.headers['x-aiss-ts'])) return json(200, { commandId: env.commandId, status: 'expired' });
        if (env.type === 'haptic' && !['tap', 'confirm', 'warning', 'danger', 'sos', 'locate', 'nudge'].includes(env.payload.pattern)) return json(200, { commandId: env.commandId, status: 'rejected', error: 'unknown pattern' });
        return json(200, { commandId: env.commandId, status: 'completed' });
      }
      json(404, { error: 'not_found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());

const dev = (keyB64 = KEY_B64) => ({ deviceId: DEVICE_ID, model: 'm', firmware: 'f', protocolVersion: 1, keyB64, host: `127.0.0.1:${port}`, ownerUid: 'u', pairedAt: 0 });

async function waitFor<T>(fn: () => T | undefined, ms = 4000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('HttpTransport ↔ ECU protocol', () => {
  it('authenticates with the key proof, then streams validated telemetry', async () => {
    protocolVersion = 1;
    const t = new HttpTransport(dev(), 50);
    const links: LinkState[] = [];
    let packets = 0;
    let firmware = '';
    t.on('link', (s) => links.push(s));
    t.on('identity', (i) => (firmware = i.firmware));
    t.on('packet', () => packets++);
    await t.connect();
    await waitFor(() => (packets >= 3 ? true : undefined));
    expect(links).toContain('connected');
    expect(firmware).toBe('1.1.0-ecu');
    t.disconnect();
  });

  it('commands are acknowledged; a retried commandId is never executed twice; unknown patterns are rejected', async () => {
    const t = new HttpTransport(dev(), 50);
    await t.connect();
    await waitFor(() => (executed.size >= 0 ? true : undefined));
    const a = await t.send({ type: 'locate' }, { commandId: 'cmd-1' });
    expect(a).toMatchObject({ commandId: 'cmd-1', status: 'completed' });
    const b = await t.send({ type: 'locate' }, { commandId: 'cmd-1' });
    expect(b.status).toBe('duplicate');
    const c = await t.send({ type: 'haptic', pattern: 'zap' as never });
    expect(c.status).toBe('rejected');
    t.disconnect();
  });

  it('a wrong key ends in auth_failed (never "connected")', async () => {
    const t = new HttpTransport(dev(Buffer.alloc(32, 9).toString('base64')), 50);
    const links: LinkState[] = [];
    t.on('link', (s) => links.push(s));
    await t.connect();
    await waitFor(() => (links.includes('auth_failed') ? true : undefined));
    expect(links).not.toContain('connected');
    t.disconnect();
  });

  it('a firmware speaking another protocol version ends in protocol_mismatch', async () => {
    protocolVersion = 2;
    const t = new HttpTransport(dev(), 50);
    const links: LinkState[] = [];
    t.on('link', (s) => links.push(s));
    await t.connect();
    await waitFor(() => (links.includes('protocol_mismatch') ? true : undefined));
    expect(links).not.toContain('connected');
    protocolVersion = 1;
    t.disconnect();
  });

  it('replayed signed requests are refused by the device (nonce ring)', async () => {
    // Build one valid signed telemetry request, send it twice.
    const ts = String(Date.now());
    const nonce = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const canon = `GET\n/api/v1/telemetry\n${ts}\n${nonce}\n${createHash('sha256').update('').digest('hex')}`;
    const headers = { 'x-aiss-device': DEVICE_ID, 'x-aiss-ts': ts, 'x-aiss-nonce': nonce, 'x-aiss-sig': hmac(canon) };
    const r1 = await fetch(`http://127.0.0.1:${port}/api/v1/telemetry`, { headers });
    const r2 = await fetch(`http://127.0.0.1:${port}/api/v1/telemetry`, { headers });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(401);
  });
});
