import { useEffect, useId, useState } from 'react';
import { useAuth, initialsOf } from '../core/auth/authStore';
import { cacheProfilePhoto, effectivePhoto, setCustomPhoto, usePhotoCache } from '../core/profile/photoCache';
import { useProfileName } from '../core/profile/profile';

/** The account's photo as every screen shows it: picked photo → Google photo (local copy first) → null. */
export function useProfilePhotoSrc(): string | null {
  const url = useAuth((s) => s.user?.photoURL ?? null);
  const cached = usePhotoCache((s) => s.cached);
  const custom = usePhotoCache((s) => s.custom);
  useEffect(() => {
    void cacheProfilePhoto(url);
  }, [url]);
  return effectivePhoto(url, cached, custom);
}

/**
 * Profile picture of the signed-in account: the photo picked in the app first, then the locally
 * cached Google photo (instant, offline), the network URL until it is cached, and initials of the
 * account's name (the edited one) when there is no photo or it fails to load. Always a circle.
 */
export function AccountAvatar({ size = 40, className = '' }: { size?: number; className?: string }) {
  const src = useProfilePhotoSrc();
  const name = useProfileName();
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (src && !broken)
    return <img src={src} alt="" referrerPolicy="no-referrer" draggable={false} onError={() => setBroken(true)} className={`block shrink-0 rounded-full object-cover ${className}`} style={{ width: size, height: size }} />;
  return (
    <span className={`grid shrink-0 place-items-center rounded-full bg-teal-soft font-bold text-teal-ink ${className}`} style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden>
      {initialsOf(name || null)}
    </span>
  );
}

/**
 * Big avatar with "Change photo" / "Use Google photo". The picked photo is compressed on the phone
 * (≤ 100 KB JPEG), shown everywhere at once, kept across restarts and synced to the account.
 * <input type="file"> opens Android's own photo picker (camera or gallery) in the app's WebView.
 */
export function ProfilePhotoEditor({ size = 120 }: { size?: number }) {
  const custom = usePhotoCache((s) => s.custom);
  const googleUrl = useAuth((s) => s.user?.photoURL ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputId = useId();
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const { compressProfilePhoto } = await import('../core/profile/imageCompress');
      setCustomPhoto(await compressProfilePhoto(file));
    } catch (e) {
      setErr((e as Error).message || 'This photo could not be used.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-center">
      <label htmlFor={inputId} className="relative block cursor-pointer rounded-full" aria-label="Change profile photo">
        <span className="block overflow-hidden rounded-full shadow-xl ring-4 ring-surface" style={{ width: size, height: size }}>
          <AccountAvatar size={size} />
        </span>
        <span className="absolute -bottom-0.5 -right-0.5 grid h-10 w-10 place-items-center rounded-full border-[3px] border-bg bg-teal text-white shadow-lg" aria-hidden>
          {busy ? (
            <svg width="18" height="18" viewBox="0 0 24 24" className="animate-spin" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.2-8.56" /></svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" /><circle cx="12" cy="13" r="3" /></svg>
          )}
        </span>
      </label>
      <input
        id={inputId}
        type="file"
        accept="image/*"
        className="sr-only"
        disabled={busy}
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        <label htmlFor={inputId} className="glass interactive inline-flex h-10 cursor-pointer items-center rounded-full px-4 text-[14px] font-bold text-teal-ink">
          {busy ? 'Saving photo…' : custom?.dataUrl ? 'Change photo' : 'Choose a photo'}
        </label>
        {custom?.dataUrl && (
          <button type="button" className="inline-flex h-10 items-center rounded-full px-3 text-[14px] font-semibold text-ink-3 underline" onClick={() => setCustomPhoto(null)}>
            {googleUrl ? 'Use Google photo' : 'Remove photo'}
          </button>
        )}
      </div>
      {err && <p className="mt-2 max-w-[280px] text-center text-[13px] font-semibold text-sos" role="alert">{err}</p>}
    </div>
  );
}
