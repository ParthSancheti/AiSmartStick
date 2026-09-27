import { create } from 'zustand';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import { fb } from '../firebase/app';
import { call } from '../backend/api';
import { paths, type RelationshipDoc } from '../../../shared/firestoreSchema';
import { useSession } from '../store/session';

/**
 * User ↔ Guardian relationship (1 user → 1 guardian).
 * Codes are created and redeemed ONLY by Cloud Functions; clients can read a relationship
 * they are part of but can never write one (firestore.rules).
 */
interface RelState {
  status: 'idle' | 'loading' | 'none' | 'active' | 'error';
  rel: RelationshipDoc | null;
  code: { code: string; expiresAt: number } | null;
  error: string | null;
}

export const useRelationship = create<RelState>(() => ({ status: 'idle', rel: null, code: null, error: null }));

let unsub: (() => void) | null = null;

export function watchRelationship(uid: string, side: 'user' | 'guardian') {
  unsub?.();
  useRelationship.setState({ status: 'loading' });
  const q = query(collection(fb().db, 'relationships'), where(side === 'user' ? 'userUid' : 'guardianUid', '==', uid), where('status', '==', 'active'));
  unsub = onSnapshot(
    q,
    (snap) => {
      const rel = (snap.docs[0]?.data() as RelationshipDoc | undefined) ?? null;
      useRelationship.setState({ status: rel ? 'active' : 'none', rel, error: null });
      if (rel) {
        const s = useSession.getState();
        useSession.setState({
          linked: true,
          guardian: { ...s.guardian, name: rel.guardianName, heardAs: rel.heardAs, phone: rel.guardianPhone },
          person: { ...s.person, name: s.person.name || rel.userName },
        });
      } else useSession.setState({ linked: false });
    },
    (e) => useRelationship.setState({ status: 'error', error: e.message }),
  );
}

export function stopRelationshipWatch() {
  unsub?.();
  unsub = null;
  useRelationship.setState({ status: 'idle', rel: null });
}

/** Guardian: get a 6-digit code valid for 10 minutes. */
export async function createPairingCode(input: { userName: string; heardAs: string; guardianPhone: string | null }) {
  const r = await call<typeof input, { code: string; expiresAt: number }>('createPairingCode', input);
  useRelationship.setState({ code: r });
  return r;
}

/** Stick user: redeem the guardian's code. */
export async function claimPairingCode(code: string) {
  return call<{ code: string }, { relationshipId: string; heardAs: string; guardianName: string }>('claimPairingCode', { code });
}

export async function revokeRelationship() {
  const rel = useRelationship.getState().rel;
  if (!rel) return;
  await call<{ relationshipId: string }, { ok: boolean }>('revokeRelationship', { relationshipId: rel.relationshipId });
}

export const relationshipRef = (userUid: string, guardianUid: string) => doc(fb().db, paths.relationship(userUid, guardianUid));

/** Guardian edits how they are heard, their phone number, or the user's display name (server validates). */
export async function updateRelationship(patch: { heardAs?: string; guardianPhone?: string | null; userName?: string }) {
  const rel = useRelationship.getState().rel;
  if (!rel) throw new Error('Not linked yet');
  await call<{ relationshipId: string } & typeof patch, { ok: boolean }>('updateRelationship', { relationshipId: rel.relationshipId, ...patch });
}
