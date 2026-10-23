import { Capacitor } from '@capacitor/core';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';
import { GoogleAuthProvider, onAuthStateChanged, signInWithCredential, signInWithPopup, signOut as fbSignOut, type Auth, type User } from 'firebase/auth';
import { doc, getDocFromCache, getDocFromServer, runTransaction, serverTimestamp, updateDoc } from 'firebase/firestore';
import { fb, FirebaseNotConfigured } from '../firebase/app';
import { paths, type AccountRole, type UserDoc } from '../../../shared/firestoreSchema';
import { useAuth } from './authStore';
import { friendlyError } from '../errors';
import { isDemo } from '../runtime/mode';
import { appRole, accountMatchesApp, BUILD_ROLE } from '../runtime/appRole';

const CACHE_OWNER_KEY = 'aiss.account.cacheOwner.v1';
const VERIFIED_ROLE_KEY = 'aiss.account.verifiedRole.v1';
let localClear: Promise<void> = Promise.resolve();
let interactiveSignIn: Promise<void> | null = null;
let signInGeneration = 0;
let cancelInteractiveSignIn: (() => void) | null = null;
let resolveAccount: ((user: User) => Promise<void>) | null = null;
let cancelAccountResolution: (() => void) | null = null;
let intendedSignInRole: AccountRole | null = null;
let credentialExchange: { generation: number } | null = null;
let credentialBarrier: Promise<void> = Promise.resolve();

function invalidateInteractiveSignIn() {
  signInGeneration++;
  cancelInteractiveSignIn?.();
  cancelInteractiveSignIn = null;
}
/** Firebase credential calls cannot be aborted; discard their late identity before another starts. */
function exchangeCredential(auth: Auth, generation: number, exchange: () => Promise<unknown>): Promise<void> {
  const exchangeState = { generation };
  credentialExchange = exchangeState;
  const pending = (async () => {
    try {
      await exchange();
    } finally {
      try {
        if (generation !== signInGeneration) await fbSignOut(auth);
      } finally {
        if (credentialExchange === exchangeState) credentialExchange = null;
      }
    }
  })();
  credentialBarrier = pending.catch(() => undefined);
  return pending;
}
function rememberedRole(uid: string): AccountRole | null {
  try {
    const remembered = JSON.parse(localStorage.getItem(VERIFIED_ROLE_KEY) ?? 'null');
    return remembered?.uid === uid && (remembered.role === 'user' || remembered.role === 'guardian') ? remembered.role : null;
  } catch { return null; }
}
function rememberVerifiedRole(uid: string, role: AccountRole) {
  try { localStorage.setItem(VERIFIED_ROLE_KEY, JSON.stringify({ uid, role })); } catch { /* the acknowledged Firestore cache still works */ }
}

/** A lost server connection must lead to an explicit retry, never an endless sign-in screen. */
export const AUTH_PROFILE_TIMEOUT_MS = 12_000;
function profileDeadline<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Your account could not be verified in time. Check your internet connection, then retry account setup.')), AUTH_PROFILE_TIMEOUT_MS);
    operation.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
const cachedAccount = () => {
  try {
    const owner = localStorage.getItem(CACHE_OWNER_KEY);
    if (owner) return owner;
    // Existing installs already remembered the avatar's account before this ownership key
    // existed. Read it before publishing the next identity to React's avatar effect.
    const legacy = JSON.parse(localStorage.getItem('aiss.profilePhoto.account.v1') ?? 'null');
    return typeof legacy?.uid === 'string' && legacy.uid ? legacy.uid : null;
  } catch { return null; }
};
const rememberAccount = (uid: string | null) => {
  try {
    if (uid) localStorage.setItem(CACHE_OWNER_KEY, uid);
    else localStorage.removeItem(CACHE_OWNER_KEY);
  } catch { /* Storage can be unavailable; the active UID still isolates this process. */ }
};

/**
 * Google sign-in → real Firebase Auth state. On Android the native Google flow returns an ID
 * token which signs in the web SDK (capacitor.config: skipNativeAuth = true), so Firestore,
 * Functions and App Check all see the same user.
 */
export function startAuth(onSignedIn: (uid: string) => void, onSignedOut: () => void, onUid?: (uid: string) => void) {
  if (isDemo()) {
    useAuth.setState({ status: 'signedIn', user: { uid: 'demo-user', displayName: 'Demo user', email: null, photoURL: null }, role: null, profile: null, busy: false, phase: null });
    onSignedIn('demo-user');
    return () => {};
  }
  let unsub = () => {};
  let generation = 0;
  let activeUid: string | null = null;
  let resolving: { uid: string; promise: Promise<void> } | null = null;
  let ownedResolver: typeof resolveAccount = null;
  try {
    const { auth } = fb();
    const resolveUser = (u: User): Promise<void> => {
      if (resolving?.uid === u.uid) return resolving.promise;
      if (activeUid === u.uid && useAuth.getState().status === 'signedIn') return Promise.resolve();
      const request = ++generation;
      const intendedRole = intendedSignInRole ?? useAuth.getState().role;
      const changedAccount = !!activeUid && activeUid !== u.uid;
      if (changedAccount) { activeUid = null; onSignedOut(); }
      useAuth.setState({ status: 'loading', busy: true, phase: 'profile', role: null, profile: null, error: null });
      const current = () => request === generation && auth.currentUser?.uid === u.uid;
      const run = async () => {
        try {
          // Boot may already have queued a clear for the preceding sign-out. Finish it before
          // the new account can restore or upload any profile, contacts or settings.
          await localClear;
          if (!current()) return;
          const owner = cachedAccount();
          if (changedAccount || (owner && owner !== u.uid)) await clearLocalAccountData();
          if (!current()) return;
        } catch (e) {
          if (!current()) return;
          useAuth.setState({ status: 'error', busy: false, phase: null, error: friendlyError(e, 'The previous account could not be cleared. Please restart the app.') });
          return;
        }
        // Identity alone does not authorize user/Guardian services. Wait for the account role.
        useAuth.setState({ status: 'loading', role: null, profile: null, user: { uid: u.uid, displayName: u.displayName, email: u.email, photoURL: u.photoURL, providerName: u.displayName }, error: null });
        try {
          onUid?.(u.uid);
        } catch {
          /* never blocks sign-in */
        }
        try {
          const profile = await profileDeadline(loadOrCreateProfile(u.uid, u.displayName, u.email, u.photoURL, intendedRole, current));
          if (!current()) return;
          if (!accountMatchesApp(profile.role)) {
            activeUid = null;
            useAuth.setState({ status: 'error', busy: false, phase: null, profile, role: profile.role,
              error: `This account is registered as ${profile.role === 'guardian' ? 'a guardian' : 'a stick user'}. Open the ${profile.role === 'guardian' ? 'Guardian' : 'SmartStick user'} app, or sign in with a separate ${BUILD_ROLE} account.` });
            onSignedOut();
            return;
          }
          const cur = useAuth.getState().user;
          // Legacy installs had no cache owner. Adopt their first verified account so an update
          // preserves the current account's local data; later switches also work across restarts.
          rememberAccount(u.uid);
        rememberVerifiedRole(u.uid, profile.role);
          // The account's name is the one in the user doc (the person may have typed their own).
          useAuth.setState({ status: 'signedIn', busy: false, phase: null, profile, role: profile.role, user: cur && profile.displayName ? { ...cur, displayName: profile.displayName } : cur });
        } catch (e) {
          if (!current()) return;
          generation++; // Also invalidate a timed-out Firestore operation that may finish later.
          useAuth.setState({ status: 'error', busy: false, phase: null, error: friendlyError(e, 'Your profile could not be loaded. Check your connection, then retry account setup.') });
          activeUid = null;
          onSignedOut();
          return;
        }
        if (request === generation) { activeUid = u.uid; onSignedIn(u.uid); }
      };
      const promise = run().finally(() => { if (resolving?.promise === promise) resolving = null; });
      resolving = { uid: u.uid, promise };
      return promise;
    };
    ownedResolver = resolveUser;
    resolveAccount = resolveUser;
    cancelAccountResolution = () => { generation++; resolving = null; };
    unsub = onAuthStateChanged(auth, async (u) => {
      if (u && credentialExchange && credentialExchange.generation !== signInGeneration) return;
      if (u) return resolveUser(u);
      generation++;
      resolving = null;
      activeUid = null;
      const signing = !!interactiveSignIn && !!cancelInteractiveSignIn;
      useAuth.setState({ status: 'signedOut', user: null, role: null, profile: null, error: null, busy: signing, phase: signing ? 'google' : null });
      onSignedOut();
    });
  } catch (e) {
    useAuth.setState({ status: e instanceof FirebaseNotConfigured ? 'unconfigured' : 'error', busy: false, phase: null, error: (e as Error).message });
  }
  return () => {
    generation++;
    if (resolveAccount === ownedResolver) {
      invalidateInteractiveSignIn();
      useAuth.setState({ busy: false, phase: null });
      resolveAccount = null;
      cancelAccountResolution = null;
    }
    unsub();
  };
}

/** Role comes from the initial role selection. */
export function roleForThisApp(fallback: AccountRole): AccountRole {
  return appRole(fallback);
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

async function loadOrCreateProfile(uid: string, name: string | null, email: string | null, photo: string | null, intendedRole: AccountRole | null, current: () => boolean): Promise<UserDoc> {
  const { db } = fb();
  const ref = doc(db, paths.user(uid));
  const checkedProfile = (data: unknown): UserDoc => {
    const d = data as UserDoc;
    if (!d || (d.role !== 'user' && d.role !== 'guardian') || (d.uid && d.uid !== uid)) throw new Error('Your account role could not be verified. Please contact support.');
    return d;
  };
  const existingProfile = (data: unknown): UserDoc => {
    const d = checkedProfile(data);
    const patch = profileUpdateOnSignIn(d, name, photo);
    // Not awaited: offline, the write only settles when the server acknowledges it, and sign-in
    // (which starts the stick link, GPS and SOS) must never wait on that.
    if (current() && Object.keys(patch).length) void updateDoc(ref, { ...patch, updatedAt: Date.now() }).catch(() => undefined);
    return { ...d, ...patch };
  };
  // Account roles are immutable. Acknowledged cache may restore offline; queued mutable edits
  // also may restore if this exact UID and role were previously verified. A queued first
  // registration has no verified role record and must still wait for server acknowledgement.
  try {
    const cached = await getDocFromCache(ref);
    if (cached.exists()) {
      const d = checkedProfile(cached.data());
      if (!cached.metadata.hasPendingWrites || rememberedRole(uid) === d.role) return existingProfile(d);
    }
  } catch { /* no usable cache: verify with the server below */ }
  const snap = await getDocFromServer(ref);
  if (!current()) throw new Error('The signed-in account changed.');
  if (snap.exists()) return existingProfile(snap.data());
  const profile: UserDoc = {
    uid,
    role: roleForThisApp(intendedRole ?? 'user'),
    displayName: name ?? '',
    photoURL: photo,
    email,
    phone: null,
    guardianRelationshipId: null,
    watchesUserUid: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  // Registration is acknowledged and atomic. Another app may have created the role after our read.
  return runTransaction(db, async (transaction) => {
    const latest = await transaction.get(ref);
    if (!current()) throw new Error('The signed-in account changed.');
    if (latest.exists()) return checkedProfile(latest.data());
    transaction.set(ref, { ...profile, serverCreatedAt: serverTimestamp() });
    return profile;
  });
}

export function signInWithGoogle(intendedRole: AccountRole): Promise<void> {
  if (interactiveSignIn) return interactiveSignIn;
  const operation = ++signInGeneration;
  const resolver = resolveAccount;
  const current = () => operation === signInGeneration && resolver === resolveAccount;
  let cancel!: () => void;
  const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
  cancelInteractiveSignIn = cancel;
  intendedSignInRole = roleForThisApp(intendedRole);
  const run = async () => {
    try {
      await credentialBarrier;
      if (!current()) return;
      const { auth } = fb();
      const state = useAuth.getState();
      if (state.status === 'signedIn') return;
      // Google already succeeded: a profile retry must not open another account picker.
      if (auth.currentUser && resolver && !(state.profile && !accountMatchesApp(state.profile.role))) {
        await resolver(auth.currentUser);
        return;
      }
      useAuth.setState({ busy: true, phase: 'google', error: null, role: intendedSignInRole });
      if (Capacitor.isNativePlatform()) {
        const r = await FirebaseAuthentication.signInWithGoogle();
        if (!current()) return;
        const idToken = r.credential?.idToken;
        if (!idToken) throw new Error('Google sign-in did not return an ID token');
        await exchangeCredential(auth, operation, () => signInWithCredential(auth, GoogleAuthProvider.credential(idToken)));
      } else {
        await exchangeCredential(auth, operation, () => signInWithPopup(auth, new GoogleAuthProvider()));
      }
      if (!current()) return;
      if (!auth.currentUser || !resolver) throw new Error('Google sign-in completed, but account setup could not start. Please retry.');
      await resolver(auth.currentUser);
    } catch (e) {
      if (!current()) return;
      const msg = (e as Error).message ?? 'Sign-in failed';
      useAuth.setState({ error: /cancel|closed/i.test(msg) ? 'Sign-in was cancelled.' : friendlyError(e, 'Google sign-in did not work. Please try again.') });
      throw e;
    } finally {
      // The resolver owns the profile phase. Never unlock the button while it is still pending.
      if (current() && useAuth.getState().phase === 'google') useAuth.setState({ busy: false, phase: null });
    }
  };
  const promise = Promise.race([run(), cancelled]).finally(() => {
    if (interactiveSignIn === promise) interactiveSignIn = null;
    if (cancelInteractiveSignIn === cancel) cancelInteractiveSignIn = null;
  });
  interactiveSignIn = promise;
  return promise;
}

export async function signOut() {
  if (isDemo()) return;
  invalidateInteractiveSignIn();
  cancelAccountResolution?.();
  useAuth.setState({ busy: false, phase: null });
  const { auth } = fb();
  if (Capacitor.isNativePlatform()) await FirebaseAuthentication.signOut().catch(() => undefined);
  await credentialBarrier;
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
export function clearLocalAccountData(): Promise<void> {
  const clearing = localClear.then(clearAccountCache);
  localClear = clearing.catch(() => undefined);
  return clearing;
}

async function clearAccountCache() {
  // Sync must stop FIRST: otherwise clearing the phone would be uploaded as "the person deleted
  // their name, places and contacts".
  const { stopSettingsSync, LOCAL_ONLY } = await import('../sync/settingsSync');
  stopSettingsSync();
  const { useSession, defaultSettings, emptyPerson } = await import('../store/session');
  const { useActivity } = await import('../store/activity');
  const { useAssistant } = await import('../store/assistant');
  const { resetWalkTracker } = await import('../walking/walkTracker');
  resetWalkTracker();
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
  rememberAccount(null);
  try { localStorage.removeItem(VERIFIED_ROLE_KEY); } catch { /* ignore */ }
  try {
    localStorage.removeItem('aiss.nav.active.v1');
  } catch {
    /* ignore */
  }
}
