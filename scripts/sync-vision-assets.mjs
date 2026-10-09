// Copies the MediaPipe Tasks Vision WASM runtime from the INSTALLED package into public/ so the
// JS API (bundled into the detector worker) and the .wasm binaries always come from the same
// version. Runs before dev/build (npm pre-scripts). public/mediapipe/wasm is generated, not committed.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'node_modules', '@mediapipe', 'tasks-vision');
const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
const src = join(pkgDir, 'wasm');
const dest = join(root, 'public', 'mediapipe', 'wasm');
mkdirSync(dest, { recursive: true });
// Release builds run the detector in a classic worker (importScripts): the ES-module variant is only
// needed by the Vite dev server's module workers. Leaving it out keeps ~13 MB out of the APK.
const dev = process.argv.includes('--dev');
let copied = 0;
for (const f of readdirSync(src)) {
  if (!dev && f.includes('_module_')) {
    rmSync(join(dest, f), { force: true });
    continue;
  }
  const from = join(src, f);
  const to = join(dest, f);
  if (existsSync(to) && statSync(to).size === statSync(from).size && statSync(to).mtimeMs >= statSync(from).mtimeMs) continue;
  copyFileSync(from, to);
  copied++;
}
const model = join(root, 'public', 'models', 'efficientdet_lite0.tflite');
if (!existsSync(model)) {
  console.error('[vision-assets] public/models/efficientdet_lite0.tflite is missing: object detection cannot start.');
  process.exit(1);
}
console.log(`[vision-assets] MediaPipe ${version} WASM ready (${copied} file(s) updated)`);
