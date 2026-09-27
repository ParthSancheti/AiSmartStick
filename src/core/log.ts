/**
 * Structured logging with categories. Never logs secrets: keys named like token/key/password/secret/
 * sig/idToken and any medical fields are redacted. Camera images and audio are never logged.
 */
type Level = 'debug' | 'info' | 'warn' | 'error' | 'security' | 'safety';

const REDACT = /token|key|password|secret|sig|auth|medical|allerg|medication|blood/i;

function clean(meta?: Record<string, unknown>) {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) out[k] = REDACT.test(k) ? '[redacted]' : v instanceof Blob ? `[blob ${v.size} B]` : v;
  return out;
}

const ring: { t: number; level: Level; msg: string; meta?: Record<string, unknown> }[] = [];

function write(level: Level, msg: string, meta?: Record<string, unknown>) {
  const entry = { t: Date.now(), level, msg, meta: clean(meta) };
  ring.push(entry);
  if (ring.length > 200) ring.shift();
  if (import.meta.env?.DEV || level === 'error' || level === 'security' || level === 'safety') {
    const fn = level === 'error' || level === 'security' ? console.error : level === 'warn' ? console.warn : console.info;
    fn(`[${level.toUpperCase()}] ${msg}`, entry.meta ?? '');
  }
}

export const log = {
  debug: (m: string, meta?: Record<string, unknown>) => write('debug', m, meta),
  info: (m: string, meta?: Record<string, unknown>) => write('info', m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => write('warn', m, meta),
  error: (m: string, meta?: Record<string, unknown>) => write('error', m, meta),
  security: (m: string, meta?: Record<string, unknown>) => write('security', m, meta),
  safety: (m: string, meta?: Record<string, unknown>) => write('safety', m, meta),
  /** Recent entries for the diagnostics screen / bug reports (already redacted). */
  recent: () => [...ring],
  redactForTest: clean,
};
