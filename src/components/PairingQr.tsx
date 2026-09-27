import { useEffect, useState } from 'react';
import { pairingQrDataUrl } from '../core/pairing/qr';

/** Real, scannable QR for a pairing code (replaces the old decorative QrMock). */
export function PairingQr({ code, size = 118 }: { code: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    pairingQrDataUrl(code, size * 2)
      .then((u) => alive && setSrc(u))
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [code, size]);
  return src ? <img src={src} width={size} height={size} alt={`Pairing QR code for ${code.split('').join(' ')}`} /> : <div style={{ width: size, height: size }} aria-hidden />;
}
