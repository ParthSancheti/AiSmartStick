import { create } from 'zustand';
import type { PluginListenerHandle } from '@capacitor/core';
import { DASHCAM_STATION_PLACEHOLDER, DEVICE_API, PROTOCOL_VERSION, SETUP_AP_HOST, STICK_AP_PASSPHRASE, STICK_AP_SSID, type DeviceInfoPacket, type ProvisioningPacket, type ProvisioningResult } from '../../../shared/deviceProtocol';
import { AissNative } from '../native/aissNative';
import { randomBytes, sha256Hex, toB64, toHex, hmacHex, safeEqual } from '../device/crypto';
import { loadPairedDevice, savePairedDevice, type PairedDevice } from '../device/pairedDevice';
import { attachPairedDevice } from '../device/realDevice';
import { currentUid } from '../auth/authStore';
import { isDemo } from '../runtime/mode';
import { getMock } from '../device/bridge';
import { logEvent } from '../store/activity';
import { doc, setDoc } from 'firebase/firestore';
import { fb } from '../firebase/app';
import { paths } from '../../../shared/firestoreSchema';
import { wait } from '../util';

/**
 * Stick setup (dashcam topology): find the stick's own AP → bind it (one system "Connect to device?"
 * sheet) → read identity → hand it a fresh 32-byte HMAC key → verify the key proof → save the
 * pairing in the Keystore → start the authenticated transport.
 *
 * Without this, every telemetry / capture / command request is rejected by the stick (401).
 */
export type ProvStep =
  | 'idle'
  | 'searching'
  | 'stick_found'
  | 'connecting_to_stick'
  | 'stick_connected'
  | 'reading_device_info'
  | 'configuring_network'
  | 'waiting_for_stick_network'
  | 'verifying_stick'
  | 'authenticating'
  | 'completed'
  | 'error';

/** The four phases the setup screen shows. */
export type ProvPhase = 'scanning' | 'found' | 'connecting' | 'connected' | 'error' | 'idle';
export function provPhase(step: ProvStep): ProvPhase {
  switch (step) {
    case 'searching':
      return 'scanning';
    case 'stick_found':
      return 'found';
    case 'completed':
      return 'connected';
    case 'error':
      return 'error';
    case 'idle':
      return 'idle';
    default:
      return 'connecting';
  }
}

interface ProvState {
  step: ProvStep;
  ssid: string | null;
  deviceId: string | null;
  firmware: string | null;
  error: string | null;
  /** The stick already holds a key from an earlier setup this phone no longer has. */
  needsFactoryReset: boolean;
  diagnostics: string[];
}

export const useProvisioning = create<ProvState>(() => ({
  step: 'idle',
  ssid: null,
  deviceId: null,
  firmware: null,
  error: null,
  needsFactoryReset: false,
  diagnostics: [],
}));

const set = (p: Partial<ProvState>) => useProvisioning.setState(p);
const diag = (line: string) =>
  useProvisioning.setState((s) => ({
    diagnostics: [...s.diagnostics, `${new Date().toLocaleTimeString()}  ${line}`].slice(-40),
  }));

/** Each search/provision run gets a number; cancelling or restarting invalidates older runs. */
let run = 0;

export function cancelProvisioning() {
  run++;
  if (!isDemo()) void AissNative.releaseSetupNetwork().catch(() => undefined);
  set({ step: 'idle', error: null });
}

class Abort extends Error {}

/**
 * SCANNING: looks for the stick's access point for up to ~30 s, then provisions automatically.
 * "Found" is only shown when the AP really appeared in a Wi-Fi scan.
 */
export async function searchForStick() {
  const me = ++run;
  const alive = () => me === run;
  set({ step: 'searching', error: null, ssid: null, needsFactoryReset: false, diagnostics: [] });
  if (isDemo()) {
    await wait(1600);
    if (!alive()) return;
    set({ step: 'stick_found', ssid: STICK_AP_SSID });
    await wait(600);
    if (alive()) await provisionStick();
    return;
  }

  try {
    diag('requesting Wi-Fi permissions');
    await AissNative.requestPermissions({ permissions: ['location', 'nearbyWifi'] });
  } catch (e) {
    diag(`permission request failed: ${(e as Error).message}`);
  }

  const deadline = Date.now() + 30_000;
  let lastError: string | null = null;
  while (alive() && Date.now() < deadline) {
    try {
      const { networks } = await AissNative.scanForSetupNetworks({ prefix: STICK_AP_SSID });
      const hit = networks.find((n) => n.ssid === STICK_AP_SSID);
      if (hit) {
        diag(`found ${hit.ssid} (${hit.rssi} dBm)`);
        if (!alive()) return;
        set({ step: 'stick_found', ssid: hit.ssid });
        await wait(600); // let FOUND register before the system "Connect to device?" sheet
        if (alive()) await provisionStick();
        return;
      }
      lastError = null;
    } catch (e) {
      lastError = (e as Error).message;
      diag(`scan failed: ${lastError}`);
      if (/wi-?fi is off|permission/i.test(lastError)) break;
    }
    await wait(3000);
  }
  if (!alive()) return;
  set({
    step: 'error',
    error: lastError
      ? /wi-?fi is off/i.test(lastError)
        ? 'Wi-Fi is off. Turn on Wi-Fi, then try again.'
        : /permission/i.test(lastError)
          ? 'Allow location and nearby devices so the phone can find your SmartStick.'
          : lastError
      : `${STICK_AP_SSID} was not found. Switch the stick on, keep it close to the phone, then try again.`,
  });
}

/** FOUND → CONNECTING → CONNECTED. */
export async function provisionStick() {
  const me = run;
  const check = () => {
    if (me !== run) throw new Abort();
  };
  if (isDemo()) return demoProvision(me);
  const uid = currentUid();
  if (!uid) return set({ step: 'error', error: 'Sign in first.' });

  let handle: PluginListenerHandle | null = null;
  try {
    set({ step: 'connecting_to_stick', error: null, needsFactoryReset: false });
    diag(`joining ${STICK_AP_SSID}`);
    handle = await AissNative.addListener('WIFI_STATE', (ev) => {
      if (ev.event === 'WIFI_CONNECTED' && useProvisioning.getState().step === 'connecting_to_stick') set({ step: 'stick_connected' });
    });
    const { connected, reason } = await AissNative.connectToSetupNetwork({ ssid: STICK_AP_SSID, passphrase: STICK_AP_PASSPHRASE, timeoutMs: 30_000 });
    check();
    if (!connected) {
      if (reason === 'WIFI_DISABLED') throw new Error('Wi-Fi is off. Turn it on and try again.');
      throw new Error('The phone could not join the SmartStick. Make sure it is switched on and close by, then try again.');
    }
    set({ step: 'stick_connected' });

    set({ step: 'reading_device_info' });
    const info = await setupJson<DeviceInfoPacket>('GET', DEVICE_API.device);
    check();
    diag(`stick ${info.deviceId} firmware ${info.firmware} protocol v${info.protocolVersion} paired ${info.paired}`);
    if (info.protocolVersion !== PROTOCOL_VERSION) throw new Error(`This stick's firmware speaks protocol v${info.protocolVersion}. Update it to v${PROTOCOL_VERSION} first.`);
    set({ deviceId: info.deviceId, firmware: info.firmware });

    let dev: PairedDevice;
    if (info.paired) {
      // Set up before. Reuse the key only if THIS phone still holds it and the stick proves it.
      const saved = await loadPairedDevice();
      if (!saved || saved.deviceId !== info.deviceId || saved.ownerUid !== uid) {
        set({ needsFactoryReset: true });
        throw new Error('This SmartStick is still set up with another phone or an earlier install. Reset it: switch it off, then hold the button while switching it on for 5 seconds. Then try again.');
      }
      set({ step: 'authenticating' });
      await verifyProof(info.deviceId, saved.keyB64);
      dev = { ...saved, firmware: info.firmware, model: info.model, protocolVersion: info.protocolVersion, host: SETUP_AP_HOST };
    } else {
      set({ step: 'configuring_network' });
      const keyB64 = toB64(randomBytes(32));
      // Dashcam firmware never joins another network but still validates the credential fields (8–63 chars).
      const packet: ProvisioningPacket = { v: 1, ssid: DASHCAM_STATION_PLACEHOLDER.ssid, password: DASHCAM_STATION_PLACEHOLDER.password, deviceKey: keyB64, ownerHash: await sha256Hex(uid), nonce: toHex(randomBytes(12)) };
      const result = await setupJson<ProvisioningResult>('POST', DEVICE_API.provision, packet);
      check();
      if (!result.ok) throw new Error(`The stick refused the configuration (${result.error ?? 'unknown'}).`);
      set({ step: 'verifying_stick' });
      await wait(400);
      set({ step: 'authenticating' });
      await verifyProof(info.deviceId, keyB64);
      dev = { deviceId: info.deviceId, model: info.model, firmware: info.firmware, protocolVersion: info.protocolVersion, keyB64, host: SETUP_AP_HOST, ownerUid: uid, pairedAt: Date.now() };
    }
    check();
    await savePairedDevice(dev);

    const meta = { deviceId: dev.deviceId, model: dev.model, firmware: dev.firmware, protocolVersion: dev.protocolVersion, pairedAt: dev.pairedAt, authState: 'verified', revokedAt: null };
    await Promise.all([setDoc(doc(fb().db, paths.devices(uid), dev.deviceId), meta), setDoc(doc(fb().db, paths.deviceRegistry(dev.deviceId)), { ownerUid: uid, ...meta })]).catch((e) =>
      diag(`cloud save deferred: ${(e as Error).message}`),
    );

    // The stick network stays bound: the authenticated transport keeps using it.
    await attachPairedDevice(dev);
    logEvent({ kind: 'device', severity: 'success', title: 'AI SmartStick paired', detail: `${dev.deviceId}, firmware ${dev.firmware}` });
    set({ step: 'completed' });
  } catch (e) {
    if (e instanceof Abort) return;
    await AissNative.releaseSetupNetwork().catch(() => undefined);
    diag(`error: ${(e as Error).message}`);
    set({ step: 'error', error: (e as Error).message });
  } finally {
    await handle?.remove().catch(() => undefined);
  }
}

async function setupJson<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const r = await AissNative.setupRequest({ method, path, body: body ? JSON.stringify(body) : undefined, timeoutMs: 8000 });
  if (r.status < 200 || r.status >= 300) {
    let msg = '';
    try {
      msg = (JSON.parse(r.body) as { message?: string }).message ?? '';
    } catch {
      /* not JSON */
    }
    throw new Error(`Stick answered HTTP ${r.status}${msg ? `: ${msg}` : ''}`);
  }
  return JSON.parse(r.body) as T;
}

async function verifyProof(deviceId: string, keyB64: string) {
  const challenge = toHex(randomBytes(16));
  const info = await setupJson<DeviceInfoPacket>('GET', `${DEVICE_API.device}?challenge=${challenge}`);
  const expect = await hmacHex(keyB64, challenge + deviceId);
  if (info.deviceId !== deviceId || !info.proof || !safeEqual(info.proof, expect)) throw new Error('The stick could not prove it received the key. Reset it (hold the button while switching it on), then set up again.');
}

async function demoProvision(me: number) {
  const steps: ProvStep[] = ['connecting_to_stick', 'stick_connected', 'reading_device_info', 'configuring_network', 'verifying_stick', 'authenticating'];
  for (const s of steps) {
    if (me !== run) return;
    set({ step: s });
    await wait(700);
  }
  if (me !== run) return;
  getMock()?.setLinked(true);
  set({ step: 'completed', deviceId: 'DEMO-4F2A', firmware: '1.0.0-demo' });
}
