import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ callback: null as null | ((u: any) => Promise<void>), getDoc: vi.fn(), cache: vi.fn(), transaction: vi.fn(), transactionGet: vi.fn(), transactionSet: vi.fn(), native: true, google: vi.fn(), credential: vi.fn(), popup: vi.fn(), signOut: vi.fn(), auth: { currentUser: null as any }, storage: new Map<string, string>(), resetWalk: vi.fn() }));
vi.mock('../src/core/firebase/app', () => ({ fb: () => ({ auth: mock.auth, db: {} }), FirebaseNotConfigured: class extends Error {} }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => mock.native } }));
vi.mock('@capacitor-firebase/authentication', () => ({ FirebaseAuthentication: { signInWithGoogle: mock.google, signOut: vi.fn(async () => {}) } }));
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_: unknown, cb: typeof mock.callback) => { mock.callback = cb; return () => {}; },
  GoogleAuthProvider: class { static credential(token: string) { return token; } }, signInWithCredential: mock.credential, signInWithPopup: mock.popup, signOut: mock.signOut,
}));
vi.mock('firebase/firestore', () => ({ doc: () => ({}), getDocFromServer: mock.getDoc, getDocFromCache: mock.cache, runTransaction: mock.transaction, updateDoc: vi.fn(async () => {}), setDoc: vi.fn(async () => {}), serverTimestamp: () => 1 }));
vi.mock('../src/core/sync/settingsSync', () => ({ stopSettingsSync: vi.fn(), LOCAL_ONLY: ['theme'] }));
vi.mock('../src/core/walking/walkTracker', () => ({ resetWalkTracker: mock.resetWalk }));
vi.mock('../src/core/profile/photoCache', () => ({ clearProfilePhoto: vi.fn() }));
vi.stubGlobal('localStorage', {
  getItem: (key: string) => mock.storage.get(key) ?? null,
  setItem: (key: string, value: string) => mock.storage.set(key, value),
  removeItem: (key: string) => mock.storage.delete(key),
});
const { startAuth, clearLocalAccountData, signInWithGoogle, signOut, AUTH_PROFILE_TIMEOUT_MS } = await import('../src/core/auth/authService');
const { signInPresentation, useAuth } = await import('../src/core/auth/authStore');
const { useSession, defaultSettings, emptyPerson } = await import('../src/core/store/session');
const user = (uid: string) => ({ uid, displayName: 'User', email: null, photoURL: null });
const profile = (role: string) => ({ exists: () => true, data: () => ({ role, displayName: 'User' }) });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => {
  vi.clearAllMocks(); mock.storage.clear(); mock.auth.currentUser = null;
  for (const fn of [mock.getDoc, mock.cache, mock.transaction, mock.transactionGet, mock.transactionSet, mock.google, mock.credential, mock.popup, mock.signOut]) fn.mockReset();
  mock.native = true;
  mock.cache.mockRejectedValue(new Error('No cached profile'));
  mock.transaction.mockImplementation(async (_db, run) => run({ get: mock.transactionGet, set: mock.transactionSet }));
  mock.google.mockResolvedValue({ credential: { idToken: 'test-id-token' } });
  mock.credential.mockImplementation(async () => { mock.auth.currentUser = user('u1'); void mock.callback!(mock.auth.currentUser); });
  mock.popup.mockImplementation(async () => { mock.auth.currentUser = user('u1'); void mock.callback!(mock.auth.currentUser); });
  mock.signOut.mockImplementation(async () => { mock.auth.currentUser = null; await mock.callback!(null); });
  useAuth.setState({ status: 'loading', user: null, role: null, profile: null, busy: false, phase: 'restoring', error: null });
  useSession.setState({ person: emptyPerson(), contacts: [], settings: { ...defaultSettings }, profileEditedAt: undefined, settingsEditedAt: undefined });
});
afterEach(() => { vi.useRealTimers(); });
const privateCache = () => useSession.setState({
  person: { ...emptyPerson(), name: 'Account A private name', nameEditedAt: 500, phone: 'private-A', homeAddress: 'Private home A' },
  contacts: [{ id: 'A', name: 'Account A contact', phone: 'private-A', relation: '', aliases: [] }],
  settings: { ...defaultSettings, theme: 'dark', sosMessage: 'Private message A' },
  profileEditedAt: 500, settingsEditedAt: 500,
});

describe('verified app account lifecycle', () => {
  it('does not authorize runtime services if the profile cannot be verified', async () => {
    const start = vi.fn(), stop = vi.fn();
    mock.getDoc.mockRejectedValueOnce(new Error('offline without cached profile'));
    startAuth(start, stop);
    mock.auth.currentUser = user('u1');
    await mock.callback!(mock.auth.currentUser);
    expect(start).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(useAuth.getState().status).toBe('error');
  });

  it('rejects a Guardian account in the user package before runtime startup', async () => {
    const start = vi.fn(), stop = vi.fn();
    mock.getDoc.mockResolvedValueOnce(profile('guardian'));
    startAuth(start, stop);
    mock.auth.currentUser = user('guardian');
    await mock.callback!(mock.auth.currentUser);
    expect(start).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(useAuth.getState().status).toBe('error');
  });

  it('ignores an old account profile finishing after the current account', async () => {
    let release!: (p: ReturnType<typeof profile>) => void;
    mock.getDoc.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    mock.getDoc.mockResolvedValueOnce(profile('user'));
    const start = vi.fn();
    startAuth(start, vi.fn());
    mock.auth.currentUser = user('old');
    const old = mock.callback!(mock.auth.currentUser);
    await flush(); // let the old request enter its deferred profile read
    mock.auth.currentUser = user('current');
    await mock.callback!(mock.auth.currentUser);
    release(profile('user'));
    await old;
    expect(start.mock.calls).toEqual([['current']]);
    expect(useAuth.getState().user?.uid).toBe('current');
  });

  it('clears the prior account before starting a directly switched UID', async () => {
    mock.getDoc.mockResolvedValue(profile('user'));
    const states: { uid: string; phone: string; contacts: number }[] = [];
    const stop = vi.fn();
    startAuth((uid) => states.push({ uid, phone: useSession.getState().person.phone, contacts: useSession.getState().contacts.length }), stop);
    mock.auth.currentUser = user('A'); await mock.callback!(mock.auth.currentUser);
    privateCache();
    mock.auth.currentUser = user('B'); await mock.callback!(mock.auth.currentUser);
    expect(stop).toHaveBeenCalledOnce();
    expect(states.at(-1)).toEqual({ uid: 'B', phone: '', contacts: 0 });
    expect(useSession.getState()).toMatchObject({ profileEditedAt: undefined, settingsEditedAt: undefined, settings: { sosMessage: defaultSettings.sosMessage, theme: 'dark' } });
    expect(mock.resetWalk).toHaveBeenCalledOnce();
  });

  it('uses the persisted owner when a different UID restores after process restart', async () => {
    mock.getDoc.mockResolvedValue(profile('user'));
    const off = startAuth(vi.fn(), vi.fn());
    mock.auth.currentUser = user('A'); await mock.callback!(mock.auth.currentUser);
    privateCache(); off();
    const start = vi.fn(() => expect(useSession.getState().contacts).toEqual([]));
    startAuth(start, vi.fn());
    mock.auth.currentUser = user('B'); await mock.callback!(mock.auth.currentUser);
    expect(start).toHaveBeenCalledWith('B');
    expect(useSession.getState().person.phone).toBe('');
  });

  it('keeps the same account cache across a restart', async () => {
    mock.getDoc.mockResolvedValue(profile('user'));
    const off = startAuth(vi.fn(), vi.fn());
    mock.auth.currentUser = user('A'); await mock.callback!(mock.auth.currentUser);
    privateCache(); off();
    startAuth(vi.fn(), vi.fn());
    await mock.callback!(mock.auth.currentUser);
    expect(useSession.getState().person.phone).toBe('private-A');
    expect(useSession.getState().contacts[0]?.id).toBe('A');
    expect(mock.resetWalk).not.toHaveBeenCalled();
  });

  it('waits for a queued sign-out clear before starting a new account', async () => {
    mock.getDoc.mockResolvedValue(profile('user'));
    const seen: string[] = [];
    startAuth((uid) => { if (uid === 'B') seen.push(useSession.getState().person.phone); }, () => { void clearLocalAccountData(); });
    mock.auth.currentUser = user('A'); await mock.callback!(mock.auth.currentUser);
    privateCache();
    mock.auth.currentUser = null;
    const signedOut = mock.callback!(null);
    mock.auth.currentUser = user('B');
    await mock.callback!(mock.auth.currentUser); await signedOut;
    expect(seen).toEqual(['']);
    expect(useSession.getState().contacts).toEqual([]);
  });

  it('uses the existing avatar account as a legacy cache owner', async () => {
    mock.getDoc.mockResolvedValue(profile('user'));
    mock.storage.set('aiss.profilePhoto.account.v1', JSON.stringify({ uid: 'A' }));
    privateCache();
    startAuth(vi.fn(), vi.fn());
    mock.auth.currentUser = user('B'); await mock.callback!(mock.auth.currentUser);
    expect(useSession.getState().person.phone).toBe('');
  });

  it('ignores an intermediate account when another switch happens during cleanup', async () => {
    mock.getDoc.mockResolvedValue(profile('user'));
    const start = vi.fn();
    startAuth(start, vi.fn());
    mock.auth.currentUser = user('A'); await mock.callback!(mock.auth.currentUser);
    privateCache();
    mock.auth.currentUser = user('B');
    const intermediate = mock.callback!(mock.auth.currentUser);
    mock.auth.currentUser = user('C');
    await mock.callback!(mock.auth.currentUser); await intermediate;
    expect(start.mock.calls).toEqual([['A'], ['C']]);
    expect(useSession.getState().contacts).toEqual([]);
    expect(useAuth.getState().user?.uid).toBe('C');
  });
});

describe('Google identity and profile completion are one sign-in operation', () => {
  const signedOut = async () => {
    const start = vi.fn(), stop = vi.fn();
    startAuth(start, stop);
    await mock.callback!(null);
    return { start, stop };
  };

  it('keeps the native button blocked after OAuth while a slow profile resolves, and shares duplicate calls', async () => {
    let release!: (p: ReturnType<typeof profile>) => void;
    mock.getDoc.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const { start } = await signedOut();
    const first = signInWithGoogle('user');
    const second = signInWithGoogle('user');
    expect(second).toBe(first);
    await flush();
    expect(mock.google).toHaveBeenCalledOnce();
    expect(mock.credential).toHaveBeenCalledOnce();
    expect(mock.getDoc).toHaveBeenCalledOnce();
    expect(useAuth.getState()).toMatchObject({ status: 'loading', busy: true, phase: 'profile' });
    expect(signInPresentation(useAuth.getState())).toEqual({ pending: true, label: 'Setting up your account…' });
    expect(signInWithGoogle('user')).toBe(first);
    release(profile('user'));
    await first;
    expect(useAuth.getState()).toMatchObject({ status: 'signedIn', busy: false, phase: null });
    expect(start.mock.calls).toEqual([['u1']]);
    await signInWithGoogle('user');
    expect(mock.google).toHaveBeenCalledOnce();
  });

  it('uses the same completion lock for web Google sign-in', async () => {
    mock.native = false;
    let release!: (p: ReturnType<typeof profile>) => void;
    mock.getDoc.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await signedOut();
    const first = signInWithGoogle('user');
    await flush();
    expect(signInWithGoogle('user')).toBe(first);
    expect(mock.popup).toHaveBeenCalledOnce();
    expect(mock.google).not.toHaveBeenCalled();
    release(profile('user')); await first;
    expect(useAuth.getState().status).toBe('signedIn');
  });

  it('blocks restored-account setup and joins its pending profile without opening Google', async () => {
    let release!: (p: ReturnType<typeof profile>) => void;
    mock.getDoc.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    startAuth(vi.fn(), vi.fn());
    mock.auth.currentUser = user('restored');
    const restoring = mock.callback!(mock.auth.currentUser);
    await flush();
    const joining = signInWithGoogle('user');
    expect(signInPresentation(useAuth.getState()).pending).toBe(true);
    expect(mock.google).not.toHaveBeenCalled();
    expect(mock.getDoc).toHaveBeenCalledOnce();
    release(profile('user')); await Promise.all([restoring, joining]);
    expect(useAuth.getState().status).toBe('signedIn');
  });

  it('times out an uncached profile, retains Google identity, and retries it without another picker', async () => {
    vi.useFakeTimers();
    let releaseOld!: (p: ReturnType<typeof profile>) => void;
    mock.getDoc.mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve; }));
    const { start } = await signedOut();
    const signing = signInWithGoogle('user');
    await flush();
    await vi.advanceTimersByTimeAsync(AUTH_PROFILE_TIMEOUT_MS);
    await signing;
    expect(useAuth.getState()).toMatchObject({ status: 'error', busy: false, user: { uid: 'u1' } });
    expect(signInPresentation(useAuth.getState())).toEqual({ pending: false, label: 'Retry account setup' });
    expect(start).not.toHaveBeenCalled();
    mock.getDoc.mockResolvedValueOnce(profile('user'));
    await signInWithGoogle('user');
    expect(mock.google).toHaveBeenCalledOnce();
    expect(start.mock.calls).toEqual([['u1']]);
    releaseOld(profile('guardian')); await flush();
    expect(useAuth.getState()).toMatchObject({ status: 'signedIn', role: 'user' });
    expect(start.mock.calls).toEqual([['u1']]);
  });

  it('recovers from Google cancellation and lets a later attempt start once', async () => {
    mock.google.mockRejectedValueOnce(new Error('User cancelled sign-in'));
    mock.getDoc.mockResolvedValueOnce(profile('user'));
    await signedOut();
    await expect(signInWithGoogle('user')).rejects.toThrow('cancelled');
    expect(useAuth.getState()).toMatchObject({ status: 'signedOut', busy: false, phase: null, error: 'Sign-in was cancelled.' });
    await signInWithGoogle('user');
    expect(mock.google).toHaveBeenCalledTimes(2);
    expect(useAuth.getState().status).toBe('signedIn');
  });

  it('returns a retryable profile error without reopening Google on retry', async () => {
    mock.getDoc.mockRejectedValueOnce(new Error('offline without a cached account'));
    const { start } = await signedOut();
    await signInWithGoogle('user');
    expect(useAuth.getState()).toMatchObject({ status: 'error', busy: false });
    expect(start).not.toHaveBeenCalled();
    mock.getDoc.mockResolvedValueOnce(profile('user'));
    await signInWithGoogle('user');
    expect(mock.google).toHaveBeenCalledOnce();
    expect(useAuth.getState().status).toBe('signedIn');
  });

  it('restores an existing acknowledged cached role without waiting for a server', async () => {
    mock.cache.mockResolvedValueOnce({ ...profile('user'), metadata: { hasPendingWrites: false } });
    mock.getDoc.mockImplementationOnce(() => new Promise(() => {}));
    const { start } = await signedOut();
    await signInWithGoogle('user');
    expect(mock.getDoc).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith('u1');
    expect(useAuth.getState().status).toBe('signedIn');
  });

  it('does not authorize a locally pending registration when the server is unavailable', async () => {
    mock.cache.mockResolvedValueOnce({ ...profile('user'), metadata: { hasPendingWrites: true } });
    mock.getDoc.mockRejectedValueOnce(new Error('offline'));
    const { start } = await signedOut();
    await signInWithGoogle('user');
    expect(start).not.toHaveBeenCalled();
    expect(useAuth.getState().status).toBe('error');
    expect(mock.transaction).not.toHaveBeenCalled();
  });

  it('never converts a missing offline cache into a new profile', async () => {
    mock.cache.mockResolvedValueOnce({ exists: () => false, metadata: { hasPendingWrites: false } });
    mock.getDoc.mockRejectedValueOnce(new Error('offline'));
    const { start } = await signedOut();
    await signInWithGoogle('user');
    expect(start).not.toHaveBeenCalled();
    expect(mock.transaction).not.toHaveBeenCalled();
  });

  it('waits for new-profile registration acknowledgement before authorizing services', async () => {
    let acknowledge!: () => void;
    const missing = { exists: () => false };
    mock.getDoc.mockResolvedValueOnce(missing);
    mock.transactionGet.mockResolvedValueOnce(missing);
    mock.transaction.mockImplementationOnce(async (_db, run) => { const result = await run({ get: mock.transactionGet, set: mock.transactionSet }); await new Promise<void>((resolve) => { acknowledge = resolve; }); return result; });
    const { start } = await signedOut();
    const signing = signInWithGoogle('user');
    await flush();
    expect(mock.transactionSet).toHaveBeenCalledOnce();
    expect(useAuth.getState()).toMatchObject({ status: 'loading', busy: true });
    expect(start).not.toHaveBeenCalled();
    acknowledge(); await signing;
    expect(start).toHaveBeenCalledWith('u1');
  });

  it('keeps a concurrently created Guardian role and permits a different Google account', async () => {
    mock.getDoc.mockResolvedValueOnce({ exists: () => false });
    mock.transactionGet.mockResolvedValueOnce(profile('guardian'));
    const { start } = await signedOut();
    await signInWithGoogle('user');
    expect(useAuth.getState()).toMatchObject({ status: 'error', profile: { role: 'guardian' } });
    expect(start).not.toHaveBeenCalled();
    expect(mock.transactionSet).not.toHaveBeenCalled();
    mock.getDoc.mockResolvedValueOnce(profile('user'));
    mock.credential.mockImplementationOnce(async () => { mock.auth.currentUser = user('separate-user'); void mock.callback!(mock.auth.currentUser); });
    await signInWithGoogle('user');
    expect(mock.google).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledWith('separate-user');
    expect(useAuth.getState()).toMatchObject({ status: 'signedIn', user: { uid: 'separate-user' } });
  });

  it('does not resurrect a timed-out or pending account after sign-out', async () => {
    let release!: (p: ReturnType<typeof profile>) => void;
    mock.getDoc.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const { start } = await signedOut();
    const signing = signInWithGoogle('user');
    await flush();
    mock.auth.currentUser = null;
    await mock.callback!(null);
    release(profile('user')); await signing;
    expect(start).not.toHaveBeenCalled();
    expect(useAuth.getState()).toMatchObject({ status: 'signedOut', busy: false, user: null });
  });

  it('blocks the initial restore screen even before Firebase publishes an identity', () => {
    expect(signInPresentation(useAuth.getState())).toEqual({ pending: true, label: 'Checking sign-in…' });
  });

  it('restores a previously verified role offline when mutable profile edits are still queued', async () => {
    mock.getDoc.mockResolvedValueOnce(profile('user'));
    const off = startAuth(vi.fn(), vi.fn());
    mock.auth.currentUser = user('u1');
    await mock.callback!(mock.auth.currentUser);
    off();
    mock.getDoc.mockClear();
    mock.cache.mockResolvedValueOnce({ exists: () => true, data: () => ({ uid: 'u1', role: 'user', displayName: 'Offline edited name', nameEditedAt: 123 }), metadata: { hasPendingWrites: true } });
    mock.getDoc.mockRejectedValueOnce(new Error('offline'));
    const start = vi.fn();
    startAuth(start, vi.fn());
    await mock.callback!(mock.auth.currentUser);
    expect(mock.getDoc).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith('u1');
    expect(useAuth.getState()).toMatchObject({ status: 'signedIn', role: 'user', user: { displayName: 'Offline edited name' } });
  });

  it('does not use a remembered role for a different UID or conflicting pending role', async () => {
    mock.storage.set('aiss.account.verifiedRole.v1', JSON.stringify({ uid: 'different-uid', role: 'user' }));
    mock.cache.mockResolvedValueOnce({ ...profile('user'), metadata: { hasPendingWrites: true } });
    mock.getDoc.mockRejectedValueOnce(new Error('offline'));
    const { start } = await signedOut();
    await signInWithGoogle('user');
    expect(start).not.toHaveBeenCalled();
    mock.storage.set('aiss.account.verifiedRole.v1', JSON.stringify({ uid: 'u1', role: 'guardian' }));
    mock.cache.mockResolvedValueOnce({ ...profile('user'), metadata: { hasPendingWrites: true } });
    mock.getDoc.mockRejectedValueOnce(new Error('offline'));
    await signInWithGoogle('user');
    expect(start).not.toHaveBeenCalled();
    expect(useAuth.getState().status).toBe('error');
  });

  it('discards native Google completion after explicit sign-out before exchanging a credential', async () => {
    let finishGoogle!: (r: unknown) => void;
    mock.google.mockImplementationOnce(() => new Promise((resolve) => { finishGoogle = resolve; }));
    const { start } = await signedOut();
    const signing = signInWithGoogle('user');
    await flush();
    await signOut();
    await signing;
    finishGoogle({ credential: { idToken: 'discarded-token' } });
    await flush();
    expect(mock.credential).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(useAuth.getState()).toMatchObject({ status: 'signedOut', busy: false });
  });

  it('discards OAuth from a disposed listener instead of using a replacement account resolver', async () => {
    let finishGoogle!: (r: unknown) => void;
    mock.google.mockImplementationOnce(() => new Promise((resolve) => { finishGoogle = resolve; }));
    const oldStart = vi.fn(), nextStart = vi.fn();
    const off = startAuth(oldStart, vi.fn());
    await mock.callback!(null);
    const signing = signInWithGoogle('user');
    await flush();
    off();
    startAuth(nextStart, vi.fn());
    await mock.callback!(null);
    await signing;
    finishGoogle({ credential: { idToken: 'discarded-token' } });
    await flush();
    expect(mock.credential).not.toHaveBeenCalled();
    expect(oldStart).not.toHaveBeenCalled();
    expect(nextStart).not.toHaveBeenCalled();
    expect(useAuth.getState()).toMatchObject({ status: 'signedOut', busy: false });
  });

  it('ignores an identity published by a credential exchange after explicit sign-out', async () => {
    let finishCredential!: () => void;
    mock.credential.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishCredential = resolve; });
      mock.auth.currentUser = user('cancelled-user');
      await mock.callback!(mock.auth.currentUser);
    });
    mock.getDoc.mockResolvedValue(profile('user'));
    const { start } = await signedOut();
    const signing = signInWithGoogle('user');
    await flush();
    const signingOut = signOut();
    await signing;
    finishCredential();
    await signingOut;
    await flush();
    expect(start).not.toHaveBeenCalled();
    expect(mock.getDoc).not.toHaveBeenCalled();
    expect(mock.auth.currentUser).toBeNull();
    expect(useAuth.getState()).toMatchObject({ status: 'signedOut', busy: false, user: null });
  });

  it('discards a cancelled web popup identity before letting another attempt proceed', async () => {
    mock.native = false;
    let finishPopup!: () => void;
    mock.popup.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishPopup = resolve; });
      mock.auth.currentUser = user('cancelled-web-user');
      await mock.callback!(mock.auth.currentUser);
    });
    const { start } = await signedOut();
    const signing = signInWithGoogle('user');
    await flush();
    const signingOut = signOut();
    await signing;
    finishPopup();
    await signingOut;
    await flush();
    expect(start).not.toHaveBeenCalled();
    expect(mock.auth.currentUser).toBeNull();
    expect(useAuth.getState()).toMatchObject({ status: 'signedOut', busy: false });
    mock.getDoc.mockResolvedValueOnce(profile('user'));
    await signInWithGoogle('user');
    expect(start).toHaveBeenCalledWith('u1');
    expect(mock.popup).toHaveBeenCalledTimes(2);
  });

  it('does not authorize a late registration acknowledgement until an explicit retry verifies it', async () => {
    vi.useFakeTimers();
    let acknowledge!: () => void;
    const missing = { exists: () => false };
    mock.getDoc.mockResolvedValueOnce(missing);
    mock.transactionGet.mockResolvedValueOnce(missing);
    mock.transaction.mockImplementationOnce(async (_db, run) => { const result = await run({ get: mock.transactionGet, set: mock.transactionSet }); await new Promise<void>((resolve) => { acknowledge = resolve; }); return result; });
    const { start } = await signedOut();
    const signing = signInWithGoogle('user');
    await flush();
    await vi.advanceTimersByTimeAsync(AUTH_PROFILE_TIMEOUT_MS);
    await signing;
    expect(useAuth.getState().status).toBe('error');
    acknowledge(); await flush();
    expect(start).not.toHaveBeenCalled();
    expect(mock.storage.get('aiss.account.verifiedRole.v1')).toBeUndefined();
    mock.getDoc.mockResolvedValueOnce(profile('user'));
    await signInWithGoogle('user');
    expect(start).toHaveBeenCalledWith('u1');
    expect(mock.google).toHaveBeenCalledOnce();
  });
});
