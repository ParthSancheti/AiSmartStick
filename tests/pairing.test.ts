import { describe, expect, it } from 'vitest';
import { parsePairingPayload, pairingUri } from '../src/core/pairing/qr';

describe('pairing QR payload', () => {
  it('round-trips the pairing URI', () => {
    expect(parsePairingPayload(pairingUri('482913'))).toBe('482913');
  });
  it('accepts a bare 6-digit code', () => {
    expect(parsePairingPayload(' 123456 ')).toBe('123456');
  });
  it('rejects other QR contents', () => {
    expect(parsePairingPayload('https://example.com/?code=123456')).toBeNull();
    expect(parsePairingPayload('aiss://pair?v=2&code=123456')).toBeNull();
    expect(parsePairingPayload('aiss://pair?v=1&code=12345')).toBeNull();
    expect(parsePairingPayload('')).toBeNull();
  });
});
