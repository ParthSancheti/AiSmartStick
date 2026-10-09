import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Profile photo on this phone: what the avatar shows on the very first frame after an app start
 * (before Firebase restored the session), never a "?".
 */

class MemStorage {
  m = new Map<string, string>();
  quota = Infinity;
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    const used = [...this.m.entries()].filter(([key]) => key !== k).reduce((n, [key, val]) => n + key.length + val.length, 0);
    if (used + k.length + v.length > this.quota) throw new Error('QuotaExceededError');
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
const ls = new MemStorage();
vi.stubGlobal('localStorage', ls);

const JPEG = 'data:image/jpeg;base64,' + 'A'.repeat(200);
const GOOGLE = 'data:image/jpeg;base64,' + 'G'.repeat(200);
const URL1 = 'https://lh3.googleusercontent.com/a/abc=s96-c';
const URL2 = 'https://lh3.googleusercontent.com/a/new=s96-c';

async function freshModule() {
  vi.resetModules();
  return import('../src/core/profile/photoCache');
}

beforeEach(() => {
  ls.clear();
  ls.quota = Infinity;
});

describe('photo candidates', () => {
  it('the picked photo wins everywhere', async () => {
    const { photoCandidates } = await freshModule();
    expect(photoCandidates({ uid: 'u', photoURL: URL1 }, 'signedIn', { custom: { dataUrl: JPEG, updatedAt: 1 }, cached: { url: URL1, dataUrl: GOOGLE }, last: null })).toEqual([JPEG]);
  });

  it('while Firebase restores the session, the last account on this phone stands in (no "?")', async () => {
    const { photoCandidates } = await freshModule();
    const photos = { custom: null, cached: { url: URL1, dataUrl: GOOGLE, uid: 'u' }, last: { uid: 'u', photoURL: URL1, name: 'Aru Sharma' } };
    expect(photoCandidates(null, 'loading', photos)).toEqual([GOOGLE]);
    // Offline start: auth may end in "error" but the photo stays.
    expect(photoCandidates(null, 'error', photos)).toEqual([GOOGLE]);
    // Signed out: nothing of the previous account.
    expect(photoCandidates(null, 'signedOut', photos)).toEqual([]);
  });

  it('a new Google photo URL tries the network first, then the older local copy', async () => {
    const { photoCandidates } = await freshModule();
    expect(photoCandidates({ uid: 'u', photoURL: URL2 }, 'signedIn', { custom: null, cached: { url: URL1, dataUrl: GOOGLE, uid: 'u' }, last: null })).toEqual([URL2, GOOGLE]);
  });

  it("another account's cached photo is never shown", async () => {
    const { photoCandidates } = await freshModule();
    expect(photoCandidates({ uid: 'other', photoURL: URL2 }, 'signedIn', { custom: null, cached: { url: URL1, dataUrl: GOOGLE, uid: 'u' }, last: null })).toEqual([URL2]);
    expect(photoCandidates({ uid: 'other', photoURL: null }, 'signedIn', { custom: null, cached: { url: URL1, dataUrl: GOOGLE, uid: 'u' }, last: null })).toEqual([]);
  });
});

describe('kept on the phone', () => {
  it('picked photo and last account survive an app restart (read synchronously at load)', async () => {
    let m = await freshModule();
    m.setCustomPhoto(JPEG, 5);
    m.rememberAccount('u', URL1, 'Aru Sharma');
    m = await freshModule();
    const s = m.usePhotoCache.getState();
    expect(s.custom).toEqual({ dataUrl: JPEG, updatedAt: 5 });
    expect(s.last).toEqual({ uid: 'u', photoURL: URL1, name: 'Aru Sharma' });
  });

  it('rememberAccount keeps the known name when the new value has none', async () => {
    const m = await freshModule();
    m.rememberAccount('u', URL1, 'Aru');
    m.rememberAccount('u', URL1, null);
    expect(m.usePhotoCache.getState().last?.name).toBe('Aru');
  });

  it('a full storage drops the re-downloadable Google copy to keep the picked photo', async () => {
    ls.setItem('aiss.profilePhoto.v1', JSON.stringify({ url: URL1, dataUrl: 'data:image/jpeg;base64,' + 'G'.repeat(5000) }));
    ls.quota = 5200;
    let m = await freshModule();
    m.setCustomPhoto(JPEG, 7);
    m = await freshModule();
    expect(m.usePhotoCache.getState().custom?.dataUrl).toBe(JPEG);
  });

  it('sign-out clears every photo and the remembered account', async () => {
    let m = await freshModule();
    m.setCustomPhoto(JPEG, 5);
    m.rememberAccount('u', URL1, 'Aru');
    m.clearProfilePhoto();
    m = await freshModule();
    expect(m.usePhotoCache.getState()).toEqual({ cached: null, custom: null, last: null });
  });
});

describe('initials', () => {
  it('never "?"', async () => {
    const { initialsOf } = await import('../src/core/auth/authStore');
    expect(initialsOf('')).toBe('');
    expect(initialsOf(null)).toBe('');
    expect(initialsOf('aru sharma')).toBe('AS');
    expect(initialsOf('  अरु  ')).toBe('अ');
  });
});
