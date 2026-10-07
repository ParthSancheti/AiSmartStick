import { Capacitor } from '@capacitor/core';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';
import { GoogleAuthProvider, onAuthStateChanged, signInWithCredential, signInWithPopup, signOut as fbSignOut } from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { fb, FirebaseNotConfigured } from '../firebase/app';
import { paths, type AccountRole, type UserDoc } from '../../../shared/firestoreSchema';
import { useAuth } from './authStore';
import { friendlyError } from '../errors';
import { isDemo } from '../runtime/mode';

/**
 * Google sign-in → real Firebase Auth state. On Android the native Google flow returns an ID
 * token which signs in the web SDK (capacitor.config: skipNativeAuth = true), so Firestore,
 * Functions and App Check all see the same user.
 */
export function startAuth(onSignedIn: (uid: string) => void, onSignedOut: () => void) {
  if (isDemo()) {
    useAuth.setState({ status: 'signedIn', user: { uid: 'demo-user', displayName: 'Demo user', email: null, photoURL: null }, role: null, profile: null });
    onSignedIn('demo-user');
    return () => {};
  }
  let unsub = () => {};
  try {
    const { auth } = fb();
    unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        useAuth.setState({ status: 'signedOut', user: null, role: null, profile: null });
        onSignedOut();
        return;
      }
      useAuth.setState({ status: 'signedIn', user: { uid: u.uid, displayName: u.displayName, email: u.email, photoURL: u.photoURL, providerName: u.displayName }, error: null });
      try {
        const profile = await loadOrCreateProfile(u.uid, u.displayName, u.email, u.photoURL);
        const cur = useAuth.getState().user;
        // The account's name is the one in the user doc (the person may have typed their own).
        useAuth.setState({ profile, role: profile.role, user: cur && profile.displayName ? { ...cur, displayName: profile.displayName } : cur });
      } catch (e) {
        useAuth.setState({ error: friendlyError(e, 'Your profile could not be loaded. Please try again.') });
      }
      onSignedIn(u.uid);
    });
  } catch (e) {
    useAuth.setState({ status: e instanceof FirebaseNotConfigured ? 'unconfigured' : 'error', error: (e as Error).message });
  }
  return unsub;
}

/** Role comes from the initial role selection. */
export function roleForThisApp(fallback: AccountRole): AccountRole {
  return fallback;
}

/**
 * Existing account: keeps the Google photo URL current; the Google NAME only fills displayName while
 * the person never typed their own (nameEditedAt), so an edited name is never overwritten.
 */
export function profileUpdateOnSignIn(d: Pick<UserDoc, 'displayName' | 'photoURL' | 'nameEditedAt'>, googleName: string | null, googlePhoto: string | null): Partial<UserDoc> {
  const patch: Partial<UserDoc> = {};
  if (!d.nameEditedAt && googleName && d.displayName !== googleName) patch.displayName = googleName;
  if ((d.photoURL ?? null) !== (googlePhoto ?? null)) patch.photoURL = googlePhoto;
  return patch;
}

async function loadOrCreateProfile(uid: string, name: string | null, email: string | null, photo: string | null): Promise<UserDoc> {
  const { db } = fb();
  const ref = doc(db, paths.user(uid));
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const d = snap.data() as UserDoc;
    const patch = profileUpdateOnSignIn(d, name, photo);
    // Not awaited: offline, the write only settles when the server acknowledges it, and sign-in
    // (which starts the stick link, GPS and SOS) must never wait on that.
    if (Object.keys(patch).length) void updateDoc(ref, { ...patch, updatedAt: Date.now() }).catch(() => undefined);
    return { ...d, ...patch };
  }
  const pending = useAuth.getState().role;
  const profile: UserDoc = {
    uid,
    role: roleForThisApp(pending ?? 'user'),
    displayName: name ?? '',
    photoURL: photo,
    email,
    phone: null,
    guardianRelationshipId: null,
    watchesUserUid: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  void setDoc(ref, { ...profile, serverCreatedAt: serverTimestamp() }).catch(() => undefined);
  return profile;
}

export async function signInWithGoogle(intendedRole: AccountRole) {
  useAuth.setState({ busy: true, error: null, role: roleForThisApp(intendedRole) });
  try {
    const { auth } = fb();
    if (Capacitor.isNativePlatform()) {
      const r = await FirebaseAuthentication.signInWithGoogle();
      const idToken = r.credential?.idToken;
      if (!idToken) throw new Error('Google sign-in did not return an ID token');
      await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
    } else {
      await signInWithPopup(auth, new GoogleAuthProvider());
    }
  } catch (e) {
    const msg = (e as Error).message ?? 'Sign-in failed';
    useAuth.setState({ error: /cancel|closed/i.test(msg) ? 'Sign-in was cancelled.' : friendlyError(e, 'Google sign-in did not work. Please try again.') });
    throw e;
  } finally {
    useAuth.setState({ busy: false });
  }
}

export async function signOut() {
  if (isDemo()) return;
  const { auth } = fb();
  if (Capacitor.isNativePlatform()) await FirebaseAuthentication.signOut().catch(() => undefined);
  await fbSignOut(auth);
}

/**
 * Direct write of profile fields to users/{uid}. Returns at once (never waits for the server: offline
 * that would hang the screen); Firestore queues it. Screens normally just change useSession.person —
 * core/sync/profileSync.ts uploads it — this stays for callers that want an immediate cloud copy.
 */
export async function updateProfileFields(p: Partial<Pick<UserDoc, 'phone' | 'displayName' | 'homeAddress' | 'homePlace'>>) {
  const uid = useAuth.getState().user?.uid;
  if (!uid || isDemo()) return;
  const clean = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  if (typeof clean.displayName === 'string') clean.nameEditedAt = Date.now();
  try {
    void updateDoc(doc(fb().db, paths.user(uid)), { ...clean, updatedAt: Date.now() }).catch(() => undefined);
  } catch {
    /* not configured / invalid data: the local copy still holds it and profileSync retries */
  }
}

/** Permanently delete this account and its data (server-side), then clear this phone. */
export async function deleteAccount() {
  if (isDemo()) return;
  const { call } = await import('../backend/api');
  await call<Record<string, never>, { ok: boolean }>('deleteAccount', {}, 60000);
  await clearLocalAccountData();
  await signOut().catch(() => undefined);
}

/** Remove everything this phone cached for the signed-in account (used on sign-out and deletion). */
export async function clearLocalAccountData() {
  // Sync must stop FIRST: otherwise clearing the phone would be uploaded as "the person deleted
  // their name, places and contacts".
  const { stopSettingsSync, LOCAL_ONLY } = await import('../sync/settingsSync');
  stopSettingsSync();
  const { useSession, defaultSettings, emptyPerson } = await import('../store/session');
  const { useActivity } = await import('../store/activity');
  const { useAssistant } = await import('../store/assistant');
  // Account settings go back to defaults; this phone's own display preferences (theme, text size…) stay.
  const cur = useSession.getState().settings;
  const keep = Object.fromEntries(LOCAL_ONLY.map((k) => [k, cur[k]]));
  useSession.setState({
    userOnboarded: false,
    guardianOnboarded: false,
    linked: false,
    pairingCode: null,
    contacts: [],
    person: emptyPerson(),
    guardian: { name: '', email: '', heardAs: '', phone: null },
    settings: { ...defaultSettings, demoTools: false, ...keep },
    profileEditedAt: undefined,
    settingsEditedAt: undefined,
  });
  useActivity.setState({ events: [] });
  useAssistant.setState({ thread: [], conversationId: null });
  // A different account on this phone starts at sign-in, with nothing of the previous one.
  useSession.setState({ onboardingStep: 'signin' });
  const { clearProfilePhoto } = await import('../profile/photoCache');
  clearProfilePhoto();
  try {
    localStorage.removeItem('aiss.nav.active.v1');
  } catch {
    /* ignore */
  }
}
