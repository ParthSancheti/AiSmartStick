import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { randomInt } from 'node:crypto';
import { CALLABLE, db, requireAuth, requireRole, str } from './common';
import { relationshipId, type RelationshipDoc } from './shared/firestoreSchema';
import { push } from './notify';

/**
 * 1 user → 1 guardian. Relationships are created ONLY here; clients can never write them
 * (firestore.rules). Codes: 6 digits, 10-minute TTL, single use, 5 wrong tries per user per hour.
 */
const CODE_TTL_MS = 10 * 60_000;

export const createPairingCode = onCall(CALLABLE, async (req) => {
  const guardianUid = requireAuth(req);
  const g = await requireRole(guardianUid, 'guardian');
  const d = (req.data ?? {}) as Record<string, unknown>;
  const existing = await db.collection('relationships').where('guardianUid', '==', guardianUid).where('status', '==', 'active').limit(1).get();
  if (!existing.empty) throw new HttpsError('already-exists', 'You are already linked to someone. Unlink first.');
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const ref = db.doc(`pairingSessions/${code}`);
    try {
      await ref.create({
        guardianUid,
        guardianName: str(g.get('displayName'), 60),
        userName: str(d.userName, 40),
        heardAs: str(d.heardAs, 24) || 'Guardian',
        guardianPhone: str(d.guardianPhone, 20) || null,
        expiresAt: Date.now() + CODE_TTL_MS,
        expireAt: Timestamp.fromMillis(Date.now() + CODE_TTL_MS + 3600_000), // TTL cleanup
        claimed: false,
      });
      return { code, expiresAt: Date.now() + CODE_TTL_MS };
    } catch {
      /* collision, retry */
    }
  }
  throw new HttpsError('unavailable', 'Could not create a code. Try again.');
});

export const claimPairingCode = onCall(CALLABLE, async (req) => {
  const userUid = requireAuth(req);
  const u = await requireRole(userUid, 'user');
  const code = str((req.data as Record<string, unknown>)?.code, 6);
  if (!/^\d{6}$/.test(code)) throw new HttpsError('invalid-argument', 'invalid code');

  // Brute-force limit.
  const lim = db.doc(`users/${userUid}/private/pairingAttempts`);
  const l = await lim.get();
  const hour = Math.floor(Date.now() / 3600_000);
  const tries = l.get('hour') === hour ? (l.get('count') ?? 0) : 0;
  if (tries >= 5) throw new HttpsError('resource-exhausted', 'Too many attempts. Try again in an hour.');

  const result = await db.runTransaction(async (tx) => {
    const sRef = db.doc(`pairingSessions/${code}`);
    const s = await tx.get(sRef);
    if (!s.exists || s.get('claimed') || (s.get('expiresAt') ?? 0) < Date.now()) {
      tx.set(lim, { hour, count: tries + 1 });
      throw new HttpsError('not-found', 'invalid or expired code');
    }
    const guardianUid = s.get('guardianUid') as string;
    if (guardianUid === userUid) throw new HttpsError('invalid-argument', 'You cannot link to yourself.');
    const mine = await tx.get(db.collection('relationships').where('userUid', '==', userUid).where('status', '==', 'active').limit(1));
    if (!mine.empty) throw new HttpsError('already-exists', 'This account already has a guardian.');
    const id = relationshipId(userUid, guardianUid);
    const rel: RelationshipDoc = {
      relationshipId: id,
      userUid,
      guardianUid,
      status: 'active',
      role: 'guardian',
      permissions: { location: true, camera: true, activity: true, sos: true, messages: true, safetySettings: true },
      heardAs: s.get('heardAs'),
      guardianName: s.get('guardianName'),
      userName: str(u.get('displayName'), 60) || s.get('userName'),
      guardianPhone: s.get('guardianPhone'),
      createdAt: Date.now(),
      revokedAt: null,
    };
    tx.set(db.doc(`relationships/${id}`), rel);
    tx.update(sRef, { claimed: true, claimedBy: userUid, claimedAt: Date.now() });
    tx.set(db.doc(`users/${userUid}`), { guardianRelationshipId: id, updatedAt: Date.now() }, { merge: true });
    tx.set(db.doc(`users/${guardianUid}`), { watchesUserUid: userUid, updatedAt: Date.now() }, { merge: true });
    tx.set(db.collection(`users/${userUid}/activity`).doc(`ev_pair_${Date.now()}`), { eventId: `ev_pair_${Date.now()}`, kind: 'device', severity: 'success', title: `Linked with ${rel.heardAs}`, detail: null, ts: Date.now(), source: 'backend', deviceId: null });
    return { relationshipId: id, heardAs: rel.heardAs, guardianName: rel.guardianName, guardianUid, userName: rel.userName };
  });
  // Pairing state push to the guardian (outside the transaction).
  await push(result.guardianUid, 'pairing', `${result.userName || 'Your person'} is now linked`, 'You will see their stick status, location and SOS alerts.').catch(() => undefined);
  return { relationshipId: result.relationshipId, heardAs: result.heardAs, guardianName: result.guardianName };
});

export const revokeRelationship = onCall(CALLABLE, async (req) => {
  const uid = requireAuth(req);
  const id = str((req.data as Record<string, unknown>)?.relationshipId, 200);
  const ref = db.doc(`relationships/${id}`);
  const r = await ref.get();
  if (!r.exists || (r.get('userUid') !== uid && r.get('guardianUid') !== uid)) throw new HttpsError('permission-denied', 'Not your relationship.');
  const batch = db.batch();
  batch.update(ref, { status: 'revoked', revokedAt: Date.now(), revokedBy: uid });
  batch.set(db.doc(`users/${r.get('userUid')}`), { guardianRelationshipId: null }, { merge: true });
  batch.set(db.doc(`users/${r.get('guardianUid')}`), { watchesUserUid: null }, { merge: true });
  await batch.commit();
  const other = r.get('userUid') === uid ? r.get('guardianUid') : r.get('userUid');
  await push(other, 'pairing', 'AI Smart Stick link removed', 'You are no longer linked. Open the app to link again.').catch(() => undefined);
  return { ok: true };
});

export const updateRelationship = onCall(CALLABLE, async (req) => {
  const uid = requireAuth(req);
  const d = (req.data ?? {}) as Record<string, unknown>;
  const ref = db.doc(`relationships/${str(d.relationshipId, 200)}`);
  const r = await ref.get();
  if (!r.exists || r.get('status') !== 'active' || r.get('guardianUid') !== uid) throw new HttpsError('permission-denied', 'Only the linked guardian can edit this.');
  const patch: Record<string, unknown> = { updatedAt: Date.now() };
  if (typeof d.heardAs === 'string' && str(d.heardAs, 24)) patch.heardAs = str(d.heardAs, 24);
  if (d.guardianPhone === null || typeof d.guardianPhone === 'string') {
    const p = str(d.guardianPhone, 20);
    if (p && !/^\+?[0-9 ()-]{6,20}$/.test(p)) throw new HttpsError('invalid-argument', 'Phone number looks wrong.');
    patch.guardianPhone = p || null;
  }
  if (typeof d.userName === 'string' && str(d.userName, 40)) patch.userName = str(d.userName, 40);
  await ref.update(patch);
  return { ok: true, changed: Object.keys(patch).length - 1 };
});
