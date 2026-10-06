/**
 * Typed access to build-time configuration. Nothing here is a secret:
 * Firebase web config and a restricted Maps browser key are public by design.
 * Gemini / Places / Routes keys live ONLY in Cloud Functions (see functions/.env.example).
 */
const e = import.meta.env;

export const ENV = {
  /** 'real' (default for production builds) or 'demo'. */
  appMode: (e.VITE_APP_MODE as string | undefined) ?? (e.PROD ? 'real' : 'demo'),
  firebase: {
    apiKey: e.VITE_FIREBASE_API_KEY as string | undefined,
    authDomain: e.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
    projectId: e.VITE_FIREBASE_PROJECT_ID as string | undefined,
    storageBucket: e.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
    messagingSenderId: e.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
    appId: e.VITE_FIREBASE_APP_ID as string | undefined,
  },
  firebaseRegion: (e.VITE_FIREBASE_FUNCTIONS_REGION as string | undefined) ?? 'asia-south1',
  appCheckSiteKey: e.VITE_APPCHECK_RECAPTCHA_ENTERPRISE_KEY as string | undefined,
  /** Sideloaded/debug APKs fail Play Integrity: opt in to the App Check debug provider (register the logged token in the console). Never in Play builds. */
  appCheckDebug: e.VITE_APPCHECK_DEBUG === 'true',
  fcmVapidKey: e.VITE_FCM_VAPID_KEY as string | undefined,
  mapsBrowserKey: e.VITE_GOOGLE_MAPS_BROWSER_KEY as string | undefined,
  mapsMapId: e.VITE_GOOGLE_MAPS_MAP_ID as string | undefined,
  useEmulators: e.VITE_USE_FIREBASE_EMULATORS === 'true',
  /** TURN server for Guardian camera sessions (WebRTC). STUN-only works on many but not all networks. */
  turn: {
    urls: e.VITE_TURN_URLS as string | undefined,
    username: e.VITE_TURN_USERNAME as string | undefined,
    credential: e.VITE_TURN_CREDENTIAL as string | undefined,
  },
  appVersion: (e.VITE_APP_VERSION as string | undefined) ?? '0.2.0',
};

export const firebaseConfigured = () => !!(ENV.firebase.apiKey && ENV.firebase.projectId && ENV.firebase.appId);
export const mapsConfigured = () => !!ENV.mapsBrowserKey;
