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
      useAuth.setState({ status: 'signedIn', user: { uid: u.uid, displayName: u.displayName, email: u.email, photoURL: u.photoURL }, error: null });
      try {
        const profile = await loadOrCreateProfile(u.uid, u.displayName, u.email, u.photoURL);
        useAuth.setState({ profile, role: profile.role });
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

async function loadOrCreateProfile(uid: string, name: string | null, email: string | null, photo: string | null): Promise<UserDoc> {
  const { db } = fb();
  const ref = doc(db, paths.user(uid));
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const d = snap.data() as UserDoc;
    if (d.displayName !== (name ?? d.displayName) || d.photoURL !== photo) await updateDoc(ref, { displayName: name ?? d.displayName, photoURL: photo, updatedAt: Date.now() });
    return d;
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
  await setDoc(ref, { ...profile, serverCreatedAt: serverTimestamp() });
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

export async function updateProfileFields(p: Partial<Pick<UserDoc, 'phone' | 'displayName' | 'homeAddress' | 'homePlace'>>) {
  const uid = useAuth.getState().user?.uid;
  if (!uid || isDemo()) return;
  await updateDoc(doc(fb().db, paths.user(uid)), { ...p, updatedAt: Date.now() });
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
  const { useSession } = await import('../store/session');
  const { useActivity } = await import('../store/activity');
  const { useAssistant } = await import('../store/assistant');
  useSession.setState({
    userOnboarded: false,
    guardianOnboarded: false,
    linked: false,
    pairingCode: null,
    contacts: [],
    person: { name: '', phone: '', email: '', homeAddress: '', workAddress: '', medicalId: '', savedPlaces: [] },
    guardian: { name: '', email: '', heardAs: '', phone: null },
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
