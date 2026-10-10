/**
 * Protocol conformance: HttpTransport (the app's real device transport) against a local HTTP server
 * that implements DEVICE_PROTOCOL.md v1 exactly as firmware 1.2 does (REQUIRE_AUTH 0: plain unsigned
 * requests, telemetry, command envelope + idempotent ack). Firmware 1.1 (signed requests) is
 * simulated by answering 401. This is the "device ↔ app" integration test that runs without hardware.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpTransport, OLD_FIRMWARE_MESSAGE } from '../src/core/transport/httpTransport';
import type { LinkState } from '../src/core/types';

const DEVICE_ID = 'AISS-E2E001';

let server: http.Server;
let port = 0;
const stick = { protocolVersion: 1, oldFirmware: false, failing: false, signedRequests: 0 };
const executed = new Map<string, number>();
let seq = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (status: number, o: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (Object.keys(req.headers).some((h) => h.startsWith('x-aiss-sig') || h.startsWith('x-aiss-nonce'))) stick.signedRequests++;
      const url = new URL(req.url!, 'http://x');
      if (stick.failing) return json(500, { error: 'busy' });
      if (url.pathname === '/api/v1/device') {
        return json(200, { deviceId: DEVICE_ID, model: 'AISS-ESP32CAM-1', firmware: stick.oldFirmware ? '1.1.0-ecu' : '1.2.0', protocolVersion: stick.protocolVersion, paired: false, ...(stick.oldFirmware ? {} : { auth: false }), uptimeMs: 1 });
      }
      // Firmware 1.1: everything but /device needs a signature the v1 app no longer sends.
      if (stick.oldFirmware) return json(401, { error: 'unauthorized' });
      if (url.pathname === '/api/v1/telemetry') {
        return json(200, {
          v: 1, deviceId: DEVICE_ID, seq: ++seq, uptimeMs: 1000 + seq,
          battery: { busV: 3.95, shuntMv: 15, currentMa: 150, charging: null, chargeSource: 'current', ok: true },
          imu: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, pitch: 2, roll: 0, ok: true },
          ultrasonic: { distanceCm: 80, echoUs: 4640, status: 'ok', sampleAgeMs: 10, zone: 'warning' },
          button: [], safety: [], rssi: -50,
          health: { camera: 'ok', i2c: 'ok', motor: 'idle', firmware: '1.2.0', configVersion: 0, errors: [] },
        });
      }
      if (url.pathname === '/api/v1/command') {
        const env = JSON.parse(body);
        const n = executed.get(env.commandId) ?? 0;
        executed.set(env.commandId, n + 1);
        if (n > 0) return json(200, { commandId: env.commandId, status: 'duplicate' });
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
beforeEach(() => Object.assign(stick, { protocolVersion: 1, oldFirmware: false, failing: false, signedRequests: 0 }));

const dev = () => ({ deviceId: DEVICE_ID, model: 'm', firmware: 'f', protocolVersion: 1, host: `127.0.0.1:${port}`, ownerUid: 'u', pairedAt: 0 });

async function waitFor<T>(fn: () => T | undefined, ms = 4000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('HttpTransport ↔ firmware 1.2 (unsigned v1 link)', () => {
  it('streams telemetry without any signature; "connected" only once the first packet arrived', async () => {
    const t = new HttpTransport(dev(), 50);
    const events: string[] = [];
    let firmware = '';
    t.on('link', (s) => events.push(`link:${s}`));
    t.on('identity', (i) => (firmware = i.firmware));
    t.on('packet', () => events.push('packet'));
    await t.connect();
    await waitFor(() => (events.filter((e) => e === 'packet').length >= 3 ? true : undefined));
    expect(events[0]).toBe('link:connecting');
    expect(events.indexOf('link:connected')).toBeGreaterThan(0);
    expect(events.indexOf('link:connected')).toBeLessThan(events.indexOf('packet'));
    expect(firmware).toBe('1.2.0');
    expect(stick.signedRequests).toBe(0);
    t.disconnect();
  });

  it('commands are acknowledged; a retried commandId is never executed twice; unknown patterns are rejected', async () => {
    const t = new HttpTransport(dev(), 50);
    const links: LinkState[] = [];
    t.on('link', (s) => links.push(s));
    await t.connect();
    await waitFor(() => (links.includes('connected') ? true : undefined));
    const a = await t.send({ type: 'locate' }, { commandId: 'cmd-1' });
    expect(a).toMatchObject({ commandId: 'cmd-1', status: 'completed' });
    const b = await t.send({ type: 'locate' }, { commandId: 'cmd-1' });
    expect(b.status).toBe('duplicate');
    const c = await t.send({ type: 'haptic', pattern: 'zap' as never });
    expect(c.status).toBe('rejected');
    expect(stick.signedRequests).toBe(0);
    t.disconnect();
  });

  it('old secure firmware (401) ends in auth_failed with the "flash firmware 1.2" message, never "connected"', async () => {
    stick.oldFirmware = true;
    const t = new HttpTransport(dev(), 50);
    const links: [LinkState, string | undefined][] = [];
    t.on('link', (s, d) => links.push([s, d]));
    await t.connect();
    await waitFor(() => (links.some(([s]) => s === 'auth_failed') ? true : undefined));
    expect(links.find(([s]) => s === 'auth_failed')?.[1]).toBe(OLD_FIRMWARE_MESSAGE);
    expect(OLD_FIRMWARE_MESSAGE).toMatch(/1\.2/);
    expect(links.map(([s]) => s)).not.toContain('connected');
    t.disconnect();
  });

  it('a firmware speaking another protocol version ends in protocol_mismatch', async () => {
    stick.protocolVersion = 2;
    const t = new HttpTransport(dev(), 50);
    const links: LinkState[] = [];
    t.on('link', (s) => links.push(s));
    await t.connect();
    await waitFor(() => (links.includes('protocol_mismatch') ? true : undefined));
    expect(links).not.toContain('connected');
    t.disconnect();
  });

  it('a stale record from the old HMAC pairing (with keyB64) still connects; the key is ignored', async () => {
    const t = new HttpTransport({ ...dev(), keyB64: Buffer.alloc(32, 7).toString('base64') } as ReturnType<typeof dev>, 50);
    const links: LinkState[] = [];
    t.on('link', (s) => links.push(s));
    await t.connect();
    await waitFor(() => (links.includes('connected') ? true : undefined));
    expect(stick.signedRequests).toBe(0);
    t.disconnect();
  });

  it('missed telemetry → degraded, then back to connected when the stick answers again', async () => {
    const t = new HttpTransport(dev(), 50);
    const links: LinkState[] = [];
    t.on('link', (s) => links.push(s));
    await t.connect();
    await waitFor(() => (links.includes('connected') ? true : undefined));
    stick.failing = true;
    await waitFor(() => (links.includes('degraded') ? true : undefined), 5000);
    stick.failing = false;
    await waitFor(() => (links.lastIndexOf('connected') > links.indexOf('degraded') ? true : undefined), 5000);
    t.disconnect();
  });

  it('commands and frames are refused while not connected (no fake success)', async () => {
    stick.oldFirmware = true;
    const t = new HttpTransport(dev(), 50);
    await expect(t.send({ type: 'locate' })).rejects.toThrow('stick-offline');
    await expect(t.captureFrame()).rejects.toThrow('stick-offline');
  });
});
