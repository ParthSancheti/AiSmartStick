import { Capacitor } from '@capacitor/core';
import { useDevice } from '../store/device';
import { HttpTransport } from '../transport/httpTransport';
import { LegacyTransport } from '../transport/legacyTransport';
import { connectStick, disconnectStick, getTransport } from './bridge';
import { startDiscovery, stopDiscovery } from './discovery';
import { deleteDoc, doc, updateDoc } from 'firebase/firestore';
import { fb } from '../firebase/app';
import { paths } from '../../../shared/firestoreSchema';
import { currentUid } from '../auth/authStore';
import { forgetPairedDevice, loadPairedDevice, savePairedDevice, type PairedDevice } from './pairedDevice';

/**
 * REAL MODE device lifecycle: load the paired stick, listen for its signed announcement
 * on the hotspot, connect with HttpTransport, re-authenticate whenever its address changes.
 */
export async function startRealDevice() {
  if (!Capacitor.isNativePlatform()) {
    useDevice.setState({ link: 'unpaired', linkDetail: 'The stick connects only in the Android app' });
    return;
  }
  const loaded = await loadPairedDevice();
  // A stick paired by a different account on this phone is not used (and never shown as connected).
  const dev = loaded && loaded.ownerUid === currentUid() ? loaded : null;
  if (!dev) {
    useDevice.setState({ link: 'unpaired', linkDetail: null });
    return;
  }
  await attachPairedDevice(dev);
}

export async function attachPairedDevice(dev: PairedDevice) {
  useDevice.setState({ link: 'searching', identity: { deviceId: dev.deviceId, model: dev.model, firmware: dev.firmware, protocolVersion: dev.protocolVersion } });
  const t = new HttpTransport(dev);
  await connectStick(t);
  let savedHost = dev.host;
  // UDP discovery only matters for firmware that joins another network; the AP address is fixed.
  await startDiscovery(dev, (ip) => {
    const cur = getTransport();
    if (cur instanceof HttpTransport) cur.setHost(ip);
    if (ip !== savedHost) {
      savedHost = ip;
      void savePairedDevice({ ...dev, host: ip }).catch(() => undefined);
    }
  }).catch(() => undefined);
}

/** Unpair: forget the key locally. The stick must be factory-reset (hold its button while switching it on, about 10 s, until it buzzes) to accept a new owner. */
export async function unpairStick() {
  const id = useDevice.getState().identity?.deviceId;
  const uid = currentUid();
  await stopDiscovery();
  disconnectStick();
  await forgetPairedDevice();
  // Release ownership so the stick (after a factory reset) can be paired by anyone again.
  if (id && uid) {
    // Not awaited: offline, Firestore writes only settle when the server acknowledges them.
    void Promise.all([deleteDoc(doc(fb().db, paths.deviceRegistry(id))), updateDoc(doc(fb().db, paths.devices(uid), id), { authState: 'revoked', revokedAt: Date.now() })]).catch(() => undefined);
  }
  useDevice.setState({ link: 'unpaired', identity: null, linkDetail: null });
}

/** Diagnostics only: connect to the old test firmware by IP (unauthenticated, clearly labelled). */
export async function connectLegacyTestFirmware(host: string) {
  await stopDiscovery();
  await connectStick(new LegacyTransport(host));
}
