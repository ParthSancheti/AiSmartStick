import { useEffect, useState } from 'react';
import { useAuth, initialsOf } from '../core/auth/authStore';
import { cacheProfilePhoto, photoSrc, usePhotoCache } from '../core/profile/photoCache';

/**
 * Profile picture of the signed-in account: the locally cached copy first (instant, offline), the
 * network URL until it is cached, initials when there is no photo or it fails to load.
 */
export function AccountAvatar({ size = 40, className = '' }: { size?: number; className?: string }) {
  const user = useAuth((s) => s.user);
  const cached = usePhotoCache((s) => s.cached);
  const [broken, setBroken] = useState(false);
  const src = photoSrc(user?.photoURL, cached);
  useEffect(() => {
    setBroken(false);
    void cacheProfilePhoto(user?.photoURL);
  }, [user?.photoURL]);
  if (src && !broken)
    return <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} className={`h-full w-full rounded-full object-cover ${className}`} style={{ width: size, height: size }} />;
  return (
    <span className={`grid h-full w-full place-items-center rounded-full bg-teal-soft font-bold text-teal-ink ${className}`} style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden>
      {initialsOf(user?.displayName ?? null)}
    </span>
  );
}
