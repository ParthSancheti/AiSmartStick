// ECDSA P-256 Public Key for Firmware Verification
const PUBLIC_KEY_SPKI = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEokbKSqNdbrXa98glpanPUI1q2/l5pJ4HDbzqaHHou7FzD4sGkHs+a0Jdil/uAJi5rBaFxBgnCZ8AGk8i96k3rg==";

export async function verifyFirmware(blob: Blob, expectedSha256: string, signatureBase64: string): Promise<boolean> {
  const buffer = await blob.arrayBuffer();

  // 1. Check SHA-256
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  if (hashHex !== expectedSha256.toLowerCase()) {
    throw new Error(`Hash mismatch! Expected ${expectedSha256} but got ${hashHex}`);
  }

  // 2. Verify ECDSA signature of the binary
  try {
    const rawKey = Uint8Array.from(atob(PUBLIC_KEY_SPKI), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      'spki',
      rawKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );

    const sigArray = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0));

    const isValid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      sigArray,
      buffer
    );

    if (!isValid) {
      throw new Error("Invalid firmware signature");
    }
  } catch (e) {
    throw new Error(`Signature verification failed: ${(e as Error).message}`);
  }

  return true;
}
