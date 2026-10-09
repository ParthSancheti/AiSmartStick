import { httpsCallable } from 'firebase/functions';
import { fb } from '../firebase/app';

/**
 * Authenticated calls to Cloud Functions. httpsCallable attaches the Firebase ID token
 * and the App Check token; the functions reject calls without them (enforceAppCheck).
 * One console line per call: "[SERVER] <name> ok|<code> <ms>ms" (never the payload).
 */
export class BackendError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/**
 * The Firebase SDK gets the sign-in and App Check tokens BEFORE its own `timeout` starts, so a stuck
 * token request would hold the call forever. This outer limit covers the whole call.
 */
export const OUTER_EXTRA_MS = 10_000;

export async function call<Req, Res>(name: string, data: Req, timeoutMs = 30000): Promise<Res> {
  const t0 = Date.now();
  const limitMs = timeoutMs + OUTER_EXTRA_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const fn = httpsCallable<Req, Res>(fb().functions, name, { timeout: timeoutMs });
    const outer = new Promise<never>((_, rej) => {
      timer = setTimeout(
        () => rej(new BackendError('deadline-exceeded', `The server did not answer in ${Math.round(limitMs / 1000)} s (slow first start, App Check, or functions not deployed).`)),
        limitMs,
      );
    });
    const r = await Promise.race([fn(data), outer]);
    console.info(`[SERVER] ${name} ok ${Date.now() - t0}ms`);
    return r.data;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const be = e instanceof BackendError ? e : new BackendError(err?.code ?? 'unknown', err?.message ?? 'Backend call failed');
    console.warn(`[SERVER] ${name} ${be.code} ${Date.now() - t0}ms`);
    throw be;
  } finally {
    clearTimeout(timer);
  }
}
