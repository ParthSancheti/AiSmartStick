/**
 * Stick setup against a simulated dashcam ECU (same rules as firmware Api.cpp hDevice/hProvision and
 * Identity.cpp): the regression is a stick that already reports `paired` while this phone has no
 * key (earlier install / another phone). Setup must give it a new key and complete — not dead-end
 * on "reset the stick".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const ecu = { paired: true, key: Buffer.alloc(32, 1) as Buffer, provisions: 0 };
const DEVICE_ID = 'AISS-ABC123';

vi.mock('../src/core/native/aissNative', () => ({
  AissNative: {
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
    connectToSetupNetwork: vi.fn(async () => ({ connected: true })),
    releaseSetupNetwork: vi.fn(async () => undefined),
    setupRequest: vi.fn(async (o: { method: string; path: string; body?: string }) => {
      const url = new URL(o.path, 'http://192.168.4.1');
      if (url.pathname === '/api/v1/device') {
        const ch = url.searchParams.get('challenge');
        const body: Record<string, unknown> = { deviceId: DEVICE_ID, model: 'AISS-ESP32CAM-1', firmware: '1.1.0', protocolVersion: 1, paired: ecu.paired, uptimeMs: 5 };
        if (ecu.paired && ch) body.proof = createHmac('sha256', ecu.key).update(ch + DEVICE_ID).digest('hex');
        return { status: 200, body: JSON.stringify(body) };
      }
      if (url.pathname === '/api/v1/provision' && o.method === 'POST') {
        const p = JSON.parse(o.body!);
        const key = Buffer.from(p.deviceKey, 'base64');
        // Firmware validation: v=1, ssid 1–32, password 8–63, 32-byte key. No "already paired" check.
        if (p.v !== 1 || !p.ssid || p.password.length < 8 || p.password.length > 63 || key.length !== 32) return { status: 400, body: '{"error":"bad_request"}' };
        ecu.key = key;
        ecu.paired = true;
        ecu.provisions++;
        return { status: 200, body: JSON.stringify({ ok: true, deviceId: DEVICE_ID, model: 'AISS-ESP32CAM-1', firmware: '1.1.0', protocolVersion: 1 }) };
      }
      return { status: 404, body: '{}' };
    }),
    secureGet: vi.fn(async () => ({ value: null })),
    secureSet: vi.fn(async () => undefined),
  },
}));
vi.mock('../src/core/device/realDevice', () => ({ attachPairedDevice: vi.fn(async () => undefined) }));
vi.mock('../src/core/auth/authStore', () => ({ currentUid: () => 'uid-1', useAuth: { getState: () => ({}), subscribe: vi.fn() } }));
vi.mock('../src/core/firebase/app', () => ({ fb: () => ({ db: {} }) }));
vi.mock('firebase/firestore', () => ({ doc: vi.fn(() => ({})), setDoc: vi.fn(async () => undefined) }));
vi.mock('../src/core/runtime/mode', async (orig) => ({ ...(await orig<typeof import('../src/core/runtime/mode')>()), isDemo: () => false, isReal: () => true }));
vi.mock('../src/core/util', async (orig) => ({ ...(await orig<typeof import('../src/core/util')>()), wait: () => Promise.resolve() }));

import { provisionStick, useProvisioning } from '../src/core/provisioning/provisioning';
import { AissNative } from '../src/core/native/aissNative';
import { setDoc } from 'firebase/firestore';
import { attachPairedDevice } from '../src/core/device/realDevice';

describe('Stick setup (dashcam firmware)', () => {
  beforeEach(() => {
    ecu.paired = true;
    ecu.key = Buffer.alloc(32, 1);
    ecu.provisions = 0;
    vi.mocked(AissNative.secureSet).mockClear();
  });

  it('re-pairs a stick that is still paired from an earlier install, and verifies the new key', async () => {
    await provisionStick();
    const st = useProvisioning.getState();
    expect(st.error).toBeNull();
    expect(st.step).toBe('completed');
    expect(ecu.provisions).toBe(1);
    const saved = JSON.parse(vi.mocked(AissNative.secureSet).mock.calls[0][0].value);
    expect(Buffer.from(saved.keyB64, 'base64').equals(ecu.key)).toBe(true);
  });

  it('pairs a fresh stick', async () => {
    ecu.paired = false;
    await provisionStick();
    expect(useProvisioning.getState().step).toBe('completed');
    expect(ecu.provisions).toBe(1);
  });

  it('completes and starts the link while the phone is offline (cloud write never settles)', async () => {
    ecu.paired = false;
    vi.mocked(setDoc).mockImplementation(() => new Promise(() => undefined));
    vi.mocked(attachPairedDevice).mockClear();
    await provisionStick();
    expect(useProvisioning.getState().step).toBe('completed');
    expect(attachPairedDevice).toHaveBeenCalledTimes(1);
  });

  it('a failure after the key is saved keeps the pairing and the stick network', async () => {
    ecu.paired = false;
    vi.mocked(attachPairedDevice).mockRejectedValueOnce(new Error('UDP port busy'));
    vi.mocked(AissNative.releaseSetupNetwork).mockClear();
    await provisionStick();
    expect(useProvisioning.getState().step).toBe('completed');
    expect(AissNative.releaseSetupNetwork).not.toHaveBeenCalled();
  });
});
