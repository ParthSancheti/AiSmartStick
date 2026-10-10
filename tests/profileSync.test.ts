import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Profile & settings sync: one source of truth, last writer wins, no echo loops, the Google name
 * never overwrites a typed name, the picked photo persists and syncs, sign-out clears the phone.
 */

// ─── fake Firestore (records writes, lets the test deliver snapshots) ───
type Snap = { exists: () => boolean; data: () => Record<string, unknown> | undefined; metadata: { hasPendingWrites: boolean; fromCache: boolean } };
const listeners = new Map<string, (s: Snap) => void>();
const writes: { path: string; data: Record<string, unknown> }[] = [];
const snap = (data: Record<string, unknown> | undefined, meta: Partial<Snap['metadata']> = {}): Snap => ({
  exists: () => data !== undefined,
  data: () => data,
  metadata: { hasPendingWrites: false, fromCache: false, ...meta },
});
const deliver = (path: string, data: Record<string, unknown> | undefined, meta?: Partial<Snap['metadata']>) => {
  const l = listeners.get(path);
  if (!l) throw new Error(`no listener on ${path}`);
  l(snap(data, meta));
};
const writesTo = (path: string) => writes.filter((w) => w.path === path);

vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ...parts: string[]) => {
    const base = parts[0] as unknown as { path?: string } | string;
    const path = typeof base === 'object' && base?.path ? [base.path, ...parts.slice(1)].join('/') : parts.join('/');
    return { path };
  },
  collection: (_db: unknown, path: string) => ({ path }),
  onSnapshot: (ref: { path: string }, cb: (s: Snap) => void) => {
    listeners.set(ref.path, cb);
    return () => listeners.delete(ref.path);
  },
  setDoc: vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
    writes.push({ path: ref.path, data });
    return new Promise(() => undefined); // offline: never acknowledged — callers must not wait
  }),
  updateDoc: vi.fn(() => new Promise(() => undefined)),
  deleteDoc: vi.fn(() => Promise.resolve()),
  getDocs: vi.fn(async () => ({ docs: [] })),
}));
vi.mock('../src/core/firebase/app', () => ({ fb: () => ({ db: {} }) }));
vi.mock('../src/core/pairing/pairingService', () => ({ useRelationship: { getState: () => ({ rel: null }) } }));

const { useSession, defaultSettings, emptyPerson } = await import('../src/core/store/session');
const { useAuth } = await import('../src/core/auth/authStore');
const { usePhotoCache, setCustomPhoto, effectivePhoto } = await import('../src/core/profile/photoCache');
const { mergeCloudProfile, profileCloudPatch, mergeCloudPhoto, setProfileName, profileName } = await import('../src/core/profile/profile');
const { decideSettings, sanitizeCloudSettings, startSettingsSync, stopSettingsSync } = await import('../src/core/sync/settingsSync');
const { profileUpdateOnSignIn } = await import('../src/core/auth/authService');
const { pickEncoding } = await import('../src/core/profile/imageCompress');

const UID = 'u1';
const USER = `users/${UID}`;
const SETTINGS = `users/${UID}/settings/app`;
const JPEG = 'data:image/jpeg;base64,AAAA';

function resetState() {
  stopSettingsSync();
  listeners.clear();
  writes.length = 0;
  useSession.setState({ person: emptyPerson(), contacts: [], settings: { ...defaultSettings }, profileEditedAt: undefined, settingsEditedAt: undefined, entryRole: 'user' });
  useAuth.setState({ status: 'signedIn', role: 'user', user: { uid: UID, displayName: 'Google Name', providerName: 'Google Name', email: 'a@b.c', photoURL: null }, profile: null });
  usePhotoCache.setState({ cached: null, custom: null });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
  resetState();
});
afterEach(() => {
  stopSettingsSync();
  vi.useRealTimers();
});

// ─── pure logic ──────────────────────────────────────────────

describe('profile merge (pure)', () => {
  const local = (p: Partial<ReturnType<typeof emptyPerson>> = {}, at = 0) => ({ person: { ...emptyPerson(), ...p }, profileEditedAt: at });

  it('fills an empty name from the account (Google default)', () => {
    expect(mergeCloudProfile(local(), { displayName: 'Aarav Shah' }, 'Aarav Shah').person?.name).toBe('Aarav Shah');
    expect(mergeCloudProfile(local(), {}, 'Google Name').person?.name).toBe('Google Name');
  });

  it('an edited name wins over the Google name, on both sides', () => {
    // Typed on this phone, cloud still has the Google name → keep local, upload it.
    const m = mergeCloudProfile(local({ name: 'Aru', nameEditedAt: 100 }), { displayName: 'Google Name' }, 'Google Name');
    expect(m.person).toBeNull();
    expect(m.push).toBe(true);
    // Typed on another phone (cloud newer) → applied here.
    const m2 = mergeCloudProfile(local({ name: 'Google Name' }), { displayName: 'Aru', nameEditedAt: 100 }, 'Google Name');
    expect(m2.person?.name).toBe('Aru');
    expect(m2.person?.nameEditedAt).toBe(100);
  });

  it('a stale cloud copy never undoes a newer local edit', () => {
    const m = mergeCloudProfile(local({ phone: '+91 99999 11111' }, 500), { phone: '+91 00000 00000', profileUpdatedAt: 400 }, null);
    expect(m.person).toBeNull();
    expect(m.push).toBe(true);
  });

  it('a newer cloud copy (other phone) is applied, including the home place', () => {
    const m = mergeCloudProfile(local({ phone: 'old' }, 100), { phone: 'new', profileUpdatedAt: 200, homePlace: { lat: 20, lng: 74, placeId: 'p', address: 'Chandwad, Nashik', label: 'Home' } }, null);
    expect(m.person?.phone).toBe('new');
    expect(m.person?.savedPlaces[0]).toMatchObject({ id: 'home', lat: 20, lng: 74 });
    expect(m.profileEditedAt).toBe(200);
    expect(m.push).toBe(false);
  });

  it('older account data without timestamps only fills gaps', () => {
    const m = mergeCloudProfile(local({ phone: 'mine' }), { phone: 'cloud', homeAddress: 'Home street' }, null);
    expect(m.person?.phone).toBe('mine');
    expect(m.person?.homeAddress).toBe('Home street');
  });

  it('cloud patch: name only when typed; homePlace mirrors the saved Home', () => {
    const p = { ...emptyPerson(), name: 'Google Name', savedPlaces: [{ id: 'home', label: 'Home', placeId: 'x', name: 'Home', address: 'Addr', lat: 1, lng: 2, updatedAt: 1 }] };
    const patch = profileCloudPatch(p, 10);
    expect(patch.displayName).toBeUndefined();
    expect(patch.homePlace).toEqual({ lat: 1, lng: 2, placeId: 'x', address: 'Addr', label: 'Home' });
    expect(patch.profileUpdatedAt).toBe(10);
    expect(profileCloudPatch({ ...p, nameEditedAt: 5, name: ' Aru  S ' }, 0)).toEqual({ displayName: 'Aru S', nameEditedAt: 5 });
  });

  it('sign-in never overwrites a typed name with the Google name', () => {
    expect(profileUpdateOnSignIn({ displayName: 'Aru', photoURL: null, nameEditedAt: 5 }, 'Google Name', null)).toEqual({});
    expect(profileUpdateOnSignIn({ displayName: 'Old Google', photoURL: null }, 'Google Name', 'http://p')).toEqual({ displayName: 'Google Name', photoURL: 'http://p' });
  });

  it('photo: last writer wins, removal is kept', () => {
    expect(mergeCloudPhoto(null, { photoData: JPEG, photoUpdatedAt: 5 }).apply).toEqual({ dataUrl: JPEG, updatedAt: 5 });
    expect(mergeCloudPhoto({ dataUrl: null, updatedAt: 9 }, { photoData: JPEG, photoUpdatedAt: 5 })).toEqual({ apply: null, push: true });
    expect(mergeCloudPhoto({ dataUrl: JPEG, updatedAt: 5 }, { photoData: JPEG, photoUpdatedAt: 5 })).toEqual({ apply: null, push: false });
    expect(effectivePhoto('http://google', null, { dataUrl: JPEG, updatedAt: 1 })).toBe(JPEG);
    expect(effectivePhoto('http://google', null, { dataUrl: null, updatedAt: 1 })).toBe('http://google');
  });

  it('photo compression picks the best encoding under the cap', () => {
    const enc = (size: number, q: number) => 'x'.repeat(Math.round(size * size * q * 1.5));
    const out = pickEncoding(enc, 100_000);
    expect(out.length).toBeLessThanOrEqual(100_000);
    expect(() => pickEncoding(() => 'x'.repeat(200_000), 100_000)).toThrow();
  });
});

describe('settings decision (pure)', () => {
  it('cloud newer → applied; local newer → kept and uploaded; missing doc → upload', () => {
    const local = { ...defaultSettings, voiceRate: 1.25 };
    expect(decideSettings(local, 100, { voiceRate: 0.85, updatedAt: 200 })).toMatchObject({ apply: { voiceRate: 0.85 }, editedAt: 200, push: false });
    expect(decideSettings(local, 300, { voiceRate: 0.85, updatedAt: 200 })).toMatchObject({ apply: null, push: true });
    expect(decideSettings(local, 0, undefined)).toMatchObject({ apply: null, push: true });
  });
  it('ignores unknown keys, wrong types and this-phone-only settings', () => {
    const clean = sanitizeCloudSettings({ theme: 'dark', updatedAt: 5, updatedBy: 'g', voiceRate: 'fast', sosCancelSec: 8, sosTriggers: { fall: false } });
    expect(clean).toEqual({ sosCancelSec: 8, sosTriggers: { ...defaultSettings.sosTriggers, fall: false } });
  });
});

// ─── sync wiring (fake Firestore) ───────────────────────────

describe('settings sync both ways', () => {
  it('applies a newer cloud change without echoing it back (no loop)', () => {
    startSettingsSync(UID);
    deliver(SETTINGS, { voiceRate: 0.85, assistantVolume: 60, updatedAt: Date.now() - 1000 });
    expect(useSession.getState().settings.voiceRate).toBe(0.85);
    expect(useSession.getState().settings.assistantVolume).toBe(60);
    vi.advanceTimersByTime(5000);
    expect(writesTo(SETTINGS)).toHaveLength(0);
  });

  it('a local change applies instantly, uploads once (debounced) and survives a late stale echo', () => {
    startSettingsSync(UID);
    deliver(SETTINGS, { voiceRate: 1, updatedAt: Date.now() - 60_000 });
    useSession.getState().updateSettings({ voiceRate: 1.25 });
    useSession.getState().updateSettings({ assistantVolume: 70 });
    expect(useSession.getState().settings.voiceRate).toBe(1.25); // instant
    vi.advanceTimersByTime(1500);
    expect(writesTo(SETTINGS)).toHaveLength(1);
    expect(writesTo(SETTINGS)[0].data).toMatchObject({ voiceRate: 1.25, assistantVolume: 70 });
    expect(writesTo(SETTINGS)[0].data.theme).toBeUndefined(); // this phone only
    // Our own write echoes back (pending), then an OLDER server copy arrives late.
    deliver(SETTINGS, { voiceRate: 1.25, updatedAt: Date.now() }, { hasPendingWrites: true });
    deliver(SETTINGS, { voiceRate: 1, assistantVolume: 100, updatedAt: Date.now() - 30_000 });
    expect(useSession.getState().settings.voiceRate).toBe(1.25);
    expect(useSession.getState().settings.assistantVolume).toBe(70);
  });

  it('theme changes stay on this phone', () => {
    startSettingsSync(UID);
    deliver(SETTINGS, { updatedAt: 1 });
    useSession.getState().updateSettings({ theme: 'dark' });
    vi.advanceTimersByTime(3000);
    expect(writesTo(SETTINGS).filter((w) => 'theme' in w.data)).toHaveLength(0);
  });

  it('a change made while offline is not lost when sync stops (flushed into the write queue)', () => {
    startSettingsSync(UID);
    deliver(SETTINGS, { updatedAt: 1 });
    useSession.getState().updateSettings({ sosCancelSec: 9 });
    stopSettingsSync(); // e.g. app going away before the debounce
    expect(writesTo(SETTINGS).at(-1)?.data).toMatchObject({ sosCancelSec: 9 });
  });
});

describe('profile sync', () => {
  it('Google name is the default, an edited name wins and is uploaded, and the screens update at once', () => {
    startSettingsSync(UID);
    deliver(USER, { uid: UID, displayName: 'Google Name', photoURL: null });
    expect(useSession.getState().person.name).toBe('Google Name');
    expect(writesTo(USER)).toHaveLength(0); // the default is not "an edit"

    const editedAt = Date.now();
    setProfileName('Aru');
    expect(useSession.getState().person.name).toBe('Aru');
    expect(useAuth.getState().user?.displayName).toBe('Aru'); // profile menu / avatar initials
    expect(profileName()).toBe('Aru');
    vi.advanceTimersByTime(1000);
    const w = writesTo(USER);
    expect(w).toHaveLength(1);
    expect(w[0].data).toMatchObject({ displayName: 'Aru', nameEditedAt: editedAt });

    // Sign-in again with Google: the doc still says the Google name for a moment (stale) → not applied.
    deliver(USER, { uid: UID, displayName: 'Google Name' });
    expect(useSession.getState().person.name).toBe('Aru');
  });

  it('a profile photo picked here persists, is uploaded once and is restored on another phone', () => {
    startSettingsSync(UID);
    deliver(USER, { uid: UID, displayName: 'Google Name' });
    setCustomPhoto(JPEG);
    expect(effectivePhoto(null, null, usePhotoCache.getState().custom)).toBe(JPEG);
    vi.advanceTimersByTime(1000);
    expect(writesTo(USER).at(-1)?.data).toMatchObject({ photoData: JPEG });
    const n = writesTo(USER).length;
    // Server confirms: the next unrelated edit does not resend the 100 KB photo.
    deliver(USER, { uid: UID, displayName: 'Google Name', photoData: JPEG, photoUpdatedAt: usePhotoCache.getState().custom!.updatedAt });
    useSession.setState({ person: { ...useSession.getState().person, phone: '+91 98765 43210' } });
    vi.advanceTimersByTime(1000);
    expect(writesTo(USER).length).toBe(n + 1);
    expect(writesTo(USER).at(-1)?.data.photoData).toBeUndefined();
    expect(writesTo(USER).at(-1)?.data.phone).toBe('+91 98765 43210');

    // "Another phone": empty local state, same cloud doc → photo and phone restored.
    stopSettingsSync();
    useSession.setState({ person: emptyPerson(), profileEditedAt: undefined });
    usePhotoCache.setState({ custom: null });
    writes.length = 0;
    startSettingsSync(UID);
    deliver(USER, { uid: UID, displayName: 'Google Name', phone: '+91 98765 43210', profileUpdatedAt: 50, photoData: JPEG, photoUpdatedAt: 40 });
    expect(usePhotoCache.getState().custom?.dataUrl).toBe(JPEG);
    expect(useSession.getState().person.phone).toBe('+91 98765 43210');
    vi.advanceTimersByTime(3000);
    expect(writesTo(USER)).toHaveLength(0); // restoring is not an edit: nothing echoed back
  });

  it('never writes before the user doc exists (rules would reject a create)', () => {
    startSettingsSync(UID);
    setProfileName('Aru');
    vi.advanceTimersByTime(2000);
    expect(writesTo(USER)).toHaveLength(0);
    deliver(USER, { uid: UID, displayName: 'Google Name' });
    vi.advanceTimersByTime(1000);
    expect(writesTo(USER).at(-1)?.data).toMatchObject({ displayName: 'Aru' });
  });

  it('a guardian phone never uploads the person it looks after as its own profile', () => {
    useAuth.setState({ role: 'guardian' });
    startSettingsSync(UID);
    expect(listeners.has(USER)).toBe(false);
  });

  it('sign-out clears the account from the phone without uploading the clearing', async () => {
    const { clearLocalAccountData } = await import('../src/core/auth/authService');
    startSettingsSync(UID);
    deliver(USER, { uid: UID, displayName: 'Google Name' });
    deliver(SETTINGS, { updatedAt: 1 });
    setProfileName('Aru');
    useSession.getState().updateSettings({ theme: 'dark', sosCancelSec: 9 });
    vi.advanceTimersByTime(2000);
    const before = writes.length;
    await clearLocalAccountData();
    vi.advanceTimersByTime(5000);
    const s = useSession.getState();
    expect(s.person.name).toBe('');
    expect(s.settings.sosCancelSec).toBe(defaultSettings.sosCancelSec);
    expect(s.settings.theme).toBe('dark'); // this phone's own preference stays
    expect(usePhotoCache.getState().custom).toBeNull();
    // Nothing that looks like "name/places deleted" went to the cloud.
    expect(writes.slice(before).filter((w) => w.path === USER)).toHaveLength(0);
  });
});
