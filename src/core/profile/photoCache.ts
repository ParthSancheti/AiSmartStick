import { create } from 'zustand';

/**
 * The Google profile photo, downloaded once and kept on the phone (data URL in localStorage), so
 * Home renders it instantly and offline and never re-downloads it on every launch. Re-fetched only
 * when the account's photo URL changes.
 */
const KEY = 'aiss.profilePhoto.v1';

interface Cached {
  url: string;
  dataUrl: string;
}

function read(): Cached | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Cached | null;
    return v?.url && v.dataUrl?.startsWith('data:image/') ? v : null;
  } catch {
    return null;
  }
}

export const usePhotoCache = create<{ cached: Cached | null }>(() => ({ cached: read() }));

let inflight: string | null = null;

/** Ensures the photo for `url` is cached. Safe to call often; downloads at most once per URL. */
export async function cacheProfilePhoto(url: string | null | undefined) {
  if (!url || usePhotoCache.getState().cached?.url === url || inflight === url) return;
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

export function clearProfilePhoto() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  usePhotoCache.setState({ cached: null });
}

/** Best source right now: the local copy for this account's photo, else the network URL. */
export function photoSrc(url: string | null | undefined, cached: Cached | null) {
  if (!url) return null;
  return cached?.url === url ? cached.dataUrl : url;
}
