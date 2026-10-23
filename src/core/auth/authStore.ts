import { create } from 'zustand';
import type { AccountRole, UserDoc } from '../../../shared/firestoreSchema';

export interface AuthUser {
  uid: string;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
  /** The Google account name (displayName may be the name the person typed in the app). */
  providerName?: string | null;
}

interface AuthState {
  status: 'loading' | 'signedOut' | 'signedIn' | 'unconfigured' | 'error';
  user: AuthUser | null;
  role: AccountRole | null;
  profile: UserDoc | null;
  error: string | null;
  busy: boolean;
  phase: 'restoring' | 'google' | 'profile' | null;
}

export const useAuth = create<AuthState>(() => ({ status: 'loading', user: null, role: null, profile: null, error: null, busy: false, phase: 'restoring' }));

/** Keep both onboarding flows blocked until identity AND the account role are resolved. */
export function signInPresentation(auth: Pick<AuthState, 'status' | 'busy' | 'phase' | 'user' | 'profile'>) {
  const pending = auth.busy || auth.status === 'loading' || auth.status === 'signedIn';
  const retryingProfile = !!auth.user && !auth.profile;
  const label = auth.phase === 'google' ? 'Signing in with Google…'
    : auth.phase === 'profile' || (auth.status === 'loading' && auth.user) ? 'Setting up your account…'
    : auth.status === 'loading' ? 'Checking sign-in…'
    : auth.status === 'signedIn' ? 'Signed in'
    : retryingProfile ? 'Retry account setup' : 'Continue with Google';
  return { pending, label };
}

export const currentUid = () => useAuth.getState().user?.uid ?? null;

/**
 * Initials for the avatar when there is no photo (never a random stock avatar). Empty when no name is
 * known: the avatar then shows a person icon, never a "?".
 */
export function initialsOf(name: string | null | undefined) {
  if (!name) return '';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => [...p][0]?.toUpperCase() ?? '').join('');
}
