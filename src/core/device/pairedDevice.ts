import { Preferences } from '@capacitor/preferences';
import { AissNative } from '../native/aissNative';

/**
 * The stick this phone uses. v1 simple link: there is NO secret (joining the stick's Wi-Fi is the
 * pairing), so the record lives in plain storage — Capacitor Preferences, mirrored to localStorage —
 * and never depends on the Android Keystore.
 */
export interface PairedDevice {
  deviceId: string;
  model: string;
  firmware: string;
  protocolVersion: number;
  /** Always 192.168.4.1 (the stick's own access point). Never used as identity. */
  host: string | null;
  ownerUid: string;
  pairedAt: number;
}

const KEY = 'pairedDevice.v1';
const LS_KEY = `aiss.${KEY}`;

/** Accepts current records and the old HMAC-era ones (their keyB64 is dropped). */
export function parsePairedDevice(raw: string | null | undefined): PairedDevice | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<PairedDevice> & { keyB64?: unknown };
    if (!d || typeof d.deviceId !== 'string' || !d.deviceId) return null;
    return {
      deviceId: d.deviceId,
      model: typeof d.model === 'string' ? d.model : '',
      firmware: typeof d.firmware === 'string' ? d.firmware : '',
      protocolVersion: typeof d.protocolVersion === 'number' ? d.protocolVersion : 1,
      host: typeof d.host === 'string' && d.host ? d.host : null,
      ownerUid: typeof d.ownerUid === 'string' ? d.ownerUid : '',
      pairedAt: typeof d.pairedAt === 'number' ? d.pairedAt : 0,
    };
  } catch {
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error('timeout')), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

function lsGet(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
  } catch {
    return null;
  }
}
function lsSet(v: string | null) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (v == null) localStorage.removeItem(LS_KEY);
    else localStorage.setItem(LS_KEY, v);
  } catch {
    /* storage blocked */
  }
}

export async function loadPairedDevice(): Promise<PairedDevice | null> {
  try {
    const { value } = await withTimeout(Preferences.get({ key: KEY }), 3000);
    const d = parsePairedDevice(value);
    if (d) return d;
  } catch {
    /* plugin unavailable: fall through */
  }
  const ls = parsePairedDevice(lsGet());
  if (ls) return ls;
  // One-time migration from the old Keystore store (firmware 1.1 pairing with a key).
  try {
    const { value } = await withTimeout(AissNative.secureGet({ key: KEY }), 3000);
    const legacy = parsePairedDevice(value);
    if (legacy) {
      await savePairedDevice(legacy).catch(() => undefined);
      void AissNative.secureRemove({ key: KEY }).catch(() => undefined);
      return legacy;
    }
  } catch {
    /* no legacy store */
  }
  return null;
}

export async function savePairedDevice(d: PairedDevice) {
  const clean = parsePairedDevice(JSON.stringify(d));
  if (!clean) throw new Error('invalid stick record');
  const value = JSON.stringify(clean);
  lsSet(value);
  try {
    await withTimeout(Preferences.set({ key: KEY, value }), 3000);
  } catch {
    // localStorage already holds it; only throw when neither store took it.
    if (lsGet() !== value) throw new Error('Could not save the stick on this phone');
  }
}

export async function forgetPairedDevice() {
  lsSet(null);
  await withTimeout(Preferences.remove({ key: KEY }), 3000).catch(() => undefined);
  await withTimeout(AissNative.secureRemove({ key: KEY }), 3000).catch(() => undefined);
}
