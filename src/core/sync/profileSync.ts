import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { fb } from '../firebase/app';
import { paths, type UserDoc } from '../../../shared/firestoreSchema';
import { useSession, type Person } from '../store/session';
import { useAuth } from '../auth/authStore';
import { setCustomPhoto, usePhotoCache } from '../profile/photoCache';
import { mergeCloudPhoto, mergeCloudProfile, mirrorNameToAuth, profileCloudPatch } from '../profile/profile';
import { log } from '../log';

/**
 * STICK USER'S PROFILE ⇄ users/{uid}. Name, phone, addresses, saved places and the picked photo.
 *  - cloud → phone: onSnapshot, merged with last-writer-wins timestamps (core/profile/profile.ts);
 *    applying a cloud value never counts as a local edit (no echo loop).
 *  - phone → cloud: debounced merge write, never awaited (offline it waits in Firestore's queue),
 *    flushed when the app goes to the background.
 * Writes only after the user doc exists (it is created at sign-in; a merge-write on a missing doc
 * would be a "create" that the rules reject).
 */
let unsubs: (() => void)[] = [];
let ref: ReturnType<typeof doc> | null = null;
let applying = false;
let docExists = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastSent = '';
/** photoUpdatedAt last seen in the cloud: the ~100 KB photo is only sent when it differs. */
let cloudPhotoAt = 0;

const fieldsKey = (p: Person) => JSON.stringify([p.phone, p.homeAddress, p.workAddress, p.savedPlaces]);

function payload(): Record<string, unknown> {
  const s = useSession.getState();
  const out = profileCloudPatch(s.person, s.profileEditedAt ?? 0);
  const photo = usePhotoCache.getState().custom;
  if (photo?.updatedAt && photo.updatedAt !== cloudPhotoAt) {
    out.photoData = photo.dataUrl;
    out.photoUpdatedAt = photo.updatedAt;
  }
  return out;
}

function flush() {
  clearTimeout(timer);
  timer = undefined;
  if (!ref || !docExists) return;
  const data = payload();
  if (!Object.keys(data).length) return;
  const key = JSON.stringify(data);
  if (key === lastSent) return;
  lastSent = key;
  try {
    void setDoc(ref, { ...data, updatedAt: Date.now() }, { merge: true }).catch((e) => {
      lastSent = '';
      log.warn('profile upload failed', { e: String(e) });
    });
  } catch (e) {
    lastSent = '';
    log.warn('profile upload rejected', { e: String(e) });
  }
}

function schedule(ms = 800) {
  clearTimeout(timer);
  timer = setTimeout(flush, ms);
}

const onHidden = () => {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && timer) flush();
};

export function startProfileSync(uid: string) {
  stopProfileSync();
  ref = doc(fb().db, paths.user(uid));
  const userRef = ref;
  docExists = false;
  lastSent = '';
  cloudPhotoAt = 0;

  unsubs.push(
    onSnapshot(
      userRef,
      (snap) => {
        if (!snap.exists()) return;
        docExists = true;
        if (snap.metadata.hasPendingWrites) return; // our own write, not yet confirmed
        const cloud = snap.data() as Partial<UserDoc>;
        cloudPhotoAt = typeof cloud.photoUpdatedAt === 'number' ? cloud.photoUpdatedAt : 0;
        const st = useSession.getState();
        const auth = useAuth.getState().user;
        const m = mergeCloudProfile({ person: st.person, profileEditedAt: st.profileEditedAt ?? 0 }, cloud, auth?.providerName ?? auth?.displayName ?? null);
        const ph = mergeCloudPhoto(usePhotoCache.getState().custom, cloud);
        applying = true;
        try {
          if (m.person || m.profileEditedAt != null) {
            useSession.setState({ ...(m.person ? { person: m.person } : {}), ...(m.profileEditedAt != null ? { profileEditedAt: m.profileEditedAt } : {}) });
          }
          if (ph.apply) setCustomPhoto(ph.apply.dataUrl, ph.apply.updatedAt);
        } finally {
          applying = false;
        }
        mirrorNameToAuth(useSession.getState().person.name);
        if (m.push || ph.push) schedule(300);
      },
      (e) => log.warn('profile listener failed', { e: String(e) }),
    ),
  );

  unsubs.push(
    useSession.subscribe((s, old) => {
      if (applying || s.person === old.person) return;
      if (s.person.name !== old.person.name) mirrorNameToAuth(s.person.name);
      const fieldsChanged = fieldsKey(s.person) !== fieldsKey(old.person);
      const nameChanged = s.person.nameEditedAt !== old.person.nameEditedAt || (!!s.person.nameEditedAt && s.person.name !== old.person.name);
      if (fieldsChanged) {
        // A real local edit (Settings, home picker, assistant): it is now the newest version.
        applying = true;
        try {
          useSession.setState({ profileEditedAt: Date.now() });
        } finally {
          applying = false;
        }
      }
      if (fieldsChanged || nameChanged) schedule();
    }),
  );

  unsubs.push(
    usePhotoCache.subscribe((s, old) => {
      if (!applying && s.custom !== old.custom) schedule(300);
    }),
  );

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onHidden);
    unsubs.push(() => document.removeEventListener('visibilitychange', onHidden));
  }
}

/** Stops listening. A pending local edit is written first (queued offline), never dropped. */
export function stopProfileSync() {
  if (timer) flush();
  unsubs.forEach((u) => u());
  unsubs = [];
  ref = null;
  docExists = false;
}

/** Tests only. */
export const __profileSyncInternals = { flush, isApplying: () => applying };
