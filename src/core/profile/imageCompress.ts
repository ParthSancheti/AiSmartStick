/**
 * Turns a picked image (camera or gallery, often 3–12 MB) into a small square JPEG data URL for the
 * profile photo: centre-cropped, 320 px, quality stepped down until it fits PHOTO_MAX_CHARS.
 * Works in the Android WebView (<input type="file"> opens the system picker) and in browsers.
 */
export const PHOTO_MAX_CHARS = 100_000;
const SIZES = [320, 256, 192, 128];
const QUALITIES = [0.85, 0.75, 0.65, 0.55, 0.45];

type Encode = (size: number, quality: number) => string;

/** Pure size search (exported for tests): the best quality/size whose data URL fits the cap. */
export function pickEncoding(encode: Encode, maxChars = PHOTO_MAX_CHARS): string {
  for (const size of SIZES) {
    for (const q of QUALITIES) {
      const out = encode(size, q);
      if (out.length <= maxChars) return out;
    }
  }
  throw new Error('This photo could not be made small enough. Please pick another one.');
}

async function loadImage(file: Blob): Promise<{ img: CanvasImageSource; w: number; h: number; done: () => void }> {
  // createImageBitmap honours EXIF orientation (phone camera photos) and decodes off the main thread.
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
      return { img: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close() };
    } catch {
      /* fall back to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('This file is not a photo the phone can open.'));
      img.src = url;
    });
    return { img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

export async function compressProfilePhoto(file: Blob): Promise<string> {
  if (file.type && !file.type.startsWith('image/')) throw new Error('Please pick a photo.');
  const { img, w, h, done } = await loadImage(file);
  try {
    if (!w || !h) throw new Error('This photo is empty.');
    const side = Math.min(w, h);
    const sx = (w - side) / 2;
    const sy = (h - side) / 2;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This phone could not process the photo.');
    return pickEncoding((size, q) => {
      canvas.width = size;
      canvas.height = size;
      ctx.fillStyle = '#ffffff'; // transparent PNGs become white, not black, as JPEG
      ctx.fillRect(0, 0, size, size);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      return canvas.toDataURL('image/jpeg', q);
    });
  } finally {
    done();
  }
}
