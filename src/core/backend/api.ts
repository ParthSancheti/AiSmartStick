import { httpsCallable } from 'firebase/functions';
import { fb } from '../firebase/app';

/**
 * Authenticated calls to Cloud Functions. httpsCallable attaches the Firebase ID token
 * and the App Check token; the functions reject calls without them (enforceAppCheck).
 */
export class BackendError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export async function call<Req, Res>(name: string, data: Req, timeoutMs = 30000): Promise<Res> {
  try {
    const fn = httpsCallable<Req, Res>(fb().functions, name, { timeout: timeoutMs });
    const r = await fn(data);
    return r.data;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    throw new BackendError(err.code ?? 'unknown', err.message ?? 'Backend call failed');
  }
}
