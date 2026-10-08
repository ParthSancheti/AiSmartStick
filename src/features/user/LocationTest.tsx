import { useCallback, useEffect, useState } from 'react';
import { create } from 'zustand';
import { AnimatePresence } from 'motion/react';
import { Capacitor } from '@capacitor/core';
import { Check, Clipboard, Crosshair, LocateFixed, MapPin, RotateCcw, Settings } from 'lucide-react';
import { SubPageView } from '../../components/Layout';
import { Group, Row } from '../../components/glass';
import { AissLocation, type NativeLocationDiagnostics } from '../../core/native/aissLocation';
import {
  acquireFix,
  ensureLocation,
  freshnessLabel,
  locationProblem,
  locLog,
  openAppLocationSettings,
  openLocationSettings,
  requestLocationPermission,
  useLocation,
  useLocationDiag,
  type LocationDiag,
  type LocationState,
} from '../../core/location/locationService';
import { useNow } from '../../hooks/useNow';

/**
 * Location test: everything that decides whether the phone gets a position, on one screen, with
 * the buttons that fix it and a "Copy report" for support. Real values only: what Android and the
 * location sources report right now; nothing is simulated.
 *
 * Open it from anywhere with openLocationTest(); <LocationTestHost/> renders it (StickUserApp, so
 * it gets the user's text size and high contrast), and LocationStatus also offers it when there is
 * a location problem. It sits below SOS / incoming call: StickUserApp closes it when either starts.
 */
export const useLocationTest = create<{ open: boolean }>(() => ({ open: false }));
export const openLocationTest = () => useLocationTest.setState({ open: true });
export const closeLocationTest = () => useLocationTest.setState({ open: false });
/**
 * Test pages (Location / Connection test) sit above Settings (60) and stick setup (90) that open
 * them, inside StickUserApp. SOS (80) and an incoming call (72) close them (see StickUserApp).
 */
export const TEST_PAGE_Z = 'z-[96]';

/** Duplicate hosts are safe: only the first mounted one renders. */
let nextHostId = 1;
const useHosts = create<{ ids: number[] }>(() => ({ ids: [] }));

/**
 * Mount once, inside StickUserApp's root (zoom / data-contrast). Rendered in place (no portal to
 * body), so text size and high contrast apply and the page stays inside the phone frame.
 */
export function LocationTestHost() {
  const [id] = useState(() => nextHostId++);
  useEffect(() => {
    useHosts.setState((s) => ({ ids: [...s.ids, id] }));
    return () => useHosts.setState((s) => ({ ids: s.ids.filter((x) => x !== id) }));
  }, [id]);
  const owner = useHosts((s) => s.ids[0] === id);
  const open = useLocationTest((s) => s.open);
  if (!owner) return null;
  return (
    <AnimatePresence>
      {open && (
        <div key="loctest" className={`absolute inset-0 ${TEST_PAGE_Z}`}>
          <LocationTest onClose={closeLocationTest} />
        </div>
      )}
    </AnimatePresence>
  );
}

const age = (ms: number | null | undefined) => {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
};

const permText = (s: LocationState) =>
  s.permission === 'granted' ? (s.precise === false ? 'Allowed · approximate only' : s.precise ? 'Allowed · precise' : 'Allowed') : s.permission === 'denied' ? 'Blocked (Don’t ask again)' : s.permission === 'prompt' ? 'Not allowed yet' : 'Not checked yet';

/** Plain-text report for "Copy report" (no secrets: only location state). */
export function locationReport(s: LocationState, d: LocationDiag, n: NativeLocationDiagnostics | null, nativeError: string | null, now = Date.now()) {
  const f = s.fix;
  const lines = [
    `AI SmartStick location report ${new Date(now).toISOString()}`,
    `platform: ${Capacitor.getPlatform()} · AissLocation plugin: ${Capacitor.isPluginAvailable('AissLocation') ? 'yes' : 'no'}`,
    `permission: ${s.permission} (precise=${s.precise}) · location switch: ${s.servicesOn == null ? 'unknown' : s.servicesOn ? 'on' : 'off'}`,
    `status: ${s.status} · reason: ${s.reason ?? 'none'} · error: ${s.error ?? 'none'} · source: ${s.source ?? 'none'}`,
    `last fix: ${f ? `${f.lat.toFixed(5)},${f.lng.toFixed(5)} ±${Math.round(f.accuracyM)} m, ${age(now - f.ts)} old, from ${s.fixSource ?? '?'}` : 'none'}`,
    `live updates: ${d.updates} ${JSON.stringify(d.bySource)} · last ${d.lastUpdateAt ? `${age(now - d.lastUpdateAt)} ago` : 'never'} · fallbacks: ${d.fallback.join(', ') || 'none'}`,
  ];
  if (n) {
    lines.push(
      `native: sdk ${n.sdk} · permission ${n.state} (fine=${n.precise}, coarse=${n.coarse}) · switch ${n.enabled ? 'on' : 'off'} · wanted ${n.wanted} · running ${n.running} · background ${n.backgroundAllowed}`,
      `native: delivered ${n.delivered} · last ${n.lastDeliveredAt ? `${age(now - n.lastDeliveredAt)} ago from ${n.lastProvider}` : 'never'} · active [${(n.activeProviders ?? []).join(', ')}] · last error: ${n.lastError ?? 'none'}`,
      ...(n.providers ?? []).map((p) => `  provider ${p.name}: ${p.enabled ? 'on' : 'off'} · cached ${p.lastAgeMs == null ? 'none' : `${age(p.lastAgeMs)} old ±${Math.round(p.lastAccuracy ?? 0)} m`}${p.error ? ` · ${p.error}` : ''}`),
    );
  } else lines.push(`native diagnostics: ${nativeError ?? 'not available'}`);
  lines.push('log:', ...d.lines.slice(-30).map((l) => `  ${l}`));
  return lines.join('\n');
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function Btn({ onClick, icon, children, busy }: { onClick: () => void | Promise<unknown>; icon: React.ReactNode; children: React.ReactNode; busy?: boolean }) {
  const [running, setRunning] = useState(false);
  return (
    <button
      type="button"
      disabled={running || busy}
      onClick={async () => {
        setRunning(true);
        try {
          await onClick();
        } finally {
          setRunning(false);
        }
      }}
      className="flex min-h-11 items-center justify-center gap-1.5 rounded-full bg-teal px-4 text-[14px] font-bold text-on-teal active:scale-[0.98] disabled:opacity-60"
    >
      {icon}
      {children}
    </button>
  );
}

export function LocationTest({ onClose }: { onClose: () => void }) {
  const s = useLocation();
  const d = useLocationDiag();
  const now = useNow(1000);
  const [native, setNative] = useState<NativeLocationDiagnostics | null>(null);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const [probe, setProbe] = useState<string | null>(null);
  const isAndroid = Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('AissLocation');

  const refresh = useCallback(async () => {
    if (!isAndroid) return setNativeError(Capacitor.isNativePlatform() ? 'AissLocation plugin missing in this APK' : 'browser (no native plugin)');
    try {
      setNative(await AissLocation.getDiagnostics());
      setNativeError(null);
    } catch (e) {
      setNativeError(`getDiagnostics failed: ${(e as Error)?.message ?? e} (older APK?)`);
    }
  }, [isAndroid]);

  useEffect(() => {
    locLog('location test opened');
    void ensureLocation({ request: false });
    void refresh();
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const p = locationProblem(s, { native: Capacitor.isNativePlatform() });
  const f = s.fix;
  const live = f && now - f.ts <= 30_000;

  return (
    <SubPageView onClose={onClose} title="Location test">
      <div className="glass rounded-[28px] p-5" role="status" aria-live="polite">
        <div className="flex items-center gap-3">
          <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-full ${live ? 'bg-ok/15 text-ok' : 'bg-amber-soft text-amber-ink'}`}>{live ? <LocateFixed size={24} /> : <Crosshair size={24} />}</span>
          <div className="min-w-0 flex-1">
            <p className="break-words text-[19px] font-extrabold leading-tight text-ink">{live ? 'Location works' : f ? 'Only an old position' : 'No position yet'}</p>
            <p className="mt-0.5 break-words text-[14px] leading-snug text-ink-2">{p?.text ?? (f ? `${freshnessLabel(f.ts, now)} · ±${Math.round(f.accuracyM)} m` : 'Waiting for the first position…')}</p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Btn
            icon={<MapPin size={16} />}
            onClick={async () => {
              locLog('test: Allow pressed');
              await requestLocationPermission();
              await refresh();
            }}
          >
            Allow
          </Btn>
          {s.permission === 'granted' && s.precise === false && (
            <Btn icon={<Crosshair size={16} />} onClick={() => requestLocationPermission({ upgrade: true })}>
              Use precise
            </Btn>
          )}
          <Btn icon={<Settings size={16} />} onClick={() => openAppLocationSettings()}>
            Open settings
          </Btn>
          <Btn icon={<Settings size={16} />} onClick={() => openLocationSettings()}>
            Turn on
          </Btn>
          <Btn
            icon={<RotateCcw size={16} />}
            onClick={async () => {
              setProbe('Asking every source for a fresh position…');
              locLog('test: fresh position requested');
              const r = await acquireFix({ maxAgeMs: 10_000, timeoutMs: 10_000 });
              setProbe(r.fix ? `${r.fresh ? 'Fresh' : 'Only old'} position: ±${Math.round(r.fix.accuracyM)} m, ${age(Date.now() - r.fix.ts)} old` : 'No position from any source in 10 s.');
              await refresh();
            }}
          >
            Get position
          </Btn>
          <Btn
            icon={copied === 'ok' ? <Check size={16} /> : <Clipboard size={16} />}
            onClick={async () => {
              await refresh();
              const ok = await copyText(locationReport(useLocation.getState(), useLocationDiag.getState(), native, nativeError));
              setCopied(ok ? 'ok' : 'fail');
              setTimeout(() => setCopied(null), 2500);
            }}
          >
            {copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Copy failed' : 'Copy report'}
          </Btn>
        </div>
        {probe && <p className="mt-3 break-words text-[13.5px] font-semibold text-ink-2">{probe}</p>}
      </div>

      <Group title="This phone">
        <Row label="Permission" detail={permText(s)} tone={s.permission === 'granted' ? 'teal' : 'amber'} />
        <Row label="Location switch" detail={s.servicesOn == null ? (native ? (native.enabled ? 'On' : 'Off') : 'Unknown') : s.servicesOn ? 'On' : 'Off'} tone={s.servicesOn === false ? 'amber' : 'teal'} />
        <Row label="Status" detail={`${s.status}${s.reason ? ` · ${s.reason}` : ''}${s.error ? ` · ${s.error}` : ''}`} tone="ink" />
        <Row label="Last position" detail={f ? `${f.lat.toFixed(5)}, ${f.lng.toFixed(5)} · ±${Math.round(f.accuracyM)} m · ${age(now - f.ts)} old · ${s.fixSource ?? '?'}` : 'None'} tone={live ? 'teal' : 'amber'} />
        <Row
          label="Live updates"
          detail={`${d.updates}${Object.keys(d.bySource).length ? ` (${Object.entries(d.bySource).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''} · last ${d.lastUpdateAt ? `${age(now - d.lastUpdateAt)} ago` : 'never'}${d.fallback.length ? ` · fallbacks: ${d.fallback.join(', ')}` : ''}`}
          tone="ink"
        />
      </Group>

      <Group title="Android location (LocationManager)" footer={native && nativeError ? nativeError : undefined}>
        {native ? (
          <>
            <Row label="Android permission" detail={`${native.state} · precise ${native.precise ? 'yes' : 'no'} · approximate ${native.coarse ? 'yes' : 'no'} · Android ${native.sdk}`} tone="ink" />
            <Row label="Updates" detail={`${native.running ? 'running' : 'stopped'} (${(native.activeProviders ?? []).join(', ') || 'no providers'}) · delivered ${native.delivered} · last ${native.lastDeliveredAt ? `${age(now - native.lastDeliveredAt)} ago from ${native.lastProvider}` : 'never'}`} tone={native.running ? 'teal' : 'amber'} />
            {(native.providers ?? []).map((pr) => (
              <Row key={pr.name} label={`Provider: ${pr.name}`} detail={`${pr.enabled ? 'on' : 'off'} · cached ${pr.lastAgeMs == null ? 'none' : `${age(pr.lastAgeMs)} old, ±${Math.round(pr.lastAccuracy ?? 0)} m`}${pr.error ? ` · ${pr.error}` : ''}`} tone={pr.enabled ? 'teal' : 'ink'} />
            ))}
            {native.lastError && <Row label="Last error" detail={native.lastError} tone="amber" />}
          </>
        ) : (
          <Row label="Not available" detail={nativeError ?? 'Loading…'} tone="ink" />
        )}
      </Group>

      <Group title="Log" footer='Also in logcat: adb logcat | findstr LOCATION (Windows) or grep LOCATION.'>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[11.5px] leading-snug text-ink-2">{d.lines.slice(-30).join('\n') || 'No location events yet.'}</pre>
      </Group>
    </SubPageView>
  );
}
