import { create } from 'zustand';
import { DEVICE_API, MIN_STICK_FIRMWARE, PROTOCOL_VERSION, SETUP_AP_HOST, STICK_AP_PASSPHRASE, STICK_AP_SSID, type DeviceInfoPacket, type TelemetryPacket } from '../../../shared/deviceProtocol';
import { AissNative } from '../native/aissNative';
import { savePairedDevice, type PairedDevice } from '../device/pairedDevice';
import { attachPairedDevice, startRealDevice } from '../device/realDevice';
import { disconnectStick } from '../device/bridge';
import { stopDiscovery } from '../device/discovery';
import { currentUid } from '../auth/authStore';
import { isDemo } from '../runtime/mode';
import { getMock } from '../device/bridge';
import { logEvent } from '../store/activity';
import { doc, setDoc } from 'firebase/firestore';
import { fb } from '../firebase/app';
import { paths } from '../../../shared/firestoreSchema';
import { wait } from '../util';
import { explainPacket } from '../telemetry/pipeline';
import { looksLikeStick } from '../transport/stickHttp';

/**
 * Stick setup, v1 SIMPLE LINK (firmware 1.2+): no keys, no provisioning.
 *
 *   1. SCANNING   ask for Wi-Fi permissions (best effort); if the phone is already on the stick's
 *                 Wi-Fi (joined by hand in Android settings) use it, otherwise Android's own
 *                 "Connect to device" sheet joins SmartStick_AI (it scans by itself).
 *   2. FOUND      the phone is on the stick's Wi-Fi.
 *   3. CONNECTING GET /api/v1/device (retried: the access point needs a moment after joining),
 *                 then one real telemetry packet.
 *   4. CONNECTED  the stick record is saved (no secret) and the live link starts.
 *
 * A 401 means the stick still runs the old secure firmware: the user is told to flash 1.2
 * (never silently paired some other way). Every failure has a plain-language message and the
 * step log stays available under "Details".
 */
export type ProvStep = 'idle' | 'searching' | 'joining' | 'stick_found' | 'reading_device_info' | 'waiting_for_data' | 'completed' | 'error';

/** The four phases the setup screen shows. */
export type ProvPhase = 'scanning' | 'found' | 'connecting' | 'connected' | 'error' | 'idle';
export function provPhase(step: ProvStep): ProvPhase {
  switch (step) {
    case 'searching':
    case 'joining':
      return 'scanning';
    case 'stick_found':
      return 'found';
    case 'reading_device_info':
    case 'waiting_for_data':
      return 'connecting';
    case 'completed':
      return 'connected';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

/** What went wrong, so the screen can offer the right button. */
export type ProvErrorKind = 'signin' | 'wifi_off' | 'not_found' | 'permission' | 'unsupported' | 'no_answer' | 'not_a_stick' | 'old_firmware' | 'protocol' | 'other';

interface ProvState {
  step: ProvStep;
  ssid: string | null;
  deviceId: string | null;
  firmware: string | null;
  error: string | null;
  errorKind: ProvErrorKind | null;
  diagnostics: string[];
}

export const useProvisioning = create<ProvState>(() => ({
  step: 'idle',
  ssid: null,
  deviceId: null,
  firmware: null,
  error: null,
  errorKind: null,
  diagnostics: [],
}));

const set = (p: Partial<ProvState>) => useProvisioning.setState(p);
const diag = (line: string) => {
  // Also in logcat (Capacitor/Console) as "[SMARTSTICK] setup: …".
  console.info(`[SMARTSTICK] setup: ${line}`);
  useProvisioning.setState((s) => ({
    diagnostics: [...s.diagnostics, `${new Date().toLocaleTimeString()}  ${line}`].slice(-60),
  }));
};

export const OLD_FIRMWARE_SETUP_MESSAGE = `This stick still runs the old secure firmware. Flash firmware ${MIN_STICK_FIRMWARE} on the stick (Arduino IDE, firmware/ai_smart_stick_v1), switch it on again, then tap Try again.`;

class SetupError extends Error {
  constructor(
    readonly kind: ProvErrorKind,
    message: string,
  ) {
    super(message);
  }
}
class Abort extends Error {}

/** Each setup run gets a number; cancelling or restarting invalidates older runs. */
let run = 0;

/**
 * Leaves setup without finishing (Back / "Connect later" / screen closed): stops an Android
 * "Connect to device" request still in flight and restarts the saved stick's link, which setup
 * had paused.
 */
export function cancelProvisioning() {
  run++;
  const { step } = useProvisioning.getState();
  set({ step: 'idle', error: null, errorKind: null });
  if (isDemo() || step === 'idle' || step === 'completed') return;
  if (step === 'joining') void AissNative.releaseSetupNetwork().catch(() => undefined);
  void startRealDevice().catch(() => undefined);
}

/** Starts (or restarts, e.g. "Try again") the whole setup. */
export async function searchForStick() {
  const me = ++run;
  set({ step: 'searching', error: null, errorKind: null, ssid: null, deviceId: null, firmware: null, diagnostics: [] });
  if (isDemo()) {
    await wait(1600);
    if (me !== run) return;
    set({ step: 'stick_found', ssid: STICK_AP_SSID });
    await wait(600);
    if (me === run) await demoProvision(me);
    return;
  }
  await provisionStick();
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out`)), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/** SCANNING → FOUND → CONNECTING → CONNECTED for the current run. */
export async function provisionStick() {
  const me = run;
  const check = () => {
    if (me !== run) throw new Abort();
  };
  if (isDemo()) return demoProvision(me);
  const uid = currentUid();
  if (!uid) return set({ step: 'error', errorKind: 'signin', error: 'Sign in first, then set up the stick.' });

  let saved = false;
  try {
    // An earlier link keeps retrying in the background and would compete for the stick's few sockets.
    disconnectStick();
    await stopDiscovery().catch(() => undefined);
    set({ step: 'searching', error: null, errorKind: null });

    diag('asking for Location / Nearby devices permission (helps Android find the stick)');
    try {
      const p = await withTimeout(AissNative.requestPermissions({ permissions: ['location', 'nearbyWifi'] }), 60_000, 'permission request');
      diag(`permissions: location ${p.location}, nearby ${p.nearbyWifi}`);
    } catch (e) {
      diag(`permission request skipped: ${(e as Error).message}`);
    }
    check();

    // Already on the stick's Wi-Fi (joined by hand, or still bound)? Then no system sheet at all.
    let info = await probeOnce();
    check();
    if (info) {
      diag(`the phone is already on ${STICK_AP_SSID}: no Wi-Fi dialog needed`);
    } else {
      const w = await withTimeout(AissNative.getCurrentWifiSsid(), 3000, 'Wi-Fi status').catch(() => null);
      if (w) diag(`Wi-Fi ${w.wifiEnabled ? 'on' : 'OFF'}${w.ssid ? `, connected to "${w.ssid}"` : ''}${w.stickNetwork ? ', stick network present' : ''}`);
      if (w && !w.wifiEnabled) {
        void AissNative.openWifiSettings().catch(() => undefined);
        throw new SetupError('wifi_off', 'Wi-Fi is off. Turn on Wi-Fi, then tap Try again.');
      }
      set({ step: 'joining' });
      diag(`asking Android to join ${STICK_AP_SSID} (approve "Connect" if Android asks)`);
      let res: Awaited<ReturnType<typeof AissNative.connectToSetupNetwork>>;
      try {
        // Android answers within its own 45 s; the JS cap only guards a callback that never comes.
        res = await withTimeout(AissNative.connectToSetupNetwork({ ssid: STICK_AP_SSID, passphrase: STICK_AP_PASSPHRASE, timeoutMs: 45_000 }), 55_000, 'Android Wi-Fi join').catch((e: Error) => {
          if (/timed out/.test(e.message)) return { connected: false, reason: 'UNAVAILABLE' };
          throw e;
        });
      } catch (e) {
        throw new SetupError('other', `Android could not start the Wi-Fi connection: ${(e as Error).message}`);
      }
      check();
      if (!res.connected) throw await joinError(res.reason);
      diag(`joined ${STICK_AP_SSID}${res.via ? ` (${res.via})` : ''}`);
    }
    set({ step: 'stick_found', ssid: STICK_AP_SSID });
    await wait(300); // let FOUND register on screen
    check();

    set({ step: 'reading_device_info' });
    if (!info) info = await readDevice(check);
    diag(`stick ${info.deviceId}, firmware ${info.firmware}, protocol v${info.protocolVersion}, auth ${info.auth === false ? 'off' : info.auth === true ? 'ON' : 'unknown (old firmware?)'}`);
    if (info.protocolVersion !== PROTOCOL_VERSION) throw new SetupError('protocol', `This stick's firmware speaks protocol v${info.protocolVersion}; the app needs v${PROTOCOL_VERSION}. Flash firmware ${MIN_STICK_FIRMWARE}.`);
    if (info.auth === true) throw new SetupError('old_firmware', OLD_FIRMWARE_SETUP_MESSAGE);
    set({ deviceId: info.deviceId, firmware: info.firmware });

    set({ step: 'waiting_for_data' });
    const packet = await readTelemetry(check);
    diag(`first telemetry packet #${packet.seq} received`);

    const dev: PairedDevice = { deviceId: info.deviceId, model: info.model, firmware: info.firmware, protocolVersion: info.protocolVersion, host: SETUP_AP_HOST, ownerUid: uid, pairedAt: Date.now() };
    check();
    await savePairedDevice(dev);
    saved = true;
    diag('stick saved on this phone');

    // The stick network stays bound: the live link keeps using it. Never wait for it here: setup is
    // done once real data arrived and the stick is saved (the link shows Connected on Home).
    void attachPairedDevice(dev).catch((e) => diag(`live link: ${(e as Error).message}`));

    // Cloud record in the background. The stick network has no internet (and Firestore writes only
    // resolve once the server acknowledges them), so setup never waits for it.
    const meta = { deviceId: dev.deviceId, model: dev.model, firmware: dev.firmware, protocolVersion: dev.protocolVersion, pairedAt: dev.pairedAt, authState: 'none', revokedAt: null };
    void Promise.all([setDoc(doc(fb().db, paths.devices(uid), dev.deviceId), meta), setDoc(doc(fb().db, paths.deviceRegistry(dev.deviceId)), { ownerUid: uid, ...meta })]).catch((e) =>
      diag(`cloud save deferred: ${(e as Error).message}`),
    );
    logEvent({ kind: 'device', severity: 'success', title: 'AI SmartStick set up', detail: `${dev.deviceId}, firmware ${dev.firmware}` });
    set({ step: 'completed' });
  } catch (e) {
    if (e instanceof Abort) return;
    if (saved) {
      // The stick answered with real data and is saved: this is set up. Keep the network and the link.
      diag(`after setup: ${(e as Error).message}`);
      set({ step: 'completed' });
      return;
    }
    const kind = e instanceof SetupError ? e.kind : 'other';
    diag(`error (${kind}): ${(e as Error).message}`);
    set({ step: 'error', errorKind: kind, error: (e as Error).message });
  }
}

/** Sends GET over whatever reaches the stick (binding, Wi-Fi joined by hand, or default route). */
async function get(path: string, timeoutMs: number) {
  // The plugin applies timeoutMs to connect and read; the JS cap guards a call that never settles.
  return withTimeout(AissNative.setupRequest({ method: 'GET', path, timeoutMs }), timeoutMs + 3000, `GET ${path}`);
}

function parseDevice(status: number, body: string): DeviceInfoPacket {
  // A router / captive portal at 192.168.4.1 can answer 403 with a web page: that is "not a stick",
  // never "old firmware" (the firmware's 401 is JSON: {"error":"unauthorized"}).
  if ((status === 401 || status === 403) && looksLikeStick(status, body)) throw new SetupError('old_firmware', OLD_FIRMWARE_SETUP_MESSAGE);
  if (status !== 200) throw new SetupError('not_a_stick', `Something at ${SETUP_AP_HOST} answered HTTP ${status}, but it is not a SmartStick.`);
  let info: DeviceInfoPacket;
  try {
    info = JSON.parse(body) as DeviceInfoPacket;
  } catch {
    throw new SetupError('not_a_stick', `Something at ${SETUP_AP_HOST} answered, but it is not a SmartStick. Make sure the phone is on ${STICK_AP_SSID}.`);
  }
  if (!info || typeof info.deviceId !== 'string' || !info.deviceId) throw new SetupError('not_a_stick', `Something at ${SETUP_AP_HOST} answered, but it is not a SmartStick.`);
  return info;
}

/** Quick check whether the stick is already reachable. Network errors → null (not reachable). */
async function probeOnce(): Promise<DeviceInfoPacket | null> {
  try {
    const r = await get(DEVICE_API.device, 2500);
    const info = parseDevice(r.status, r.body);
    return info;
  } catch (e) {
    if (e instanceof SetupError && e.kind === 'old_firmware') throw e;
    diag(`not on the stick's Wi-Fi yet (${(e as Error).message.slice(0, 80)})`);
    return null;
  }
}

/** GET /device, retried for ~10 s: right after joining, the stick's access point needs a moment. */
async function readDevice(check: () => void): Promise<DeviceInfoPacket> {
  let last = '';
  for (let i = 1; i <= 8; i++) {
    check();
    try {
      const r = await get(DEVICE_API.device, 3000);
      return parseDevice(r.status, r.body);
    } catch (e) {
      if (e instanceof SetupError && (e.kind === 'old_firmware' || e.kind === 'not_a_stick')) throw e;
      last = (e as Error).message;
      diag(`stick not answering yet (try ${i}/8): ${last.slice(0, 100)}`);
    }
    await wait(1200);
  }
  throw new SetupError('no_answer', `The phone joined ${STICK_AP_SSID} but the stick did not answer. Switch the stick off and on, wait 10 seconds, then tap Try again.`);
}

/** One real telemetry packet proves data flows (and catches the old firmware's 401). */
async function readTelemetry(check: () => void): Promise<TelemetryPacket> {
  let last = '';
  for (let i = 1; i <= 4; i++) {
    check();
    try {
      const r = await get(DEVICE_API.telemetry, 3000);
      if ((r.status === 401 || r.status === 403) && looksLikeStick(r.status, r.body)) throw new SetupError('old_firmware', OLD_FIRMWARE_SETUP_MESSAGE);
      if (r.status === 200) {
        let p: TelemetryPacket | null = null;
        try {
          p = JSON.parse(r.body) as TelemetryPacket;
        } catch {
          last = `telemetry is not JSON (${r.body.length} bytes)`;
        }
        if (p && typeof p.seq === 'number') {
          const why = explainPacket(p);
          // Setup still completes (the link is real), but the reason is in the log at once.
          if (why) diag(`warning: the app will reject this telemetry: ${why}`);
          return p;
        }
        if (p) last = 'malformed telemetry (no seq)';
      } else last = `HTTP ${r.status}`;
    } catch (e) {
      if (e instanceof SetupError) throw e;
      last = (e as Error).message;
    }
    diag(`no telemetry yet (try ${i}/4): ${last.slice(0, 100)}`);
    await wait(1000);
  }
  throw new SetupError('no_answer', `The stick answered but sent no sensor data (${last}). Switch it off and on, then tap Try again.`);
}

/** Plain-language reason why Android did not join the stick's Wi-Fi (with an optional scan hint). */
async function joinError(reason?: string): Promise<SetupError> {
  diag(`Android did not join ${STICK_AP_SSID} (${reason ?? 'no reason'})`);
  switch (reason) {
    case 'WIFI_DISABLED':
      return new SetupError('wifi_off', 'Wi-Fi is off. Turn on Wi-Fi, then tap Try again.');
    case 'UNSUPPORTED':
      return new SetupError('unsupported', `On this phone, join the stick by hand: open Wi-Fi settings, choose ${STICK_AP_SSID} (password ${STICK_AP_PASSPHRASE}), come back and tap Try again.`);
    case 'PERMISSION_DENIED':
      return new SetupError('permission', 'Android did not let the app join the stick’s Wi-Fi. Allow Location and Nearby devices for AI SmartStick in App settings, then tap Try again.');
  }
  // UNAVAILABLE / CANCELLED: not found, declined, or timed out. A scan (never required) tells which.
  let seen: boolean | null = null;
  try {
    const { networks } = await withTimeout(AissNative.scanForSetupNetworks({ prefix: STICK_AP_SSID }), 8000, 'Wi-Fi scan');
    const hit = networks.find((n) => n.ssid === STICK_AP_SSID);
    seen = !!hit;
    diag(hit ? `scan: ${STICK_AP_SSID} is visible (${hit.rssi} dBm)` : `scan: ${STICK_AP_SSID} is not visible`);
  } catch (e) {
    diag(`scan unavailable: ${(e as Error).message}`);
  }
  if (seen)
    return new SetupError('not_found', `The phone can see ${STICK_AP_SSID} but did not join it. Tap Try again and choose ${STICK_AP_SSID} → Connect in the Android box.`);
  return new SetupError('not_found', `${STICK_AP_SSID} was not found. Switch the stick on, wait 10 seconds, keep it next to the phone, then tap Try again.`);
}

async function demoProvision(me: number) {
  const steps: ProvStep[] = ['joining', 'stick_found', 'reading_device_info', 'waiting_for_data'];
  for (const s of steps) {
    if (me !== run) return;
    set({ step: s });
    await wait(700);
  }
  if (me !== run) return;
  getMock()?.setLinked(true);
  set({ step: 'completed', deviceId: 'DEMO-4F2A', firmware: '1.2.0-demo' });
}
