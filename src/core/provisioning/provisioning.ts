import { create } from 'zustand';
import { DEVICE_API, PROTOCOL_VERSION, SETUP_AP_PREFIX, type DeviceInfoPacket, type ProvisioningPacket, type ProvisioningResult } from '../../../shared/deviceProtocol';
import { AissNative } from '../native/aissNative';
import { randomBytes, sha256Hex, toB64, toHex, hmacHex, safeEqual } from '../device/crypto';
import { savePairedDevice, type PairedDevice } from '../device/pairedDevice';
import { attachPairedDevice } from '../device/realDevice';
import { currentUid } from '../auth/authStore';
import { isDemo } from '../runtime/mode';
import { getMock } from '../device/bridge';
import { logEvent } from '../store/activity';
import { doc, setDoc } from 'firebase/firestore';
import { fb } from '../firebase/app';
import { paths } from '../../../shared/firestoreSchema';
import { wait } from '../util';

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

interface ProvState {
  step: ProvStep;
  ssid: string | null;
  deviceId: string | null;
  firmware: string | null;
  error: string | null;
  diagnostics: string[];
}

export const useProvisioning = create<ProvState>(() => ({
  step: 'idle',
  ssid: null,
  deviceId: null,
  firmware: null,
  error: null,
  diagnostics: [],
}));

const set = (p: Partial<ProvState>) => useProvisioning.setState(p);
const diag = (line: string) => useProvisioning.setState((s) => ({
  diagnostics: [...s.diagnostics, `${new Date().toLocaleTimeString()}  ${line}`].slice(-40)
}));

let cancelled = false;

export function cancelProvisioning() {
  cancelled = true;
  void AissNative.releaseSetupNetwork().catch(() => undefined);
  set({ step: 'idle', error: null });
}

class Abort extends Error {}
const check = () => {
  if (cancelled) throw new Abort();
};

export async function searchForStick() {
  cancelled = false;
  set({ step: 'searching', error: null, ssid: null, diagnostics: [] });
  if (isDemo()) {
    await wait(1600);
    if (!cancelled) set({ step: 'stick_found', ssid: `${SETUP_AP_PREFIX}4F2A` });
    return;
  }

  // Request permissions upfront
  try {
    diag('requesting permissions...');
    await AissNative.requestPermissions({ permissions: ['location', 'nearbyWifi'] });
  } catch (e) {
    diag(`permissions request failed: ${(e as Error).message}`);
  }

  // Dashcam Protocol: See if we are ALREADY connected or can connect instantly
  try {
    diag('checking if already connected to SmartStick_AI...');
    const { connected } = await AissNative.connectToSetupNetwork({ ssid: 'SmartStick_AI', passphrase: 'Stick@1234', timeoutMs: 3000 });
    if (connected && !cancelled) {
      diag('already connected! Skipping to dashboard.');
      set({ step: 'stick_found', ssid: 'SmartStick_AI' });
      return provisionStick({ setupCode: '', hotspotSsid: '', hotspotPassword: '' });
    }
  } catch (e) {
    diag(`auto-connect check failed: ${(e as Error).message}`);
  }
  
  if (!cancelled) set({ step: 'stick_found', ssid: 'SmartStick_AI' });
}

export async function provisionStick(input: { setupCode: string; hotspotSsid: string; hotspotPassword: string }) {
  cancelled = false;
  const ssid = useProvisioning.getState().ssid;
  if (!ssid) return set({ step: 'error', error: 'No stick detected yet.' });
  if (isDemo()) return demoProvision();
  const uid = currentUid();
  if (!uid) return set({ step: 'error', error: 'Sign in first.' });
  
  // Overall 20-second timeout for the entire provision flow
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error('Connection process took too long. Please try again.'));
  }, 20000);

  try {
    set({ step: 'connecting_to_stick', error: null });
    diag(`joining SmartStick_AI`);
    
    // Listen for the native event so the UI updates instantly
    const handle = await AissNative.addListener('WIFI_STATE', (ev) => {
       if (ev.event === 'WIFI_CONNECTED') {
          set({ step: 'stick_connected' });
       }
    });

    const { connected, reason } = await AissNative.connectToSetupNetwork({ ssid: 'SmartStick_AI', passphrase: 'Stick@1234', timeoutMs: 15000 });
    check();
    if (controller.signal.aborted) throw controller.signal.reason;
    handle.remove();
    
    if (!connected) {
      if (reason === 'WIFI_DISABLED') {
        throw new Error('Please turn on your Wi-Fi and try again.');
      }
      throw new Error('Connection failed or timed out. Ensure the SmartStick is turned on and try again.');
    }
    set({ step: 'stick_connected' });

    set({ step: 'reading_device_info' });
    const info = await setupJson<DeviceInfoPacket>('GET', DEVICE_API.device);
    diag(`stick ${info.deviceId} firmware ${info.firmware} protocol v${info.protocolVersion} paired ${info.paired}`);
    if (info.protocolVersion !== PROTOCOL_VERSION) throw new Error(`This stick's firmware speaks protocol v${info.protocolVersion}. Update it to v${PROTOCOL_VERSION} first.`);
    if (info.paired) {
      throw new Error("This stick is already set up. If you don't see it on your dashboard, please factory reset it (hold the button for 5 seconds while turning it on) and try again.");
    }
    set({ deviceId: info.deviceId, firmware: info.firmware });

    set({ step: 'configuring_network' });
    const keyB64 = toB64(randomBytes(32));
    const packet: ProvisioningPacket = { v: 1, ssid: "dashcam", password: "none", deviceKey: keyB64, ownerHash: await sha256Hex(uid), nonce: toHex(randomBytes(12)) };
    const result = await setupJson<ProvisioningResult>('POST', DEVICE_API.provision, packet);
    check();
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!result.ok) throw new Error(`The stick refused the configuration (${result.error ?? 'unknown'}).`);
    
    // DASHCAM PROTOCOL: DO NOT RELEASE SETUP NETWORK!
    // The app stays connected to the Stick's AP forever!
    const ip = "192.168.4.1";

    set({ step: 'verifying_stick' });
    await wait(1000);
    
    set({ step: 'authenticating' });
    await verifyProof(ip, info.deviceId, keyB64);
    check();
    if (controller.signal.aborted) throw controller.signal.reason;

    const dev: PairedDevice = { deviceId: info.deviceId, model: info.model, firmware: info.firmware, protocolVersion: info.protocolVersion, keyB64, host: ip, ownerUid: uid, pairedAt: Date.now() };
    await savePairedDevice(dev);
    
    const meta = { deviceId: dev.deviceId, model: dev.model, firmware: dev.firmware, protocolVersion: dev.protocolVersion, pairedAt: dev.pairedAt, authState: 'verified', revokedAt: null };
    await Promise.all([
      setDoc(doc(fb().db, paths.devices(uid), dev.deviceId), meta),
      setDoc(doc(fb().db, paths.deviceRegistry(dev.deviceId)), { ownerUid: uid, ...meta }),
    ]).catch((e) => diag(`cloud save deferred: ${(e as Error).message}`));
    
    await attachPairedDevice(dev);
    logEvent({ kind: 'device', severity: 'success', title: 'AI SmartStick paired', detail: `${dev.deviceId}, firmware ${dev.firmware}` });
    
    clearTimeout(timeoutId);
    set({ step: 'completed' });
  } catch (e) {
    clearTimeout(timeoutId);
    await AissNative.releaseSetupNetwork().catch(() => undefined);
    if (e instanceof Abort) return;
    diag(`error: ${(e as Error).message}`);
    set({ step: 'error', error: (e as Error).message });
  }
}

async function setupJson<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const r = await AissNative.setupRequest({ method, path, body: body ? JSON.stringify(body) : undefined, timeoutMs: 8000 });
  if (r.status < 200 || r.status >= 300) throw new Error(`Stick answered HTTP ${r.status}`);
  return JSON.parse(r.body) as T;
}



async function verifyProof(ip: string, deviceId: string, keyB64: string) {
  const challenge = toHex(randomBytes(16));
  // DASHCAM PROTOCOL FIX: MUST use Native setupRequest to route over Wi-Fi interface!
  const info = await setupJson<DeviceInfoPacket>('GET', `${DEVICE_API.device}?challenge=${challenge}`);
  const expect = await hmacHex(keyB64, challenge + deviceId);
  if (info.deviceId !== deviceId || !info.proof || !safeEqual(info.proof, expect)) throw new Error('The stick could not prove it received the key. Reset it (hold the button while switching it on), then set up again.');
}

async function demoProvision() {
  const steps: ProvStep[] = ['connecting_to_stick', 'stick_connected', 'reading_device_info', 'configuring_network', 'waiting_for_stick_network', 'verifying_stick', 'authenticating'];
  for (const s of steps) {
    if (cancelled) return;
    set({ step: s });
    await wait(s === 'waiting_for_stick_network' ? 2200 : 1100);
  }
  if (cancelled) return;
  getMock()?.setLinked(true);
  set({ step: 'completed', deviceId: 'DEMO-4F2A', firmware: '1.0.0-demo' });
}
