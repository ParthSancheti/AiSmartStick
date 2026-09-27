import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { CALLABLE, db, quota, requireAuth } from './common';
import { push } from './notify';

/**
 * Guardian → (this function) → users/{userUid}/deviceCommands/{id} → User phone → stick.
 * The Guardian never reaches the stick directly. Commands are whitelisted, permission-checked,
 * rate-limited, idempotent (the id is reused as the device commandId) and expire after 2 minutes.
 * Policy: a Guardian can NOT trigger or cancel the user's SOS remotely.
 */
const ALLOWED = {
  locate: 'activity', // vibrate so the user can find the stick
  nudge: 'messages',  // gentle "are you ok?" vibration
  scan: 'camera',     // ask the user's phone to describe the scene (user is told)
} as const;

type RemoteType = keyof typeof ALLOWED;

export const sendRemoteCommand = onCall(CALLABLE, async (req) => {
  const guardianUid = requireAuth(req);
  const type = (req.data as { type?: string })?.type as RemoteType;
  if (!type || !(type in ALLOWED)) throw new HttpsError('invalid-argument', 'Unknown command.');
  const rels = await db.collection('relationships').where('guardianUid', '==', guardianUid).where('status', '==', 'active').limit(1).get();
  const rel = rels.docs[0]?.data();
  if (!rel) throw new HttpsError('permission-denied', 'Not linked.');
  if (!rel.permissions?.[ALLOWED[type]]) throw new HttpsError('permission-denied', 'This link does not allow that command.');
  await quota(guardianUid, 'remoteCommand', 6, 200);
  const ref = db.collection(`users/${rel.userUid}/deviceCommands`).doc();
  const now = Date.now();
  await ref.set({ commandId: ref.id, type, issuedBy: guardianUid, createdAt: now, expiresAt: now + 120_000, status: 'queued', result: null, error: null, updatedAt: now });
  await push(rel.userUid, 'snapshot', type === 'scan' ? `${rel.heardAs || 'Your guardian'} asked for a scan` : `${rel.heardAs || 'Your guardian'} sent a ${type === 'locate' ? 'find-stick' : 'nudge'} request`, 'Open AI Smart Stick if it is not running.', { commandId: ref.id }).catch(() => undefined);
  return { commandId: ref.id, userUid: rel.userUid };
});
