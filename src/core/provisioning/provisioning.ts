import { create } from 'zustand';
import { DEVICE_API, PROTOCOL_VERSION, SETUP_AP_PREFIX, type DeviceInfoPacket, type ProvisioningPacket, type ProvisioningResult, type DiscoveryAnnouncement } from '../../../shared/deviceProtocol';
import { AissNative } from '../native/aissNative';
import { randomBytes, sha256Hex, toB64, toHex, hmacHex, safeEqual } from '../device/crypto';
import { savePairedDevice, type PairedDevice } from '../device/pairedDevice';
import { attachPairedDevice } from '../device/realDevice';
import { verifyAnnouncement } from '../device/discovery';
import { DISCOVERY_UDP_PORT } from '../../../shared/deviceProtocol';
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
  
  const until = Date.now() + 90_000;
  while (!cancelled && Date.now() < until) {
    try {
      const { networks } = await AissNative.scanForSetupNetworks({ prefix: SETUP_AP_PREFIX });
      diag(`scan: ${networks.length} setup network(s)`);
      if (networks.length) {
        const best = [...networks].sort((a, b) => b.rssi - a.rssi)[0];
        set({ step: 'stick_found', ssid: best.ssid });
        return;
      }
    } catch (e) {
      diag(`scan failed: ${(e as Error).message}`);
      set({ step: 'error', error: 'Wi-Fi scanning is unavailable. Allow "Nearby devices" / location permission and turn Wi-Fi on.' });
      return;
    }
    await wait(3000);
  }
  if (!cancelled) set({ step: 'error', error: 'No stick in setup mode found. Hold the stick button for 5 seconds until it buzzes twice, then try again.' });
}

export async function provisionStick(input: { setupCode: string; hotspotSsid: string; hotspotPassword: string }) {
  cancelled = false;
  const ssid = useProvisioning.getState().ssid;
  if (!ssid) return set({ step: 'error', error: 'No stick detected yet.' });
  if (isDemo()) return demoProvision();
  const uid = currentUid();
  if (!uid) return set({ step: 'error', error: 'Sign in first.' });
  
  try {
    set({ step: 'connecting_to_stick', error: null });
    diag(`joining ${ssid}`);
    const { connected } = await AissNative.connectToSetupNetwork({ ssid, passphrase: input.setupCode.trim(), timeoutMs: 30000 });
    check();
    if (!connected) throw new Error('Could not join the stick’s setup network. Check the setup code on the stick label.');
    set({ step: 'stick_connected' });

    set({ step: 'reading_device_info' });
    const info = await setupJson<DeviceInfoPacket>('GET', DEVICE_API.device);
    diag(`stick ${info.deviceId} firmware ${info.firmware} protocol v${info.protocolVersion}`);
    if (info.protocolVersion !== PROTOCOL_VERSION) throw new Error(`This stick's firmware speaks protocol v${info.protocolVersion}. Update it to v${PROTOCOL_VERSION} first.`);
    set({ deviceId: info.deviceId, firmware: info.firmware });

    set({ step: 'configuring_network' });
    const keyB64 = toB64(randomBytes(32));
    const packet: ProvisioningPacket = { v: 1, ssid: input.hotspotSsid.trim(), password: input.hotspotPassword, deviceKey: keyB64, ownerHash: await sha256Hex(uid), nonce: toHex(randomBytes(12)) };
    const result = await setupJson<ProvisioningResult>('POST', DEVICE_API.provision, packet);
    check();
    if (!result.ok) throw new Error(`The stick refused the configuration (${result.error ?? 'unknown'}).`);
    
    // Crucial: Release the temporary Wi-Fi network immediately so phone restores internet
    await AissNative.releaseSetupNetwork();

    set({ step: 'waiting_for_stick_network' });
    diag('waiting for the stick on the hotspot (make sure the hotspot is ON, 2.4 GHz)');
    const ip = await waitForAnnouncement({ deviceId: info.deviceId, keyB64 }, 120_000);
    check();
    diag(`announcement from ${ip}`);

    set({ step: 'verifying_stick' });
    // Add brief wait for TCP stack
    await wait(1000);
    
    set({ step: 'authenticating' });
    await verifyProof(ip, info.deviceId, keyB64);
    check();

    const dev: PairedDevice = { deviceId: info.deviceId, model: info.model, firmware: info.firmware, protocolVersion: info.protocolVersion, keyB64, host: ip, ownerUid: uid, pairedAt: Date.now() };
    await savePairedDevice(dev);
    
    const meta = { deviceId: dev.deviceId, model: dev.model, firmware: dev.firmware, protocolVersion: dev.protocolVersion, pairedAt: dev.pairedAt, authState: 'verified', revokedAt: null };
    await Promise.all([
      setDoc(doc(fb().db, paths.devices(uid), dev.deviceId), meta),
      setDoc(doc(fb().db, paths.deviceRegistry(dev.deviceId)), { ownerUid: uid, ...meta }),
    ]).catch((e) => diag(`cloud save deferred: ${(e as Error).message}`));
    
    await attachPairedDevice(dev);
    logEvent({ kind: 'device', severity: 'success', title: 'AI SmartStick paired', detail: `${dev.deviceId}, firmware ${dev.firmware}` });
    
    set({ step: 'completed' });
  } catch (e) {
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

async function waitForAnnouncement(dev: { deviceId: string; keyB64: string }, timeoutMs: number): Promise<string> {
  await AissNative.startDiscovery({ port: DISCOVERY_UDP_PORT });
  return new Promise<string>((resolve, reject) => {
    let handle: { remove: () => Promise<void> } | null = null;
    const done = (fn: () => void) => {
      clearTimeout(timer);
      clearInterval(poll);
      void handle?.remove();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error('The stick did not appear on your hotspot. Is the hotspot on, 2.4 GHz, with the name and password you typed?'))), timeoutMs);
    const poll = setInterval(() => cancelled && done(() => reject(new Abort())), 500);
    void AissNative.addListener('announcement', async ({ json, fromIp }) => {
      try {
        const a = JSON.parse(json) as DiscoveryAnnouncement;
        if (await verifyAnnouncement(a, dev)) done(() => resolve(a.ip || fromIp));
      } catch {
      }
    }).then((h) => (handle = h));
  });
}

async function verifyProof(ip: string, deviceId: string, keyB64: string) {
  const challenge = toHex(randomBytes(16));
  const res = await fetch(`http://${ip}${DEVICE_API.device}?challenge=${challenge}`, { signal: AbortSignal.timeout(4000) });
  const info = (await res.json()) as DeviceInfoPacket;
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
