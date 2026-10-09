import type { PluginListenerHandle } from '@capacitor/core';
import { DISCOVERY_UDP_PORT, type DiscoveryAnnouncement } from '../../../shared/deviceProtocol';
import { AissNative } from '../native/aissNative';
import { hmacHex, safeEqual } from './crypto';

/**
 * LEGACY (station-mode firmware with a device key): finds the stick on a phone hotspot from its
 * signed UDP announcement. The v1 simple link does not use it — the stick is always its own access
 * point at 192.168.4.1 — but stopDiscovery() is still called to clean up older sessions.
 */
export interface SignedStick {
  deviceId: string;
  keyB64: string;
}
let handle: PluginListenerHandle | null = null;

export async function verifyAnnouncement(a: DiscoveryAnnouncement, dev: SignedStick) {
  if (a.v !== 1 || a.deviceId !== dev.deviceId) return false;
  const expect = await hmacHex(dev.keyB64, `${a.deviceId}${a.ip}${a.uptimeMs}`);
  return safeEqual(a.sig, expect);
}

export async function startDiscovery(dev: SignedStick, onFound: (ip: string) => void) {
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
