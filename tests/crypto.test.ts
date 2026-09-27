import { describe, expect, it } from 'vitest';
import { canonicalRequest, hmacHex, sha256Hex, safeEqual, toB64 } from '../src/core/device/crypto';
import { verifyAnnouncement } from '../src/core/device/discovery';

const key = toB64(new Uint8Array(32).map((_, i) => i));

describe('device auth primitives', () => {
  it('sha256 of empty body matches the known digest', async () => {
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('HMAC is stable and the canonical string is exact', async () => {
    const c = canonicalRequest('get', '/api/v1/telemetry', 1700000000000, 'abc', 'e3b0');
    expect(c).toBe('GET\n/api/v1/telemetry\n1700000000000\nabc\ne3b0');
    const a = await hmacHex(key, c);
    expect(a).toHaveLength(64);
    expect(await hmacHex(key, c)).toBe(a);
    expect(safeEqual(a, a)).toBe(true);
    expect(safeEqual(a, a.replace(/.$/, a.endsWith('0') ? '1' : '0'))).toBe(false);
  });
  it('accepts only announcements signed with our key', async () => {
    const sig = await hmacHex(key, 'AISS-ABCDEF' + '192.168.43.10' + '5000');
    const a = { v: 1 as const, deviceId: 'AISS-ABCDEF', ip: '192.168.43.10', port: 80, uptimeMs: 5000, sig };
    expect(await verifyAnnouncement(a, { deviceId: 'AISS-ABCDEF', keyB64: key })).toBe(true);
    expect(await verifyAnnouncement({ ...a, ip: '192.168.43.99' }, { deviceId: 'AISS-ABCDEF', keyB64: key })).toBe(false);
    expect(await verifyAnnouncement(a, { deviceId: 'AISS-000000', keyB64: key })).toBe(false);
  });
});
