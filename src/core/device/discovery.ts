import type { PluginListenerHandle } from '@capacitor/core';
import { DISCOVERY_UDP_PORT, type DiscoveryAnnouncement } from '../../../shared/deviceProtocol';
import { AissNative } from '../native/aissNative';
import { hmacHex, safeEqual } from './crypto';
import type { PairedDevice } from './pairedDevice';

/**
 * Finds the paired stick on the phone's hotspot. The stick broadcasts a signed JSON
 * announcement every 2 s; we accept only announcements signed with our device key.
 */
let handle: PluginListenerHandle | null = null;

export async function verifyAnnouncement(a: DiscoveryAnnouncement, dev: Pick<PairedDevice, 'deviceId' | 'keyB64'>) {
  if (a.v !== 1 || a.deviceId !== dev.deviceId) return false;
  const expect = await hmacHex(dev.keyB64, `${a.deviceId}${a.ip}${a.uptimeMs}`);
  return safeEqual(a.sig, expect);
}

export async function startDiscovery(dev: Pick<PairedDevice, 'deviceId' | 'keyB64'>, onFound: (ip: string) => void) {
  await stopDiscovery();
  handle = await AissNative.addListener('announcement', async ({ json, fromIp }) => {
    try {
      const a = JSON.parse(json) as DiscoveryAnnouncement;
      if (await verifyAnnouncement(a, dev)) onFound(a.ip || fromIp);
    } catch {
      /* not ours / malformed */
    }
  });
  await AissNative.startDiscovery({ port: DISCOVERY_UDP_PORT });
}

export async function stopDiscovery() {
  await handle?.remove();
  handle = null;
  try {
    await AissNative.stopDiscovery();
  } catch {
    /* web */
  }
}
