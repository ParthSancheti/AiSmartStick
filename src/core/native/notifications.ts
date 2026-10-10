import { Capacitor } from '@capacitor/core';
import { FirebaseMessaging, Importance } from '@capacitor-firebase/messaging';
import { getMessaging, getToken, isSupported, onMessage } from 'firebase/messaging';
import { doc, setDoc } from 'firebase/firestore';
import { fb } from '../firebase/app';
import { paths } from '../../../shared/firestoreSchema';
import { ENV } from '../runtime/env';
import { toastGuardian, useUI } from '../store/ui';

/**
 * FCM registration. Push is for events that need attention (SOS, disconnects, critical battery,
 * stale location, snapshot requests) — never for telemetry. Tokens are stored per user; the
 * Cloud Functions send to them.
 */
export type PushStatus = 'registered' | 'denied' | 'unsupported' | 'unconfigured' | 'error';

async function save(uid: string, token: string, platform: string, role: string) {
  await setDoc(doc(fb().db, paths.fcmTokens(uid), token), { token, platform, role, updatedAt: Date.now() }, { merge: true });
}

export async function registerPush(uid: string, role: 'user' | 'guardian'): Promise<PushStatus> {
  try {
    if (Capacitor.isNativePlatform()) {
      const perm = await FirebaseMessaging.requestPermissions();
      if (perm.receive !== 'granted') return 'denied';
      await FirebaseMessaging.createChannel({ id: 'sos', name: 'Emergency alerts', description: 'SOS and critical safety alerts', importance: Importance.Max, vibration: true, lights: true }).catch(() => undefined);
      await FirebaseMessaging.createChannel({ id: 'status', name: 'Stick status', description: 'Disconnects, low battery, stale location', importance: Importance.High }).catch(() => undefined);
      const { token } = await FirebaseMessaging.getToken();
      await save(uid, token, 'android', role);
      // Sign-in can happen more than once per process: never stack listeners.
      await FirebaseMessaging.removeAllListeners().catch(() => undefined);
      void FirebaseMessaging.addListener('notificationActionPerformed', (e) => {
        const kind = (e.notification?.data as Record<string, string> | undefined)?.kind;
        // Tapping any alert opens the app; SOS/geofence/stale open Home (the SOS takeover shows itself from the feed).
        if (role === 'guardian' && kind) useUI.setState({ guardianTab: kind === 'snapshot' ? 'vision' : 'home' });
      });
      void FirebaseMessaging.addListener('notificationReceived', (e) => {
        const n = e.notification;
        if (n?.title && role === 'guardian') toastGuardian(n.title);
      });
      return 'registered';
    }
    if (!(await isSupported())) return 'unsupported';
    if (!ENV.fcmVapidKey) return 'unconfigured';
    const reg = await navigator.serviceWorker.register(`/firebase-messaging-sw.js?config=${encodeURIComponent(JSON.stringify(ENV.firebase))}`);
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return 'denied';
    const messaging = getMessaging(fb().app);
    const token = await getToken(messaging, { vapidKey: ENV.fcmVapidKey, serviceWorkerRegistration: reg });
    await save(uid, token, 'web', role);
    onMessage(messaging, (m) => {
      if (m.notification?.title) toastGuardian(m.notification.title);
    });
    return 'registered';
  } catch {
    return 'error';
  }
}
