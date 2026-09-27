import { AissNative } from '../native/aissNative';

/** The stick this phone is paired with. The key never leaves the phone (and never goes to Firebase). */
export interface PairedDevice {
  deviceId: string;
  model: string;
  firmware: string;
  protocolVersion: number;
  keyB64: string;
  /** Last IP seen on the hotspot; refreshed by discovery. Never used as identity. */
  host: string | null;
  ownerUid: string;
  pairedAt: number;
}

const KEY = 'pairedDevice.v1';

export async function loadPairedDevice(): Promise<PairedDevice | null> {
  try {
    const { value } = await AissNative.secureGet({ key: KEY });
    if (!value) return null;
    const d = JSON.parse(value) as PairedDevice;
    return d.deviceId && d.keyB64 ? d : null;
  } catch {
    return null;
  }
}

export async function savePairedDevice(d: PairedDevice) {
  await AissNative.secureSet({ key: KEY, value: JSON.stringify(d) });
}

export async function forgetPairedDevice() {
  await AissNative.secureRemove({ key: KEY });
}
