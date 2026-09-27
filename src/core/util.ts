export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const uid = () => Math.random().toString(36).slice(2, 10);
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function isWide() {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 1100px)').matches;
}

export function timeAgo(ts: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} h ago`;
}

export function clock(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function meters(m: number) {
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}
