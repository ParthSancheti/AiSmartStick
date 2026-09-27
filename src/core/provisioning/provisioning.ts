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

/**
 * First-time stick setup (DEVICE_PROTOCOL.md §Provisioning):
 *  1 user holds the stick button 5 s → stick raises WPA2 AP "AISmartStick-XXXX" (password = setup code on its label)
 *  2 app scans for that AP → "Stick detected"
 *  3 Android joins it via WifiNetworkSpecifier (one system prompt) → "Connecting to Stick"
 *  4 app sends hotspot SSID/password + a fresh 32-byte device key → "Sending network configuration"
 *  5 stick leaves AP mode and joins the hotspot → "Connecting Stick to phone network"
 *  6 app hears the stick's SIGNED UDP announcement → challenge/response proves the key → "Authenticating"
 *  7 pairing saved (key in Android Keystore storage, metadata in Firestore) → "Connected"
 * Android does not let apps read the hotspot password, so the user types it once (step 4 form).
 */
export type ProvStep =
  | 'idle'
  | 'searching'
  | 'detected'
  | 'connecting_ap'
  | 'sending_config'
  | 'joining_network'
  | 'authenticating'
  | 'finalizing'
  | 'connected'
  | 'failed'
  | 'retrying';

interface ProvState {
  step: ProvStep;
  ssid: string | null;
  deviceId: string | null;
  firmware: string | null;
  error: string | null;
  diagnostics: string[];
}

export const useProvisioning = create<ProvState>(() => ({ step: 'idle', ssid: null, deviceId: null, firmware: null, error: null, diagnostics: [] }));

const set = (p: Partial<ProvState>) => useProvisioning.setState(p);
const diag = (line: string) => useProvisioning.setState((s) => ({ diagnostics: [...s.diagnostics, `${new Date().toLocaleTimeString()}  ${line}`].slice(-40) }));

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

/** Step 1–2: look for the stick's setup network. */
export async function searchForStick() {
  cancelled = false;
  set({ step: 'searching', error: null, ssid: null, diagnostics: [] });
  if (isDemo()) {
    await wait(1600);
    if (!cancelled) set({ step: 'detected', ssid: `${SETUP_AP_PREFIX}4F2A` });
    return;
  }
  const until = Date.now() + 90_000;
  while (!cancelled && Date.now() < until) {
    try {
      const { networks } = await AissNative.scanForSetupNetworks({ prefix: SETUP_AP_PREFIX });
      diag(`scan: ${networks.length} setup network(s)`);
      if (networks.length) {
        const best = [...networks].sort((a, b) => b.rssi - a.rssi)[0];
        set({ step: 'detected', ssid: best.ssid });
        return;
      }
    } catch (e) {
      diag(`scan failed: ${(e as Error).message}`);
      set({ step: 'failed', error: 'Wi-Fi scanning is unavailable. Allow "Nearby devices" / location permission and turn Wi-Fi on.' });
      return;
    }
    await wait(3000);
  }
  if (!cancelled) set({ step: 'failed', error: 'No stick in setup mode found. Hold the stick button for 5 seconds until it buzzes twice, then try again.' });
}

/** Steps 3–7. `setupCode` is printed on the stick; hotspot credentials are typed by the user once. */
export async function provisionStick(input: { setupCode: string; hotspotSsid: string; hotspotPassword: string }) {
  cancelled = false;
  const ssid = useProvisioning.getState().ssid;
  if (!ssid) return set({ step: 'failed', error: 'No stick detected yet.' });
  if (isDemo()) return demoProvision();
  const uid = currentUid();
  if (!uid) return set({ step: 'failed', error: 'Sign in first.' });
  try {
    set({ step: 'connecting_ap', error: null });
    diag(`joining ${ssid}`);
    const { connected } = await AissNative.connectToSetupNetwork({ ssid, passphrase: input.setupCode.trim(), timeoutMs: 30000 });
    check();
    if (!connected) throw new Error('Could not join the stick’s setup network. Check the setup code on the stick label.');

    const info = await setupJson<DeviceInfoPacket>('GET', DEVICE_API.device);
    diag(`stick ${info.deviceId} firmware ${info.firmware} protocol v${info.protocolVersion}`);
    if (info.protocolVersion !== PROTOCOL_VERSION) throw new Error(`This stick's firmware speaks protocol v${info.protocolVersion}. Update it to v${PROTOCOL_VERSION} first.`);
    set({ deviceId: info.deviceId, firmware: info.firmware });

    set({ step: 'sending_config' });
    const keyB64 = toB64(randomBytes(32));
    const packet: ProvisioningPacket = { v: 1, ssid: input.hotspotSsid.trim(), password: input.hotspotPassword, deviceKey: keyB64, ownerHash: await sha256Hex(uid), nonce: toHex(randomBytes(12)) };
    const result = await setupJson<ProvisioningResult>('POST', DEVICE_API.provision, packet);
    check();
    if (!result.ok) throw new Error(`The stick refused the configuration (${result.error ?? 'unknown'}).`);
    await AissNative.releaseSetupNetwork();

    set({ step: 'joining_network' });
    diag('waiting for the stick on the hotspot (make sure the hotspot is ON, 2.4 GHz)');
    const ip = await waitForAnnouncement({ deviceId: info.deviceId, keyB64 }, 120_000);
    check();
    diag(`announcement from ${ip}`);

    set({ step: 'authenticating' });
    await verifyProof(ip, info.deviceId, keyB64);
    check();

    set({ step: 'finalizing' });
    const dev: PairedDevice = { deviceId: info.deviceId, model: info.model, firmware: info.firmware, protocolVersion: info.protocolVersion, keyB64, host: ip, ownerUid: uid, pairedAt: Date.now() };
    await savePairedDevice(dev);
    const meta = { deviceId: dev.deviceId, model: dev.model, firmware: dev.firmware, protocolVersion: dev.protocolVersion, pairedAt: dev.pairedAt, authState: 'verified', revokedAt: null };
    await Promise.all([
      setDoc(doc(fb().db, paths.devices(uid), dev.deviceId), meta),
      setDoc(doc(fb().db, paths.deviceRegistry(dev.deviceId)), { ownerUid: uid, ...meta }),
    ]).catch((e) => diag(`cloud save deferred: ${(e as Error).message}`));
    await attachPairedDevice(dev);
    logEvent({ kind: 'device', severity: 'success', title: 'AI Smart Stick paired', detail: `${dev.deviceId}, firmware ${dev.firmware}` });
    set({ step: 'connected' });
  } catch (e) {
    await AissNative.releaseSetupNetwork().catch(() => undefined);
    if (e instanceof Abort) return;
    diag(`error: ${(e as Error).message}`);
    set({ step: 'failed', error: (e as Error).message });
  }
}

async function setupJson<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
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
        /* ignore */
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

/** DEMO: same states, simulated timings, then the mock stick links. */
async function demoProvision() {
  const steps: ProvStep[] = ['connecting_ap', 'sending_config', 'joining_network', 'authenticating', 'finalizing'];
  for (const s of steps) {
    if (cancelled) return;
    set({ step: s });
    await wait(s === 'joining_network' ? 2200 : 1100);
  }
  if (cancelled) return;
  getMock()?.setLinked(true);
  set({ step: 'connected', deviceId: 'DEMO-4F2A', firmware: '1.0.0-demo' });
}
