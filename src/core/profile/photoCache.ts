import { create } from 'zustand';

/**
 * The account's profile photo on this phone. Two sources, one answer (`photoCandidates`):
 *  - custom: a photo the person picked in the app (onboarding or Settings), already compressed to
 *    a small JPEG data URL. It wins everywhere. Synced to the user doc (core/sync/profileSync.ts),
 *    so the same account on another phone gets it. `dataUrl: null` with a time = "removed" (a
 *    tombstone, so an older cloud copy can never bring it back).
 *  - cached: the Google account photo, downloaded once, shrunk to a small JPEG and kept here
 *    (localStorage), so Home renders it instantly and offline. Re-fetched only when the account's
 *    photo URL changes.
 *  - last: who was signed in on this phone (uid, Google photo URL, name). Firebase restores the
 *    session asynchronously (a second or more, longer offline); until then `useAuth().user` is
 *    null. Without this the header showed "?" on every app start. Cleared on sign-out.
 *
 * Everything is read SYNCHRONOUSLY from localStorage when this module loads, so the very first
 * frame already has the photo. All values are small (≤ ~150 KB in total).
 */
const KEY = 'aiss.profilePhoto.v1';
const CUSTOM_KEY = 'aiss.profilePhoto.custom.v1';
const LAST_KEY = 'aiss.profilePhoto.account.v1';
/** Largest Google-photo copy kept on the phone (data URL characters). */
export const GOOGLE_PHOTO_MAX_CHARS = 150_000;

export interface Cached {
  url: string;
  dataUrl: string;
  /** Account the copy belongs to (missing in copies saved by older versions). */
  uid?: string;
}

export interface CustomPhoto {
  /** JPEG data URL, or null when the person removed their photo. */
  dataUrl: string | null;
  updatedAt: number;
}

/** The account last signed in on this phone. */
export interface LastAccount {
  uid: string;
  photoURL: string | null;
  name: string;
}

const isImageData = (v: unknown): v is string => typeof v === 'string' && v.startsWith('data:image/');

function readJson<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
}

function read(): Cached | null {
  const v = readJson<Cached>(KEY);
  return v?.url && isImageData(v.dataUrl) ? { url: v.url, dataUrl: v.dataUrl, ...(typeof v.uid === 'string' ? { uid: v.uid } : {}) } : null;
}

function readCustom(): CustomPhoto | null {
  const v = readJson<CustomPhoto>(CUSTOM_KEY);
  if (!v || typeof v.updatedAt !== 'number') return null;
  return { dataUrl: isImageData(v.dataUrl) ? v.dataUrl : null, updatedAt: v.updatedAt };
}

function readLast(): LastAccount | null {
  const v = readJson<LastAccount>(LAST_KEY);
  if (!v || typeof v.uid !== 'string' || !v.uid) return null;
  return { uid: v.uid, photoURL: typeof v.photoURL === 'string' && v.photoURL ? v.photoURL : null, name: typeof v.name === 'string' ? v.name : '' };
}

/** localStorage write that survives a full quota once: drops the (re-downloadable) Google copy and retries. */
function store(key: string, value: unknown): boolean {
  const json = JSON.stringify(value);
  try {
    localStorage.setItem(key, json);
    return true;
  } catch {
    try {
      if (key !== KEY) localStorage.removeItem(KEY);
      localStorage.setItem(key, json);
      return true;
    } catch {
      return false;
    }
  }
}

export const usePhotoCache = create<{ cached: Cached | null; custom: CustomPhoto | null; last: LastAccount | null }>(() => ({ cached: read(), custom: readCustom(), last: readLast() }));

/**
 * Remembers who is signed in (photo URL + name), so the next app start can show their photo and
 * initials before Firebase has restored the session. Cheap: writes only on a change.
 */
export function rememberAccount(uid: string | null | undefined, photoURL: string | null | undefined, name: string | null | undefined) {
  if (!uid) return;
  const v: LastAccount = { uid, photoURL: photoURL || null, name: (name ?? '').trim() };
  const cur = usePhotoCache.getState().last;
  if (cur && cur.uid === v.uid && cur.photoURL === v.photoURL && (cur.name === v.name || !v.name)) return;
  if (cur && cur.uid === v.uid && !v.name) v.name = cur.name;
  store(LAST_KEY, v);
  usePhotoCache.setState({ last: v });
}

let inflight: string | null = null;

/** Blob → data URL. */
function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Second way in when fetch() is refused (CORS in the WebView): an <img> with crossOrigin drawn to a canvas. */
function imageToDataUrl(src: string) {
  return new Promise<string>((resolve, reject) => {
    if (typeof Image === 'undefined' || typeof document === 'undefined') return reject(new Error('no DOM'));
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    const t = setTimeout(() => reject(new Error('timeout')), 15000);
    img.onload = () => {
      clearTimeout(t);
      try {
        const side = Math.min(img.naturalWidth, img.naturalHeight, 256);
        if (!side) throw new Error('empty image');
        const c = document.createElement('canvas');
        c.width = side;
        c.height = side;
        const ctx = c.getContext('2d');
        if (!ctx) throw new Error('no canvas');
        const s = Math.min(img.naturalWidth, img.naturalHeight);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, side, side);
        ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, side, side);
        resolve(c.toDataURL('image/jpeg', 0.85));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => {
      clearTimeout(t);
      reject(new Error('image failed'));
    };
    img.src = src;
  });
}

async function downloadPhoto(src: string): Promise<string> {
  try {
    const res = await fetch(src, { cache: 'force-cache', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') || blob.size > 2_000_000) throw new Error('not a usable image');
    try {
      // Same small square JPEG as a picked photo (≤ 100 KB): localStorage stays tiny.
      const { compressProfilePhoto } = await import('./imageCompress');
      return await compressProfilePhoto(blob);
    } catch {
      return await blobToDataUrl(blob);
    }
  } catch {
    return await imageToDataUrl(src);
  }
}

/**
 * Ensures the Google photo for `url` is kept on the phone. Safe to call often; downloads at most once
 * per URL (and again after a failure, e.g. when the phone is back online).
 */
export async function cacheProfilePhoto(url: string | null | undefined, uid?: string | null) {
  const cur = usePhotoCache.getState().cached;
  if (!url || url.startsWith('data:') || inflight === url) return;
  if (cur?.url === url && (!uid || !cur.uid || cur.uid === uid)) return;
  inflight = url;
  try {
    // Ask Google for a crisp but small square (s256) instead of the default 96 px thumbnail.
    const sized = /googleusercontent\.com/.test(url) ? url.replace(/=s\d+(-c)?$/, '=s256-c') : url;
    const dataUrl = await downloadPhoto(sized);
    if (!isImageData(dataUrl) || dataUrl.length > GOOGLE_PHOTO_MAX_CHARS) throw new Error('photo too large');
    const v: Cached = uid ? { url, dataUrl, uid } : { url, dataUrl };
    try {
      localStorage.setItem(KEY, JSON.stringify(v));
    } catch {
      /* storage full: still use it for this session */
    }
    usePhotoCache.setState({ cached: v });
  } catch {
    /* offline / blocked: the network URL (or the person icon) is used until the next attempt */
  } finally {
    inflight = null;
  }
}

/**
 * The person picked (dataUrl) or removed (null) their own photo. Shown everywhere at once, kept
 * across restarts; profileSync sends it to the account. `updatedAt` is given when the change comes
 * from the cloud (keeps the cloud's time, so the echo is recognised).
 */
export function setCustomPhoto(dataUrl: string | null, updatedAt = Date.now()) {
  const v: CustomPhoto = { dataUrl: isImageData(dataUrl) ? dataUrl : null, updatedAt };
  // Kept on the phone (survives restarts, works offline); a full quota first frees the Google copy.
  store(CUSTOM_KEY, v);
  usePhotoCache.setState({ custom: v });
}

/** Sign-out / account deletion: no photo of the previous account stays on the phone. */
export function clearProfilePhoto() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(CUSTOM_KEY);
    localStorage.removeItem(LAST_KEY);
  } catch {
    /* ignore */
  }
  usePhotoCache.setState({ cached: null, custom: null, last: null });
}

/** Best Google-photo source right now: the local copy for this account's photo, else the network URL. */
export function photoSrc(url: string | null | undefined, cached: Cached | null) {
  if (!url) return null;
  return cached?.url === url ? cached.dataUrl : url;
}

/**
 * The one photo every screen shows: the picked photo, else the Google photo (local copy first).
 * A removed custom photo falls back to the Google photo.
 */
export function effectivePhoto(googleUrl: string | null | undefined, cached: Cached | null, custom: CustomPhoto | null) {
  if (custom?.dataUrl) return custom.dataUrl;
  return photoSrc(googleUrl, cached);
}

/**
 * Every image the avatar may show, best first; the avatar falls through the list when one fails to
 * load (offline network URL) and shows the person icon after the last one.
 *  1. the picked photo,
 *  2. the account's Google photo: the local copy when it is for this URL, else the network URL
 *     followed by the older local copy of the same account (Google changed the photo / offline).
 * `user` is null while Firebase restores the session at app start: the account last signed in on
 * this phone stands in (never after a sign-out, which clears it).
 */
export function photoCandidates(
  user: { uid: string; photoURL: string | null } | null,
  authStatus: string,
  photos: { cached: Cached | null; custom: CustomPhoto | null; last: LastAccount | null },
): string[] {
  const { cached, custom, last } = photos;
  if (custom?.dataUrl) return [custom.dataUrl];
  const account = user ?? (authStatus !== 'signedOut' && last ? { uid: last.uid, photoURL: last.photoURL } : null);
  if (!account?.photoURL) return [];
  const mine = cached && (!cached.uid || cached.uid === account.uid) ? cached : null;
  if (!mine) return [account.photoURL];
  if (mine.url === account.photoURL) return [mine.dataUrl];
  return [account.photoURL, mine.dataUrl];
}
