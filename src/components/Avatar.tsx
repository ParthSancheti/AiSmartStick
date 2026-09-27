import { useAuth, initialsOf } from '../core/auth/authStore';

/** Profile picture from the signed-in Firebase account, or initials. Never a stock/random avatar. */
export function AccountAvatar({ size = 40, className = '' }: { size?: number; className?: string }) {
  const user = useAuth((s) => s.user);
  const name = user?.displayName ?? null;
  if (user?.photoURL)
    return <img src={user.photoURL} alt="" referrerPolicy="no-referrer" className={`h-full w-full rounded-full object-cover ${className}`} style={{ width: size, height: size }} />;
  return (
    <span className={`grid h-full w-full place-items-center rounded-full bg-teal-soft font-bold text-teal-ink ${className}`} style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden>
      {initialsOf(name)}
    </span>
  );
}
