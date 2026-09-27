/**
 * Firestore Security Rules tests. Require the Firestore emulator (Java):
 *   npm run test:rules      (runs: firebase emulators:exec --only firestore "vitest run -c vitest.rules.config.ts")
 * NOT executed in the authoring environment (emulator download blocked). Run before every rules deploy.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, collection, query, where, getDocs, Timestamp } from 'firebase/firestore';

let env: RulesTestEnvironment;
const U = 'user1';
const G = 'guardian1';
const X = 'stranger';
const REL = `${U}_${G}`;

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'aiss-rules-test', firestore: { rules: readFileSync('firestore.rules', 'utf8') } });
});
afterAll(async () => env?.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, `users/${U}`), { uid: U, role: 'user', guardianRelationshipId: REL, watchesUserUid: null });
    await setDoc(doc(db, `users/${G}`), { uid: G, role: 'guardian', guardianRelationshipId: null, watchesUserUid: U });
    await setDoc(doc(db, `relationships/${REL}`), { relationshipId: REL, userUid: U, guardianUid: G, status: 'active', permissions: { location: true, camera: true, activity: true, sos: true, messages: true, safetySettings: true } });
    await setDoc(doc(db, `users/${U}/live/location`), { lat: 1, lng: 2 });
    await setDoc(doc(db, `users/${U}/sosEvents/s1`), { sosId: 's1', state: 'active', acknowledgedAt: null, acknowledgedBy: null, onTheWayAt: null, resolvedAt: null, resolvedBy: null, smsFallback: 'not_needed' });
  });
});

const as = (uid: string) => env.authenticatedContext(uid).firestore();

describe('guardian authorization', () => {
  it('linked guardian can read live location; a stranger who guesses the uid cannot', async () => {
    await assertSucceeds(getDoc(doc(as(G), `users/${U}/live/location`)));
    await assertFails(getDoc(doc(as(X), `users/${U}/live/location`)));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), `users/${U}/live/location`)));
  });

  it('revoked relationship removes access immediately', async () => {
    await env.withSecurityRulesDisabled((c) => updateDoc(doc(c.firestore(), `relationships/${REL}`), { status: 'revoked' }));
    await assertFails(getDoc(doc(as(G), `users/${U}/live/location`)));
  });

  it('permission flags are enforced (location off)', async () => {
    await env.withSecurityRulesDisabled((c) => updateDoc(doc(c.firestore(), `relationships/${REL}`), { 'permissions.location': false }));
    await assertFails(getDoc(doc(as(G), `users/${U}/live/location`)));
  });

  it('nobody can create or edit relationships from a client', async () => {
    await assertFails(setDoc(doc(as(X), `relationships/${U}_${X}`), { userUid: U, guardianUid: X, status: 'active', permissions: { location: true } }));
    await assertFails(updateDoc(doc(as(G), `relationships/${REL}`), { 'permissions.camera': true }));
  });

  it('members can query their relationship; others cannot', async () => {
    await assertSucceeds(getDocs(query(collection(as(G), 'relationships'), where('guardianUid', '==', G), where('status', '==', 'active'))));
    await assertFails(getDocs(query(collection(as(X), 'relationships'), where('userUid', '==', U))));
  });
});

describe('SOS', () => {
  it('guardian may acknowledge as themselves only, and only allowed fields', async () => {
    await assertSucceeds(updateDoc(doc(as(G), `users/${U}/sosEvents/s1`), { state: 'acknowledged', acknowledgedAt: 1, acknowledgedBy: G }));
    await assertFails(updateDoc(doc(as(G), `users/${U}/sosEvents/s1`), { acknowledgedBy: X }));
    await assertFails(updateDoc(doc(as(G), `users/${U}/sosEvents/s1`), { smsFallback: 'sent' }));
  });
  it('stranger cannot read or touch the SOS', async () => {
    await assertFails(getDoc(doc(as(X), `users/${U}/sosEvents/s1`)));
  });
});

describe('ownership and server-only data', () => {
  it('a user cannot change their own role or relationship pointers', async () => {
    await assertFails(updateDoc(doc(as(U), `users/${U}`), { role: 'guardian' }));
    await assertFails(updateDoc(doc(as(U), `users/${U}`), { guardianRelationshipId: null }));
    await assertSucceeds(updateDoc(doc(as(U), `users/${U}`), { phone: '+91 9' }));
  });
  it('assistant history is written by functions only', async () => {
    await assertFails(setDoc(doc(as(U), `users/${U}/aiConversations/c1`), { title: 'x' }));
  });
  it('device keys can never be stored', async () => {
    await assertFails(setDoc(doc(as(U), `users/${U}/devices/d1`), { deviceId: 'd1', keyB64: 'secret' }));
    await assertSucceeds(setDoc(doc(as(U), `users/${U}/devices/d1`), { deviceId: 'd1', firmware: '1' }));
  });
  it('guardian may change only SOS settings of the user', async () => {
    await assertSucceeds(setDoc(doc(as(G), `users/${U}/settings/app`), { sosCancelSec: 8, updatedAt: 1, updatedBy: G }));
    await assertFails(setDoc(doc(as(G), `users/${U}/settings/app`), { locationSharing: false }, { merge: true }));
  });
});

describe('remote commands and medical data', () => {
  it('only functions create device commands; the user phone updates status; guardian reads', async () => {
    await assertFails(setDoc(doc(as(G), `users/${U}/deviceCommands/c1`), { type: 'locate', status: 'queued' }));
    await env.withSecurityRulesDisabled((c) => setDoc(doc(c.firestore(), `users/${U}/deviceCommands/c1`), { commandId: 'c1', type: 'locate', status: 'queued', result: null, error: null, updatedAt: 0 }));
    await assertSucceeds(getDoc(doc(as(G), `users/${U}/deviceCommands/c1`)));
    await assertSucceeds(updateDoc(doc(as(U), `users/${U}/deviceCommands/c1`), { status: 'completed', updatedAt: 1 }));
    await assertFails(updateDoc(doc(as(G), `users/${U}/deviceCommands/c1`), { status: 'completed' }));
    await assertFails(updateDoc(doc(as(U), `users/${U}/deviceCommands/c1`), { type: 'scan' }));
  });
  it('medical profile: owner writes, guardian with sos permission reads, strangers never', async () => {
    await assertSucceeds(setDoc(doc(as(U), `users/${U}/medical/profile`), { bloodGroup: 'O+' }));
    await assertSucceeds(getDoc(doc(as(G), `users/${U}/medical/profile`)));
    await assertFails(getDoc(doc(as(X), `users/${U}/medical/profile`)));
    await assertFails(setDoc(doc(as(G), `users/${U}/medical/profile`), { bloodGroup: 'A+' }));
  });
});

describe('camera sessions', () => {
  it('only the linked guardian with camera permission can request, with a short TTL', async () => {
    const base = { userUid: U, guardianUid: G, state: 'requested', mode: 'snapshot', expireAt: Timestamp.fromMillis(Date.now() + 5 * 60_000) };
    await assertSucceeds(setDoc(doc(as(G), 'cameraSessions/s1'), base));
    await assertFails(setDoc(doc(as(X), 'cameraSessions/s2'), { ...base, guardianUid: X }));
    await assertFails(setDoc(doc(as(G), 'cameraSessions/s3'), { ...base, expireAt: Timestamp.fromMillis(Date.now() + 60 * 60_000) }));
  });
});
