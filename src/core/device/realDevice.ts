import { Capacitor } from '@capacitor/core';
import { useDevice } from '../store/device';
import { HttpTransport } from '../transport/httpTransport';
import { LegacyTransport } from '../transport/legacyTransport';
import { connectStick, disconnectStick } from './bridge';
import { stopDiscovery } from './discovery';
import { deleteDoc, doc, updateDoc } from 'firebase/firestore';
import { fb } from '../firebase/app';
import { paths } from '../../../shared/firestoreSchema';
import { SETUP_AP_HOST } from '../../../shared/deviceProtocol';
import { currentUid } from '../auth/authStore';
import { AissNative } from '../native/aissNative';
import { forgetPairedDevice, loadPairedDevice, savePairedDevice, type PairedDevice } from './pairedDevice';

/**
 * REAL MODE device lifecycle (v1 simple link): load the saved stick, reach its Wi-Fi
 * (SmartStick_AI, 192.168.4.1) and poll it with HttpTransport. No keys, no discovery.
 * Runs at boot whenever a stick record exists (also records saved by the old secure pairing).
 */
export async function startRealDevice() {
  if (!Capacitor.isNativePlatform()) {
    useDevice.setState({ link: 'unpaired', linkDetail: 'The stick connects only in the Android app' });
    return;
  }
  const loaded = await loadPairedDevice();
  // A stick set up by a different account on this phone is not used (and never shown as connected).
  const uid = currentUid();
  const dev = loaded && (!loaded.ownerUid || !uid || loaded.ownerUid === uid) ? loaded : null;
  if (!dev) {
    useDevice.setState({ link: 'unpaired', linkDetail: null });
    return;
  }
  await attachPairedDevice(dev);
}

export async function attachPairedDevice(dev: PairedDevice) {
  // Stop a leftover UDP listener from older app versions; the AP address is fixed.
  await stopDiscovery().catch(() => undefined);
  useDevice.setState({ link: 'searching', linkDetail: null, identity: { deviceId: dev.deviceId, model: dev.model, firmware: dev.firmware, protocolVersion: dev.protocolVersion } });
  const t = new HttpTransport({ ...dev, host: dev.host ?? SETUP_AP_HOST });
  let saved = dev;
  // Keep the record in step with the stick that really answers (e.g. after flashing new firmware).
  t.on('identity', (id) => {
    if (id.deviceId === saved.deviceId && id.firmware === saved.firmware && id.model === saved.model && id.protocolVersion === saved.protocolVersion) return;
    saved = { ...saved, ...id };
    void savePairedDevice(saved).catch(() => undefined);
  });
  await connectStick(t);
}

/**
 * Forget the stick on this phone. Nothing to reset on the stick (v1 has no keys): any phone that
 * joins SmartStick_AI can use it again with "Set up SmartStick".
 */
export async function unpairStick() {
  const id = useDevice.getState().identity?.deviceId;
  const uid = currentUid();
  await stopDiscovery().catch(() => undefined);
  disconnectStick();
  await forgetPairedDevice();
  await AissNative.releaseSetupNetwork().catch(() => undefined);
  if (id && uid) {
    // Not awaited: offline, Firestore writes only settle when the server acknowledges them.
    void Promise.all([deleteDoc(doc(fb().db, paths.deviceRegistry(id))), updateDoc(doc(fb().db, paths.devices(uid), id), { authState: 'revoked', revokedAt: Date.now() })]).catch(() => undefined);
  }
  useDevice.setState({ link: 'unpaired', identity: null, linkDetail: null });
}

/** Same as unpairStick, with the v1 wording ("Forget stick"). */
export const forgetStick = unpairStick;

/** Diagnostics only: connect to the old test firmware by IP (unauthenticated, clearly labelled). */
export async function connectLegacyTestFirmware(host: string) {
  await stopDiscovery();
  await connectStick(new LegacyTransport(host));
}
