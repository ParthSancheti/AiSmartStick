/** WebCrypto helpers for the device auth scheme (DEVICE_PROTOCOL.md §Authentication). */
const enc = new TextEncoder();

export function randomBytes(n: number) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

export function toB64(bytes: Uint8Array) {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}

export function fromB64(b64: string) {
  const s = atob(b64);
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

export const toHex = (buf: ArrayBuffer | Uint8Array) => [...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(data: string | Uint8Array) {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return toHex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function hmacKey(b64: string) {
  if (!keyCache.has(b64)) keyCache.set(b64, crypto.subtle.importKey('raw', fromB64(b64) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  return keyCache.get(b64)!;
}

export async function hmacHex(keyB64: string, message: string) {
  return toHex(await crypto.subtle.sign('HMAC', await hmacKey(keyB64), enc.encode(message)));
}

/** Constant-time-ish string compare for hex digests. */
export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Canonical string that both app and firmware sign. */
export function canonicalRequest(method: string, path: string, ts: number, nonce: string, bodySha: string) {
  return `${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${bodySha}`;
}
