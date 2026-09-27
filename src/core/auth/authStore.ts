import { create } from 'zustand';
import type { AccountRole, UserDoc } from '../../../shared/firestoreSchema';

export interface AuthUser {
  uid: string;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
}

interface AuthState {
  status: 'loading' | 'signedOut' | 'signedIn' | 'unconfigured' | 'error';
  user: AuthUser | null;
  role: AccountRole | null;
  profile: UserDoc | null;
  error: string | null;
  busy: boolean;
}

export const useAuth = create<AuthState>(() => ({ status: 'loading', user: null, role: null, profile: null, error: null, busy: false }));

export const currentUid = () => useAuth.getState().user?.uid ?? null;

/** Initials for the avatar when there is no photo (never a random stock avatar). */
export function initialsOf(name: string | null | undefined) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}
