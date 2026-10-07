#!/usr/bin/env node
/*
 * AI SmartStick doctor
 * --------------------
 * One command that checks a developer PC, fixes the usual problems, and builds, installs and debugs
 * the Android app (and the ESP32-CAM firmware). Plain Node (>= 18), no dependencies. Works on
 * Windows (PowerShell and cmd), macOS and Linux. The simple guide is docs/DOCTOR.md.
 *
 *   npm run doctor              checks, then typecheck, unit tests, firmware tests, web build, cap sync
 *   npm run doctor:fix          the same, and repair what can be repaired (npm install, local.properties, ...)
 *   npm run apk                 --fix, all of the above, then the debug APK
 *   npm run apk:install         --fix, all of the above, the debug APK, then adb install
 *   npm run logcat              the app's log from the phone (Ctrl+C stops)
 *   npm run doctor -- --help    every option
 *
 * It writes doctor-report.txt (git-ignored). Secret values are never printed or written: .env keys are
 * reported by NAME only, and every .env value is masked in captured tool output.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const ANDROID_DIR = path.join(ROOT, 'android');
const APK_PATH = path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const SKETCH_NAME = 'ai_smart_stick_v1';
const SKETCH_DIR = path.join(ROOT, 'firmware', SKETCH_NAME);
const REPORT_PATH = path.join(ROOT, 'doctor-report.txt');
const FQBN = 'esp32:esp32:esp32cam'; // Arduino-ESP32 board "AI Thinker ESP32-CAM"
const ESP32_CORE = '2.0.17'; // newest 2.0.x core; the firmware is made for 2.0.x
const ESP32_INDEX_URL = 'https://espressif.github.io/arduino-esp32/package_esp32_index.json';
const FW_BUILD_DIR = path.join(os.tmpdir(), 'aiss-firmware-build');
const LOGCAT_FILTER = /AissNative|AissLocation|Capacitor|Console|chromium|SmartStick|AndroidRuntime|FATAL|DebugAppCheckProvider|debug secret/;
const TAIL_LINES = 40;
const NAME_WIDTH = 24;

const HELP = `AI SmartStick doctor: checks your PC, fixes common problems, builds and installs the app.

Usage (in the project folder):
  npm run doctor             checks, then typecheck, unit tests, firmware tests, web build, cap sync
  npm run doctor:fix         the same, and fix what can be fixed automatically
  npm run apk                fix + build + debug APK
  npm run apk:install        fix + build + debug APK + install it on the phone (USB)
  npm run logcat             show the app's log from the phone (Ctrl+C stops)
  npm run doctor -- --firmware [--port COM5]
                             build the stick firmware with arduino-cli (and upload it),
                             or print the Arduino IDE steps

Options (with npm put them after "--", for example: npm run doctor -- --checks-only):
  --fix            repair: npm install, android/local.properties, a wrong org.gradle.java.home,
                   gradlew.bat line endings, .env file encoding, misnamed secret files
  --checks-only    only the checks, build nothing
  --apk            build android/app/build/outputs/apk/debug/app-debug.apk
  --install        install the APK on the phone with adb (alone: installs the APK that is there)
  --logcat         show the phone log (alone: only the log, no checks)
  --firmware       compile the ESP32-CAM firmware (alone: no app build)
  --port <port>    with --firmware: also upload, for example --port COM5 or --port /dev/ttyUSB0
  --skip-tests     skip the unit tests and the firmware tests
  --verbose        show the full output of every step
  --dry-run        show what would be fixed and run, change nothing
  --help           this text

Writes doctor-report.txt in the project folder (no secret values).
Exit code 1 when something FAILED. Simple guide: docs/DOCTOR.md`;

// ───────────────────────────── output ─────────────────────────────

const TTY = !!process.stdout.isTTY;
const COLOR = TTY && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb';
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');
const bold = paint('1');
const dim = paint('2');
const STATUS_COLOR = { PASS: green, WARN: yellow, FAIL: red, SKIP: dim, DRY: cyan };
const RANK = { PASS: 0, WARN: 1, FAIL: 2 };
const worse = (a, b) => (RANK[b] > RANK[a] ? b : a);
const out = (s = '') => process.stdout.write(`${s}\n`);
const strip = (s) => (util.stripVTControlCharacters ? util.stripVTControlCharacters(String(s)) : String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ''));

function statusLine(text) {
  if (!TTY) return;
  const width = Math.max(20, (process.stdout.columns || 100) - 1);
  const plain = strip(text).replace(/\s+/g, ' ');
  process.stdout.write(`\r\x1b[K${dim(plain.length > width ? `${plain.slice(0, width - 3)}...` : plain)}`);
}
function clearStatusLine() {
  if (TTY) process.stdout.write('\r\x1b[K');
}

function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}
function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1048576) return `${(n / 1048576).toFixed(n % 1048576 ? 2 : 0)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

// ───────────────────────────── small helpers ─────────────────────────────

const isFile = (p) => {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p) => {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const readText = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};
const readJson = (p) => {
  const t = readText(p);
  if (t === null) return null;
  try {
    return JSON.parse(t.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
};
function rel(p) {
  const r = path.relative(ROOT, p);
  return !r ? '.' : r.startsWith('..') || path.isAbsolute(r) ? p : r;
}
function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

/** Finds a program on PATH. On Windows only .exe/.com count: the doctor starts them without a shell. */
function findOnPath(name) {
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = IS_WIN ? ['.exe', '.com'] : [''];
  for (const raw of dirs) {
    const dir = raw.replace(/^"(.*)"$/, '$1');
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (isFile(p)) return p;
    }
  }
  return null;
}

/** Quotes one argument for cmd.exe (only used with shell:true on Windows). */
function quoteArg(a) {
  const s = String(a);
  if (s === '') return '""';
  return /[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Runs a short command and returns its output (never throws). */
function sh(cmd, args = [], { cwd = ROOT, shell = false, timeout = 30000, env } = {}) {
  try {
    const opts = { cwd, encoding: 'utf8', timeout, windowsHide: true, env: env || process.env };
    const r = shell ? spawnSync([cmd, ...args].map(quoteArg).join(' '), { ...opts, shell: true }) : spawnSync(cmd, args, opts);
    const stdout = r.stdout || '';
    const stderr = r.stderr || '';
    return { ok: r.status === 0 && !r.error, code: r.status, stdout, stderr, out: stdout + stderr };
  } catch (e) {
    return { ok: false, code: null, stdout: '', stderr: String(e && e.message), out: String(e && e.message) };
  }
}

// Minimal semver range test for package "engines" fields: ||, AND (spaces), >= > <= < =, ^, ~, x-ranges, a - b.
function parseVersion(v) {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
}
function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
function testComparator(v, comp) {
  const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+][\w.-]*)?$/.exec(comp);
  if (!m) return true; // unknown syntax: do not block
  const op = m[1] || '=';
  const raw = [m[2], m[3], m[4]];
  let given = raw.findIndex((p) => p === undefined || /^[xX*]$/.test(p));
  if (given === -1) given = 3;
  const lo = raw.map((p, i) => (i < given ? Number(p) : 0));
  const next = given === 1 ? [lo[0] + 1, 0, 0] : [lo[0], lo[1] + 1, 0];
  switch (op) {
    case '>=':
      return cmpVer(v, lo) >= 0;
    case '>':
      return given === 0 ? false : given === 3 ? cmpVer(v, lo) > 0 : cmpVer(v, next) >= 0;
    case '<':
      return given === 0 ? false : cmpVer(v, lo) < 0;
    case '<=':
      return given === 0 ? true : given === 3 ? cmpVer(v, lo) <= 0 : cmpVer(v, next) < 0;
    case '~':
      return given === 0 ? true : cmpVer(v, lo) >= 0 && cmpVer(v, next) < 0;
    case '^': {
      if (given === 0) return true;
      const hi = lo[0] > 0 || given === 1 ? [lo[0] + 1, 0, 0] : lo[1] > 0 || given === 2 ? [0, lo[1] + 1, 0] : [0, 0, lo[2] + 1];
      return cmpVer(v, lo) >= 0 && cmpVer(v, hi) < 0;
    }
    default:
      return given === 0 ? true : given === 3 ? cmpVer(v, lo) === 0 : cmpVer(v, lo) >= 0 && cmpVer(v, next) < 0;
  }
}
function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v || !range || !String(range).trim()) return true;
  return String(range)
    .split('||')
    .some((alt) => {
      const part = alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1');
      if (!part || part === '*' || /^[xX]$/.test(part)) return true;
      const hy = /^(\S+)\s+-\s+(\S+)$/.exec(part);
      if (hy) return testComparator(v, `>=${hy[1]}`) && testComparator(v, `<=${hy[2]}`);
      return part.split(/\s+/).every((c) => testComparator(v, c));
    });
}

// Java .properties files (gradle.properties, local.properties)
function unescapeProp(s) {
  return String(s).replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (_, hex, ch) => (hex ? String.fromCharCode(parseInt(hex, 16)) : { t: '\t', n: '\n', r: '\r', f: '\f' }[ch] ?? ch));
}
function escapePropValue(s) {
  let r = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    if (ch === '\\') r += '\\\\';
    else if (ch === ':' || ch === '=' || ch === '#' || ch === '!') r += `\\${ch}`;
    else if (code < 0x20 || code > 0x7e) r += `\\u${code.toString(16).padStart(4, '0')}`;
    else r += ch;
  }
  return r.replace(/^ /, '\\ ');
}
function parseProps(text) {
  const res = {};
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!line.trim() || /^\s*[#!]/.test(line)) continue;
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i].replace(/^\s+/, '');
    const m = /^\s*((?:\\.|[^=:\s\\])+)\s*[=:\s]\s*(.*)$/.exec(line);
    if (m) res[unescapeProp(m[1])] = unescapeProp(m[2]).trimEnd();
  }
  return res;
}

// .env files. Vite 8 reads them with Node's util.parseEnv, so the doctor uses it too (same result).
function parseEnvText(text) {
  if (typeof util.parseEnv === 'function') {
    try {
      return { ...util.parseEnv(text) };
    } catch {
      /* fall through */
    }
  }
  const res = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([\w.\-\uFEFF]+)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    const q = /^(['"`])([\s\S]*)\1$/.exec(m[2]);
    res[m[1]] = q ? q[2] : m[2].replace(/\s+#.*$/, '');
  }
  return res;
}
/** Reads an env file the way Vite sees it, and notices Windows encodings Vite cannot read. */
function readEnvFile(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  let utf16 = null;
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    utf16 = 'UTF-16';
    text = buf.subarray(2).toString('utf16le');
  } else if (buf[0] === 0xfe && buf[1] === 0xff) {
    utf16 = 'UTF-16';
    const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    text = body.swap16().toString('utf16le');
  } else text = buf.toString('utf8');
  const bom = !utf16 && text.charCodeAt(0) === 0xfeff;
  return { utf16, bom, text, values: utf16 ? {} : parseEnvText(text), decoded: utf16 ? parseEnvText(text) : null };
}

/** Windows hides file endings: Notepad saves ".env.txt", browsers save "google-services (1).json". */
function misnamed(dir, base) {
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return [`${base}.txt`, `${base}${ext || '.txt'}`, `${stem} (1)${ext}`, `${stem}(1)${ext}`, `${stem} (2)${ext}`, `${stem} - Copy${ext}`]
    .filter((n, i, all) => n !== base && all.indexOf(n) === i)
    .map((n) => path.join(dir, n));
}

// ───────────────────────────── arguments ─────────────────────────────

function parseArgs(argv, env) {
  const a = { fix: false, checksOnly: false, apk: false, install: false, logcat: false, firmware: false, port: null, skipTests: false, verbose: false, dryRun: false, help: false, unknown: [], fromNpmConfig: [], raw: argv.join(' ') };
  const flags = { '--fix': 'fix', '--checks-only': 'checksOnly', '--apk': 'apk', '--install': 'install', '--logcat': 'logcat', '--firmware': 'firmware', '--skip-tests': 'skipTests', '--verbose': 'verbose', '--dry-run': 'dryRun', '--help': 'help', '-h': 'help', '/?': 'help' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (flags[arg]) a[flags[arg]] = true;
    else if (arg === '--port' || arg === '-p') {
      const v = argv[i + 1];
      if (v && !v.startsWith('-')) {
        a.port = v;
        i++;
      } else a.unknown.push(`${arg} (needs a port, for example --port COM5)`);
    } else if (arg.startsWith('--port=')) a.port = arg.slice(7) || null;
    else if (/^(COM\d+|\/dev\/\S+)$/i.test(arg) && !a.port) a.port = arg; // "npm run doctor --port COM5" passes only "COM5"
    else a.unknown.push(arg);
  }
  // "npm run doctor --fix" (no extra "--"), or PowerShell eating the "--": npm then keeps the option for
  // itself and exposes it as npm_config_<name>. Pick those up so the command still does what was asked.
  if (env.npm_lifecycle_event) {
    const map = { fix: 'fix', checks_only: 'checksOnly', apk: 'apk', install: 'install', logcat: 'logcat', firmware: 'firmware', skip_tests: 'skipTests', dry_run: 'dryRun' };
    for (const [k, key] of Object.entries(map)) {
      if (env[`npm_config_${k}`] === 'true' && !a[key]) {
        a[key] = true;
        a.fromNpmConfig.push(`--${k.replace(/_/g, '-')}`);
      }
    }
    if (env.npm_config_port && env.npm_config_port !== 'true' && !a.port) {
      a.port = env.npm_config_port;
      a.fromNpmConfig.push(`--port ${a.port}`);
    }
    if (env.npm_config_loglevel === 'verbose') a.verbose = true;
  }
  return a;
}

function modes(a) {
  return {
    logcatOnly: a.logcat && !a.apk && !a.install && !a.firmware && !a.checksOnly && !a.fix,
    appPipeline: !a.checksOnly && (a.apk || (!a.install && !a.firmware)),
  };
}

function describeMode(ctx) {
  const a = ctx.args;
  const parts = ['checks'];
  if (a.fix) parts.push('fixes');
  if (!a.checksOnly) {
    if (ctx.mode.appPipeline) parts.push(a.skipTests ? 'typecheck, web build, cap sync' : 'typecheck, tests, web build, cap sync');
    if (a.apk) parts.push('APK');
    if (a.install) parts.push('install on phone');
    if (a.firmware) parts.push(a.port ? `firmware compile + upload to ${a.port}` : 'firmware compile');
    if (a.logcat) parts.push('logcat');
  }
  return `${parts.join(' + ')}${a.dryRun ? '  (DRY RUN: nothing is changed or built)' : ''}`;
}

// ───────────────────────────── context ─────────────────────────────

function createContext(args) {
  const ctx = {
    args,
    mode: modes(args),
    started: new Date(),
    checks: [],
    steps: [],
    fixes: [],
    versions: [],
    notes: [],
    secrets: new Map(),
    env: {},
    envFiles: [],
    envExample: {},
    pkg: readJson(path.join(ROOT, 'package.json')) || {},
    requiredJava: requiredJavaVersion(),
    gradleEnv: {},
    sdkEnv: {},
    interrupted: false,
    onInterrupt: null,
  };
  ctx.needsBuild = args.apk && !args.checksOnly;
  ctx.needsAdb = (args.install || args.logcat) && !args.checksOnly;
  ctx.addSecret = (label, value, exampleValue) => {
    const v = String(value ?? '').trim();
    if (v.length < 6 || v === String(exampleValue ?? '').trim() || /^(true|false)$/i.test(v) || ROOT.includes(v)) return;
    ctx.secrets.set(v, label);
  };
  ctx.redact = (text) => {
    let t = String(text);
    for (const [v, label] of ctx.secrets) t = t.split(v).join(`<${label} hidden>`);
    return t;
  };
  /** Applies a fix (only with --fix). Returns the text for the report, or null. */
  ctx.doFix = (done, todo, fn) => {
    if (!args.fix) return null;
    if (args.dryRun) return { dry: true, text: `would ${todo}` };
    fn();
    ctx.fixes.push(done);
    return { dry: false, text: done };
  };
  return ctx;
}

function requiredJavaVersion() {
  let req = 0;
  for (const f of [path.join(ANDROID_DIR, 'app', 'capacitor.build.gradle'), path.join(ROOT, 'node_modules', '@capacitor', 'android', 'capacitor', 'build.gradle')]) {
    for (const m of (readText(f) || '').matchAll(/JavaVersion\.VERSION_(\d+)(?:_(\d+))?/g)) {
      const v = m[1] === '1' && m[2] ? Number(m[2]) : Number(m[1]);
      if (v > req) req = v;
    }
  }
  return req || 21;
}

function addCheck(ctx, row) {
  const infos = [].concat(row.fixInfo || []).filter(Boolean);
  delete row.fixInfo;
  const done = infos.filter((i) => !i.dry).map((i) => i.text);
  const would = infos.filter((i) => i.dry).map((i) => i.text);
  if (done.length) row.fixed = [row.fixed, ...done].filter(Boolean).join('; ');
  if (would.length) row.wouldFix = [row.wouldFix, ...would].filter(Boolean).join('; ');
  ctx.checks.push(row);
  const pad = ' '.repeat(8);
  out(`  ${STATUS_COLOR[row.status](row.status)}  ${row.name.padEnd(NAME_WIDTH)} ${row.detail}`);
  if (row.fixed) out(`${pad}${green('fixed:')} ${row.fixed}`);
  if (row.wouldFix) out(`${pad}${cyan('dry run:')} ${row.wouldFix}`);
  if (row.fix && row.status !== 'PASS') out(`${pad}${yellow('fix:')} ${row.fix}`);
  if (row.note) out(`${pad}${dim(`note: ${row.note}`)}`);
}

async function guard(ctx, name, fn) {
  try {
    await fn();
  } catch (e) {
    addCheck(ctx, { name, status: 'WARN', detail: `could not be checked (${String((e && e.message) || e).split('\n')[0]})`, fix: 'send doctor-report.txt to the developer' });
  }
}

// ───────────────────────────── checks ─────────────────────────────

function collectEngines(dir) {
  const pkg = readJson(path.join(dir, 'package.json')) || {};
  const lock = readJson(path.join(dir, 'package-lock.json'));
  const res = [];
  for (const name of Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })) {
    const meta = readJson(path.join(dir, 'node_modules', ...name.split('/'), 'package.json')) || (lock && lock.packages && lock.packages[`node_modules/${name}`]);
    const range = meta && meta.engines && typeof meta.engines === 'object' && !Array.isArray(meta.engines) ? meta.engines.node : null;
    if (typeof range === 'string' && range.trim()) res.push({ name, version: meta.version || '?', range: range.trim() });
  }
  return res;
}

function checkNode(ctx) {
  const name = 'Node.js';
  const v = process.versions.node;
  const major = Number(v.split('.')[0]);
  ctx.versions.push(['Node.js', `v${v}${process.release.lts ? ` (LTS "${process.release.lts}")` : ' (not LTS)'}`]);
  const engines = collectEngines(ROOT);
  const bad = engines.filter((e) => !satisfies(v, e.range));
  // The lowest x.y that every package accepts, to say exactly what to install.
  let needed = null;
  for (const m of [18, 20, 22, 24, 26]) {
    for (let minor = 0; minor <= 40 && !needed; minor++) if (engines.every((e) => satisfies(`${m}.${minor}.0`, e.range))) needed = `${m}.${minor}`;
    if (needed) break;
  }
  const fix = 'install Node.js 22 LTS or 24 LTS from https://nodejs.org, then open a NEW terminal and run the command again';
  ctx.nodeTooOld = major < 18 || bad.length > 0;
  if (major < 18) return addCheck(ctx, { name, status: 'FAIL', detail: `v${v} is too old${needed ? ` (the project needs ${needed} or newer)` : ''}`, fix });
  if (bad.length) {
    const list = bad.slice(0, 3).map((e) => `${e.name} ${e.version} needs ${e.range}`).join('; ');
    return addCheck(ctx, { name, status: 'FAIL', detail: `v${v} is too old${needed ? `: the project needs Node.js ${needed} or newer` : ''} (${list})`, fix });
  }
  if (!process.release.lts) return addCheck(ctx, { name, status: 'WARN', detail: `v${v} works, but it is not an LTS (long-term support) release`, fix: 'recommended: Node.js 22 LTS or 24 LTS from https://nodejs.org' });
  addCheck(ctx, { name, status: 'PASS', detail: `v${v} LTS${needed ? ` (project needs ${needed}+)` : ''}` });
}

function checkNpm(ctx) {
  const name = 'npm';
  let v = /\bnpm\/(\d[\w.-]*)/.exec(process.env.npm_config_user_agent || '')?.[1];
  if (!v) {
    const r = sh('npm', ['-v'], { shell: IS_WIN });
    v = r.ok ? r.stdout.trim().split(/\s+/).pop() : null;
  }
  if (!v) return addCheck(ctx, { name, status: 'FAIL', detail: 'npm not found', fix: 'install Node.js again from https://nodejs.org (npm comes with it)' });
  ctx.versions.push(['npm', v]);
  if (Number(v.split('.')[0]) < 7) return addCheck(ctx, { name, status: 'FAIL', detail: `${v} is too old for this package-lock.json`, fix: 'npm install -g npm@10' });
  addCheck(ctx, { name, status: 'PASS', detail: v });
}

function checkProjectFolder(ctx) {
  const name = 'Project folder';
  if (!IS_WIN) return addCheck(ctx, { name, status: 'PASS', detail: ROOT });
  const problems = [];
  let status = 'PASS';
  if (/[^\x20-\x7e]/.test(ROOT)) {
    problems.push('the folder path has non-English letters (the Android build fails on Windows)');
    status = ctx.needsBuild ? 'FAIL' : 'WARN';
  }
  const oneDrive = process.env.OneDrive || process.env.OneDriveConsumer || process.env.OneDriveCommercial;
  if (/[\\/]OneDrive( - [^\\/]+)?[\\/]/i.test(`${ROOT}\\`) || (oneDrive && ROOT.toLowerCase().startsWith(oneDrive.toLowerCase()))) {
    problems.push('it is inside OneDrive (syncing locks files and makes builds slow or fail)');
    status = worse(status, 'WARN');
  }
  if (ROOT.length > 80) {
    problems.push(`the path is long (${ROOT.length} letters; Android builds can hit the Windows path limit)`);
    status = worse(status, 'WARN');
  }
  if (!problems.length) return addCheck(ctx, { name, status: 'PASS', detail: ROOT });
  addCheck(ctx, { name, status, detail: `${ROOT}: ${problems.join('; ')}`, fix: 'move the project to a short, plain folder, for example C:\\dev\\aismartstick, then run the command there' });
}

function missingBins(nm, deps) {
  const missing = [];
  for (const d of deps) {
    const pj = readJson(path.join(nm, ...d.split('/'), 'package.json'));
    if (!pj || !pj.bin) continue;
    const names = typeof pj.bin === 'string' ? [String(pj.name || d).split('/').pop()] : Object.keys(pj.bin);
    for (const b of names) if (!fs.existsSync(path.join(nm, '.bin', IS_WIN ? `${b}.cmd` : b))) missing.push(b);
  }
  return missing;
}
let libcCache = null;
function libc() {
  if (libcCache) return libcCache;
  try {
    libcCache = process.report && process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl';
  } catch {
    libcCache = 'glibc';
  }
  return libcCache;
}
function listMatch(list, value) {
  if (!Array.isArray(list) || !list.length) return true;
  const neg = list.filter((x) => String(x).startsWith('!')).map((x) => String(x).slice(1));
  const pos = list.filter((x) => !String(x).startsWith('!'));
  return !neg.includes(value) && (!pos.length || pos.includes(value));
}
/** Inspects node_modules: missing packages, and native packages for THIS computer (a copied node_modules has the wrong ones). */
function inspectNodeModules(dir, pkg) {
  const nm = path.join(dir, 'node_modules');
  if (!isDir(nm)) return { ok: false, absent: true, missing: [], foreign: [], bins: [] };
  const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
  const missing = deps.filter((d) => !isFile(path.join(nm, ...d.split('/'), 'package.json')));
  const foreign = [];
  const lock = readJson(path.join(dir, 'package-lock.json'));
  for (const [key, meta] of Object.entries((lock && lock.packages) || {})) {
    if (!key || !meta || (!meta.os && !meta.cpu)) continue;
    if (!listMatch(meta.os, process.platform) || !listMatch(meta.cpu, process.arch)) continue;
    if (meta.libc && process.platform === 'linux' && !listMatch(meta.libc, libc())) continue;
    if (!isFile(path.join(dir, ...key.split('/'), 'package.json'))) foreign.push(key.replace(/^.*node_modules\//, ''));
  }
  const bins = missingBins(nm, deps.filter((d) => !missing.includes(d)));
  return { ok: !missing.length && !foreign.length && !bins.length, absent: false, missing, foreign, bins, count: deps.length - missing.length };
}
function describeNodeModules(s, label) {
  if (s.absent) return `${label} is missing (packages not installed)`;
  const parts = [];
  if (s.missing.length) parts.push(`${s.missing.length} package(s) not installed: ${s.missing.slice(0, 4).join(', ')}${s.missing.length > 4 ? ', ...' : ''}`);
  if (s.foreign.length) parts.push(`it was installed on another kind of computer (missing ${s.foreign.slice(0, 2).join(', ')}${s.foreign.length > 2 ? ', ...' : ''})`);
  if (s.bins.length) parts.push(`command links are missing (${s.bins.slice(0, 3).join(', ')}), so it was copied from another computer`);
  return parts.join('; ');
}

async function checkNodeModules(ctx, dir, label, main) {
  const pkg = readJson(path.join(dir, 'package.json'));
  if (!pkg) return;
  const where = rel(dir);
  const state = inspectNodeModules(dir, pkg);
  if (state.ok) return addCheck(ctx, { name: label, status: 'PASS', detail: `${state.count} packages installed` });
  const why = describeNodeModules(state, label);
  const failStatus = main ? 'FAIL' : 'WARN';
  const purpose = main ? '' : ' (only needed to build or deploy the Cloud Functions)';
  if (!ctx.args.fix) {
    if (main) ctx.nodeModulesBad = true;
    return addCheck(ctx, { name: label, status: failStatus, detail: why + purpose, fix: `run: npm run doctor:fix  (it runs npm install${where === '.' ? '' : ` in ${where}`})` });
  }
  const reinstall = state.foreign.length > 0 || state.bins.length > 0;
  if (ctx.args.dryRun) {
    if (main) ctx.nodeModulesBad = true;
    return addCheck(ctx, { name: label, status: failStatus, detail: why + purpose, wouldFix: `would ${reinstall ? 'delete node_modules and ' : ''}run npm install in ${where}` });
  }
  if (reinstall) {
    out(dim(`        ${label} came from another computer: deleting it and installing again (a few minutes)`));
    try {
      fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (e) {
      if (main) ctx.nodeModulesBad = true;
      return addCheck(ctx, { name: label, status: failStatus, detail: `${why}; could not delete it (${e.code || e.message})`, fix: `close your IDE, Android Studio and other terminals, delete the folder ${path.join(dir, 'node_modules')} by hand, then run npm run doctor:fix` });
    }
  }
  const r = await runTask(ctx, { title: `npm install (${where})`, cmd: 'npm', args: ['install'], cwd: dir, shell: IS_WIN });
  const after = inspectNodeModules(dir, pkg);
  if (r.ok && after.ok) {
    ctx.fixes.push(`ran npm install in ${where}`);
    return addCheck(ctx, { name: label, status: 'PASS', detail: `${after.count} packages installed`, fixed: `ran npm install in ${where} (${fmtMs(r.ms)})` });
  }
  if (main) ctx.nodeModulesBad = true;
  const tail = r.lines.slice(-TAIL_LINES).map((l) => ctx.redact(l));
  if (!r.ok) {
    out(dim('        --- last lines of npm install ---'));
    tail.forEach((l) => out(dim(`        | ${l}`)));
  }
  addCheck(ctx, {
    name: label,
    status: failStatus,
    detail: r.ok ? describeNodeModules(after, label) : `npm install failed (exit code ${r.code})${purpose}`,
    fix: hintsFor(r.lines)[0] || 'check the internet connection, close other programs that use the folder, then run npm run doctor:fix again',
    tail,
  });
}

/** Moves a misnamed or misplaced file to its real name when --fix is given. */
function locate(ctx, target, alternatives) {
  if (isFile(target)) return { exists: true };
  const found = alternatives.find(isFile) || null;
  if (!found) return { exists: false, found: null };
  const info = ctx.doFix(`renamed ${rel(found)} to ${rel(target)}`, `rename ${rel(found)} to ${rel(target)}`, () => fs.renameSync(found, target));
  return { exists: !!info && !info.dry, found, fixInfo: info };
}

function checkEnv(ctx) {
  const name = '.env';
  const example = readEnvFile(path.join(ROOT, '.env.example'));
  if (!example) return addCheck(ctx, { name, status: 'WARN', detail: '.env.example is missing, so the keys cannot be checked', fix: 'take .env.example from the original project ZIP' });
  const exampleValues = example.values;
  const keys = Object.keys(exampleValues);
  ctx.envExample = exampleValues;
  ctx.mapsKeyName = keys.find((k) => /^VITE_.*MAPS.*BROWSER.*KEY$/.test(k)) || keys.find((k) => /^VITE_.*MAPS.*KEY$/.test(k)) || null;
  ctx.appCheckDebugKey = keys.find((k) => k === 'VITE_APPCHECK_DEBUG') || null;
  const required = keys.filter((k) => /^VITE_FIREBASE_/.test(k) && !String(exampleValues[k] || '').trim());
  const ownRow = new Set([ctx.mapsKeyName, ctx.appCheckDebugKey].filter(Boolean));

  const loc = locate(ctx, path.join(ROOT, '.env'), misnamed(ROOT, '.env'));
  const fixInfos = loc.fixInfo ? [loc.fixInfo] : [];
  const problems = [];
  // Vite (`vite build`, mode "production") reads these; later files win, then VITE_* environment variables.
  const merged = {};
  let unreadable = false;
  for (const f of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    const p = path.join(ROOT, f);
    let info = readEnvFile(p);
    if (!info) continue;
    if (info.utf16 || info.bom) {
      const kind = info.utf16 ? 'UTF-16 (Vite cannot read it at all)' : '"UTF-8 with BOM" (Vite ignores its first line)';
      const text = info.text.replace(/^\uFEFF/, '');
      const fx = ctx.doFix(`saved ${f} again as plain UTF-8`, `save ${f} again as plain UTF-8`, () => fs.writeFileSync(p, text, 'utf8'));
      if (fx) fixInfos.push(fx);
      if (fx && !fx.dry) info = readEnvFile(p);
      else {
        problems.push(`${f} is saved as ${kind}`);
        if (info.utf16) unreadable = true;
      }
    }
    ctx.envFiles.push(f);
    Object.assign(merged, info.values);
    for (const [k, v] of Object.entries(info.decoded || info.values)) ctx.addSecret(k.replace(/^\uFEFF/, ''), v, exampleValues[k]);
  }
  const fromProcess = Object.keys(process.env).filter((k) => k.startsWith('VITE_'));
  for (const k of fromProcess) merged[k] = process.env[k];
  ctx.env = merged;
  const fixInfo = fixInfos;

  if (!ctx.envFiles.length) {
    return addCheck(ctx, {
      name,
      status: 'FAIL',
      detail: loc.found && !loc.exists ? `found ${rel(loc.found)} instead of .env` : '.env not found',
      fix: loc.found ? `rename ${rel(loc.found)} to .env (or run npm run doctor:fix)` : `copy your .env file into ${ROOT} (next to package.json); the template is .env.example`,
      fixInfo,
    });
  }
  const isEmpty = (k) => merged[k] === undefined || !String(merged[k]).trim();
  const badRequired = required.filter(isEmpty);
  const optional = keys.filter((k) => !required.includes(k) && !ownRow.has(k));
  const notInFile = unreadable ? [] : optional.filter((k) => merged[k] === undefined);
  const emptyWithDefault = unreadable ? [] : optional.filter((k) => merged[k] !== undefined && !String(merged[k]).trim() && String(exampleValues[k] || '').trim());
  const emptyOptional = optional.filter((k) => merged[k] !== undefined && !String(merged[k]).trim() && !String(exampleValues[k] || '').trim());
  const unknown = Object.keys(merged).filter((k) => k.startsWith('VITE_') && !keys.includes(k) && !fromProcess.includes(k));

  let status = 'PASS';
  const parts = [];
  const fixes = [];
  if (badRequired.length) {
    status = 'FAIL';
    parts.push(`missing or empty: ${badRequired.join(', ')}`);
    fixes.push('Firebase console > Project settings > General > Your apps > Web app > "SDK setup and configuration" > Config: copy each value into .env');
  }
  if (problems.length) {
    status = worse(status, 'WARN');
    parts.push(problems.join('; '));
    fixes.push('run npm run doctor:fix (saves it again as UTF-8), or in your editor: Save with Encoding > UTF-8');
  }
  if (notInFile.length) {
    status = worse(status, 'WARN');
    parts.push(`not in .env: ${notInFile.join(', ')}`);
    fixes.push('copy those lines from .env.example into .env');
  }
  if (emptyWithDefault.length) {
    status = worse(status, 'WARN');
    parts.push(`empty, but .env.example has a value: ${emptyWithDefault.map((k) => `${k} (example: ${exampleValues[k]})`).join(', ')}`);
    fixes.push('put the example value there, or delete the line');
  }
  if (keys.includes('VITE_APP_MODE') && String(merged.VITE_APP_MODE || '').trim() === 'demo') {
    status = worse(status, 'WARN');
    parts.push('VITE_APP_MODE is demo: the APK will show simulated data');
    fixes.push('set VITE_APP_MODE=real in .env');
  }
  if (unknown.length) parts.push(`not in .env.example (typing mistake?): ${unknown.join(', ')}`);
  const source = ctx.envFiles.length > 1 || ctx.envFiles[0] !== '.env' ? ` (read from ${ctx.envFiles.join(' + ')})` : '';
  const detail =
    status === 'PASS'
      ? `all ${required.length} Firebase keys are set${emptyOptional.length ? `; optional and empty: ${emptyOptional.join(', ')}` : ''}${unknown.length ? `; ${parts.join('; ')}` : ''}${source}`
      : `${parts.join('; ')}${source}`;
  addCheck(ctx, { name, status, detail, fix: fixes.join('; ') || null, fixInfo });
}

function checkMapsKey(ctx) {
  const key = ctx.mapsKeyName;
  if (!key || !ctx.envFiles.length) return;
  const set = !!String(ctx.env[key] || '').trim();
  const origin = ctx.webOrigin || 'https://localhost';
  addCheck(ctx, {
    name: 'Google Maps key',
    status: set ? 'PASS' : 'WARN',
    detail: set ? `${key} is set` : `${key} is missing or empty: the map will not load`,
    fix: set ? null : `Google Cloud console > APIs & Services > Credentials > create an API key for "Maps JavaScript API", put it in .env as ${key}`,
    note: `reminder: the key's "Website restrictions" must allow ${origin}/* (the app's address inside Android); an "Android apps" restriction does not work for this key`,
  });
}

function checkAppCheck(ctx) {
  const key = ctx.appCheckDebugKey;
  if (!key || !ctx.envFiles.length) return;
  const name = 'App Check (debug APK)';
  const serverOff = ctx.functionsEnv && String(ctx.functionsEnv.ENFORCE_APPCHECK || '').trim() === 'false';
  if (String(ctx.env[key] || '').trim() === 'true') {
    return addCheck(ctx, {
      name,
      status: 'PASS',
      detail: `${key} is on (right for test phones; turn it off for Play Store builds)`,
      note: 'after installing, run "npm run logcat", copy the long "debug secret" into Firebase console > App Check > Apps > Android app > Manage debug tokens',
    });
  }
  if (serverOff) {
    return addCheck(ctx, {
      name,
      status: 'WARN',
      detail: `${key} is not true, but functions/.env has ENFORCE_APPCHECK=false: test APKs work once the functions are deployed with it`,
      fix: 'testing only: set ENFORCE_APPCHECK=true again (and deploy) before real users get the app',
    });
  }
  addCheck(ctx, {
    name,
    status: 'WARN',
    detail: `${key} is not true: a debug APK installed over USB fails App Check (Play Integrity), so maps and the assistant are refused`,
    fix: `for test phones set ${key}=true in .env and build again, then register the debug token ("npm run logcat" shows it). Short tests only: ENFORCE_APPCHECK=false in functions/.env, then deploy the functions`,
  });
}

function checkFunctionsEnv(ctx) {
  const name = 'functions/.env';
  const dir = path.join(ROOT, 'functions');
  const example = readEnvFile(path.join(dir, '.env.example'));
  if (!example) return;
  const target = path.join(dir, '.env');
  const loc = locate(ctx, target, misnamed(dir, '.env'));
  let info = readEnvFile(target);
  if (!info) {
    return addCheck(ctx, {
      name,
      status: 'WARN',
      detail: `${loc.found ? `found ${rel(loc.found)} instead` : 'missing'} (only needed to deploy the Cloud Functions)`,
      fix: loc.found ? `rename ${rel(loc.found)} to functions/.env (or run npm run doctor:fix)` : 'copy your functions/.env into the functions folder (template: functions/.env.example)',
      fixInfo: loc.fixInfo,
    });
  }
  const fixInfo = [loc.fixInfo];
  let encoding = null;
  if (info.utf16 || info.bom) {
    const text = info.text.replace(/^\uFEFF/, '');
    const fx = ctx.doFix('saved functions/.env again as plain UTF-8', 'save functions/.env again as plain UTF-8', () => fs.writeFileSync(target, text, 'utf8'));
    fixInfo.push(fx);
    if (fx && !fx.dry) info = readEnvFile(target);
    else encoding = info.utf16 ? 'it is saved as UTF-16' : 'it is saved as "UTF-8 with BOM"';
  }
  const keys = Object.keys(example.values);
  ctx.functionsEnv = info.values;
  for (const [k, v] of Object.entries(info.decoded || info.values)) ctx.addSecret(k.replace(/^\uFEFF/, ''), v, example.values[k]);
  const bad = keys.filter((k) => !String(info.values[k] ?? '').trim());
  const note = 'GEMINI_API_KEY and MAPS_SERVER_KEY are not .env values: set them with "firebase functions:secrets:set"';
  if (bad.length || encoding) {
    return addCheck(ctx, {
      name,
      status: 'WARN',
      detail: [encoding, bad.length ? `missing or empty: ${bad.join(', ')}` : null].filter(Boolean).join('; '),
      fix: encoding ? 'run npm run doctor:fix (saves it again as UTF-8)' : 'copy those lines from functions/.env.example into functions/.env and check the values',
      fixInfo,
      note,
    });
  }
  addCheck(ctx, { name, status: 'PASS', detail: `all ${keys.length} keys are set`, fixInfo, note });
}

function checkFirebaserc(ctx) {
  const name = '.firebaserc';
  const file = path.join(ROOT, '.firebaserc');
  const loc = locate(ctx, file, misnamed(ROOT, '.firebaserc'));
  if (!isFile(file)) {
    return addCheck(ctx, {
      name,
      status: 'WARN',
      detail: `${loc.found ? `found ${rel(loc.found)} instead` : 'missing'} (only needed for "firebase deploy")`,
      fix: loc.found ? `rename ${rel(loc.found)} to .firebaserc (or run npm run doctor:fix)` : 'copy your .firebaserc into the project folder (template: .firebaserc.example)',
      fixInfo: loc.fixInfo,
    });
  }
  const j = readJson(file);
  if (!j) return addCheck(ctx, { name, status: 'WARN', detail: 'is not valid JSON', fix: 'compare it with .firebaserc.example', fixInfo: loc.fixInfo });
  const def = j.projects && j.projects.default;
  const placeholder = (readJson(path.join(ROOT, '.firebaserc.example')) || {}).projects?.default;
  const envProject = String(ctx.env.VITE_FIREBASE_PROJECT_ID || '').trim();
  if (!def) return addCheck(ctx, { name, status: 'WARN', detail: 'has no "default" project', fix: 'write your Firebase project id as projects.default (see .firebaserc.example)', fixInfo: loc.fixInfo });
  if (placeholder && def === placeholder) return addCheck(ctx, { name, status: 'WARN', detail: 'still has the example project id', fix: 'put your own Firebase project id in .firebaserc', fixInfo: loc.fixInfo });
  if (envProject && def !== envProject) return addCheck(ctx, { name, status: 'WARN', detail: 'its default project is not the same as VITE_FIREBASE_PROJECT_ID in .env', fix: 'use the same Firebase project in both files', fixInfo: loc.fixInfo });
  addCheck(ctx, { name, status: 'PASS', detail: `default project is set${envProject ? ' (same as .env)' : ''}`, fixInfo: loc.fixInfo });
}

function checkCapacitorConfig(ctx) {
  const name = 'capacitor.config.json';
  const cfg = readJson(path.join(ROOT, 'capacitor.config.json'));
  const gradle = readText(path.join(ANDROID_DIR, 'app', 'build.gradle')) || '';
  ctx.applicationId = /applicationId\s*=?\s*["']([^"']+)["']/.exec(gradle)?.[1] || null;
  if (!cfg) return addCheck(ctx, { name, status: 'FAIL', detail: 'missing or not valid JSON', fix: 'take capacitor.config.json from the original project ZIP' });
  ctx.appId = cfg.appId || null;
  const server = cfg.server || {};
  ctx.webOrigin = `${server.androidScheme || 'https'}://${server.hostname || 'localhost'}`;
  let status = 'PASS';
  const parts = [];
  const fixes = [];
  if (!ctx.appId) {
    status = 'FAIL';
    parts.push('"appId" is missing');
    fixes.push(`set "appId": "${ctx.applicationId || 'in.aismartstick.app'}"`);
  } else if (ctx.applicationId && ctx.applicationId !== ctx.appId) {
    status = worse(status, 'WARN');
    parts.push(`appId ${ctx.appId} is not the applicationId ${ctx.applicationId} in android/app/build.gradle`);
    fixes.push('use the same id in both files');
  }
  if (cfg.webDir !== 'dist') {
    status = 'FAIL';
    parts.push(`"webDir" is "${cfg.webDir}", but the web build goes to "dist"`);
    fixes.push('set "webDir": "dist"');
  }
  if (!cfg.plugins || !cfg.plugins.CapacitorHttp || cfg.plugins.CapacitorHttp.enabled !== false) {
    status = worse(status, 'WARN');
    parts.push('plugins.CapacitorHttp.enabled is not false');
    fixes.push('set "plugins": { "CapacitorHttp": { "enabled": false } }');
  }
  if (status === 'PASS') return addCheck(ctx, { name, status, detail: `appId ${ctx.appId}, webDir dist, CapacitorHttp off` });
  addCheck(ctx, { name, status, detail: parts.join('; '), fix: fixes.join('; ') });
}

function checkGoogleServices(ctx) {
  const name = 'google-services.json';
  const appDir = path.join(ANDROID_DIR, 'app');
  const target = path.join(appDir, 'google-services.json');
  const loc = locate(ctx, target, [
    ...misnamed(appDir, 'google-services.json'),
    path.join(ANDROID_DIR, 'google-services.json'),
    path.join(ROOT, 'google-services.json'),
    ...misnamed(ROOT, 'google-services.json'),
  ]);
  const id = ctx.applicationId || ctx.appId || 'in.aismartstick.app';
  const download = `Firebase console > Project settings > Your apps > Android app "${id}" > download google-services.json into android/app/`;
  if (!isFile(target)) {
    return addCheck(ctx, {
      name,
      status: 'FAIL',
      detail: loc.found ? `found ${rel(loc.found)}, but it must be android/app/google-services.json` : 'missing: android/app/google-services.json',
      fix: loc.found ? 'move and rename it to android/app/google-services.json (or run npm run doctor:fix)' : download,
      fixInfo: loc.fixInfo,
    });
  }
  const j = readJson(target);
  if (!j) return addCheck(ctx, { name, status: 'FAIL', detail: 'is not valid JSON', fix: download, fixInfo: loc.fixInfo });
  const clients = Array.isArray(j.client) ? j.client : [];
  for (const c of clients) for (const k of c.api_key || []) ctx.addSecret('google-services api_key', k && k.current_key);
  const ids = [...new Set([ctx.appId, ctx.applicationId].filter(Boolean))];
  const pkgOf = (c) => c && c.client_info && c.client_info.android_client_info && c.client_info.android_client_info.package_name;
  const client = clients.find((c) => ids.includes(pkgOf(c)));
  if (!client) {
    return addCheck(ctx, {
      name,
      status: 'FAIL',
      detail: `has no Android app "${ids.join('" / "') || id}" (it has: ${clients.map(pkgOf).filter(Boolean).join(', ') || 'none'})`,
      fix: `Firebase console > Project settings > Add app > Android, package name ${id}; then download its google-services.json into android/app/`,
      fixInfo: loc.fixInfo,
    });
  }
  ctx.googleClient = client;
  let status = 'PASS';
  const parts = [];
  const fixes = [];
  if (!(client.oauth_client || []).some((o) => String(o.client_type) === '3')) {
    status = 'FAIL';
    parts.push('it has no Web client ID, so Google sign-in cannot work');
    fixes.push('Firebase console > Authentication > Sign-in method > enable Google; then download google-services.json again');
  }
  const info = j.project_info || {};
  const envProject = String(ctx.env.VITE_FIREBASE_PROJECT_ID || '').trim();
  const envSender = String(ctx.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '').trim();
  if ((envProject && info.project_id && info.project_id !== envProject) || (envSender && info.project_number && String(info.project_number) !== envSender)) {
    status = worse(status, 'WARN');
    parts.push('it is from a different Firebase project than the VITE_FIREBASE_* values in .env');
    fixes.push('take .env values and google-services.json from the same Firebase project');
  }
  if (status === 'PASS') return addCheck(ctx, { name, status, detail: `Android app ${pkgOf(client)} found, Web client ID present${envProject ? ', same project as .env' : ''}`, fixInfo: loc.fixInfo });
  addCheck(ctx, { name, status, detail: parts.join('; '), fix: fixes.join('; '), fixInfo: loc.fixInfo });
}

// Java
function javaMajor(v) {
  const p = parseVersion(v);
  return p ? (p[0] === 1 ? p[1] : p[0]) : null;
}
const jdkCache = new Map();
/** A JDK folder: version from its "release" file, else from "java -version". */
function jdkInfo(home) {
  if (!home) return null;
  if (jdkCache.has(home)) return jdkCache.get(home);
  let info = null;
  const java = path.join(home, 'bin', IS_WIN ? 'java.exe' : 'java');
  if (isFile(java)) {
    const fromRelease = /^JAVA_VERSION="?([^"\r\n]+)"?/m.exec(readText(path.join(home, 'release')) || '')?.[1];
    const version = fromRelease || /version "([^"]+)"/.exec(sh(java, ['-version']).out)?.[1] || null;
    info = { home, java, version, major: javaMajor(version) };
  }
  jdkCache.set(home, info);
  return info;
}
function javaFromBinary(bin) {
  const version = /version "([^"]+)"/.exec(sh(bin, ['-version']).out)?.[1] || null;
  return version ? { home: null, java: bin, version, major: javaMajor(version) } : null;
}
/** Android Studio comes with its own Java (JBR). */
function androidStudioJdk() {
  const home = os.homedir();
  const c = [];
  if (IS_WIN) {
    const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
    for (const b of bases) c.push(path.join(b, 'Android', 'Android Studio', 'jbr'), path.join(b, 'Android Studio', 'jbr'), path.join(b, 'Android', 'Android Studio', 'jre'));
    if (process.env.LOCALAPPDATA) for (const ch of listDirs(path.join(process.env.LOCALAPPDATA, 'JetBrains', 'Toolbox', 'apps', 'AndroidStudio'))) for (const v of listDirs(ch)) c.push(path.join(v, 'jbr'));
  } else if (IS_MAC) {
    for (const app of ['/Applications/Android Studio.app', path.join(home, 'Applications', 'Android Studio.app')]) c.push(path.join(app, 'Contents', 'jbr', 'Contents', 'Home'));
  } else {
    c.push('/opt/android-studio/jbr', path.join(home, 'android-studio', 'jbr'), '/snap/android-studio/current/jbr', '/usr/local/android-studio/jbr');
  }
  return c.map(jdkInfo).filter(Boolean).sort((a, b) => (b.major || 0) - (a.major || 0))[0] || null;
}

function checkGradleJavaHome(ctx) {
  const name = 'Gradle Java setting';
  const file = path.join(ANDROID_DIR, 'gradle.properties');
  const text = readText(file);
  if (text === null) return;
  const entries = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = /^\s*org\.gradle\.java\.home\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (m) entries.push({ i, value: unescapeProp(m[1]) });
  });
  if (!entries.length) return addCheck(ctx, { name, status: 'PASS', detail: 'android/gradle.properties does not force a Java folder (JAVA_HOME or Android Studio\'s Java is used)' });
  const last = entries[entries.length - 1];
  const lastInfo = jdkInfo(last.value);
  if (lastInfo) {
    ctx.gradleJdk = lastInfo;
    if (lastInfo.major && lastInfo.major < ctx.requiredJava) {
      ctx.gradleJavaHomeBad = true;
      return addCheck(ctx, { name, status: 'FAIL', detail: `org.gradle.java.home is Java ${lastInfo.major} (${last.value}); this project needs Java ${ctx.requiredJava}`, fix: `change that line in android/gradle.properties to a JDK ${ctx.requiredJava} folder, or delete it` });
    }
    return addCheck(ctx, { name, status: 'PASS', detail: `org.gradle.java.home = ${last.value} (Java ${lastInfo.version})` });
  }
  // The folder does not exist on this PC: Gradle and Android Studio both stop with "Java home supplied is invalid".
  const bad = entries.filter((e) => !jdkInfo(e.value));
  const date = new Date().toISOString().slice(0, 10);
  const fx = ctx.doFix(
    `commented out org.gradle.java.home in android/gradle.properties (folder not found: ${last.value})`,
    `comment out org.gradle.java.home in android/gradle.properties`,
    () => {
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const idx = new Set(bad.map((e) => e.i));
      const lines = [];
      text.split(/\r?\n/).forEach((line, i) => {
        if (idx.has(i)) lines.push(`# [doctor ${date}] Commented out: this Java folder does not exist on this PC. Gradle now uses JAVA_HOME or Android Studio's Java (JBR).`, `# ${line.trim()}`);
        else lines.push(line);
      });
      fs.writeFileSync(file, lines.join(eol));
    },
  );
  if (fx && !fx.dry) return addCheck(ctx, { name, status: 'PASS', detail: 'no forced Java folder any more: Gradle uses JAVA_HOME or Android Studio\'s Java', fixInfo: fx });
  ctx.gradleJavaHomeBad = true;
  addCheck(ctx, {
    name,
    status: 'FAIL',
    detail: `org.gradle.java.home in android/gradle.properties points to a folder that does not exist: ${last.value}`,
    fix: 'run npm run doctor:fix (it comments that line out; then JAVA_HOME or Android Studio\'s Java is used)',
    fixInfo: fx,
  });
}

function checkJava(ctx) {
  const req = ctx.requiredJava;
  const name = `Java (JDK ${req})`;
  const envHome = process.env.JAVA_HOME ? process.env.JAVA_HOME.replace(/^"(.*)"$/, '$1') : null;
  const fromEnv = envHome ? jdkInfo(envHome) : null;
  const pathJava = findOnPath('java');
  const fromPath = pathJava ? javaFromBinary(pathJava) : null;
  const jbr = androidStudioJdk();
  if (jbr) ctx.versions.push(['Android Studio Java', `${jbr.version} (${jbr.home})`]);
  const tool = IS_WIN ? 'keytool.exe' : 'keytool';
  ctx.keytool = [fromEnv, ctx.gradleJdk, jbr].filter(Boolean).map((j) => path.join(j.home, 'bin', tool)).find(isFile) || findOnPath('keytool');
  const launcher = fromEnv || (envHome ? null : fromPath); // what gradlew starts with
  if (ctx.gradleJdk && !ctx.gradleJavaHomeBad) {
    // gradle.properties picks the Java for the build; gradlew still needs some java to start.
    if (!launcher) ctx.gradleEnv.JAVA_HOME = ctx.gradleJdk.home;
    ctx.versions.push(['Java for Gradle', `${ctx.gradleJdk.version} (android/gradle.properties)`]);
    return addCheck(ctx, { name, status: 'PASS', detail: `Java ${ctx.gradleJdk.version} from android/gradle.properties` });
  }
  const problems = [];
  if (envHome && !fromEnv) problems.push(`JAVA_HOME points to a folder without Java (${envHome})`);
  if (launcher && launcher.major >= req) {
    ctx.versions.push(['Java for Gradle', `${launcher.version} (${fromEnv ? 'JAVA_HOME' : 'PATH'})`]);
    return addCheck(ctx, { name, status: 'PASS', detail: `Java ${launcher.version} (${fromEnv ? `JAVA_HOME = ${fromEnv.home}` : `on PATH: ${launcher.java}; JAVA_HOME is not set`})` });
  }
  if (launcher) problems.push(`${fromEnv ? 'JAVA_HOME' : 'java on PATH'} is Java ${launcher.major}`);
  else if (!problems.length) problems.push('no JAVA_HOME and no java on PATH');
  if (jbr && jbr.major >= req) {
    ctx.gradleEnv.JAVA_HOME = jbr.home;
    ctx.versions.push(['Java for Gradle', `${jbr.version} (Android Studio, used by the doctor)`]);
    return addCheck(ctx, {
      name,
      status: 'WARN',
      detail: `${problems.join('; ')}; the doctor builds with Android Studio's Java ${jbr.version}`,
      fix: `to use it everywhere, set JAVA_HOME to ${jbr.home}${IS_WIN ? ' (Start > "Edit the system environment variables" > Environment Variables > New)' : ''}`,
    });
  }
  ctx.noJava = true;
  addCheck(ctx, {
    name,
    status: ctx.needsBuild ? 'FAIL' : 'WARN',
    detail: `${problems.join('; ')}; building the APK here needs Java ${req} (inside Android Studio its own Java is used)`,
    fix: `install Android Studio (it has Java ${req}) or a JDK ${req} (https://adoptium.net), then set JAVA_HOME to it and open a new terminal`,
  });
}

function checkGradleWrapper(ctx) {
  const name = 'Gradle wrapper';
  if (!isDir(ANDROID_DIR)) {
    ctx.wrapperMissing = true;
    return addCheck(ctx, { name, status: ctx.needsBuild ? 'FAIL' : 'WARN', detail: 'the android folder is missing', fix: 'take the android folder from the original project ZIP' });
  }
  const script = path.join(ANDROID_DIR, IS_WIN ? 'gradlew.bat' : 'gradlew');
  const props = path.join(ANDROID_DIR, 'gradle', 'wrapper', 'gradle-wrapper.properties');
  const files = [script, path.join(ANDROID_DIR, 'gradle', 'wrapper', 'gradle-wrapper.jar'), props];
  const gradleVersion = /gradle-([\d.]+)-(?:bin|all)\.zip/.exec(readText(props) || '')?.[1];
  const agp = /com\.android\.tools\.build:gradle:([\w.-]+)/.exec(readText(path.join(ANDROID_DIR, 'build.gradle')) || '')?.[1];
  const compileSdk = /compileSdkVersion\s*=\s*(\d+)/.exec(readText(path.join(ANDROID_DIR, 'variables.gradle')) || '')?.[1];
  ctx.compileSdk = compileSdk || null;
  if (gradleVersion) ctx.versions.push(['Gradle (wrapper)', gradleVersion]);
  if (agp) ctx.versions.push(['Android Gradle Plugin', agp]);
  if (compileSdk) ctx.versions.push(['compileSdk', compileSdk]);
  const missing = files.filter((f) => !isFile(f)).map(rel);
  if (missing.length) {
    ctx.wrapperMissing = true;
    return addCheck(ctx, { name, status: ctx.needsBuild ? 'FAIL' : 'WARN', detail: `missing: ${missing.join(', ')}`, fix: 'take the android folder from the original project ZIP' });
  }
  const detail = `Gradle ${gradleVersion || '?'}, Android Gradle Plugin ${agp || '?'}`;
  if (IS_WIN) {
    const buf = fs.readFileSync(script);
    if (buf.includes(0x0a) && !buf.includes(0x0d)) {
      // A .bat file with Linux line endings makes cmd.exe lose its labels ("cannot find the batch label").
      const fx = ctx.doFix('converted android/gradlew.bat to Windows line endings', 'convert android/gradlew.bat to Windows line endings', () =>
        fs.writeFileSync(script, buf.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1'),
      );
      if (fx && !fx.dry) return addCheck(ctx, { name, status: 'PASS', detail, fixInfo: fx });
      return addCheck(ctx, {
        name,
        status: 'WARN',
        detail: `${detail}; android/gradlew.bat has Linux line endings (cmd.exe can fail with "cannot find the batch label")`,
        fix: 'run npm run doctor:fix (converts it to Windows line endings)',
        fixInfo: fx,
      });
    }
  }
  addCheck(ctx, { name, status: 'PASS', detail });
}

function defaultSdkDir() {
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk');
  if (IS_MAC) return path.join(os.homedir(), 'Library', 'Android', 'sdk');
  return path.join(os.homedir(), 'Android', 'Sdk');
}
const isSdkDir = (p) => isDir(p) && ['platform-tools', 'platforms', 'build-tools', 'cmdline-tools', 'licenses'].some((d) => isDir(path.join(p, d)));
function writeSdkDir(file, existing, sdk) {
  const line = `sdk.dir=${escapePropValue(sdk)}`;
  if (existing === null) {
    const eol = IS_WIN ? '\r\n' : '\n';
    const header = ['## Written by scripts/doctor.mjs (npm run doctor:fix): where the Android SDK is on THIS computer.', '## Do not copy this file to another computer (android/.gitignore keeps it out of git).'];
    fs.writeFileSync(file, [...header, line, ''].join(eol));
    return;
  }
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing.split(/\r?\n/);
  const i = lines.findIndex((l) => /^\s*sdk\.dir\s*[=:]/.test(l));
  if (i >= 0) lines[i] = line;
  else lines.splice(lines[lines.length - 1] === '' ? lines.length - 1 : lines.length, 0, line);
  fs.writeFileSync(file, lines.join(eol));
}

function checkAndroidSdk(ctx) {
  const name = 'Android SDK';
  const lpFile = path.join(ANDROID_DIR, 'local.properties');
  const lpText = readText(lpFile);
  const sdkDirValue = lpText !== null ? (parseProps(lpText)['sdk.dir'] || '').trim() || null : null;
  const envName = ['ANDROID_HOME', 'ANDROID_SDK_ROOT'].find((k) => process.env[k] && isSdkDir(process.env[k]));
  const envSdk = envName ? process.env[envName] : null;
  const defSdk = defaultSdkDir();
  const defaultOk = isSdkDir(defSdk) ? defSdk : null;
  const missingFix = `install Android Studio and open it once: it installs the SDK (normally in ${defSdk}). Then run npm run doctor:fix`;
  let sdk = null;
  let source = null;
  let status = 'PASS';
  let fixInfo = null;
  let fix = null;
  const extra = [];
  if (sdkDirValue && isSdkDir(sdkDirValue)) {
    sdk = sdkDirValue;
    source = 'android/local.properties';
  } else if (sdkDirValue) {
    const replacement = envSdk || defaultOk;
    if (replacement) {
      fixInfo = ctx.doFix(`set sdk.dir in android/local.properties to ${replacement}`, `set sdk.dir in android/local.properties to ${replacement}`, () => writeSdkDir(lpFile, lpText, replacement));
    }
    if (fixInfo && !fixInfo.dry) {
      sdk = replacement;
      source = 'android/local.properties';
    } else {
      ctx.noSdk = true;
      return addCheck(ctx, {
        name,
        status: 'FAIL',
        detail: `android/local.properties points to a folder that does not exist: ${sdkDirValue}`,
        fix: replacement ? `run npm run doctor:fix (points it to ${replacement})` : missingFix,
        fixInfo,
      });
    }
  } else if (envSdk) {
    sdk = envSdk;
    source = envName;
  } else if (defaultOk) {
    sdk = defaultOk;
    const what = lpText === null ? 'created android/local.properties' : 'added sdk.dir to android/local.properties';
    const todo = lpText === null ? 'create android/local.properties' : 'add sdk.dir to android/local.properties';
    fixInfo = ctx.doFix(`${what} (sdk.dir = ${defaultOk})`, `${todo} (sdk.dir = ${defaultOk})`, () => writeSdkDir(lpFile, lpText, defaultOk));
    if (fixInfo && !fixInfo.dry) source = 'android/local.properties';
    else {
      source = 'the standard folder';
      ctx.sdkEnv = { ANDROID_HOME: defaultOk }; // the doctor tells its own Gradle run where the SDK is
      status = 'WARN';
      extra.push('android/local.properties is missing, so Gradle outside the doctor cannot find it');
      fix = 'run npm run doctor:fix (creates android/local.properties), or open the android folder once in Android Studio';
    }
  } else {
    ctx.noSdk = true;
    return addCheck(ctx, { name, status: ctx.needsBuild ? 'FAIL' : 'WARN', detail: 'not found (needed to build the APK)', fix: missingFix });
  }
  ctx.sdk = sdk;
  ctx.versions.push(['Android SDK', sdk]);
  if (ctx.compileSdk && !isDir(path.join(sdk, 'platforms', `android-${ctx.compileSdk}`))) {
    status = worse(status, 'WARN');
    extra.push(`Android platform ${ctx.compileSdk} is not installed yet (Gradle downloads it when the licenses are accepted)`);
    fix = fix || `Android Studio > Tools > SDK Manager > SDK Platforms > tick API ${ctx.compileSdk} > Apply`;
  }
  if (!isDir(path.join(sdk, 'licenses'))) {
    status = worse(status, 'WARN');
    extra.push('the SDK licenses are not accepted yet');
    fix = fix || 'Android Studio > Tools > SDK Manager: install anything once and accept the licenses';
  }
  addCheck(ctx, { name, status, detail: `${sdk} (from ${source})${extra.length ? `; ${extra.join('; ')}` : ''}`, fix, fixInfo });
}

function findAdb(sdk) {
  const exe = IS_WIN ? 'adb.exe' : 'adb';
  const lp = sdk ? null : readText(path.join(ANDROID_DIR, 'local.properties'));
  const sdks = [sdk, lp && parseProps(lp)['sdk.dir'], process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, defaultSdkDir()].filter(Boolean);
  return sdks.map((s) => path.join(s, 'platform-tools', exe)).find(isFile) || findOnPath('adb');
}
function adbDevices(adb) {
  const r = sh(adb, ['devices'], { timeout: 20000 });
  return r.stdout
    .split(/\r?\n/)
    .map((l) => /^(\S+)\s+(device|offline|unauthorized|recovery|sideload|bootloader|no permissions.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => ({ serial: m[1], state: m[2].startsWith('no permissions') ? 'no permissions' : m[2] }));
}
const USB_HELP = 'connect the phone with a USB data cable; turn on USB debugging (Settings > About phone > tap "Build number" 7 times > Developer options > USB debugging); unlock the phone and tap "Allow" on "Allow USB debugging?"';

function checkAdb(ctx) {
  const name = 'adb (phone over USB)';
  const adb = findAdb(ctx.sdk);
  ctx.adb = adb;
  if (!adb) {
    return addCheck(ctx, { name, status: ctx.needsAdb ? 'FAIL' : 'WARN', detail: 'not found (needed to install the APK and to read the phone log)', fix: 'Android Studio > Tools > SDK Manager > SDK Tools > tick "Android SDK Platform-Tools" > Apply' });
  }
  const v = /Version\s+([\w.-]+)/.exec(sh(adb, ['version']).out)?.[1];
  ctx.versions.push(['adb', `${v || '?'} (${adb})`]);
  const detail = `${v ? `version ${v}` : 'found'}: ${adb}`;
  if (!ctx.needsAdb || ctx.args.dryRun) return addCheck(ctx, { name, status: 'PASS', detail });
  const devices = adbDevices(adb);
  const ready = devices.filter((d) => d.state === 'device');
  if (ready.length) return addCheck(ctx, { name, status: 'PASS', detail: `${detail}; phone ready: ${ready.map((d) => d.serial).join(', ')}` });
  const state = devices.length ? devices[0].state : null;
  const why = devices.some((d) => d.state === 'unauthorized') ? 'the phone has not allowed USB debugging yet' : state === 'no permissions' ? 'this computer has no permission to use the phone (Linux: udev rules)' : state ? `the phone is in "${state}" mode` : 'no phone connected';
  addCheck(ctx, { name, status: 'WARN', detail: `${detail}; ${why}`, fix: USB_HELP });
}

function debugKeystorePath() {
  if (process.env.ANDROID_USER_HOME) return path.join(process.env.ANDROID_USER_HOME, 'debug.keystore');
  if (process.env.ANDROID_SDK_HOME) return path.join(process.env.ANDROID_SDK_HOME, '.android', 'debug.keystore');
  return path.join(os.homedir(), '.android', 'debug.keystore');
}

function checkSha1(ctx) {
  if (!ctx.googleClient) return;
  const ks = debugKeystorePath();
  if (!isFile(ks)) {
    ctx.notes.push('Google sign-in SHA-1 not checked: this PC has no debug.keystore yet (it is made by the first APK build). Run the doctor again after building.');
    return;
  }
  if (!ctx.keytool) return;
  const r = sh(ctx.keytool, ['-list', '-v', '-keystore', ks, '-alias', 'androiddebugkey', '-storepass', 'android'], { timeout: 30000 });
  const sha1 = /SHA-?1\s*:\s*((?:[0-9A-F]{2}:){19}[0-9A-F]{2})/i.exec(r.out)?.[1]?.toUpperCase();
  if (!sha1) return;
  const hashes = (ctx.googleClient.oauth_client || []).map((o) => String((o.android_info && o.android_info.certificate_hash) || '').toLowerCase()).filter(Boolean);
  const ok = hashes.includes(sha1.replace(/:/g, '').toLowerCase());
  addCheck(ctx, {
    name: 'Google sign-in SHA-1',
    status: ok ? 'PASS' : 'WARN',
    detail: ok ? `this PC's debug key ${sha1} is registered in Firebase` : `this PC's debug key ${sha1} is not in google-services.json, so Google sign-in in the debug APK can fail ("Developer console is not set up correctly")`,
    fix: ok ? null : 'Firebase console > Project settings > Your apps > Android app > "Add fingerprint": paste this SHA-1; then download google-services.json again',
  });
}

function checkFirmware(ctx) {
  const name = 'Firmware sketch';
  const ino = path.join(SKETCH_DIR, `${SKETCH_NAME}.ino`);
  if (!isFile(ino)) return addCheck(ctx, { name, status: ctx.args.firmware ? 'FAIL' : 'WARN', detail: `missing: ${rel(ino)}`, fix: 'take the firmware folder from the original project ZIP' });
  const fw = /#define\s+FW_VERSION\s+"([^"]+)"/.exec(readText(path.join(SKETCH_DIR, 'BoardConfig.h')) || '')?.[1] || null;
  ctx.fwVersion = fw;
  if (fw) ctx.versions.push(['Firmware FW_VERSION', fw]);
  for (const f of fs.readdirSync(SKETCH_DIR).filter((n) => /\.(cpp|ino)$/.test(n))) {
    const baud = /Serial\.begin\((\d+)\)/.exec(readText(path.join(SKETCH_DIR, f)) || '')?.[1];
    if (baud) ctx.fwBaud = baud;
  }
  const csv = readText(path.join(SKETCH_DIR, 'partitions.csv'));
  if (csv === null) return addCheck(ctx, { name, status: 'WARN', detail: `FW_VERSION ${fw || '?'}; partitions.csv is missing (the flash layout would be wrong)`, fix: `put partitions.csv back into ${rel(SKETCH_DIR)}` });
  const row = csv
    .split(/\r?\n/)
    .map((l) => l.split('#')[0].split(',').map((s) => s.trim()))
    .find((c) => c[1] === 'app');
  const size = row ? parseSize(row[4]) : null;
  ctx.appPartitionSize = size;
  addCheck(ctx, { name, status: 'PASS', detail: `FW_VERSION ${fw || '?'}; partitions.csv found${size ? ` (app partition ${fmtBytes(size)} = ${size} bytes)` : ''}` });
}

function parseSize(s) {
  const t = String(s || '').trim();
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16);
  const m = /^(\d+)\s*([KM]?)$/i.exec(t);
  return m ? Number(m[1]) * ({ K: 1024, M: 1048576 }[m[2].toUpperCase()] || 1) : null;
}

function findArduinoCli() {
  const onPath = findOnPath('arduino-cli');
  if (onPath) return { path: onPath, bundled: false };
  const exe = IS_WIN ? 'arduino-cli.exe' : 'arduino-cli';
  const inside = [
    ['resources', 'app', 'lib', 'backend', 'resources'],
    ['resources', 'app', 'node_modules', 'arduino-ide-extension', 'lib', 'backend', 'resources'],
  ];
  const bases = [];
  if (IS_WIN) for (const b of [process.env.ProgramFiles, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean)) bases.push(path.join(b, 'Arduino IDE'));
  if (IS_MAC) for (const app of ['/Applications/Arduino IDE.app', path.join(os.homedir(), 'Applications', 'Arduino IDE.app')]) bases.push(path.join(app, 'Contents'));
  for (const base of bases) {
    for (const parts of inside) {
      const p = path.join(base, ...(IS_MAC ? ['Resources', ...parts.slice(1)] : parts), exe);
      if (isFile(p)) return { path: p, bundled: true };
    }
  }
  return null;
}
function esp32CoreVersion(ctx) {
  const r = sh(ctx.arduinoCli, [...ctx.arduinoArgs, 'core', 'list', '--format', 'json'], { timeout: 60000 });
  try {
    const j = JSON.parse(r.stdout);
    const list = Array.isArray(j) ? j : j.platforms || [];
    const p = list.find((x) => x && x.id === 'esp32:esp32');
    return p ? p.installed_version || p.installed || p.version || null : null;
  } catch {
    return null;
  }
}

async function checkArduinoCli(ctx) {
  const name = 'arduino-cli (optional)';
  const found = findArduinoCli();
  if (!found) {
    return addCheck(ctx, { name, status: 'WARN', detail: 'not found: build the firmware in the Arduino IDE instead', fix: '"npm run doctor -- --firmware" prints the Arduino IDE steps (or install arduino-cli: https://arduino.github.io/arduino-cli/)' });
  }
  ctx.arduinoCli = found.path;
  const ideConfig = path.join(os.homedir(), '.arduinoIDE', 'arduino-cli.yaml');
  ctx.arduinoArgs = found.bundled && isFile(ideConfig) ? ['--config-file', ideConfig] : [];
  const v = /Version:\s*(\S+)/.exec(sh(found.path, ['version']).out)?.[1] || '?';
  ctx.versions.push(['arduino-cli', `${v} (${found.path})`]);
  const installCmd = `arduino-cli core install esp32:esp32@${ESP32_CORE} --additional-urls ${ESP32_INDEX_URL}`;
  let core = esp32CoreVersion(ctx);
  let fixInfo = null;
  if (!core && ctx.args.firmware && ctx.args.fix) {
    // Only when the firmware was asked for: the core is a big download (about 300 MB).
    if (ctx.args.dryRun) fixInfo = { dry: true, text: `would install the ESP32 core ${ESP32_CORE} for arduino-cli` };
    else {
      const urls = ['--additional-urls', ESP32_INDEX_URL];
      const idx = await runTask(ctx, { title: 'arduino-cli core update-index', cmd: found.path, args: [...ctx.arduinoArgs, 'core', 'update-index', ...urls] });
      const inst = idx.ok ? await runTask(ctx, { title: `arduino-cli core install esp32:esp32@${ESP32_CORE}`, cmd: found.path, args: [...ctx.arduinoArgs, 'core', 'install', `esp32:esp32@${ESP32_CORE}`, ...urls] }) : idx;
      core = esp32CoreVersion(ctx);
      if (inst.ok && core) {
        fixInfo = { dry: false, text: `installed the ESP32 core ${core} for arduino-cli` };
        ctx.fixes.push(fixInfo.text);
      } else {
        out(dim('        --- last lines of the ESP32 core install ---'));
        inst.lines.slice(-12).forEach((l) => out(dim(`        | ${ctx.redact(l)}`)));
      }
    }
  }
  if (core) ctx.versions.push(['ESP32 Arduino core', core]);
  if (!core) return addCheck(ctx, { name, status: 'WARN', detail: `arduino-cli ${v}; the ESP32 core is not installed`, fix: `run: npm run doctor -- --fix --firmware   (or: ${installCmd})`, fixInfo });
  if (!core.startsWith('2.0.')) return addCheck(ctx, { name, status: 'WARN', detail: `arduino-cli ${v}; ESP32 core ${core} is installed, but this firmware is made for 2.0.x`, fix: installCmd });
  addCheck(ctx, { name, status: 'PASS', detail: `arduino-cli ${v}, ESP32 core ${core}`, fixInfo });
}

function packageVersions(ctx) {
  for (const p of ['@capacitor/cli', '@capacitor/android', 'vite', 'typescript', 'vitest', 'firebase']) {
    const v = (readJson(path.join(ROOT, 'node_modules', ...p.split('/'), 'package.json')) || {}).version;
    if (v) ctx.versions.push([p, v]);
  }
}

async function runChecks(ctx) {
  const g = (name, fn) => guard(ctx, name, fn);
  await g('Node.js', () => checkNode(ctx));
  await g('npm', () => checkNpm(ctx));
  await g('Project folder', () => checkProjectFolder(ctx));
  await g('node_modules', () => checkNodeModules(ctx, ROOT, 'node_modules', true));
  await g('functions/node_modules', () => checkNodeModules(ctx, path.join(ROOT, 'functions'), 'functions/node_modules', false));
  await g('capacitor.config.json', () => checkCapacitorConfig(ctx));
  await g('.env', () => checkEnv(ctx));
  await g('Google Maps key', () => checkMapsKey(ctx));
  await g('functions/.env', () => checkFunctionsEnv(ctx));
  await g('App Check (debug APK)', () => checkAppCheck(ctx));
  await g('.firebaserc', () => checkFirebaserc(ctx));
  await g('google-services.json', () => checkGoogleServices(ctx));
  await g('Gradle Java setting', () => checkGradleJavaHome(ctx));
  await g('Java', () => checkJava(ctx));
  await g('Gradle wrapper', () => checkGradleWrapper(ctx));
  await g('Android SDK', () => checkAndroidSdk(ctx));
  await g('adb (phone over USB)', () => checkAdb(ctx));
  await g('Google sign-in SHA-1', () => checkSha1(ctx));
  await g('Firmware sketch', () => checkFirmware(ctx));
  await g('arduino-cli (optional)', () => checkArduinoCli(ctx));
  packageVersions(ctx);
}

// ───────────────────────────── steps ─────────────────────────────

let currentChild = null;

/** Runs one command, shows a live status line, keeps the last lines of output. */
function runTask(ctx, step) {
  return new Promise((resolve) => {
    const started = Date.now();
    const lines = [];
    let last = '';
    let done = false;
    let lastBeat = started;
    const push = (raw) => {
      const l = strip(raw).replace(/\s+$/, '');
      if (!l.trim()) return;
      lines.push(l);
      if (lines.length > 400) lines.shift();
      last = l.trim();
    };
    const opts = { cwd: step.cwd || ROOT, env: step.env || process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
    let child;
    try {
      if (step.line) child = spawn(step.line, { ...opts, shell: true });
      else if (step.shell) child = spawn([step.cmd, ...(step.args || [])].map(quoteArg).join(' '), { ...opts, shell: true });
      else child = spawn(step.cmd, step.args || [], opts);
    } catch (e) {
      resolve({ ok: false, code: null, ms: 0, lines: [`[doctor] could not start ${step.cmd}: ${e.message}`] });
      return;
    }
    currentChild = child;
    const partial = { out: '', err: '' };
    const onData = (key) => (chunk) => {
      if (ctx.args.verbose) process.stdout.write(chunk);
      const parts = (partial[key] + chunk).split(/\r\n|\n|\r/);
      partial[key] = parts.pop();
      parts.forEach(push);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData('out'));
    child.stderr.on('data', onData('err'));
    const timer = setInterval(() => {
      if (ctx.args.verbose) return;
      const el = fmtMs(Date.now() - started);
      if (TTY) statusLine(`  ... ${step.title}  ${el}  ${last}`);
      else if (Date.now() - lastBeat >= 30000) {
        lastBeat = Date.now();
        out(`  ... ${step.title} still running (${el})`);
      }
    }, TTY ? 300 : 1000);
    const finish = (code, err) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearStatusLine();
      currentChild = null;
      if (partial.out) push(partial.out);
      if (partial.err) push(partial.err);
      if (err) push(`[doctor] could not start ${step.cmd}: ${err.message}`);
      resolve({ ok: code === 0 && !err, code, ms: Date.now() - started, lines });
    };
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(code));
  });
}

const HINTS = [
  [/SDK location not found|Define a valid SDK location|ANDROID_HOME is set to an invalid/i, 'Android SDK not found: run npm run doctor:fix, or open the android folder once in Android Studio'],
  [/Java home supplied is invalid|org\.gradle\.java\.home/i, 'android/gradle.properties points to a Java folder that does not exist: run npm run doctor:fix'],
  [/invalid source release|Unsupported class file major version|requires Java \d+|JAVA_HOME is not set|JAVA_HOME is set to an invalid directory|no 'java' command could be found/i, 'Gradle needs Java 21: set JAVA_HOME to Android Studio\'s Java (Windows: C:\\Program Files\\Android\\Android Studio\\jbr) and open a new terminal'],
  [/No matching client found for package name/i, 'google-services.json is for another app id: download the one for in.aismartstick.app'],
  [/licen[cs]es? (?:for .* )?(?:have not been|not) accepted|accept the SDK license/i, 'accept the Android SDK licenses: Android Studio > Tools > SDK Manager (install something once and accept), or sdkmanager --licenses'],
  [/cannot find the batch label|is not recognized as an internal or external command.*gradlew/i, 'android/gradlew.bat has the wrong line endings: run npm run doctor:fix'],
  [/Could not (?:resolve|download|GET)|UnknownHostException|Connection (?:timed out|refused|reset)|PKIX path building failed|unable to find valid certification path|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN/i, 'a download failed: check the internet connection (the first build downloads a lot), then try again; a proxy or antivirus can block it'],
  [/EPERM|EBUSY|resource busy or locked|being used by another process/i, 'a file is locked: close Android Studio, your IDE and other terminals, then try again'],
  [/@rolldown\/binding|Cannot find native binding|@tailwindcss\/oxide-|lightningcss-/i, 'node_modules was installed on another computer: delete the node_modules folder and run npm run doctor:fix'],
  [/Error: Cannot find (?:module|package) |ERR_MODULE_NOT_FOUND|could not determine executable to run|is not recognized as an internal or external command/, 'a package is missing: run npm run doctor:fix (runs npm install)'],
  [/error TS\d+:/, 'TypeScript found mistakes in the code (lines above): a code problem, not a setup problem'],
  [/Test Files\s+\d+ failed|Tests\s+\d+ failed|\bFAIL\s+\S+\.test\.tsx?/, 'some unit tests failed (lines above); to build the APK anyway: npm run apk -- --skip-tests'],
  [/ENOSPC|No space left on device|not enough space on the disk/i, 'the disk is full: free some space'],
  [/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i, 'a different build of the app is on the phone (other PC or Play Store): uninstall it first with "adb uninstall in.aismartstick.app" (this deletes the app data on the phone), then install again'],
  [/INSTALL_FAILED_USER_RESTRICTED|Install canceled by user|INSTALL_FAILED_ABORTED/i, 'allow the install on the phone screen; on Xiaomi/Redmi/POCO also turn on Developer options > "Install via USB"'],
  [/INSTALL_FAILED_INSUFFICIENT_STORAGE/i, 'the phone is full: free some storage'],
  [/INSTALL_FAILED_OLDER_SDK|INSTALL_FAILED_NO_MATCHING_ABIS/i, 'this phone cannot run the app (Android 7.0 or newer is needed)'],
  [/no devices\/emulators found|device unauthorized|device offline|device not found/i, USB_HELP],
  [/Platform 'esp32:esp32' not found|platform not installed|Unknown FQBN|Invalid FQBN/i, `install the ESP32 core: npm run doctor -- --fix --firmware (or arduino-cli core install esp32:esp32@${ESP32_CORE} --additional-urls ${ESP32_INDEX_URL})`],
  [/Failed to connect to ESP32|Wrong boot mode detected|Timed out waiting for packet header|No serial data received/i, 'put the ESP32-CAM into download mode: hold IO0 (BOOT) on the MB board, press RST, keep holding IO0 until "Writing at 0x..." appears'],
  [/could not open port|Access is denied|PermissionError|Permission denied.*tty|port is busy|Resource busy/i, 'the serial port is busy or wrong: close the Arduino Serial Monitor; check the COM number in Device Manager > Ports'],
  [/Sketch too big|text section exceeds available space|section .* will not fit in region/i, 'the firmware is bigger than the app partition in partitions.csv'],
];
function hintsFor(lines) {
  const text = lines.slice(-200).join('\n');
  const res = [];
  for (const [re, hint] of HINTS) if (re.test(text) && !res.includes(hint)) res.push(hint);
  return res.slice(0, 2);
}

function firmwareTestStep(ctx) {
  const script = ctx.pkg.scripts && ctx.pkg.scripts['test:firmware'];
  if (!script) return null;
  const title = 'Firmware tests (g++)';
  const gpp = findOnPath('g++');
  if (!gpp) return { title, skip: 'g++ (a C++ compiler) is not installed: firmware host tests skipped (optional, the APK does not need them)' };
  const version = sh(gpp, ['--version']).out;
  const dump = sh(gpp, ['-dumpversion']).out.trim();
  ctx.versions.push(['g++', (version.split(/\r?\n/)[0] || dump).trim()]);
  if (!/clang/i.test(version) && Number(dump.split('.')[0]) < 7) return { title, skip: `g++ ${dump} is too old for these C++17 tests (optional)` };
  if (!IS_WIN) return { title, cmd: 'npm', args: ['run', 'test:firmware'], display: 'npm run test:firmware' };
  // The npm script builds into /tmp, which cmd.exe does not have: run the same command with the Windows temp folder.
  const line = script.replace(/\/tmp\/([\w.-]+)/g, (_, f) => `"${path.join(os.tmpdir(), /\.exe$/i.test(f) ? f : `${f}.exe`)}"`);
  return { title, line, display: 'test:firmware (with the Windows temp folder)' };
}

function gradleStep(ctx) {
  const title = 'APK build (Gradle)';
  const block = ctx.wrapperMissing
    ? 'the Gradle wrapper files are missing'
    : ctx.noSdk
      ? 'no Android SDK (see the Android SDK check)'
      : ctx.gradleJavaHomeBad
        ? 'android/gradle.properties points to a wrong Java folder (run with --fix)'
        : ctx.noJava
          ? `no Java ${ctx.requiredJava} (see the Java check)`
          : null;
  const env = { ...process.env, ...ctx.gradleEnv, ...ctx.sdkEnv };
  const after = () => {
    if (!isFile(APK_PATH)) return 'Gradle finished, but app-debug.apk is not where it should be';
    return `APK: ${APK_PATH} (${fmtBytes(fs.statSync(APK_PATH).size)})`;
  };
  const verify = () => isFile(APK_PATH);
  return IS_WIN
    ? { title, cmd: '.\\gradlew.bat', args: ['assembleDebug', '--console=plain'], shell: true, cwd: ANDROID_DIR, env, block, display: 'cd android && gradlew.bat assembleDebug', after, verify }
    : { title, cmd: 'sh', args: ['gradlew', 'assembleDebug', '--console=plain'], cwd: ANDROID_DIR, env, block, display: 'cd android && ./gradlew assembleDebug', after, verify };
}

function installStep(ctx) {
  return {
    title: 'Install on phone',
    cmd: ctx.adb,
    args: ['install', '-r', APK_PATH],
    display: `adb install -r ${rel(APK_PATH)}`,
    block: ctx.adb ? null : 'adb not found (see the adb check)',
    prepare(step) {
      if (!isFile(APK_PATH)) return `there is no APK yet (${rel(APK_PATH)}): build and install with npm run apk:install`;
      const devices = adbDevices(ctx.adb);
      const ready = devices.filter((d) => d.state === 'device');
      if (!ready.length) return devices.some((d) => d.state === 'unauthorized') ? 'the phone has not allowed USB debugging: unlock it and tap "Allow" on "Allow USB debugging?"' : `no phone found: ${USB_HELP}`;
      if (ready.length > 1 && !process.env.ANDROID_SERIAL) {
        step.args = ['-s', ready[0].serial, ...step.args];
        step.extraNote = `${ready.length} phones connected; used ${ready[0].serial} (set ANDROID_SERIAL to pick another)`;
      }
      return null;
    },
    verify: (lines) => lines.some((l) => /^Success\b/.test(l.trim())) && !lines.some((l) => /Failure \[/.test(l)),
    after: (r, step) => `installed: open "AI SmartStick" on the phone${step.extraNote ? `; ${step.extraNote}` : ''}`,
  };
}

function arduinoIdeSteps(ctx) {
  const ino = path.join(SKETCH_DIR, `${SKETCH_NAME}.ino`);
  const max = ctx.appPartitionSize ? `${ctx.appPartitionSize.toLocaleString('en-US')} bytes` : null;
  return [
    'Arduino IDE steps:',
    ' 1. Install Arduino IDE 2: https://www.arduino.cc/en/software',
    ` 2. File > Preferences > "Additional boards manager URLs": add ${ESP32_INDEX_URL}`,
    ` 3. Tools > Board > Boards Manager: search "esp32" (by Espressif Systems), choose version ${ESP32_CORE} (2.0.x, NOT 3.x), Install.`,
    ` 4. File > Open: ${ino}`,
    ' 5. Tools > Board > esp32 > "AI Thinker ESP32-CAM".',
    ' 6. Put the ESP32-CAM on its ESP32-CAM-MB USB board and plug it in. Tools > Port: choose its COM port',
    '    (Device Manager > Ports shows it; no port = install the CH340 USB driver).',
    ` 7. Keep partitions.csv next to the .ino: the IDE uses it by itself (the "Partition Scheme" menu is ignored).${max ? ` The sketch must stay under ${max}.` : ''}`,
    ' 8. Click Verify (the tick). Then hold the IO0 (BOOT) button on the MB board, click Upload,',
    '    and keep holding IO0 until you see "Writing at 0x...". Then let go.',
    ` 9. When it says "Hard resetting", press RST once. Serial Monitor at ${ctx.fwBaud || '115200'} baud shows "[boot] ... fw ${ctx.fwVersion || ''}".`,
    '10. Take the ESP32-CAM off the MB board before you use the stick: the MB board holds the button pin',
    '    (GPIO3) high, so the stick button does not work while the MB board is attached.',
  ];
}
const UPLOAD_HELP = [
  'Upload tips: if it stops at "Connecting....", hold IO0 (BOOT) on the ESP32-CAM-MB board, press RST,',
  'and keep holding IO0 until "Writing at 0x..." appears. Do not press the stick button while flashing.',
];
const AFTER_UPLOAD = [
  'After the upload: press RST to start the new firmware. Then take the ESP32-CAM off the MB board:',
  'the MB board holds the button pin (GPIO3) high, so the stick button does not work while it is attached.',
];

function firmwareSteps(ctx) {
  if (!ctx.arduinoCli) return [{ title: 'Firmware (Arduino IDE)', skip: 'arduino-cli not found: do it in the Arduino IDE (steps below)', printAfter: arduinoIdeSteps(ctx) }];
  const base = ctx.arduinoArgs || [];
  const props = ctx.appPartitionSize ? ['--build-property', `upload.maximum_size=${ctx.appPartitionSize}`] : [];
  const steps = [
    {
      title: 'Firmware compile',
      cmd: ctx.arduinoCli,
      args: [...base, 'compile', '--fqbn', FQBN, '--build-path', FW_BUILD_DIR, ...props, SKETCH_DIR],
      display: `arduino-cli compile --fqbn ${FQBN} firmware/${SKETCH_NAME}`,
      after: (r) => {
        const size = r.lines.find((l) => /Sketch uses/i.test(l));
        if (ctx.args.port) return size ? size.trim() : null;
        const ports = serialPorts(ctx);
        const portText = ports.length ? `serial ports now: ${ports.join(', ')}` : 'no serial port seen (plug in the ESP32-CAM-MB)';
        return `${size ? `${size.trim()} ` : ''}To upload: npm run doctor -- --firmware --port ${IS_WIN ? 'COM5' : '/dev/ttyUSB0'} (${portText})`;
      },
    },
  ];
  if (ctx.args.port) {
    steps.push({
      title: 'Firmware upload',
      cmd: ctx.arduinoCli,
      args: [...base, 'upload', '--fqbn', FQBN, '--port', ctx.args.port, '--input-dir', FW_BUILD_DIR, SKETCH_DIR],
      display: `arduino-cli upload --fqbn ${FQBN} --port ${ctx.args.port}`,
      before: () => UPLOAD_HELP.forEach((l) => out(yellow(`        ${l}`))),
      printAfter: AFTER_UPLOAD,
    });
  }
  return steps;
}
function serialPorts(ctx) {
  const r = sh(ctx.arduinoCli, [...(ctx.arduinoArgs || []), 'board', 'list', '--format', 'json'], { timeout: 30000 });
  const found = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.address === 'string' && (!o.protocol || o.protocol === 'serial')) found.push(o.address);
    Object.values(o).forEach(walk);
  };
  try {
    walk(JSON.parse(r.stdout));
  } catch {
    /* ignore */
  }
  return [...new Set(found)];
}

function buildSteps(ctx) {
  const a = ctx.args;
  const steps = [];
  if (a.checksOnly) return steps;
  const scripts = ctx.pkg.scripts || {};
  const npm = (title, args) => ({ title, cmd: 'npm', args, shell: IS_WIN, display: `npm ${args.join(' ')}`, needsNode: true });
  const npx = (title, args) => ({ title, cmd: 'npx', args: ['--no', '--', ...args], shell: IS_WIN, display: `npx ${args.join(' ')}`, needsNode: true });
  const fwTests = () => (a.skipTests ? null : firmwareTestStep(ctx));
  if (ctx.mode.appPipeline) {
    steps.push(scripts.typecheck ? npm('Typecheck', ['run', 'typecheck']) : npx('Typecheck', ['tsc', '--noEmit', '-p', '.']));
    if (!a.skipTests) steps.push(npx('Unit tests', ['vitest', 'run']));
    const fw = fwTests();
    if (fw) steps.push(fw);
    steps.push(npm('Web build', ['run', 'build']));
    steps.push(npx('Capacitor sync', ['cap', 'sync', 'android']));
  }
  if (a.apk) steps.push(gradleStep(ctx));
  if (a.install) steps.push(installStep(ctx));
  if (a.firmware) {
    if (!ctx.mode.appPipeline) {
      const fw = fwTests();
      if (fw) steps.push(fw);
    }
    steps.push(...firmwareSteps(ctx));
  }
  return steps;
}

function printStep(rec) {
  const time = rec.ms ? fmtMs(rec.ms).padStart(8) : ' '.repeat(8);
  out(`  ${STATUS_COLOR[rec.status](rec.status.padEnd(4))}  ${rec.title.padEnd(NAME_WIDTH)} ${time}${rec.note ? `  ${rec.note}` : ''}`);
  if (rec.tail.length) {
    out(dim(`        --- last ${rec.tail.length} lines of output ---`));
    rec.tail.forEach((l) => out(`        ${dim('|')} ${l}`));
  }
  rec.hints.forEach((h) => out(`        ${yellow('fix:')} ${h}`));
}

async function runSteps(ctx) {
  const steps = buildSteps(ctx);
  if (!steps.length) return;
  out('');
  out(bold('STEPS'));
  let failed = false;
  for (const step of steps) {
    const rec = { title: step.title, display: step.display || '', cwd: rel(step.cwd || ROOT), status: 'SKIP', ms: 0, note: null, tail: [], hints: [] };
    ctx.steps.push(rec);
    if (step.skip) {
      // Nothing to run (optional tool missing, or manual steps to show): never blocks other steps.
      rec.note = step.skip;
      printStep(rec);
      (step.printAfter || []).forEach((l) => out(`        ${l}`));
      rec.extra = step.printAfter || null;
      continue;
    }
    if (failed) {
      rec.note = 'not run: an earlier step failed';
      printStep(rec);
      continue;
    }
    const block = step.needsNode && ctx.nodeTooOld ? 'Node.js is too old (see the Node.js check)' : step.needsNode && ctx.nodeModulesBad ? 'node_modules is missing or broken (run npm run doctor:fix)' : step.block;
    if (block) {
      rec.status = 'FAIL';
      rec.note = `not run: ${block}`;
      failed = true;
      printStep(rec);
      continue;
    }
    if (ctx.args.dryRun) {
      rec.status = 'DRY';
      rec.note = `would run: ${step.display} (in ${rec.cwd})`;
      printStep(rec);
      continue;
    }
    if (step.prepare) {
      const err = step.prepare(step);
      if (err) {
        rec.status = 'FAIL';
        rec.note = err;
        failed = true;
        printStep(rec);
        continue;
      }
    }
    if (step.before) step.before();
    out(dim(`  > ${step.display}`));
    const r = await runTask(ctx, step);
    rec.ms = r.ms;
    const ok = r.ok && (!step.verify || step.verify(r.lines));
    rec.status = ok ? 'PASS' : 'FAIL';
    if (ok) rec.note = step.after ? step.after(r, step) || null : null;
    else {
      failed = true;
      rec.note = r.ok ? 'the command ended without the expected result' : `exit code ${r.code === null ? '?' : r.code}`;
      rec.tail = r.lines.slice(-TAIL_LINES).map((l) => ctx.redact(l));
      rec.hints = hintsFor(r.lines);
    }
    printStep(rec);
    if (ok && step.printAfter) {
      step.printAfter.forEach((l) => out(`        ${l}`));
      rec.extra = step.printAfter;
    }
  }
}

// ───────────────────────────── logcat ─────────────────────────────

function styleLogLine(line) {
  const level = /^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+([VDIWEFA])\//.exec(line)?.[1];
  if (/FATAL EXCEPTION/.test(line)) return red(bold(`!! ${line}`));
  if (/DebugAppCheckProvider|debug secret/i.test(line)) return green(bold(`>> ${line}`));
  const jsError = /Console|chromium/.test(line) && /Uncaught|TypeError|ReferenceError|SyntaxError|RangeError|Unhandled|\bError\b/.test(line);
  if (jsError || level === 'E' || level === 'F' || level === 'A' || /AndroidRuntime/.test(line)) return red(`!  ${line}`);
  if (level === 'W') return yellow(`   ${line}`);
  return `   ${line}`;
}

function waitForDevice(ctx, adb, serialArgs) {
  return new Promise((resolve) => {
    const child = spawn(adb, [...serialArgs, 'wait-for-device'], { stdio: 'ignore', windowsHide: true });
    ctx.onInterrupt = () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(false);
    };
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function runLogcat(ctx) {
  const adb = ctx.adb || findAdb(null);
  out('');
  out(bold('PHONE LOG (logcat)'));
  if (!adb) {
    out(`  ${red('FAIL')}  adb not found`);
    out(`        ${yellow('fix:')} Android Studio > Tools > SDK Manager > SDK Tools > tick "Android SDK Platform-Tools" > Apply`);
    return 1;
  }
  const devices = adbDevices(adb);
  const ready = devices.filter((d) => d.state === 'device');
  const serialArgs = [];
  if (ready.length > 1 && !process.env.ANDROID_SERIAL) {
    serialArgs.push('-s', ready[0].serial);
    out(dim(`  ${ready.length} phones connected; showing ${ready[0].serial} (set ANDROID_SERIAL to pick another)`));
  }
  if (!ready.length) {
    out(yellow(devices.some((d) => d.state === 'unauthorized') ? '  The phone has not allowed USB debugging yet: unlock it and tap "Allow".' : `  No phone found. ${USB_HELP}.`));
    out(dim('  Waiting for the phone... (Ctrl+C to stop)'));
    if (!(await waitForDevice(ctx, adb, serialArgs))) return 1;
  }
  sh(adb, [...serialArgs, 'logcat', '-c'], { timeout: 15000 });
  out(dim(`  Log cleared. Showing lines that match: ${LOGCAT_FILTER.source}`));
  out(dim('  Red "!!" = app crash, red "!" = error, green ">>" = App Check debug token. Press Ctrl+C to stop.'));
  return new Promise((resolve) => {
    const child = spawn(adb, [...serialArgs, 'logcat', '-v', 'time'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let partial = '';
    let crashes = 0;
    let shown = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const parts = (partial + chunk).split(/\r?\n/);
      partial = parts.pop();
      for (const line of parts) {
        if (!LOGCAT_FILTER.test(line)) continue;
        if (/FATAL EXCEPTION/.test(line)) crashes++;
        shown++;
        out(styleLogLine(line));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => process.stderr.write(d));
    ctx.onInterrupt = () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      out('');
      out(dim(`Stopped. ${shown} line(s) shown${crashes ? `, ${crashes} crash(es)` : ''}.`));
      resolve(0);
    };
    child.on('error', (e) => {
      out(red(`could not start adb: ${e.message}`));
      resolve(1);
    });
    child.on('close', (code) => resolve(code === 0 || code === null ? 0 : 1));
  });
}

// ───────────────────────────── report ─────────────────────────────

function osName() {
  if (IS_WIN) {
    const [maj, , build] = os.release().split('.').map(Number);
    return maj === 10 ? `Windows ${build >= 22000 ? '11' : '10'} (${os.release()})` : `Windows ${os.release()}`;
  }
  if (IS_MAC) return `macOS (Darwin ${os.release()})`;
  const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(readText('/etc/os-release') || '')?.[1];
  return `${pretty || 'Linux'} (kernel ${os.release()})`;
}

function buildReport(ctx, result) {
  const L = [];
  const pad = (s, n) => String(s).padEnd(n);
  L.push('AI SmartStick doctor report');
  L.push('===========================');
  L.push(`Date:     ${ctx.started.toString()} (${ctx.started.toISOString()})`);
  L.push(`Command:  node scripts/doctor.mjs ${ctx.args.raw}`.trimEnd());
  L.push(`Mode:     ${describeMode(ctx)}`);
  L.push(`OS:       ${osName()}, ${process.platform} ${process.arch}`);
  L.push(`Project:  ${ROOT}`);
  L.push(`Result:   ${result}`);
  L.push('Secret values are never written here: .env keys are listed by name only.');
  L.push('');
  L.push('VERSIONS');
  for (const [k, v] of ctx.versions) L.push(`  ${pad(k, 24)} ${v}`);
  L.push('');
  L.push('CHECKS');
  for (const c of ctx.checks) {
    L.push(`  ${pad(c.status, 5)} ${pad(c.name, NAME_WIDTH)} ${c.detail}`);
    if (c.fixed) L.push(`        fixed: ${c.fixed}`);
    if (c.wouldFix) L.push(`        dry run: ${c.wouldFix}`);
    if (c.fix && c.status !== 'PASS') L.push(`        fix: ${c.fix}`);
    if (c.note) L.push(`        note: ${c.note}`);
    if (c.tail && c.tail.length) c.tail.forEach((l) => L.push(`        | ${l}`));
  }
  for (const n of ctx.notes) L.push(`  note: ${n}`);
  L.push('');
  L.push('STEPS');
  if (!ctx.steps.length) L.push(`  (none${ctx.args.checksOnly ? ': --checks-only' : ''})`);
  for (const s of ctx.steps) {
    L.push(`  ${pad(s.status, 5)} ${pad(s.title, NAME_WIDTH)} ${s.ms ? pad(fmtMs(s.ms), 8) : pad('', 8)} ${s.display}${s.cwd && s.cwd !== '.' ? `  (in ${s.cwd})` : ''}`);
    if (s.note) L.push(`        ${s.note}`);
    if (s.tail.length) {
      L.push(`        --- last ${s.tail.length} lines of output ---`);
      s.tail.forEach((l) => L.push(`        | ${l}`));
    }
    s.hints.forEach((h) => L.push(`        fix: ${h}`));
    (s.extra || []).forEach((l) => L.push(`        ${l}`));
  }
  if (ctx.fixes.length) {
    L.push('');
    L.push('FIXES APPLIED');
    ctx.fixes.forEach((f) => L.push(`  - ${f}`));
  }
  if (ctx.interrupted) {
    L.push('');
    L.push('Stopped with Ctrl+C before the end.');
  }
  L.push('');
  return ctx.redact(L.join(os.EOL));
}

function writeReport(ctx, result) {
  try {
    fs.writeFileSync(REPORT_PATH, buildReport(ctx, result), 'utf8');
    return true;
  } catch (e) {
    out(yellow(`  could not write ${REPORT_PATH}: ${e.message}`));
    return false;
  }
}

function finish(ctx) {
  const count = (list, st) => list.filter((x) => x.status === st).length;
  const failedChecks = ctx.checks.filter((c) => c.status === 'FAIL');
  const failedSteps = ctx.steps.filter((s) => s.status === 'FAIL');
  const ok = !failedChecks.length && !failedSteps.length;
  out('');
  out(bold('SUMMARY'));
  out(`  checks: ${green(`${count(ctx.checks, 'PASS')} pass`)}, ${yellow(`${count(ctx.checks, 'WARN')} warn`)}, ${red(`${failedChecks.length} fail`)}`);
  if (ctx.steps.length) {
    const parts = [`${count(ctx.steps, 'PASS')} pass`, `${failedSteps.length} fail`, `${count(ctx.steps, 'SKIP')} skipped`];
    if (count(ctx.steps, 'DRY')) parts.push(`${count(ctx.steps, 'DRY')} dry run`);
    out(`  steps:  ${parts.join(', ')}`);
  }
  if (ctx.fixes.length) out(`  ${green('fixed:')} ${ctx.fixes.join('; ')}`);
  for (const n of ctx.notes) out(dim(`  note: ${n}`));
  if (failedChecks.length) out(red(`  fix these first: ${failedChecks.map((c) => c.name).join(', ')}`));
  if (failedSteps.length) out(red(`  failed step: ${failedSteps[0].title}`));
  const builtApk = ctx.steps.some((s) => s.title.startsWith('APK') && s.status === 'PASS');
  if (builtApk) out(green(`  APK: ${APK_PATH}`));
  const result = ctx.args.dryRun ? (ok ? 'OK (dry run)' : 'FAILED (dry run)') : ok ? 'OK' : 'FAILED';
  if (writeReport(ctx, result)) out(`  report: ${REPORT_PATH}  (no secret values; paste it into your AI IDE if you need help)`);
  out(ok ? green(bold(`  RESULT: ${result}`)) : red(bold(`  RESULT: ${result}`)));
  return ok ? 0 : 1;
}

// ───────────────────────────── main ─────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2), process.env);
  if (args.help) {
    out(HELP);
    return 0;
  }
  if (args.unknown.length) {
    out(red(`Unknown option: ${args.unknown.join(' ')}`));
    out('');
    out(HELP);
    return 2;
  }
  const ctx = createContext(args);
  process.on('SIGINT', () => {
    if (ctx.onInterrupt) return ctx.onInterrupt();
    ctx.interrupted = true;
    if (currentChild) {
      try {
        currentChild.kill();
      } catch {
        /* ignore */
      }
    }
    clearStatusLine();
    out(yellow('\nStopped (Ctrl+C).'));
    if (ctx.checks.length) writeReport(ctx, 'STOPPED');
    process.exit(130);
  });
  if (args.fromNpmConfig.length) out(yellow(`note: npm kept ${args.fromNpmConfig.join(' ')} for itself; the doctor uses it anyway. Next time type: npm run doctor -- ${args.fromNpmConfig.join(' ')}`));
  if (ctx.mode.logcatOnly) return runLogcat(ctx);

  out(bold('AI SmartStick doctor'));
  out(dim(`  ${osName()} | Node ${process.version} | ${ctx.started.toLocaleString()}`));
  out(dim(`  project: ${ROOT}`));
  out(dim(`  mode: ${describeMode(ctx)}`));
  if (args.checksOnly && (args.apk || args.install || args.firmware || args.logcat)) out(yellow('  --checks-only: the other actions are not run'));
  out('');
  out(bold('CHECKS'));
  await runChecks(ctx);
  if (!args.checksOnly) await runSteps(ctx);
  const code = finish(ctx);
  if (args.logcat && !args.checksOnly && !args.dryRun && !ctx.steps.some((s) => s.status === 'FAIL')) {
    const lc = await runLogcat(ctx);
    return code || lc;
  }
  return code;
}

if (!process.env.AISS_DOCTOR_NO_MAIN) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      clearStatusLine();
      out(red(`doctor crashed: ${(err && err.stack) || err}`));
      process.exitCode = 1;
    },
  );
}

export { satisfies, parseProps, escapePropValue, unescapeProp, parseEnvText, readEnvFile, parseArgs, modes, inspectNodeModules, hintsFor, styleLogLine };
