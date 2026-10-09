import { create } from 'zustand';

/**
 * What App Check did last (for the Server test page and support reports). No tokens are kept here.
 *  provider: which App Check provider this build uses.
 *  initError: the native provider did not start (or took too long).
 *  lastOkAt / lastError / lastMs: the newest token request.
 */
export type AppCheckProvider = 'play-integrity' | 'debug' | 'recaptcha' | 'none';

export interface AppCheckStatus {
  provider: AppCheckProvider;
  initError: string | null;
  lastOkAt: number | null;
  lastError: string | null;
  lastMs: number | null;
}

export const useAppCheckStatus = create<AppCheckStatus>(() => ({ provider: 'none', initError: null, lastOkAt: null, lastError: null, lastMs: null }));

export function recordAppCheckToken(ok: boolean, ms: number, error: string | null = null) {
  useAppCheckStatus.setState(ok ? { lastOkAt: Date.now(), lastError: null, lastMs: ms } : { lastError: error ?? 'App Check failed', lastMs: ms });
}

/** Rejects with `message` when `p` does not settle in `ms`. The timer is always cleared. */
export function withAppCheckTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(message)), ms)))]).finally(() => clearTimeout(t));
}

export const errorText = (e: unknown) => {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : (e as { message?: string })?.message;
  return String(m || e || 'unknown error').slice(0, 300);
};
