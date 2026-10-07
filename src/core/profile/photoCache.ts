import { create } from 'zustand';

/**
 * The account's profile photo on this phone. Two sources, one answer (`effectivePhoto`):
 *  - custom: a photo the person picked in the app (onboarding or Settings), already compressed to
 *    a small JPEG data URL. It wins everywhere. Synced to the user doc (core/sync/profileSync.ts),
 *    so the same account on another phone gets it. `dataUrl: null` with a time = "removed" (a
 *    tombstone, so an older cloud copy can never bring it back).
 *  - cached: the Google account photo, downloaded once and kept here (localStorage), so Home renders
 *    it instantly and offline. Re-fetched only when the account's photo URL changes.
 */
const KEY = 'aiss.profilePhoto.v1';
const CUSTOM_KEY = 'aiss.profilePhoto.custom.v1';

export interface Cached {
  url: string;
  dataUrl: string;
}

export interface CustomPhoto {
  /** JPEG data URL, or null when the person removed their photo. */
  dataUrl: string | null;
  updatedAt: number;
}

const isImageData = (v: unknown): v is string => typeof v === 'string' && v.startsWith('data:image/');

function read(): Cached | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Cached | null;
    return v?.url && isImageData(v.dataUrl) ? v : null;
  } catch {
    return null;
  }
}

function readCustom(): CustomPhoto | null {
  try {
    const v = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? 'null') as CustomPhoto | null;
    if (!v || typeof v.updatedAt !== 'number') return null;
    return { dataUrl: isImageData(v.dataUrl) ? v.dataUrl : null, updatedAt: v.updatedAt };
  } catch {
    return null;
  }
}

export const usePhotoCache = create<{ cached: Cached | null; custom: CustomPhoto | null }>(() => ({ cached: read(), custom: readCustom() }));

let inflight: string | null = null;

/** Ensures the photo for `url` is cached. Safe to call often; downloads at most once per URL. */
export async function cacheProfilePhoto(url: string | null | undefined) {
  if (!url || url.startsWith('data:') || usePhotoCache.getState().cached?.url === url || inflight === url) return;
  inflight = url;
  try {
    // Ask Google for a crisp but small square (s256) instead of the default 96 px thumbnail.
    const sized = /googleusercontent\.com/.test(url) ? url.replace(/=s\d+(-c)?$/, '=s256-c') : url;
    const res = await fetch(sized, { cache: 'force-cache', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') || blob.size > 400_000) throw new Error('not a usable image');
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
    const v = { url, dataUrl };
    try {
      localStorage.setItem(KEY, JSON.stringify(v));
    } catch {
      /* storage full: still use it for this session */
    }
    usePhotoCache.setState({ cached: v });
  } catch {
    /* offline / blocked: the network URL (or initials) is used until the next attempt */
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
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(v));
  } catch {
    /* storage full: still shown for this session, and synced */
  }
  usePhotoCache.setState({ custom: v });
}

/** Sign-out / account deletion: no photo of the previous account stays on the phone. */
export function clearProfilePhoto() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(CUSTOM_KEY);
  } catch {
    /* ignore */
  }
  usePhotoCache.setState({ cached: null, custom: null });
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
