import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const role = process.argv[2];
if (!['user', 'guardian', 'combined'].includes(role)) throw new Error('Usage: node scripts/build-app.mjs user|guardian|combined [--android]');
const android = process.argv.includes('--android');
if (android && role === 'combined') throw new Error('Combined builds are for browser development only.');
const win = process.platform === 'win32';
const env = { ...process.env, VITE_APP_ROLE: role, VITE_APP_MODE: role === 'combined' ? 'demo' : 'real' };
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: win && /\.(cmd|bat)$/.test(command) });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(win ? 'npm.cmd' : 'npm', ['run', 'build']);
if (android) {
  run(win ? 'npx.cmd' : 'npx', ['cap', 'sync', 'android']);
  // Prefer an explicitly configured JDK; Android Studio's bundled Java supports Capacitor 8.
  const bundledJava = win ? 'C:\\Program Files\\Android\\Android Studio\\jbr' : '';
  const configuredJava = env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', win ? 'java.exe' : 'java') : 'java';
  const version = spawnSync(configuredJava, ['-version'], { encoding: 'utf8' });
  const major = Number(/version "(\d+)/.exec(version.stderr || '')?.[1] || 0);
  if (major < 21 && existsSync(bundledJava)) env.JAVA_HOME = bundledJava;
  if (win) {
    // Native Java selectors require a real Windows temporary directory.
    env.TEMP = env.TMP = path.join(root, '.build-tmp');
    mkdirSync(env.TEMP, { recursive: true });
  }
  run(win ? '.\\gradlew.bat' : './gradlew', ['assembleDebug', `-PaissRole=${role}`, '--console=plain', '-Djava.net.preferIPv4Stack=true'], path.join(root, 'android'));
  const source = path.join(root, 'android/app/build/outputs/apk/debug/app-debug.apk');
  const delivery = path.join(root, 'deliverables');
  mkdirSync(delivery, { recursive: true });
  const marker = JSON.parse(readFileSync(path.join(root, 'dist/build-role.json'), 'utf8'));
  if (marker.role !== role) throw new Error('Build role mismatch');
  const target = path.join(delivery, `AI-SmartStick-${role}-debug.apk`);
  copyFileSync(source, target);
  console.log(`Built ${role} app: ${target}`);
}
