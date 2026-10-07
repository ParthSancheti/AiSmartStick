/**
 * The stick record (v1 simple link): plain storage, no secret. Records saved by the old secure
 * pairing (Keystore, with keyB64) must still load — without the key — and move to plain storage,
 * so an existing user does not have to set the stick up again just because of the update.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs = new Map<string, string>();
const secure = new Map<string, string>();
const fail = { prefs: false };

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => {
      if (fail.prefs) throw new Error('Preferences plugin is not implemented');
      return { value: prefs.get(key) ?? null };
    }),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      if (fail.prefs) throw new Error('Preferences plugin is not implemented');
      prefs.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => void prefs.delete(key)),
  },
}));
vi.mock('../src/core/native/aissNative', () => ({
  AissNative: {
    secureGet: vi.fn(async ({ key }: { key: string }) => ({ value: secure.get(key) ?? null })),
    secureRemove: vi.fn(async ({ key }: { key: string }) => void secure.delete(key)),
  },
}));

import { forgetPairedDevice, loadPairedDevice, parsePairedDevice, savePairedDevice } from '../src/core/device/pairedDevice';

const rec = { deviceId: 'AISS-1', model: 'AISS-ESP32CAM-1', firmware: '1.2.0', protocolVersion: 1, host: '192.168.4.1', ownerUid: 'u1', pairedAt: 5 };

describe('paired stick record', () => {
  beforeEach(() => {
    prefs.clear();
    secure.clear();
    fail.prefs = false;
  });

  it('saves and loads without any key', async () => {
    await savePairedDevice(rec);
    expect(await loadPairedDevice()).toEqual(rec);
    expect(JSON.parse(prefs.get('pairedDevice.v1')!).keyB64).toBeUndefined();
  });

  it('migrates an old Keystore record (with keyB64) and drops the key', async () => {
    secure.set('pairedDevice.v1', JSON.stringify({ ...rec, firmware: '1.1.0-ecu', keyB64: 'c2VjcmV0' }));
    const d = await loadPairedDevice();
    expect(d).toMatchObject({ deviceId: 'AISS-1', host: '192.168.4.1', ownerUid: 'u1' });
    expect((d as unknown as { keyB64?: string }).keyB64).toBeUndefined();
    expect(JSON.parse(prefs.get('pairedDevice.v1')!).deviceId).toBe('AISS-1');
    expect(secure.has('pairedDevice.v1')).toBe(false);
  });

  it('a record with a key stored in plain storage (older builds) still loads', async () => {
    prefs.set('pairedDevice.v1', JSON.stringify({ ...rec, keyB64: 'x' }));
    expect(await loadPairedDevice()).toEqual(rec);
  });

  it('forget removes it everywhere', async () => {
    await savePairedDevice(rec);
    secure.set('pairedDevice.v1', '{}');
    await forgetPairedDevice();
    expect(await loadPairedDevice()).toBeNull();
    expect(secure.size).toBe(0);
  });

  it('rejects garbage', () => {
    expect(parsePairedDevice('nope')).toBeNull();
    expect(parsePairedDevice(JSON.stringify({ model: 'x' }))).toBeNull();
    expect(parsePairedDevice(null)).toBeNull();
  });

  it('when Preferences is unavailable and there is no localStorage, saving fails loudly (never a silent fake save)', async () => {
    fail.prefs = true;
    await expect(savePairedDevice(rec)).rejects.toThrow();
  });
});
