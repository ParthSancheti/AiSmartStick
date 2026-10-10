import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { setGlobalOptions } from 'firebase-functions/v2';

if (!getApps().length) initializeApp();
export const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

export const REGION = defineString('REGION', { default: 'asia-south1' });
export const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
export const MAPS_SERVER_KEY = defineSecret('MAPS_SERVER_KEY');
export const GEMINI_LIVE_MODEL = defineString('GEMINI_LIVE_MODEL', { default: 'gemini-3.8-live' });
export const GEMINI_FLASH_MODEL = defineString('GEMINI_FLASH_MODEL', { default: 'gemini-3.8-flash' });
export const GEMINI_VISION_MODEL = defineString('GEMINI_VISION_MODEL', { default: 'gemini-3.8-flash' });

setGlobalOptions({ region: 'asia-south1', maxInstances: 20 });

/**
 * Callable defaults: signed-in user + valid App Check token. For testing with a sideloaded debug APK
 * (no App Check debug token registered yet) set ENFORCE_APPCHECK=false in functions/.env and deploy;
 * sign-in is still required. Turn it back on before giving the app to anyone else.
 */
export const CALLABLE = { enforceAppCheck: process.env.ENFORCE_APPCHECK !== 'false', cors: true } as const;

export function requireAuth(req: CallableRequest<unknown>): string {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  return uid;
}

export async function requireRole(uid: string, role: 'user' | 'guardian') {
  const snap = await db.doc(`users/${uid}`).get();
  const r = snap.get('role');
  if (r !== role) throw new HttpsError('permission-denied', `This action is for ${role} accounts.`);
  return snap;
}

/** Simple per-user quota (per minute / per day) stored server-side. */
export async function quota(uid: string, bucket: string, perMinute: number, perDay: number) {
  const ref = db.doc(`users/${uid}/private/quota_${bucket}`);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const now = Date.now();
    const minute = Math.floor(now / 60000);
    const day = Math.floor(now / 86400000);
    const d = s.data() ?? {};
    const m = d.minute === minute ? (d.mCount ?? 0) : 0;
    const dd = d.day === day ? (d.dCount ?? 0) : 0;
    if (m >= perMinute || dd >= perDay) throw new HttpsError('resource-exhausted', 'Too many requests. Please wait a moment.');
    tx.set(ref, { minute, mCount: m + 1, day, dCount: dd + 1, updatedAt: FieldValue.serverTimestamp() });
  });
}

export const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const t = Math.PI / 180;
  const dLat = (b.lat - a.lat) * t;
  const dLng = (b.lng - a.lng) * t;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** The active relationship for a stick user (1 user → 1 guardian), or null. */
export async function activeRelationshipForUser(userUid: string) {
  const q = await db.collection('relationships').where('userUid', '==', userUid).where('status', '==', 'active').limit(1).get();
  return q.docs[0]?.data() ?? null;
}
