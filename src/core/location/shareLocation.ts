import { acquireFix, type Fix } from './locationService';

/**
 * The location line every outgoing SMS carries (SOS, "send my location"). The receiver may not
 * have the app, so the text itself holds a plain Google Maps link that opens on any phone.
 * Never invents a position: no fix → says so.
 */
export const SOS_FRESH_MS = 120_000;
export const SOS_LOCATION_TIMEOUT_MS = 8000;

export const mapsLink = (f: { lat: number; lng: number }) => `https://maps.google.com/?q=${f.lat.toFixed(6)},${f.lng.toFixed(6)}`;

/** "just now", "45 sec ago", "12 min ago", "3 h ago", "2 days ago". */
export function ageText(ts: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 15) return 'just now';
  if (s < 60) return `${s} sec ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/**
 * "Location: https://maps.google.com/?q=… (accuracy 12 m, just now)" or the honest "unavailable"
 * variants. GSM-7 characters only (no "±"): an English SOS then travels as ONE 160-character SMS
 * instead of 2–3 UCS-2 parts, so the link is never split across parts.
 */
export function locationLine(fix: Fix | null, fresh: boolean, now = Date.now()) {
  if (!fix) return 'Location unavailable (no GPS position on the phone).';
  const detail = `(accuracy ${Math.max(1, Math.round(fix.accuracyM))} m, ${ageText(fix.ts, now)})`;
  if (fresh) return `Location: ${mapsLink(fix)} ${detail}`;
  return `Live location unavailable. Last known location: ${mapsLink(fix)} ${detail}`;
}

/** message + location line, separated so the link stays tappable. */
export function withLocation(message: string, fix: Fix | null, fresh: boolean, now = Date.now()) {
  const m = message.trim();
  return `${m}${m && !/[.!?]$/.test(m) ? '.' : ''} ${locationLine(fix, fresh, now)}`.trim();
}

/** Takes (or actively gets, up to ~8 s) a position and returns the text with its location line. */
export async function messageWithLocation(message: string, opts: { maxAgeMs?: number; timeoutMs?: number } = {}) {
  const r = await acquireFix({ maxAgeMs: opts.maxAgeMs ?? SOS_FRESH_MS, timeoutMs: opts.timeoutMs ?? SOS_LOCATION_TIMEOUT_MS }).catch(() => ({ fix: null, fresh: false }));
  return { text: withLocation(message, r.fix, r.fresh), fix: r.fix, fresh: r.fresh };
}

/** A text the user asked the assistant to send that should carry their position. */
export function wantsLocation(text: string) {
  return /\b(sos|help|emergency|urgent|danger|accident|hurt|injured|fell|fallen|lost|unsafe|scared|where i am|my location|location|bachao|madad|khatra|ghabra)\b/i.test(text) || /मदद|बचाओ|खतरा|लोकेशन|कहाँ हूँ/.test(text);
}
