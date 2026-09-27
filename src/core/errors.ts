import { log } from './log';

/**
 * Plain-language errors for people; technical detail goes to the (redacted) developer log.
 * Never show "FirebaseError: PERMISSION_DENIED" to a user.
 */
const MAP: [RegExp, string][] = [
  [/permission[-_ ]denied|PERMISSION_DENIED|insufficient permissions/i, 'You don’t have access to that. The link with your family member may have been removed.'],
  [/unauthenticated|auth\/|sign in required|id-token/i, 'Please sign in again.'],
  [/unavailable|network|failed to fetch|timeout|deadline-exceeded|ETIMEDOUT|offline/i, 'Couldn’t reach the server. Check the internet connection and try again.'],
  [/resource-exhausted|too many/i, 'Too many requests right now. Please wait a moment.'],
  [/not-found|invalid or expired code|invalid code/i, 'That code is wrong or has expired. Ask for a new one.'],
  [/already-exists|already linked|already has a guardian/i, 'This account is already linked. Unlink first to link someone else.'],
  [/failed-precondition.*(Gemini|Maps)|not configured/i, 'This feature isn’t set up on the server yet.'],
  [/stick-offline|stick is not connected/i, 'The stick isn’t connected to the phone.'],
  [/popup-closed|cancel/i, 'Cancelled.'],
];

export function friendlyError(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const raw = e instanceof Error ? `${(e as { code?: string }).code ?? ''} ${e.message}` : String(e ?? '');
  log.error('user-facing error', { raw: raw.slice(0, 300) });
  for (const [re, text] of MAP) if (re.test(raw)) return text;
  return fallback;
}
