import { Capacitor } from '@capacitor/core';
import QRCode from 'qrcode';

/**
 * Pairing QR: the guardian's phone shows `aiss://pair?v=1&code=123456`; the stick user's phone
 * (or a sighted helper) scans it instead of typing. The code is still redeemed ONLY by the
 * claimPairingCode Cloud Function, so a QR grants nothing by itself (10-minute, single-use code).
 */
export const pairingUri = (code: string) => `aiss://pair?v=1&code=${code}`;

export function parsePairingPayload(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.trim();
  if (/^\d{6}$/.test(t)) return t;
  const m = /^aiss:\/\/pair\?(.+)$/i.exec(t);
  if (!m) return null;
  const params = new URLSearchParams(m[1]);
  const code = params.get('code') ?? '';
  return params.get('v') === '1' && /^\d{6}$/.test(code) ? code : null;
}

export function pairingQrDataUrl(code: string, size = 240) {
  return QRCode.toDataURL(pairingUri(code), { errorCorrectionLevel: 'M', margin: 1, width: size, color: { dark: '#0b1d22', light: '#ffffff' } });
}

export type ScanOutcome = { code: string } | { error: 'unsupported' | 'cancelled' | 'invalid' | 'failed'; message: string };

/** Native: Google code scanner (ML Kit) — no camera permission needed, the system UI does the scan. */
export async function scanPairingQr(): Promise<ScanOutcome> {
  if (!Capacitor.isNativePlatform()) return { error: 'unsupported', message: 'QR scanning works in the Android app. Type the code instead.' };
  try {
    const { BarcodeScanner, BarcodeFormat } = await import('@capacitor-mlkit/barcode-scanning');
    const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
    if (!available) await BarcodeScanner.installGoogleBarcodeScannerModule();
    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
    if (!barcodes.length) return { error: 'cancelled', message: 'No code scanned.' };
    const code = parsePairingPayload(barcodes[0].rawValue);
    return code ? { code } : { error: 'invalid', message: 'That QR code is not an AI SmartStick pairing code.' };
  } catch (e) {
    const msg = (e as Error).message ?? '';
    return /cancel/i.test(msg) ? { error: 'cancelled', message: 'Scan cancelled.' } : { error: 'failed', message: `Scanner unavailable: ${msg}` };
  }
}
