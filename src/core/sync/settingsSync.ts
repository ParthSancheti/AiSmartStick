import { collection, deleteDoc, doc, getDocs, onSnapshot, setDoc } from 'firebase/firestore';
import type { Contact } from '../types';
import { fb } from '../firebase/app';
import { paths } from '../../../shared/firestoreSchema';
import { useSession, type Settings } from '../store/session';
import { useRelationship } from '../pairing/pairingService';

/**
 * Settings persistence:
 *  - LOCAL (this phone only): theme, glass, reduce motion, text scale, high contrast, IMU calibration.
 *  - FIREBASE users/{uid}/settings/app: voice, language, haptics, earcons, volume, SOS options,
 *    location sharing, camera requests, call/SMS mode, guardian notification prefs, geofence.
 *  - The guardian may edit the stick user's SOS options (settings/safety) when permitted.
 * Cloud → local on change; local → cloud debounced.
 */
const LOCAL_ONLY: (keyof Settings)[] = ['theme', 'glass', 'reduceMotion', 'textScale', 'highContrast', 'screenReaderMode', 'imuCalibration', 'demoTools', 'simSpeed', 'realMic', 'pocketKeepAlive', 'runInBackground'];
// Device-config inputs (obstacleSensitivity, hapticStrength, obstacleVibration, autoSleepMin) ARE synced to the cloud, so a new phone re-applies them to the stick.
const SAFETY_KEYS: (keyof Settings)[] = ['sosTriggers', 'sosCancelSec', 'sosMessage', 'lowBatteryAt'];

let unsubs: (() => void)[] = [];
let applying = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function cloudPart(s: Settings) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) if (!LOCAL_ONLY.includes(k as keyof Settings)) out[k] = v;
  return out;
}

export function startSettingsSync(uid: string) {
  stopSettingsSync();
  const db = fb().db;
  const ref = doc(db, paths.settings(uid, 'app'));
  unsubs.push(
    onSnapshot(ref, (snap) => {
      if (!snap.exists() || snap.metadata.hasPendingWrites) return;
      applying = true;
      useSession.getState().updateSettings(snap.data() as Partial<Settings>);
      applying = false;
    }),
  );
  // Contacts: users/{uid}/contacts (cloud is restored on a new phone; edits write through).
  const contactsCol = collection(db, paths.contacts(uid));
  void getDocs(contactsCol)
    .then((snap) => {
      const cloud = snap.docs.map((d) => d.data() as Contact);
      if (cloud.length && !useSession.getState().contacts.length) useSession.setState({ contacts: cloud });
      prevContacts = JSON.stringify(useSession.getState().contacts);
    })
    .catch(() => undefined);
  let prevContacts = JSON.stringify(useSession.getState().contacts);
  unsubs.push(
    useSession.subscribe((st, old) => {
      const next = JSON.stringify(st.contacts);
      if (next === prevContacts) return;
      prevContacts = next;
      const ids = new Set(st.contacts.map((c) => c.id));
      old.contacts.filter((c) => !ids.has(c.id)).forEach((c) => void deleteDoc(doc(contactsCol, c.id)).catch(() => undefined));
      st.contacts.forEach((c) => void setDoc(doc(contactsCol, c.id), c).catch(() => undefined));
    }),
  );

  let prev = JSON.stringify(cloudPart(useSession.getState().settings));
  unsubs.push(
    useSession.subscribe((s) => {
      if (applying) return;
      const next = JSON.stringify(cloudPart(s.settings));
      if (next === prev) return;
      prev = next;
      clearTimeout(timer);
      timer = setTimeout(() => void setDoc(ref, { ...cloudPart(useSession.getState().settings), updatedAt: Date.now() }, { merge: true }).catch(() => undefined), 1500);
    }),
  );
}

/** Guardian edits the stick user's SOS options (rules require the safetySettings permission). */
export async function writeUserSafetySettings(patch: Partial<Pick<Settings, 'sosTriggers' | 'sosCancelSec' | 'sosMessage' | 'lowBatteryAt'>>) {
  const rel = useRelationship.getState().rel;
  if (!rel) throw new Error('not-paired');
  const clean: Record<string, unknown> = {};
  for (const k of SAFETY_KEYS) if (k in patch) clean[k] = patch[k as keyof typeof patch];
  await setDoc(doc(fb().db, paths.settings(rel.userUid, 'app')), { ...clean, updatedAt: Date.now(), updatedBy: rel.guardianUid }, { merge: true });
}

export function stopSettingsSync() {
  unsubs.forEach((u) => u());
  unsubs = [];
  clearTimeout(timer);
}
