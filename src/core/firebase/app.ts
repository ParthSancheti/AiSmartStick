import { Capacitor } from '@capacitor/core';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { CustomProvider, getToken as getAppCheckToken, initializeAppCheck, ReCaptchaEnterpriseProvider, type AppCheck } from 'firebase/app-check';
import { getAuth, connectAuthEmulator, indexedDBLocalPersistence, initializeAuth, type Auth } from 'firebase/auth';
import { connectFirestoreEmulator, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, type Firestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, type Functions } from 'firebase/functions';
import { FirebaseAppCheck } from '@capacitor-firebase/app-check';
import { ENV, firebaseConfigured } from '../runtime/env';
import { errorText, recordAppCheckToken, useAppCheckStatus, withAppCheckTimeout, type AppCheckProvider } from './appCheckStatus';

/**
 * The only place Firebase is initialised. UI components never import 'firebase/*';
 * they use the services in core/auth, core/sync, core/pairing, core/backend.
 */
export interface FirebaseHandles {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  functions: Functions;
}

let handles: FirebaseHandles | null = null;
let appCheck: AppCheck | null = null;

export class FirebaseNotConfigured extends Error {
  constructor() {
    super('Firebase is not configured. Copy .env.example to .env and fill in the VITE_FIREBASE_* values.');
  }
}

// ---------------------------------------------------------------- App Check (Android, native)

/** No App Check step (native start, token) may hold a server call longer than this. */
export const APP_CHECK_TIMEOUT_MS = 8000;
/** After a failed token request, calls go out at once without a token for a while (no 8 s wait per call). */
const RETRY_FIRST_MS = 15_000;
const RETRY_MAX_MS = 5 * 60_000;

let nativeStart: Promise<void> | null = null;
let failures = 0;
let failedAt = 0;
let failedMsg = '';

export const appCheckProvider = (): AppCheckProvider => (Capacitor.isNativePlatform() ? (ENV.appCheckDebug ? 'debug' : 'play-integrity') : ENV.appCheckSiteKey ? 'recaptcha' : 'none');
const providerWords = () => (appCheckProvider() === 'debug' ? 'debug provider' : 'Play Integrity');

/** Starts the native provider once. Always resolves within APP_CHECK_TIMEOUT_MS; a problem is kept in appCheckStatus. */
export function startNativeAppCheck(): Promise<void> {
  if (nativeStart) return nativeStart;
  const init = FirebaseAppCheck.initialize({ isTokenAutoRefreshEnabled: true, ...(ENV.appCheckDebug ? { debugToken: true } : {}) });
  // A late success (after the timeout) still clears the error.
  init.then(
    () => useAppCheckStatus.setState({ initError: null }),
    (e) => useAppCheckStatus.setState({ initError: `App Check did not start: ${errorText(e)}` }),
  );
  nativeStart = withAppCheckTimeout(init, APP_CHECK_TIMEOUT_MS, `App Check did not start in ${APP_CHECK_TIMEOUT_MS / 1000} s.`).catch((e) => {
    if (!useAppCheckStatus.getState().initError) useAppCheckStatus.setState({ initError: errorText(e) });
    console.error('[app-check] native start failed:', errorText(e));
  });
  return nativeStart;
}

/**
 * CustomProvider.getToken for Android. Never hangs: it waits at most APP_CHECK_TIMEOUT_MS (native
 * start included) and then throws a clear Error. The Firebase SDK then sends the call WITHOUT an App
 * Check token: a server that enforces App Check answers 'unauthenticated' at once (a clear error
 * instead of a long timeout); a server with ENFORCE_APPCHECK=false just works.
 */
export async function nativeAppCheckToken(): Promise<{ token: string; expireTimeMillis: number }> {
  if (failedAt && Date.now() - failedAt < Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, failures - 1))) throw new Error(failedMsg);
  const t0 = Date.now();
  try {
    const r = await withAppCheckTimeout(
      (async () => {
        await startNativeAppCheck();
        return FirebaseAppCheck.getToken();
      })(),
      APP_CHECK_TIMEOUT_MS,
      `App Check (${providerWords()}) did not answer in ${APP_CHECK_TIMEOUT_MS / 1000} s.`,
    );
    if (!r?.token) throw new Error('App Check gave an empty token.');
    failures = 0;
    failedAt = 0;
    recordAppCheckToken(true, Date.now() - t0);
    return { token: r.token, expireTimeMillis: r.expireTimeMillis ?? Date.now() + 30 * 60_000 };
  } catch (e) {
    const raw = errorText(e);
    const msg = /^App Check/.test(raw) ? raw : `App Check (${providerWords()}) failed: ${raw}`;
    failures += 1;
    failedAt = Date.now();
    failedMsg = msg;
    recordAppCheckToken(false, Date.now() - t0, msg);
    console.warn(`[app-check] ${msg} Server calls go without App Check.`);
    throw new Error(msg);
  }
}

/** Server test: ask for an App Check token now (skips the retry pause). Never throws, never hangs. */
export async function probeAppCheck(): Promise<{ ok: boolean; ms: number; provider: AppCheckProvider; error: string | null }> {
  const provider = appCheckProvider();
  try {
    fb();
  } catch (e) {
    return { ok: false, ms: 0, provider, error: errorText(e) };
  }
  if (!appCheck) return { ok: false, ms: 0, provider, error: 'App Check is not set up in this build (no reCAPTCHA key for the web).' };
  failedAt = 0;
  const t0 = Date.now();
  try {
    await withAppCheckTimeout(getAppCheckToken(appCheck, false), APP_CHECK_TIMEOUT_MS + 2000, `App Check did not answer in ${(APP_CHECK_TIMEOUT_MS + 2000) / 1000} s.`);
    const ms = Date.now() - t0;
    if (provider === 'recaptcha') recordAppCheckToken(true, ms);
    return { ok: true, ms, provider, error: null };
  } catch (e) {
    const ms = Date.now() - t0;
    if (provider === 'recaptcha') recordAppCheckToken(false, ms, errorText(e));
    return { ok: false, ms, provider, error: errorText(e) };
  }
}

/** Test helper. */
export function __resetAppCheckForTests() {
  nativeStart = null;
  failures = 0;
  failedAt = 0;
  failedMsg = '';
}

// ---------------------------------------------------------------- init

export function fb(): FirebaseHandles {
  if (handles) return handles;
  if (!firebaseConfigured()) throw new FirebaseNotConfigured();
  const app = initializeApp(ENV.firebase as Record<string, string>);

  // App Check: Play Integrity (or the debug provider) via the native plugin on Android, reCAPTCHA Enterprise on the web.
  useAppCheckStatus.setState({ provider: appCheckProvider() });
  if (Capacitor.isNativePlatform()) {
    void startNativeAppCheck();
    appCheck = initializeAppCheck(app, { provider: new CustomProvider({ getToken: nativeAppCheckToken }), isTokenAutoRefreshEnabled: true });
  } else if (ENV.appCheckSiteKey) {
    appCheck = initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(ENV.appCheckSiteKey), isTokenAutoRefreshEnabled: true });
  }

  const auth = Capacitor.isNativePlatform() ? initializeAuth(app, { persistence: indexedDBLocalPersistence }) : getAuth(app);
  // Offline-first: writes queue while the phone has no data and sync when it returns.
  const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  const functions = getFunctions(app, ENV.firebaseRegion);

  if (ENV.useEmulators) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  }
  handles = { app, auth, db, functions };
  return handles;
}

export const fbReady = () => handles !== null;
