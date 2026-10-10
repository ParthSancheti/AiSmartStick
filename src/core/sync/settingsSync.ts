import { collection, deleteDoc, doc, getDocs, onSnapshot, setDoc, type DocumentReference } from 'firebase/firestore';
import type { Contact } from '../types';
import { fb } from '../firebase/app';
import { paths } from '../../../shared/firestoreSchema';
import { defaultSettings, useSession, type Settings } from '../store/session';
import { useRelationship } from '../pairing/pairingService';
import { useAuth } from '../auth/authStore';
import { startProfileSync, stopProfileSync } from './profileSync';
import { log } from '../log';

/**
 * Settings persistence:
 *  - LOCAL (this phone only): theme, glass, reduce motion, text scale, high contrast, IMU calibration…
 *  - FIREBASE users/{uid}/settings/app: voice, language, haptics, earcons, volume, SOS options,
 *    location sharing, camera requests, call/SMS mode, stick behaviour, guardian notification prefs.
 *  - The guardian may edit the stick user's SOS options when permitted (writeUserSafetySettings).
 *
 * Both ways, last writer wins on `updatedAt`:
 *  - a local change applies instantly, stamps session.settingsEditedAt and is uploaded (debounced,
 *    never awaited: offline it waits in Firestore's queue; flushed when the app is backgrounded);
 *  - a cloud snapshot applies only when it is newer than the last local change, so a late echo of an
 *    older write can never undo what the person just changed, and applying it is not a local edit.
 * Contacts: users/{uid}/contacts (restored on a new phone; edits write through).
 * The stick user's profile (name, photo, places) syncs in ./profileSync.ts (started from here).
 */
export const LOCAL_ONLY: (keyof Settings)[] = ['theme', 'glass', 'reduceMotion', 'textScale', 'highContrast', 'screenReaderMode', 'imuCalibration', 'demoTools', 'simSpeed', 'realMic', 'pocketKeepAlive', 'runInBackground'];
const SAFETY_KEYS: (keyof Settings)[] = ['sosTriggers', 'sosCancelSec', 'sosMessage', 'lowBatteryAt'];

/** Firestore rejects `undefined` (synchronously): send plain JSON only. */
export const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function cloudPart(s: Settings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) if (k in defaultSettings && !LOCAL_ONLY.includes(k as keyof Settings)) out[k] = v;
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Only known, cloud-synced keys with the right type; nested objects completed with defaults. */
export function sanitizeCloudSettings(cloud: Record<string, unknown>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cloud)) {
    if (!(k in defaultSettings) || LOCAL_ONLY.includes(k as keyof Settings)) continue;
    const def = defaultSettings[k as keyof Settings] as unknown;
    if (isObj(def)) {
      if (isObj(v)) out[k] = { ...def, ...v };
    } else if (typeof v === typeof def) {
      out[k] = v;
    }
  }
  return out as Partial<Settings>;
}

export interface SettingsDecision {
  /** Cloud values to apply locally (null: keep local). */
  apply: Partial<Settings> | null;
  /** New session.settingsEditedAt when cloud values were taken. */
  editedAt: number | null;
  /** Local is newer (or the cloud has no copy): upload. */
  push: boolean;
}

/** Pure LWW decision for one cloud snapshot of settings/app (tested). */
export function decideSettings(local: Settings, localEditedAt: number, cloud: Record<string, unknown> | undefined): SettingsDecision {
  if (!cloud) return { apply: null, editedAt: null, push: true };
  const cloudAt = typeof cloud.updatedAt === 'number' ? cloud.updatedAt : 0;
  const clean = sanitizeCloudSettings(cloud);
  const differs = Object.entries(clean).some(([k, v]) => JSON.stringify(v) !== JSON.stringify(local[k as keyof Settings]));
  if (localEditedAt > cloudAt) {
    const missing = Object.keys(cloudPart(local)).some((k) => !(k in clean));
    return { apply: null, editedAt: null, push: differs || missing };
  }
  return { apply: differs ? clean : null, editedAt: cloudAt, push: false };
}

let unsubs: (() => void)[] = [];
let applying = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let settingsRef: DocumentReference | null = null;
let lastSent = '';

function flushSettings() {
  clearTimeout(timer);
  timer = undefined;
  if (!settingsRef) return;
  const s = useSession.getState();
  const data = plain(cloudPart(s.settings));
  const key = JSON.stringify(data);
  if (key === lastSent) return;
  lastSent = key;
  try {
    void setDoc(settingsRef, { ...data, updatedAt: s.settingsEditedAt || Date.now() }, { merge: true }).catch((e) => {
      lastSent = '';
      log.warn('settings upload failed', { e: String(e) });
    });
  } catch (e) {
    lastSent = '';
    log.warn('settings upload rejected', { e: String(e) });
  }
}

function scheduleSettings(ms = 1000) {
  clearTimeout(timer);
  timer = setTimeout(flushSettings, ms);
}

const onHidden = () => {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && timer) flushSettings();
};

function safeWrite(fn: () => Promise<unknown>) {
  try {
    void fn().catch((e) => log.warn('contact sync failed', { e: String(e) }));
  } catch (e) {
    log.warn('contact sync rejected', { e: String(e) });
  }
}

const isUserApp = () => (useAuth.getState().role ?? useSession.getState().entryRole) !== 'guardian';

export function startSettingsSync(uid: string) {
  stopSettingsSync();
  const db = fb().db;
  const ref = doc(db, paths.settings(uid, 'app'));
  settingsRef = ref;
  lastSent = '';

  unsubs.push(
    onSnapshot(
      ref,
      (snap) => {
        if (snap.metadata.hasPendingWrites) return; // our own write, not yet confirmed
        // A missing doc in the offline cache says nothing about the server: wait for the server.
        if (!snap.exists() && snap.metadata.fromCache) return;
        const st = useSession.getState();
        const d = decideSettings(st.settings, st.settingsEditedAt ?? 0, snap.exists() ? (snap.data() as Record<string, unknown>) : undefined);
        if (d.apply || d.editedAt != null) {
          applying = true;
          try {
            useSession.setState((s) => ({ ...(d.apply ? { settings: { ...s.settings, ...d.apply } } : {}), ...(d.editedAt != null ? { settingsEditedAt: d.editedAt } : {}) }));
          } finally {
            applying = false;
          }
        }
        if (d.push) scheduleSettings(300);
      },
      (e) => log.warn('settings listener failed', { e: String(e) }),
    ),
  );

  // Contacts: users/{uid}/contacts (cloud is restored on a new phone; edits write through).
  const contactsCol = collection(db, paths.contacts(uid));
  let prevContacts = JSON.stringify(useSession.getState().contacts);
  let restoring = false;
  void getDocs(contactsCol)
    .then((snap) => {
      if (!settingsRef) return; // stopped meanwhile (signed out)
      const cloud = snap.docs.map((d) => d.data() as Contact).filter((c) => c && typeof c.id === 'string' && typeof c.phone === 'string');
      if (cloud.length && !useSession.getState().contacts.length) {
        restoring = true;
        try {
          useSession.setState({ contacts: cloud.map((c) => ({ id: c.id, name: c.name ?? '', relation: c.relation ?? '', phone: c.phone, aliases: Array.isArray(c.aliases) ? c.aliases : [] })) });
        } finally {
          restoring = false;
        }
      }
      prevContacts = JSON.stringify(useSession.getState().contacts);
    })
    .catch(() => undefined);
  unsubs.push(
    useSession.subscribe((st, old) => {
      if (st.contacts === old.contacts) return;
      const next = JSON.stringify(st.contacts);
      if (next === prevContacts) return;
      prevContacts = next;
      if (restoring) return; // just came from the cloud
      const ids = new Set(st.contacts.map((c) => c.id));
      old.contacts.filter((c) => !ids.has(c.id)).forEach((c) => safeWrite(() => deleteDoc(doc(contactsCol, c.id))));
      st.contacts.forEach((c) => safeWrite(() => setDoc(doc(contactsCol, c.id), plain(c))));
    }),
  );

  let prev = JSON.stringify(cloudPart(useSession.getState().settings));
  unsubs.push(
    useSession.subscribe((s, old) => {
      if (s.settings === old.settings) return;
      const next = JSON.stringify(cloudPart(s.settings));
      if (next === prev) return;
      prev = next;
      if (applying) return; // came from the cloud: not a local edit
      applying = true;
      try {
        useSession.setState({ settingsEditedAt: Date.now() });
      } finally {
        applying = false;
      }
      scheduleSettings();
    }),
  );

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onHidden);
    unsubs.push(() => document.removeEventListener('visibilitychange', onHidden));
  }

  // The stick user's own profile (name, photo, phone, places). A guardian phone's session.person is
  // the person they look after, so it is never uploaded as the guardian's profile.
  if (isUserApp()) startProfileSync(uid);
}

/** Guardian edits the stick user's SOS options (rules require the safetySettings permission). */
export async function writeUserSafetySettings(patch: Partial<Pick<Settings, 'sosTriggers' | 'sosCancelSec' | 'sosMessage' | 'lowBatteryAt'>>) {
  const rel = useRelationship.getState().rel;
  if (!rel) throw new Error('not-paired');
  const clean: Record<string, unknown> = {};
  for (const k of SAFETY_KEYS) if (k in patch) clean[k] = patch[k as keyof typeof patch];
  await setDoc(doc(fb().db, paths.settings(rel.userUid, 'app')), { ...plain(clean), updatedAt: Date.now(), updatedBy: rel.guardianUid }, { merge: true });
}

/** Stops all account sync. A pending local change is written first (queued offline), never dropped. */
export function stopSettingsSync() {
  if (timer) flushSettings();
  unsubs.forEach((u) => u());
  unsubs = [];
  clearTimeout(timer);
  timer = undefined;
  settingsRef = null;
  stopProfileSync();
}
