/**
 * Stick setup, v1 simple link, against a simulated SmartStick (same rules as firmware 1.2 Api.cpp:
 * /device is public and reports auth:false, telemetry needs no key). Firmware 1.1 (signed requests)
 * answers telemetry with 401 and must produce the clear "flash firmware 1.2" message — never a
 * silent fallback to the old key pairing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DEVICE_ID = 'AISS-ABC123';
const stick = {
  on: true,
  /** 'v12' = simple link, 'v11' = old secure firmware (no auth field, telemetry 401), 'auth' = 1.2 built with REQUIRE_AUTH 1. */
  firmware: 'v12' as 'v12' | 'v11' | 'auth',
  wifiEnabled: true,
  joinedManually: false,
  bound: false,
  /** /device fails this many times after joining (the AP needs a moment). */
  deviceFailures: 0,
  /** Forced connectToSetupNetwork result reason (e.g. the user declined the system sheet). */
  joinReason: undefined as string | undefined,
  requests: [] as string[],
};

const telemetry = () => ({
  v: 1, deviceId: DEVICE_ID, seq: 7, uptimeMs: 1000,
  battery: { busV: 3.9, shuntMv: 10, currentMa: 120, charging: null, chargeSource: 'current', ok: true },
  imu: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, pitch: 1, roll: 0, ok: true },
  ultrasonic: { distanceCm: 120, echoUs: 7000, status: 'ok', sampleAgeMs: 5, zone: 'normal' },
  button: [], safety: [], rssi: -40,
  health: { camera: 'ok', i2c: 'ok', motor: 'idle', errors: [] },
});

vi.mock('../src/core/native/aissNative', () => ({
  AissNative: {
    requestPermissions: vi.fn(async () => ({ location: 'granted', nearbyWifi: 'granted', phone: 'denied', sms: 'denied' })),
    getCurrentWifiSsid: vi.fn(async () => ({ wifiEnabled: stick.wifiEnabled, ssid: null, stickNetwork: stick.joinedManually, bound: stick.bound })),
    connectToSetupNetwork: vi.fn(async () => {
      if (!stick.wifiEnabled) return { connected: false, reason: 'WIFI_DISABLED' };
      if (stick.joinReason) return { connected: false, reason: stick.joinReason };
      if (!stick.on) return { connected: false, reason: 'UNAVAILABLE' };
      stick.bound = true;
      return { connected: true, via: 'request' };
    }),
    scanForSetupNetworks: vi.fn(async () => ({ networks: stick.on ? [{ ssid: 'SmartStick_AI', rssi: -42 }] : [] })),
    releaseSetupNetwork: vi.fn(async () => undefined),
    openWifiSettings: vi.fn(async () => undefined),
    openAppSettings: vi.fn(async () => undefined),
    stopDiscovery: vi.fn(async () => undefined),
    secureGet: vi.fn(async () => ({ value: null })),
    secureRemove: vi.fn(async () => undefined),
    setupRequest: vi.fn(async (o: { method: string; path: string; body?: string; headers?: Record<string, string> }) => {
      if (!(stick.bound || stick.joinedManually) || !stick.on) throw new Error('Setup request failed: connect timed out');
      stick.requests.push(`${o.method} ${o.path}`);
      if (o.headers && Object.keys(o.headers).some((h) => h.startsWith('x-aiss-'))) throw new Error('v1 must not sign requests');
      const url = new URL(o.path, 'http://192.168.4.1');
      if (url.pathname === '/api/v1/device') {
        if (stick.deviceFailures > 0) {
          stick.deviceFailures--;
          throw new Error('Setup request failed: ECONNREFUSED');
        }
        const body: Record<string, unknown> = { deviceId: DEVICE_ID, model: 'AISS-ESP32CAM-1', firmware: stick.firmware === 'v11' ? '1.1.0-ecu' : '1.2.0', protocolVersion: 1, paired: false, uptimeMs: 5 };
        if (stick.firmware !== 'v11') body.auth = stick.firmware === 'auth';
        return { status: 200, body: JSON.stringify(body) };
      }
      if (url.pathname === '/api/v1/telemetry') {
        if (stick.firmware !== 'v12') return { status: 401, body: '{"error":"unauthorized"}' };
        return { status: 200, body: JSON.stringify(telemetry()) };
      }
      return { status: 404, body: '{}' };
    }),
  },
}));

const prefs = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: prefs.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => void prefs.set(key, value)),
    remove: vi.fn(async ({ key }: { key: string }) => void prefs.delete(key)),
  },
}));
vi.mock('../src/core/device/realDevice', () => ({ attachPairedDevice: vi.fn(async () => undefined), startRealDevice: vi.fn(async () => undefined) }));
vi.mock('../src/core/auth/authStore', () => ({ currentUid: () => 'uid-1', useAuth: { getState: () => ({}), subscribe: vi.fn() } }));
vi.mock('../src/core/firebase/app', () => ({ fb: () => ({ db: {} }) }));
vi.mock('firebase/firestore', () => ({ doc: vi.fn(() => ({})), setDoc: vi.fn(async () => undefined) }));
vi.mock('../src/core/runtime/mode', async (orig) => ({ ...(await orig<typeof import('../src/core/runtime/mode')>()), isDemo: () => false, isReal: () => true }));
vi.mock('../src/core/util', async (orig) => ({ ...(await orig<typeof import('../src/core/util')>()), wait: () => Promise.resolve() }));

import { cancelProvisioning, provPhase, provisionStick, searchForStick, useProvisioning } from '../src/core/provisioning/provisioning';
import { AissNative } from '../src/core/native/aissNative';
import { setDoc } from 'firebase/firestore';
import { attachPairedDevice, startRealDevice } from '../src/core/device/realDevice';

const savedRecord = () => {
  const v = prefs.get('pairedDevice.v1');
  return v ? JSON.parse(v) : null;
};

describe('Stick setup (v1 simple link)', () => {
  beforeEach(() => {
    Object.assign(stick, { on: true, firmware: 'v12', wifiEnabled: true, joinedManually: false, bound: false, deviceFailures: 0, joinReason: undefined, requests: [] });
    prefs.clear();
    vi.mocked(AissNative.connectToSetupNetwork).mockClear();
    vi.mocked(AissNative.releaseSetupNetwork).mockClear();
    vi.mocked(attachPairedDevice).mockClear();
    vi.mocked(startRealDevice).mockClear();
    useProvisioning.setState({ step: 'idle', error: null, errorKind: null, diagnostics: [] });
  });

  it('joins the stick Wi-Fi, retries /device while the AP settles, reads telemetry, saves a key-less record', async () => {
    stick.deviceFailures = 3;
    await provisionStick();
    const st = useProvisioning.getState();
    expect(st.error).toBeNull();
    expect(st.step).toBe('completed');
    expect(st.deviceId).toBe(DEVICE_ID);
    expect(AissNative.connectToSetupNetwork).toHaveBeenCalledTimes(1);
    expect(stick.requests).toContain('GET /api/v1/telemetry');
    expect(stick.requests.some((r) => r.includes('provision'))).toBe(false);
    const rec = savedRecord();
    expect(rec).toMatchObject({ deviceId: DEVICE_ID, host: '192.168.4.1', ownerUid: 'uid-1', firmware: '1.2.0' });
    expect(rec.keyB64).toBeUndefined();
    expect(attachPairedDevice).toHaveBeenCalledTimes(1);
  });

  it('uses the Wi-Fi the user joined by hand: no system sheet at all', async () => {
    stick.joinedManually = true;
    await provisionStick();
    expect(useProvisioning.getState().step).toBe('completed');
    expect(AissNative.connectToSetupNetwork).not.toHaveBeenCalled();
    expect(savedRecord()?.deviceId).toBe(DEVICE_ID);
  });

  it('old secure firmware (1.1, telemetry 401) → clear "flash firmware 1.2" message, nothing saved', async () => {
    stick.firmware = 'v11';
    await provisionStick();
    const st = useProvisioning.getState();
    expect(st.step).toBe('error');
    expect(st.errorKind).toBe('old_firmware');
    expect(st.error).toMatch(/firmware 1\.2/);
    expect(savedRecord()).toBeNull();
    expect(attachPairedDevice).not.toHaveBeenCalled();
  });

  it('firmware built with REQUIRE_AUTH 1 (auth: true) → same firmware message', async () => {
    stick.firmware = 'auth';
    await provisionStick();
    expect(useProvisioning.getState().errorKind).toBe('old_firmware');
  });

  it('stick switched off → "was not found" (scan only used as a hint)', async () => {
    stick.on = false;
    await provisionStick();
    const st = useProvisioning.getState();
    expect(st.errorKind).toBe('not_found');
    expect(st.error).toMatch(/was not found/);
    expect(st.diagnostics.join('\n')).toMatch(/not visible/);
  });

  it('stick visible but the system sheet was declined → tells the user to choose it and tap Connect', async () => {
    stick.joinReason = 'UNAVAILABLE';
    await provisionStick();
    expect(useProvisioning.getState().error).toMatch(/can see SmartStick_AI/);
  });

  it('Wi-Fi off → plain message', async () => {
    stick.wifiEnabled = false;
    await provisionStick();
    expect(useProvisioning.getState().errorKind).toBe('wifi_off');
    expect(useProvisioning.getState().error).toMatch(/Wi-Fi is off/);
  });

  it('joined but /device never answers → no_answer after the retries', async () => {
    stick.deviceFailures = 100;
    await provisionStick();
    const st = useProvisioning.getState();
    expect(st.errorKind).toBe('no_answer');
    expect(st.diagnostics.filter((l) => l.includes('not answering yet')).length).toBe(8);
  });

  it('completes and starts the link while the phone is offline (cloud write never settles)', async () => {
    vi.mocked(setDoc).mockImplementation(() => new Promise(() => undefined));
    await provisionStick();
    expect(useProvisioning.getState().step).toBe('completed');
    expect(attachPairedDevice).toHaveBeenCalledTimes(1);
  });

  it('a failure after the record is saved keeps the setup and the stick network', async () => {
    vi.mocked(attachPairedDevice).mockRejectedValueOnce(new Error('boom'));
    await provisionStick();
    expect(useProvisioning.getState().step).toBe('completed');
    expect(AissNative.releaseSetupNetwork).not.toHaveBeenCalled();
  });

  it('cancelling while Android is joining releases the request and restarts the saved stick link', async () => {
    useProvisioning.setState({ step: 'joining' });
    cancelProvisioning();
    expect(AissNative.releaseSetupNetwork).toHaveBeenCalledTimes(1);
    expect(startRealDevice).toHaveBeenCalledTimes(1);
    expect(useProvisioning.getState().step).toBe('idle');
  });

  it('"Try again" (searchForStick) starts a fresh run with a clean log', async () => {
    stick.on = false;
    await searchForStick();
    expect(useProvisioning.getState().step).toBe('error');
    stick.on = true;
    await searchForStick();
    expect(useProvisioning.getState().step).toBe('completed');
    expect(useProvisioning.getState().diagnostics.join('\n')).not.toMatch(/not visible/);
  });

  it('maps steps to the four phases', () => {
    expect(provPhase('searching')).toBe('scanning');
    expect(provPhase('joining')).toBe('scanning');
    expect(provPhase('stick_found')).toBe('found');
    expect(provPhase('reading_device_info')).toBe('connecting');
    expect(provPhase('waiting_for_data')).toBe('connecting');
    expect(provPhase('completed')).toBe('connected');
    expect(provPhase('error')).toBe('error');
  });
});
