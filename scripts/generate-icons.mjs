#!/usr/bin/env node
/**
 * Generates every app icon from the one brand logo (src/core/brand/logo.png).
 *
 *   node scripts/generate-icons.mjs
 *
 * The logo is a rounded-square badge. Android adaptive icons need two full-bleed 108 dp layers of
 * which only the centre 72 dp is visible (circle, squircle or rounded square depending on the
 * launcher) and only the centre 66 dp is guaranteed. So:
 *   foreground  = the badge's inscribed circle (fully opaque, contains all the artwork), 66 dp wide (the safe zone),
 *                 so nothing is ever clipped and every mask shape shows a clean
 *                 round logo;
 *   background  = the badge's own edge colours stretched outward and blurred, full bleed, so square
 *                 and squircle masks continue the badge seamlessly (no white ring, no inset square).
 * Legacy (API < 26) ic_launcher.png = the rounded badge, ic_launcher_round.png = the circle.
 * Also writes assets/icon-foreground.png / icon-background.png (the same layers at 1024 px, for
 * @capacitor/assets) and src/core/brand/logo-round.png (small round logo for the Home header).
 */
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src/core/brand/logo.png');
const RES = join(ROOT, 'android/app/src/main/res');

const DENSITIES = { ldpi: 0.75, mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const FG_CIRCLE_DP = 66; // of 108 dp: the badge circle IS the 66 dp safe zone; the background continues it

const { data: logo, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width;
const H = info.height;

// Find the opaque badge (alpha > 240) and its inscribed circle.
let minX = W, minY = H, maxX = 0, maxY = 0;
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++)
    if (logo[(y * W + x) * 4 + 3] > 240) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
const CX = (minX + maxX) / 2;
const CY = (minY + maxY) / 2;
const SIDE = Math.min(maxX - minX, maxY - minY);
const R = SIDE / 2 - 6; // inscribed circle, a few px inside the anti-aliased edge

function sample(x, y) {
  // bilinear sample of the logo (premultiplied-safe enough: everything sampled is opaque)
  const x0 = Math.max(0, Math.min(W - 2, Math.floor(x)));
  const y0 = Math.max(0, Math.min(H - 2, Math.floor(y)));
  const fx = Math.min(1, Math.max(0, x - x0));
  const fy = Math.min(1, Math.max(0, y - y0));
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const a = logo[(y0 * W + x0) * 4 + c];
    const b = logo[(y0 * W + x0 + 1) * 4 + c];
    const d = logo[((y0 + 1) * W + x0) * 4 + c];
    const e = logo[((y0 + 1) * W + x0 + 1) * 4 + c];
    out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
  }
  return out;
}

/** Foreground layer: the inscribed circle of the badge, `circlePx` wide, centred on an n×n canvas. */
function foreground(n, circlePx) {
  const buf = Buffer.alloc(n * n * 4);
  const rc = circlePx / 2;
  const k = R / rc;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const dx = x + 0.5 - n / 2;
      const dy = y + 0.5 - n / 2;
      const r = Math.hypot(dx, dy);
      if (r > rc + 1) continue;
      const [cr, cg, cb] = sample(CX + dx * k, CY + dy * k);
      const alpha = Math.max(0, Math.min(1, rc + 0.5 - r)); // 1px anti-aliased edge
      const i = (y * n + x) * 4;
      buf[i] = cr;
      buf[i + 1] = cg;
      buf[i + 2] = cb;
      buf[i + 3] = Math.round(255 * alpha);
    }
  return sharp(buf, { raw: { width: n, height: n, channels: 4 } });
}

/** Background layer: the badge's edge ring stretched radially to full bleed, then blurred. */
async function background(n) {
  const buf = Buffer.alloc(n * n * 4);
  const rr = R * 0.99;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const t = Math.atan2(y + 0.5 - n / 2, x + 0.5 - n / 2);
      const [cr, cg, cb] = sample(CX + Math.cos(t) * rr, CY + Math.sin(t) * rr);
      const i = (y * n + x) * 4;
      buf[i] = cr;
      buf[i + 1] = cg;
      buf[i + 2] = cb;
      buf[i + 3] = 255;
    }
  const raw = await sharp(buf, { raw: { width: n, height: n, channels: 4 } }).blur(Math.max(1, n / 24)).raw().toBuffer();
  return sharp(raw, { raw: { width: n, height: n, channels: 4 } });
}

/** The rounded badge itself, trimmed and centred with a little padding (legacy square icon). */
function badge(n) {
  const pad = Math.round(SIDE * 0.04);
  const left = Math.max(0, Math.round(CX - SIDE / 2 - pad));
  const top = Math.max(0, Math.round(CY - SIDE / 2 - pad));
  const size = Math.min(W - left, H - top, Math.round(SIDE + pad * 2));
  return sharp(SRC).extract({ left, top, width: size, height: size }).resize(n, n);
}

async function write(img, file) {
  mkdirSync(dirname(file), { recursive: true });
  await img.png({ compressionLevel: 9 }).toFile(file);
}

for (const [d, s] of Object.entries(DENSITIES)) {
  const dir = join(RES, `mipmap-${d}`);
  const layer = Math.round(108 * s);
  await write(foreground(layer, Math.round(FG_CIRCLE_DP * s)), join(dir, 'ic_launcher_foreground.png'));
  await write(await background(layer), join(dir, 'ic_launcher_background.png'));
  const legacy = Math.round(48 * s);
  await write(badge(legacy), join(dir, 'ic_launcher.png'));
  // Legacy round icon: the circle with a 1 dp margin.
  const round = foreground(legacy, legacy - Math.round(2 * s));
  await write(round, join(dir, 'ic_launcher_round.png'));
  console.log(`mipmap-${d}: layers ${layer}px, legacy ${legacy}px`);
}

await write(foreground(1024, Math.round((1024 * FG_CIRCLE_DP) / 108)), join(ROOT, 'assets/icon-foreground.png'));
await write(await background(1024), join(ROOT, 'assets/icon-background.png'));
await write(foreground(192, 190), join(ROOT, 'src/core/brand/logo-round.png'));
console.log('assets/icon-foreground.png, assets/icon-background.png, src/core/brand/logo-round.png');
