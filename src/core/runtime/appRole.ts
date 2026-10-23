import type { Role } from '../types';

/** The package fixes its role. Only an explicitly combined development build can switch. */
export const BUILD_ROLE: Role | null = import.meta.env.VITE_APP_ROLE === 'guardian' ? 'guardian'
  : import.meta.env.VITE_APP_ROLE === 'combined' ? null : 'user';

export function appRole(entryRole?: Role | null, accountRole?: Role | null): Role {
  return BUILD_ROLE ?? accountRole ?? entryRole ?? 'user';
}

export function accountMatchesApp(role: Role): boolean {
  return BUILD_ROLE === null || role === BUILD_ROLE;
}
