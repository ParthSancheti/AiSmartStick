import { rolldown } from 'rolldown';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const out = path.resolve(root, args[args.indexOf('--out') + 1] && args.includes('--out')
  ? args[args.indexOf('--out') + 1] : 'deliverables/algorithm-replay/core/walking-core.mjs');
const bundle = await rolldown({
  input: path.join(root, 'src/core/perception/index.ts'),
  platform: 'neutral',
  onwarn(warning) { throw new Error(warning.message); },
});
const result = await bundle.generate({ format: 'es', sourcemap: false });
await bundle.close();
const chunk = result.output.find(item => item.type === 'chunk');
if (!chunk || chunk.imports.length || chunk.dynamicImports.length || result.output.length !== 1) {
  throw new Error('Portable algorithm must have exactly one JavaScript file and zero runtime imports');
}
const forbidden = /\b(?:Date\.now|setTimeout|setInterval|fetch|localStorage|window|document|navigator|Capacitor|zustand)\b/;
if (forbidden.test(chunk.code)) throw new Error('Portable algorithm contains a runtime capability: ' + chunk.code.match(forbidden)[0]);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, '// Generated from the same deterministic source used by the app. Zero runtime dependencies.\n' + chunk.code);
console.log(JSON.stringify({ output: out, modules: Object.keys(chunk.modules), bytes: Buffer.byteLength(chunk.code), runtimeImports: 0 }, null, 2));
