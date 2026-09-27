import { Capacitor } from '@capacitor/core';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { CustomProvider, initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAuth, connectAuthEmulator, indexedDBLocalPersistence, initializeAuth, type Auth } from 'firebase/auth';
import { connectFirestoreEmulator, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, type Firestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, type Functions } from 'firebase/functions';
import { FirebaseAppCheck } from '@capacitor-firebase/app-check';
import { ENV, firebaseConfigured } from '../runtime/env';

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

export class FirebaseNotConfigured extends Error {
  constructor() {
    super('Firebase is not configured. Copy .env.example to .env and fill in the VITE_FIREBASE_* values.');
  }
}

export function fb(): FirebaseHandles {
  if (handles) return handles;
  if (!firebaseConfigured()) throw new FirebaseNotConfigured();
  const app = initializeApp(ENV.firebase as Record<string, string>);

  // App Check: Play Integrity via the native plugin on Android, reCAPTCHA Enterprise on the web.
  if (Capacitor.isNativePlatform()) {
    void FirebaseAppCheck.initialize({ isTokenAutoRefreshEnabled: true }).catch(() => undefined);
    initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: async () => {
          const r = await FirebaseAppCheck.getToken();
          return { token: r.token, expireTimeMillis: r.expireTimeMillis ?? Date.now() + 30 * 60_000 };
        },
      }),
      isTokenAutoRefreshEnabled: true,
    });
  } else if (ENV.appCheckSiteKey) {
    initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(ENV.appCheckSiteKey), isTokenAutoRefreshEnabled: true });
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
