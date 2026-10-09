import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { AnimatePresence } from 'motion/react';
import { Capacitor } from '@capacitor/core';
import { Check, ClipboardCopy, Loader2, Minus, Play, ScanEye, X } from 'lucide-react';
import { SubPageView } from '../../components/Layout';
import { GlassButton, cx } from '../../components/glass';
import { ENV, firebaseConfigured, mapsConfigured } from '../../core/runtime/env';
import { isDemo } from '../../core/runtime/mode';
import { useAuth } from '../../core/auth/authStore';
import { probeAppCheck } from '../../core/firebase/app';
import { useAppCheckStatus, type AppCheckProvider } from '../../core/firebase/appCheckStatus';
import { call } from '../../core/backend/api';
import { searchPlaces, type PlaceResult } from '../../core/maps/mapsService';
import { currentMapsAuthError, loadPlacesLibrary, loadRoutesLibrary } from '../../core/maps/mapsLoader';
import { osmSearch } from '../../core/maps/osmFallback';
import { useLocation } from '../../core/location/locationService';
import { useDevice, isLinked } from '../../core/store/device';
import { useSafety } from '../../core/store/safety';
import { useUI } from '../../core/store/ui';
import { captureFrame } from '../../core/vision/relay';
import type { VisionRequest, VisionResult } from '../../../shared/assistantContract';
import { TEST_PAGE_Z } from './LocationTest';

/**
 * SERVER & MAPS TEST (Diagnostics): every hop between this phone and the cloud — internet, Firebase
 * config, sign-in, App Check, the Cloud Functions (serverPing), Google Maps on the server and in the
 * app, the OpenStreetMap fallback and the Gemini Live token — with PASS / FAIL, timings, one line of
 * what to do (naming a section of docs/GOOGLE_CLOUD_SETUP.md) and "Copy report" (no keys, no tokens).
 * "Test AI vision" is a separate button: it sends one camera photo to the AI (costs one AI call).
 * Every step is also logged as "[SMARTSTICK] server test: …".
 */
export const useServerTest = create<{ open: boolean }>(() => ({ open: false }));
export const openServerTest = () => useServerTest.setState({ open: true });
export const closeServerTest = () => useServerTest.setState({ open: false });

let nextHostId = 1;
const useHosts = create<{ ids: number[] }>(() => ({ ids: [] }));

/**
 * Rendered by ConnectionTestHost (Diagnostics.tsx), so it is mounted wherever that host is (inside
 * StickUserApp's text-size / high-contrast root). Duplicate hosts are safe: only the first renders.
 * An SOS, an incoming call or pocket mode closes it (they must never be hidden under a test page).
 */
export function ServerTestHost() {
  const [id] = useState(() => nextHostId++);
  useEffect(() => {
    useHosts.setState((s) => ({ ids: [...s.ids, id] }));
    return () => useHosts.setState((s) => ({ ids: s.ids.filter((x) => x !== id) }));
  }, [id]);
  const owner = useHosts((s) => s.ids[0] === id);
  const open = useServerTest((s) => s.open);
  const sos = useSafety((s) => s.phase !== 'idle');
  const callOrPocket = useUI((s) => !!s.call || s.pocket);
  const urgent = sos || callOrPocket;
  useEffect(() => {
    if (urgent) closeServerTest();
  }, [urgent]);
  if (!owner) return null;
  return (
    <AnimatePresence>
      {open && (
        <div key="servertest" className={`absolute inset-0 ${TEST_PAGE_Z}`}>
          <SubPageView onClose={closeServerTest} title="Server & maps test">
            <ServerTest />
          </SubPageView>
        </div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------- pure helpers (tested)

export type Status = 'pending' | 'running' | 'pass' | 'fail' | 'skip' | 'info';
export interface Step {
  id: string;
  label: string;
  status: Status;
  detail: string;
  /** One line: what to do when it failed. */
  fix: string | null;
  ms: number | null;
}
type Outcome = { status: Status; detail: string; fix?: string | null };

export const SETUP_DOC = 'docs/GOOGLE_CLOUD_SETUP.md';
export type SetupSection = '1 Billing' | '2 Enable APIs' | '3 Browser key' | '4 Server key' | '5 Gemini key' | '6 App Check' | '7 Deploy functions';
/** "What to do" + where the setup guide explains it. */
export const todo = (what: string, section?: SetupSection) => (section ? `${what} See ${SETUP_DOC}, "${section}".` : what);

export type KeyKind = 'browser' | 'server' | 'gemini';
const KEY_NAME: Record<KeyKind, string> = { browser: 'browser key (VITE_GOOGLE_MAPS_BROWSER_KEY)', server: 'server key (MAPS_SERVER_KEY)', gemini: 'Gemini key (GEMINI_API_KEY)' };
const KEY_SECTION: Record<KeyKind, SetupSection> = { browser: '3 Browser key', server: '4 Server key', gemini: '5 Gemini key' };

/** Server (callable) code without the "functions/" prefix; a number code (DOMException) is not one. */
const codeOf = (e: unknown) => {
  const c = (e as { code?: unknown })?.code;
  return typeof c === 'string' ? c.replace(/^functions\//, '') : '';
};
const messageOf = (e: unknown) => {
  const m = (e as { message?: unknown })?.message;
  return String(typeof m === 'string' && m ? m : typeof e === 'string' ? e : codeOf(e) || 'unknown error');
};
/** "code: message", one line, short. */
export const errLine = (e: unknown) => {
  const c = codeOf(e);
  const m = messageOf(e).replace(/\s+/g, ' ').trim();
  return (c && c !== 'unknown' && !m.includes(c) ? `${c}: ${m}` : m).slice(0, 300);
};

/** A Google error text (REST status, Maps JavaScript message) → what to do, or null if it does not look like a setup problem. */
export function googleAdvice(text: string, key: KeyKind): string | null {
  const t = text || '';
  const name = KEY_NAME[key];
  const api = /Places API \(New\)|places\.googleapis|places:searchText|Places API/i.test(t)
    ? 'Places API (New)'
    : /Routes API|routes\.googleapis|computeRoutes/i.test(t)
      ? 'Routes API'
      : /legacy API|Directions/i.test(t)
        ? 'Directions API'
        : /Geocoding/i.test(t)
          ? 'Geocoding API'
          : /generativelanguage|Generative Language/i.test(t)
            ? 'Generative Language API'
            : /Maps JavaScript/i.test(t)
              ? 'Maps JavaScript API'
              : null;
  if (/billing|BILLING_DISABLED|BillingNotEnabled|OverQuota/i.test(t)) return todo('Turn on billing for the Google Cloud project.', '1 Billing');
  if (/referer|referrer|RefererNotAllowed|RefererDenied/i.test(t)) return todo('Add https://localhost/* to the website restrictions of the browser key.', '3 Browser key');
  if (/has not been used in project|it is disabled|SERVICE_DISABLED|ApiNotActivated|API_NOT_ACTIVATED|not enabled|not authorized to use this API|legacy API/i.test(t))
    return todo(`Enable ${api ? `"${api}"` : 'the API'} in the Google Cloud project${key === 'browser' ? ' and allow it on the browser key' : ''}.`, '2 Enable APIs');
  if (/API_KEY_SERVICE_BLOCKED|API_KEY_HTTP_REFERRER_BLOCKED|ApiTargetBlocked|are blocked|is blocked/i.test(t)) return todo(`The ${name} does not allow ${api ? `"${api}"` : 'this API'}: add it to the key's API restrictions.`, KEY_SECTION[key]);
  if (/API key not valid|API_KEY_INVALID|InvalidKey|ExpiredKey|expired|MissingKey|NO_KEY|key is not set|not configured/i.test(t)) return todo(`Check the ${name}: it is missing or not valid.`, KEY_SECTION[key]);
  if (/PERMISSION_DENIED|REQUEST_DENIED|\b403\b/.test(t)) return todo(`Google refused the ${name}. Check the enabled APIs and the key's restrictions.`, '2 Enable APIs');
  return null;
}

/** A failed callable (BackendError code + message) → what to do. */
export function serverAdvice(e: unknown, use: 'ping' | 'maps' | 'gemini' = 'ping'): string {
  const code = codeOf(e);
  const msg = messageOf(e);
  switch (code) {
    case 'not-found':
      return todo('This function is not on the server yet. Deploy the functions.', '7 Deploy functions');
    case 'unauthenticated':
      return /sign in/i.test(msg)
        ? 'Sign in to the app, then run the test again.'
        : todo("The server wants App Check and this phone's token was not accepted. Register this phone's debug token, or set ENFORCE_APPCHECK=false for testing.", '6 App Check');
    case 'permission-denied':
      return /account|role/i.test(msg) ? 'This account type cannot use it.' : todo('The server refused this app (App Check).', '6 App Check');
    case 'deadline-exceeded':
      return todo('No answer in time. Run the test again (the first start is slow). If it fails again, check that the functions are deployed in asia-south1.', '7 Deploy functions');
    case 'unavailable':
      if (use === 'maps' && /maps request failed/i.test(msg)) return googleAdvice(msg, 'server') ?? todo('Google refused the server key. The "Server ping" line shows the reason.', '2 Enable APIs');
      return 'Could not reach the server. Check the internet, then run the test again.';
    case 'failed-precondition':
      // functions/src/maps.ts: Google refused the server key (403), with Google's reason in the message.
      if (/maps request failed/i.test(msg)) return googleAdvice(msg, 'server') ?? todo('Google refused the server key. The "Server ping" line shows the reason.', '2 Enable APIs');
      if (use === 'gemini' || /gemini/i.test(msg)) return todo('Set the GEMINI_API_KEY secret, then deploy the functions.', '5 Gemini key');
      if (use === 'maps' || /maps/i.test(msg)) return todo('Set the MAPS_SERVER_KEY secret, then deploy the functions.', '4 Server key');
      return todo('The server is not set up for this.', '7 Deploy functions');
    case 'internal':
      if (use === 'gemini') return todo('The Gemini key or model did not work. Check GEMINI_API_KEY and the function logs.', '5 Gemini key');
      if (use === 'maps') return todo('Google Maps failed on the server. Check MAPS_SERVER_KEY and the enabled APIs.', '4 Server key');
      return todo('Server error. Look at the function logs in the Firebase console.', '7 Deploy functions');
    case 'resource-exhausted':
      return 'Too many tests in a short time. Wait a minute, then run again.';
  }
  if (/not configured/i.test(msg) && /firebase/i.test(msg)) return 'This build has no Firebase settings. Fill the VITE_FIREBASE_* values in .env and build the app again.';
  return googleAdvice(msg, use === 'gemini' ? 'gemini' : 'server') ?? todo('Unexpected server error. Look at the function logs in the Firebase console.', '7 Deploy functions');
}

export type CheckName = 'places' | 'routes' | 'geocode' | 'gemini';
export interface PingResult {
  ok: boolean;
  region?: string;
  now?: number;
  signedIn?: boolean;
  appCheckValid?: boolean;
  appCheckRequired?: boolean;
  mapsKeySet?: boolean;
  geminiKeySet?: boolean;
  liveModel?: string;
  visionModel?: string;
  checks?: Partial<Record<CheckName, string>>;
  checksError?: string;
}

/** serverPing answer → step result. The first problem found gives the "what to do" line. */
export function pingOutcome(p: PingResult): Outcome {
  const yes = (b: boolean | undefined) => (b ? 'yes' : 'no');
  const parts = [
    `region ${p.region ?? '?'}`,
    `App Check valid ${yes(p.appCheckValid)} (required ${yes(p.appCheckRequired)})`,
    `maps key ${p.mapsKeySet ? 'set' : 'NOT set'}`,
    `Gemini key ${p.geminiKeySet ? 'set' : 'NOT set'}`,
  ];
  const c = p.checks ?? {};
  for (const k of ['places', 'routes', 'geocode', 'gemini'] as CheckName[]) if (c[k]) parts.push(`${k} ${c[k]}`);
  if (p.checksError) parts.push(`checks not run: ${p.checksError}`);
  else if (!p.checks) parts.push(p.signedIn ? 'checks not run' : 'Google checks need sign-in');
  const fixes: string[] = [];
  if (p.appCheckRequired && !p.appCheckValid) fixes.push(todo("The server requires App Check and this phone's token was not valid. Register this phone's debug token, or set ENFORCE_APPCHECK=false for testing.", '6 App Check'));
  if (!p.mapsKeySet) fixes.push(todo('Set the MAPS_SERVER_KEY secret, then deploy the functions.', '4 Server key'));
  if (!p.geminiKeySet) fixes.push(todo('Set the GEMINI_API_KEY secret, then deploy the functions.', '5 Gemini key'));
  for (const k of ['places', 'routes', 'geocode'] as CheckName[]) {
    const v = c[k];
    if (v && v !== 'ok' && p.mapsKeySet) fixes.push(googleAdvice(v, 'server') ?? todo(`The server key failed the ${k} check.`, '4 Server key'));
  }
  if (c.gemini && c.gemini !== 'ok' && p.geminiKeySet) fixes.push(googleAdvice(c.gemini, 'gemini') ?? todo('The Gemini key check failed (key or model name).', '5 Gemini key'));
  return { status: p.ok && !fixes.length ? 'pass' : 'fail', detail: parts.join(' · '), fix: fixes[0] ?? null };
}

export const PROVIDER_LABEL: Record<AppCheckProvider, string> = { 'play-integrity': 'Play Integrity', debug: 'debug provider', recaptcha: 'reCAPTCHA Enterprise', none: 'none' };

/** What to do when the App Check token failed. */
export function appCheckAdvice(provider: AppCheckProvider): string {
  if (provider === 'debug') return todo('Find the debug token in logcat ("debug secret") and add it in Firebase console → App Check → Manage debug tokens.', '6 App Check');
  if (provider === 'play-integrity') return todo('Play Integrity fails on a sideloaded APK. Build with VITE_APPCHECK_DEBUG=true and register the debug token, or set ENFORCE_APPCHECK=false for testing.', '6 App Check');
  if (provider === 'recaptcha') return todo('Check the reCAPTCHA Enterprise key and the allowed domains.', '6 App Check');
  return todo('This build has no App Check. Set ENFORCE_APPCHECK=false on the server for testing.', '6 App Check');
}

export function bytesToBase64(b: Uint8Array) {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export const isJpeg = (b: Uint8Array) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8;

export const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/** Plain-text report for "Copy report": no keys, no tokens, no account e-mail. */
export function serverReport(steps: Step[], meta: string[]) {
  const line = (s: Step) => `${s.status.toUpperCase().padEnd(7)} ${s.label}${s.ms != null ? ` (${secs(s.ms)})` : ''}\n        ${s.detail || '—'}${s.fix ? `\n        TO DO: ${s.fix}` : ''}`;
  return ['AI SmartStick server & maps test', ...meta, '', ...steps.map(line)].join('\n');
}

/** Rejects with "<what> timed out after N s" when `p` takes longer than `ms`. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(Object.assign(new Error(`${what} timed out after ${ms / 1000} s`), { code: 'deadline-exceeded' })), ms)))]).finally(() => clearTimeout(t));
}

// ---------------------------------------------------------------- the page

const STEPS: Pick<Step, 'id' | 'label'>[] = [
  { id: 'internet', label: 'Internet' },
  { id: 'config', label: 'Firebase config' },
  { id: 'signin', label: 'Signed in' },
  { id: 'appcheck', label: 'App Check token' },
  { id: 'ping', label: 'Server ping' },
  { id: 'serverSearch', label: 'Maps search via server' },
  { id: 'places', label: 'In-app Google Places' },
  { id: 'route', label: 'In-app Google route' },
  { id: 'osm', label: 'OpenStreetMap fallback' },
  { id: 'live', label: 'Gemini Live token' },
];
const VISION_LABEL = 'AI vision (camera photo → AI)';

const fresh = (): Step[] => STEPS.map((s) => ({ ...s, status: 'pending', detail: '', fix: null, ms: null }));
const log = (line: string) => console.info(`[SMARTSTICK] server test: ${line}`);
const native = () => Capacitor.isNativePlatform();
const bias = () => {
  const f = useLocation.getState().fix;
  return f ? { lat: f.lat, lng: f.lng } : null;
};
const distText = (m: number | null | undefined) => (m == null ? '' : m < 1000 ? ` (${Math.round(m)} m)` : ` (${(m / 1000).toFixed(1)} km)`);

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function StepRow({ s }: { s: Step }) {
  return (
    <li className="glass flex min-w-0 items-start gap-3 rounded-[20px] px-4 py-3">
      <span
        className={cx(
          'mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full',
          s.status === 'pass' ? 'bg-ok/15 text-ok' : s.status === 'fail' ? 'bg-sos/15 text-sos' : s.status === 'info' ? 'bg-amber/15 text-amber' : 'bg-ink/5 text-ink-3',
        )}
        aria-hidden
      >
        {s.status === 'running' ? <Loader2 size={16} className="animate-spin" /> : s.status === 'pass' ? <Check size={16} /> : s.status === 'fail' ? <X size={16} /> : <Minus size={16} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline justify-between gap-x-2">
          <span className="text-[15px] font-bold text-ink">{s.label}</span>
          <span className={cx('text-[12px] font-bold uppercase tracking-wide', s.status === 'pass' ? 'text-ok' : s.status === 'fail' ? 'text-sos' : 'text-ink-3')}>
            {s.status === 'pending' ? '' : s.status === 'running' ? '…' : s.status}
            {s.ms != null ? ` · ${secs(s.ms)}` : ''}
          </span>
        </span>
        {s.detail && <span className="mt-0.5 block break-words font-mono text-[12px] leading-snug text-ink-2">{s.detail}</span>}
        {s.fix && (s.status === 'fail' || s.status === 'info') && <span className="mt-1 block break-words text-[13px] font-semibold leading-snug text-amber-ink">{s.fix}</span>}
      </span>
    </li>
  );
}

export function ServerTest() {
  const [steps, setSteps] = useState<Step[]>(fresh);
  const [vision, setVision] = useState<Step | null>(null);
  const [running, setRunning] = useState(false);
  const [visionBusy, setVisionBusy] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const linked = useDevice((s) => isLinked(s.link));
  const alive = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const set = useCallback((id: string, p: Partial<Step>) => {
    if (!alive.current) return;
    setSteps((all) => all.map((s) => (s.id === id ? { ...s, ...p } : s)));
  }, []);

  const run = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    setCopied('idle');
    setSteps(fresh());
    setStartedAt(Date.now());
    const step = async (id: string, fn: () => Promise<Outcome>): Promise<Outcome> => {
      set(id, { status: 'running' });
      const t0 = Date.now();
      let r: Outcome;
      try {
        r = await fn();
      } catch (e) {
        r = { status: 'fail', detail: errLine(e) };
      }
      const ms = Date.now() - t0;
      set(id, { status: r.status, detail: r.detail, fix: r.fix ?? null, ms });
      log(`${STEPS.find((s) => s.id === id)?.label}: ${r.status.toUpperCase()} (${ms} ms) ${r.detail}${r.fix ? ` | to do: ${r.fix}` : ''}`);
      return r;
    };
    log(`started (${native() ? 'Android app' : 'browser'})`);

    try {
      await step('internet', async () => {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 5000);
        try {
          await fetch('https://www.google.com/generate_204', { mode: 'no-cors', cache: 'no-store', signal: ctl.signal });
          return { status: 'pass', detail: 'Google answered' };
        } catch (e) {
          const why = ctl.signal.aborted ? 'no answer in 5 s' : errLine(e);
          return { status: 'fail', detail: `${why}${typeof navigator !== 'undefined' && navigator.onLine === false ? ' · phone says offline' : ''}`, fix: 'Turn on mobile data (the stick Wi-Fi has no internet), then run again.' };
        } finally {
          clearTimeout(t);
        }
      });

      const configured = firebaseConfigured();
      await step('config', async () => {
        const extra = `maps browser key ${mapsConfigured() ? 'set' : 'NOT set'} · App Check debug ${ENV.appCheckDebug ? 'on' : 'off'}${ENV.useEmulators ? ' · EMULATORS' : ''}`;
        if (!configured) return { status: 'fail', detail: `project ${ENV.firebase.projectId ?? 'NOT set'} · ${extra}`, fix: 'Fill the VITE_FIREBASE_* values in .env and build the app again.' };
        return { status: 'pass', detail: `project ${ENV.firebase.projectId} · functions region ${ENV.firebaseRegion} · ${extra}` };
      });

      let signedIn = false;
      await step('signin', async () => {
        const until = Date.now() + 3000;
        while (useAuth.getState().status === 'loading' && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
        const a = useAuth.getState();
        signedIn = a.status === 'signedIn' && !!a.user;
        if (signedIn) return { status: 'pass', detail: `signed in · account ${a.user!.uid.slice(0, 6)}… · role ${a.role ?? 'not set'}` };
        return { status: 'fail', detail: `status ${a.status}${a.error ? ` · ${a.error}` : ''}`, fix: 'Sign in to the app first. The server and maps need it.' };
      });

      await step('appcheck', async () => {
        const r = await probeAppCheck();
        const st = useAppCheckStatus.getState();
        const base = `provider ${PROVIDER_LABEL[r.provider]} · debug ${ENV.appCheckDebug ? 'on' : 'off'}`;
        if (r.ok) return { status: 'pass', detail: `token ready · ${base}` };
        return { status: 'fail', detail: `${base} · ${r.error ?? 'failed'}${st.initError && st.initError !== r.error ? ` · start: ${st.initError}` : ''}`, fix: appCheckAdvice(r.provider) };
      });

      let ping: PingResult | null = null;
      await step('ping', async () => {
        if (!configured) return { status: 'skip', detail: 'no Firebase config' };
        try {
          ping = await call<Record<string, never>, PingResult>('serverPing', {}, 15000);
        } catch (e) {
          return { status: 'fail', detail: errLine(e), fix: codeOf(e) === 'not-found' ? todo('serverPing is not on the server yet. Deploy the functions.', '7 Deploy functions') : serverAdvice(e) };
        }
        return pingOutcome(ping);
      });
      const p = ping as PingResult | null;
      // App Check problems do not matter while the server does not check App Check.
      if (p && p.appCheckRequired === false) {
        setSteps((all) =>
          all.map((s) =>
            s.id === 'appcheck' && s.status === 'fail' ? { ...s, status: 'info', fix: todo('Not needed now: the server does not check App Check (ENFORCE_APPCHECK=false). Turn it back on before you share the app.', '6 App Check') } : s,
          ),
        );
      }

      const b = bias();
      await step('serverSearch', async () => {
        if (!configured) return { status: 'skip', detail: 'no Firebase config' };
        try {
          const r = await searchPlaces({ query: 'hospital', lat: b?.lat ?? null, lng: b?.lng ?? null, radiusM: 5000 });
          const first = r.places[0];
          return { status: r.places.length ? 'pass' : 'info', detail: `${r.places.length} places${first ? `, first: ${first.name}${distText(first.distanceM)}` : ''} · ${b ? 'near your GPS position' : 'no GPS position (India-wide)'}` };
        } catch (e) {
          const placesCheck = p?.checks?.places;
          const fix = codeOf(e) === 'unavailable' && placesCheck && placesCheck !== 'ok' ? googleAdvice(placesCheck, 'server') ?? serverAdvice(e, 'maps') : serverAdvice(e, 'maps');
          return { status: 'fail', detail: errLine(e), fix };
        }
      });

      await step('places', async () => {
        if (!mapsConfigured()) return { status: 'skip', detail: 'no browser key in this build (VITE_GOOGLE_MAPS_BROWSER_KEY)', fix: todo('Set VITE_GOOGLE_MAPS_BROWSER_KEY in .env and build again.', '3 Browser key') };
        try {
          const lib = await loadPlacesLibrary();
          const req: google.maps.places.SearchByTextRequest = { textQuery: 'hospital', fields: ['id', 'displayName'], maxResultCount: 1, region: 'in', language: 'en' };
          if (b) req.locationBias = { center: b, radius: 5000 };
          const { places } = await within(lib.Place.searchByText(req), 12_000, 'Places search');
          return { status: places.length ? 'pass' : 'info', detail: `${places.length} place${places[0]?.displayName ? `: ${places[0].displayName}` : ''}` };
        } catch (e) {
          const text = `${errLine(e)} ${(e as { hint?: string })?.hint ?? ''} ${currentMapsAuthError()?.code ?? ''}`.trim();
          return { status: 'fail', detail: errLine(e), fix: googleAdvice(text, 'browser') ?? todo('Google Maps in the app did not work. Check the browser key.', '3 Browser key') };
        }
      });

      await step('route', async () => {
        if (!mapsConfigured()) return { status: 'skip', detail: 'no browser key in this build' };
        if (!b) return { status: 'skip', detail: 'no GPS position yet (open the Location test first)' };
        try {
          const lib = await loadRoutesLibrary();
          const res = await within(
            new lib.DirectionsService().route({ origin: b, destination: { lat: b.lat + 0.0045, lng: b.lng }, travelMode: 'WALKING' as google.maps.TravelMode, region: 'in' }),
            12_000,
            'Directions',
          );
          const leg = res.routes?.[0]?.legs?.[0];
          return leg ? { status: 'pass', detail: `walking route ${leg.distance?.text ?? '?'}, ${leg.duration?.text ?? '?'} (to a point 500 m north)` } : { status: 'info', detail: 'Google found no walking route here' };
        } catch (e) {
          const text = `${errLine(e)} ${(e as { code?: string })?.code ?? ''}`;
          if (/ZERO_RESULTS|NOT_FOUND/.test(text)) return { status: 'info', detail: 'Google found no walking route here' };
          const legacy = /legacy API|REQUEST_DENIED|not authorized|not enabled|has not been used/i.test(text);
          return {
            status: 'fail',
            detail: errLine(e),
            fix: legacy ? todo('The browser key cannot use "Directions API" (a legacy API). Enable it in Google Cloud and allow it on the key. The server route (Routes API) does not need it.', '2 Enable APIs') : (googleAdvice(text, 'browser') ?? todo('In-app directions did not work. Check the browser key.', '3 Browser key')),
          };
        }
      });

      await step('osm', async () => {
        try {
          const places: PlaceResult[] = await within(osmSearch('hospital', b), 12_000, 'OpenStreetMap search');
          const first = places[0];
          return { status: places.length ? 'pass' : 'info', detail: `${places.length} places${first ? `, first: ${first.name}${distText(first.distanceM)}` : ''}` };
        } catch (e) {
          return { status: 'fail', detail: errLine(e), fix: 'OpenStreetMap did not answer. Check the internet, then run again.' };
        }
      });

      await step('live', async () => {
        if (!configured) return { status: 'skip', detail: 'no Firebase config' };
        try {
          const r = await call<Record<string, never>, { token?: string; liveModel?: string }>('getLiveToken', {}, 15000);
          if (!r?.token) return { status: 'fail', detail: 'server answered without a token', fix: todo('Check GEMINI_API_KEY and the function logs.', '5 Gemini key') };
          return { status: 'pass', detail: `token ready${r.liveModel ? ` · model ${r.liveModel}` : ''}` };
        } catch (e) {
          return { status: 'fail', detail: errLine(e), fix: serverAdvice(e, 'gemini') };
        }
      });
    } finally {
      log('finished');
      busy.current = false;
      if (alive.current) setRunning(false);
    }
  }, [set]);

  useEffect(() => {
    void run();
    // Run once when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** One camera photo → the assistantVision callable (costs one AI call, so only on a tap). */
  const testVision = async () => {
    if (visionBusy) return;
    setVisionBusy(true);
    const base: Step = { id: 'vision', label: VISION_LABEL, status: 'running', detail: '', fix: null, ms: null };
    setVision(base);
    const t0 = Date.now();
    let out: Outcome;
    try {
      // Errors in this part are the stick camera's (the AI call below catches its own).
      const f = await within(captureFrame('assistant'), 15_000, 'Camera photo');
      const bytes = new Uint8Array(await f.blob.arrayBuffer());
      const capMs = Date.now() - t0;
      if (!isJpeg(bytes)) throw new Error(`the photo is not a JPEG (${bytes.length} B)`);
      const t1 = Date.now();
      try {
        const r = await call<VisionRequest, VisionResult>('assistantVision', { task: 'describe_scene', lang: 'en', imageBase64: bytesToBase64(bytes) }, 40000);
        out = { status: 'pass', detail: `photo ${(bytes.length / 1024).toFixed(1)} KB in ${secs(capMs)} · AI answered in ${secs(Date.now() - t1)} · "${String(r.spoken ?? '').slice(0, 160)}"${r.uncertain ? ' (uncertain)' : ''}` };
      } catch (e) {
        out = { status: 'fail', detail: `photo ${(bytes.length / 1024).toFixed(1)} KB in ${secs(capMs)} · AI: ${errLine(e)}`, fix: serverAdvice(e, 'gemini') };
      }
    } catch (e) {
      const m = errLine(e);
      out = { status: 'fail', detail: `camera photo: ${m}`, fix: /camera: busy|\b409\b/i.test(m) ? 'The camera is busy (live video). Wait a moment and try again.' : m === 'stick-offline' ? 'Connect the stick first.' : 'The stick camera gave no photo. Run the Connection test.' };
    }
    const done = { ...base, status: out.status, detail: out.detail, fix: out.fix ?? null, ms: Date.now() - t0 };
    log(`${VISION_LABEL}: ${done.status.toUpperCase()} (${done.ms} ms) ${done.detail}${done.fix ? ` | to do: ${done.fix}` : ''}`);
    if (alive.current) {
      setVision(done);
      setVisionBusy(false);
    }
  };

  const report = () => {
    const st = useAppCheckStatus.getState();
    const meta = [
      `time: ${new Date(startedAt ?? Date.now()).toISOString()}`,
      `app: ${native() ? 'Android app' : 'browser'} · version ${ENV.appVersion} · mode ${isDemo() ? 'demo' : 'real'}`,
      `firebase: project ${ENV.firebase.projectId ?? 'NOT set'} · region ${ENV.firebaseRegion}`,
      `app check: ${PROVIDER_LABEL[st.provider]} · start error ${st.initError ?? 'none'} · last ok ${st.lastOkAt ? `${secs(Date.now() - st.lastOkAt)} ago` : 'never'} · last error ${st.lastError ?? 'none'}${st.lastMs != null ? ` · last ${secs(st.lastMs)}` : ''}`,
      `stick: ${useDevice.getState().link} · GPS: ${useLocation.getState().fix ? 'yes' : 'no'}`,
    ];
    return serverReport(vision ? [...steps, vision] : steps, meta);
  };

  const onCopy = async () => {
    const ok = await copyText(report());
    setCopied(ok ? 'ok' : 'fail');
  };

  const passed = steps.filter((s) => s.status === 'pass').length;
  const failed = steps.filter((s) => s.status === 'fail').length;
  const canVision = linked && !isDemo();

  return (
    <div className="flex flex-col gap-4">
      <div className="glass rounded-[24px] p-4">
        <p className="text-[15px] leading-snug text-ink-2">
          Checks the internet, the server, Google Maps and the AI. If something fails, the orange line says what to do. Tap <b>Copy report</b> to send it to whoever helps you.
        </p>
        <p className="mt-2 text-[13.5px] font-semibold text-ink-3" role="status" aria-live="polite">
          {running ? 'Testing…' : `${passed} passed, ${failed} failed`}
        </p>
      </div>

      <ol className="flex flex-col gap-2.5" aria-label="Server test steps">
        {steps.map((s) => (
          <StepRow key={s.id} s={s} />
        ))}
      </ol>

      <div className="flex flex-col gap-3">
        <GlassButton variant="teal" size="lg" className="w-full" disabled={running} onClick={() => void run()}>
          {running ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} />} {running ? 'Testing…' : 'Run again'}
        </GlassButton>
        <GlassButton size="lg" className="w-full" disabled={running || visionBusy} onClick={() => void onCopy()}>
          <ClipboardCopy size={18} /> {copied === 'ok' ? 'Report copied' : copied === 'fail' ? 'Could not copy' : 'Copy report'}
        </GlassButton>
      </div>

      <div className="glass flex flex-col gap-3 rounded-[24px] p-4">
        <div>
          <p className="text-[15px] font-bold text-ink">Test AI vision</p>
          <p className="mt-1 text-[13px] leading-snug text-ink-3">
            {canVision ? 'Takes one photo with the stick camera and asks the AI what it sees. This uses one AI request.' : isDemo() ? 'Needs the real stick (the app is in demo mode).' : 'Connect the stick first.'}
          </p>
        </div>
        {canVision && (
          <GlassButton size="lg" className="w-full" disabled={visionBusy} onClick={() => void testVision()}>
            {visionBusy ? <Loader2 size={18} className="animate-spin" /> : <ScanEye size={18} />} {visionBusy ? 'Looking…' : 'Test AI vision'}
          </GlassButton>
        )}
        {vision && (
          <ol aria-label="AI vision test" aria-live="polite">
            <StepRow s={vision} />
          </ol>
        )}
      </div>
    </div>
  );
}
