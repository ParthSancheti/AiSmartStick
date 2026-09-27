import { onCall } from 'firebase-functions/v2/https';
import { getAuth } from 'firebase-admin/auth';
import { CALLABLE, db, requireAuth } from './common';

/**
 * Account deletion (Play policy requirement): revokes every relationship the caller is part of,
 * releases their stick registrations, deletes all of users/{uid} recursively, then the Auth user.
 * Camera-session signalling docs expire through their TTL policy.
 */
export const deleteAccount = onCall(CALLABLE, async (req) => {
  const uid = requireAuth(req);
  const [asUser, asGuardian, devices] = await Promise.all([
    db.collection('relationships').where('userUid', '==', uid).get(),
    db.collection('relationships').where('guardianUid', '==', uid).get(),
    db.collection('devices').where('ownerUid', '==', uid).get(),
  ]);
  const batch = db.batch();
  for (const r of [...asUser.docs, ...asGuardian.docs]) {
    batch.update(r.ref, { status: 'revoked', revokedAt: Date.now(), revokedBy: uid, reason: 'account_deleted' });
    const other = r.get('userUid') === uid ? r.get('guardianUid') : r.get('userUid');
    batch.set(db.doc(`users/${other}`), r.get('userUid') === uid ? { watchesUserUid: null } : { guardianRelationshipId: null }, { merge: true });
  }
  devices.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  await db.recursiveDelete(db.doc(`users/${uid}`));
  await getAuth().deleteUser(uid);
  return { ok: true };
});
