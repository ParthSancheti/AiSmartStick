import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ClipboardCopy, Loader2, Minus, Play, X } from 'lucide-react';
import { GlassButton, cx } from '../../components/glass';
import { DEVICE_API, STICK_AP_PASSPHRASE, STICK_AP_SSID, type DeviceInfoPacket } from '../../../shared/deviceProtocol';
import { AissNative } from '../../core/native/aissNative';
import { isNativeApp, setWholeAppOnStick, stickBinary, stickRequest, STICK_PATHS, useStickRoute, withTimeout, type StickPath } from '../../core/transport/stickHttp';
import { explainPacket } from '../../core/telemetry/pipeline';
import { useDevice } from '../../core/store/device';
import { useDeviceTrace } from '../../core/device/deviceTrace';
import { getTransport } from '../../core/device/bridge';
import { HttpTransport } from '../../core/transport/httpTransport';
import { linkLabel } from '../shared/labels';
import { isDemo } from '../../core/runtime/mode';

/**
 * BUILT-IN CONNECTION TEST (Stick details, Settings → Hardware, setup error). Runs every hop of the
 * stick link and shows PASS / FAIL with timing; "Copy report" puts a plain-text report (no secrets)
 * on the clipboard. Every step is also logged as "[SMARTSTICK] test: …" (logcat: Capacitor/Console).
 */
type Status = 'pending' | 'running' | 'pass' | 'fail' | 'skip' | 'info';
interface Step {
  id: string;
  label: string;
  status: Status;
  detail: string;
  ms: number | null;
}

const PATH_LABEL: Record<StickPath, string> = {
  native: 'Stick Wi-Fi (bound by the app)',
  'native-default': 'Phone’s default network',
  webview: 'WebView fetch',
};

const STEPS: Omit<Step, 'status' | 'detail' | 'ms'>[] = [
  { id: 'wifi', label: 'Phone Wi-Fi' },
  { id: 'bind', label: `Join ${STICK_AP_SSID}` },
  { id: 'device', label: 'GET /api/v1/device' },
  { id: 'telemetry', label: 'GET /api/v1/telemetry' },
  { id: 'link', label: 'Live link (Home)' },
  { id: 'capture', label: 'GET /api/v1/capture (camera)' },
  { id: 'paths', label: 'Which way reaches the stick' },
];

const fresh = (): Step[] => STEPS.map((s) => ({ ...s, status: 'pending', detail: '', ms: null }));
const log = (line: string) => console.info(`[SMARTSTICK] test: ${line}`);
const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

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

function linkSummary() {
  const d = useDevice.getState();
  const tr = useDeviceTrace.getState();
  const t = getTransport();
  const stats = t instanceof HttpTransport ? t.getStats() : null;
  const age = d.lastPacketAt ? Date.now() - d.lastPacketAt : null;
  return {
    linked: (d.link === 'connected' || d.link === 'degraded') && age != null && age < 5000,
    text:
      `${linkLabel(d.link).text}${d.linkDetail ? ` · ${d.linkDetail}` : ''}; last packet ${age == null ? 'never' : `${secs(age)} ago`}; ` +
      `packets received ${tr.counts.packet_received}, accepted ${tr.counts.packet_valid}, rejected ${tr.counts.packet_rejected}` +
      (stats ? `; transport ${stats.state}, ${stats.packets} packets${stats.path ? ` via ${stats.path}${stats.via ? `/${stats.via}` : ''}` : ''}${stats.lastError ? `; last error: ${stats.lastError}` : ''}` : t ? `; transport ${t.kind}` : '; no transport running (stick not set up on this phone?)'),
  };
}

export function ConnectionTest() {
  const [steps, setSteps] = useState<Step[]>(fresh);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const wholeApp = useStickRoute((s) => s.wholeApp);
  const [wholeBusy, setWholeBusy] = useState(false);
  const [wholeMsg, setWholeMsg] = useState<string | null>(null);
  const alive = useRef(true);
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
    if (running) return;
    setRunning(true);
    setCopied('idle');
    setSteps(fresh());
    setStartedAt(Date.now());
    const native = isNativeApp();
    const step = async (id: string, fn: () => Promise<{ status: Status; detail: string }>) => {
      set(id, { status: 'running' });
      const t0 = Date.now();
      let r: { status: Status; detail: string };
      try {
        r = await fn();
      } catch (e) {
        r = { status: 'fail', detail: (e as Error).message.slice(0, 200) };
      }
      const ms = Date.now() - t0;
      set(id, { ...r, ms });
      log(`${STEPS.find((s) => s.id === id)?.label}: ${r.status.toUpperCase()} (${ms} ms) ${r.detail}`);
      return r;
    };
    log(`started (${native ? 'Android app' : 'browser'})`);

    await step('wifi', async () => {
      if (!native) return { status: 'skip', detail: 'Android app only' };
      const w = await withTimeout(AissNative.getCurrentWifiSsid(), 4000, 'Wi-Fi status');
      const parts = [
        `Wi-Fi ${w.wifiEnabled ? 'on' : 'OFF'}`,
        `SSID ${w.ssid ? `"${w.ssid}"` : 'hidden (needs Location on)'}`,
        `stick network ${w.stickNetwork ? 'present' : 'not present'}`,
        `bound ${w.bound ? 'yes' : 'no'}`,
        ...(w.requested != null ? [`request ${w.requested ? (w.connecting ? 'waiting for Android' : 'registered') : 'none'}`] : []),
        ...(w.processBound ? ['whole app on stick Wi-Fi'] : []),
        ...(w.sdk ? [`Android SDK ${w.sdk}`] : []),
      ];
      return { status: !w.wifiEnabled ? 'fail' : w.stickNetwork || w.bound ? 'pass' : 'info', detail: parts.join(', ') };
    });

    await step('bind', async () => {
      if (!native) return { status: 'skip', detail: 'Android app only' };
      const r = await withTimeout(AissNative.connectToSetupNetwork({ ssid: STICK_AP_SSID, passphrase: STICK_AP_PASSPHRASE, timeoutMs: 20_000, openWifiPanelIfOff: false }), 26_000, 'Android Wi-Fi join');
      return r.connected ? { status: 'pass', detail: `connected (${r.via ?? 'request'})` } : { status: 'fail', detail: `not joined: ${r.reason ?? 'no reason'}` };
    });

    let deviceId: string | null = null;
    await step('device', async () => {
      const r = await stickRequest('GET', DEVICE_API.device, { timeoutMs: 3000 });
      let info: DeviceInfoPacket | null = null;
      try {
        info = JSON.parse(r.text) as DeviceInfoPacket;
      } catch {
        /* reported below */
      }
      const where = `via ${r.path}${r.via ? `/${r.via}` : ''}`;
      if (r.status !== 200 || !info || typeof info.deviceId !== 'string') return { status: 'fail', detail: `HTTP ${r.status}, ${r.text.length} B, not a SmartStick answer (${where})` };
      deviceId = info.deviceId;
      return { status: 'pass', detail: `HTTP 200, ${info.deviceId}, firmware ${info.firmware}, protocol v${info.protocolVersion}, auth ${info.auth === false ? 'off' : info.auth === true ? 'ON (old firmware build)' : 'unknown (old firmware?)'} (${where})` };
    });

    await step('telemetry', async () => {
      const r = await stickRequest('GET', DEVICE_API.telemetry, { timeoutMs: 3000 });
      const where = `via ${r.path}${r.via ? `/${r.via}` : ''}`;
      if (r.status !== 200) return { status: 'fail', detail: `HTTP ${r.status}, ${r.text.length} B (${where})${r.status === 401 ? ' — old secure firmware: flash 1.2' : ''}` };
      let p: unknown;
      try {
        p = JSON.parse(r.text);
      } catch {
        return { status: 'fail', detail: `HTTP 200, ${r.text.length} B, NOT JSON: ${r.text.slice(0, 60)} (${where})` };
      }
      const why = explainPacket(p);
      if (why) return { status: 'fail', detail: `HTTP 200, ${r.text.length} B, JSON ok, packet REJECTED: ${why} (${where})` };
      const x = p as { seq: number; battery: { busV: number | null }; ultrasonic: { distanceCm: number | null; status: string }; imu: { ok: boolean }; deviceId: string };
      const other = deviceId && x.deviceId !== deviceId ? `, deviceId differs from /device (${x.deviceId})` : '';
      return { status: 'pass', detail: `HTTP 200, ${r.text.length} B, JSON ok, packet ok: seq ${x.seq}, battery ${x.battery.busV ?? '—'} V, distance ${x.ultrasonic.distanceCm ?? '—'} cm (${x.ultrasonic.status}), IMU ${x.imu.ok ? 'ok' : 'error'}${other} (${where})` };
    });

    await step('link', async () => {
      // Give a just-(re)started link a moment to deliver its first packet.
      const until = Date.now() + 3000;
      while (!linkSummary().linked && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
      const s = linkSummary();
      return { status: s.linked ? 'pass' : 'fail', detail: s.text };
    });

    await step('capture', async () => {
      const r = await stickBinary(DEVICE_API.capture, { timeoutMs: 8000 });
      const where = `via ${r.path}${r.via ? `/${r.via}` : ''}`;
      if (r.status === 409) return { status: 'info', detail: `HTTP 409: camera busy (${where})` };
      if (r.status !== 200 || !r.bytes) return { status: 'fail', detail: `HTTP ${r.status}${r.status === 503 ? ' (camera not available)' : ''} (${where})` };
      const b = r.bytes;
      const jpeg = b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b.subarray(Math.max(0, b.length - 64)).some((v, i, a) => v === 0xff && a[i + 1] === 0xd9);
      return { status: jpeg ? 'pass' : 'fail', detail: `HTTP 200, ${b.length} B, ${jpeg ? 'valid JPEG' : 'NOT a valid JPEG'} (${where})` };
    });

    await step('paths', async () => {
      const paths = native ? STICK_PATHS : (['webview'] as StickPath[]);
      const out: string[] = [];
      let any = false;
      for (const p of paths) {
        const t0 = Date.now();
        try {
          const r = await stickRequest('GET', DEVICE_API.device, { only: p, timeoutMs: 2500 });
          any = true;
          // The camera needs its own check: a path can carry JSON but not the JPEG (e.g. CORS on the WebView).
          let cam = 'camera ok';
          try {
            const c = await stickBinary(DEVICE_API.capture, { only: p, timeoutMs: 6000 });
            cam = c.status === 200 ? 'camera ok' : `camera HTTP ${c.status}`;
          } catch (e) {
            cam = `camera no (${(e as Error).message.slice(0, 50)})`;
          }
          out.push(`${PATH_LABEL[p]}: works (HTTP ${r.status}${r.via ? `, ${r.via}` : ''}, ${secs(Date.now() - t0)}; ${cam})`);
        } catch (e) {
          out.push(`${PATH_LABEL[p]}: no (${(e as Error).message.slice(0, 70)})`);
        }
      }
      const pref = useStickRoute.getState().preferred;
      return { status: any ? 'pass' : 'fail', detail: `${out.join('; ')}${pref ? `. In use: ${PATH_LABEL[pref]}` : ''}` };
    });
    log('finished');
    if (alive.current) setRunning(false);
  }, [running, set]);

  useEffect(() => {
    void run();
    // Run once when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const report = () => {
    const lines = [
      'AI SmartStick connection test',
      `time: ${new Date(startedAt ?? Date.now()).toISOString()}`,
      `app: ${isNativeApp() ? 'Android app' : 'browser'} · ${typeof navigator !== 'undefined' ? navigator.userAgent : ''}`,
      `mode: ${isDemo() ? 'demo' : 'real'} · whole app on stick Wi-Fi: ${useStickRoute.getState().wholeApp ? 'ON' : 'off'}`,
      '',
      ...steps.map((s) => `${s.status.toUpperCase().padEnd(7)} ${s.label}${s.ms != null ? ` (${secs(s.ms)})` : ''}\n        ${s.detail || '—'}`),
      '',
      `now: ${linkSummary().text}`,
    ];
    return lines.join('\n');
  };

  const onCopy = async () => {
    const ok = await copyText(report());
    setCopied(ok ? 'ok' : 'fail');
  };

  const toggleWholeApp = async () => {
    setWholeBusy(true);
    const r = await setWholeAppOnStick(!wholeApp);
    setWholeBusy(false);
    setWholeMsg(!wholeApp ? (r.bound ? 'On. Maps and the assistant are paused until you turn this off.' : `Could not switch: ${r.reason ?? 'no stick network'}. Join ${STICK_AP_SSID} first.`) : 'Off. Everything uses mobile data / internet again.');
    log(`whole app on stick Wi-Fi → ${!wholeApp ? (r.bound ? 'ON' : `failed (${r.reason})`) : 'off'}`);
  };

  const passed = steps.filter((s) => s.status === 'pass').length;
  const failed = steps.filter((s) => s.status === 'fail').length;

  return (
    <div className="flex flex-col gap-4">
      <div className="glass rounded-[24px] p-4">
        <p className="text-[15px] leading-snug text-ink-2">
          Checks every step between this phone and the stick. If something fails, tap <b>Copy report</b> and send it to whoever helps you.
        </p>
        {isDemo() && <p className="mt-2 text-[13.5px] text-ink-3">Demo mode: Home shows a simulated stick; this test still checks for a real one.</p>}
        <p className="mt-2 text-[13.5px] font-semibold text-ink-3" role="status" aria-live="polite">
          {running ? 'Testing…' : `${passed} passed, ${failed} failed`}
        </p>
      </div>

      <ol className="flex flex-col gap-2.5" aria-label="Connection test steps">
        {steps.map((s) => (
          <li key={s.id} className="glass flex min-w-0 items-start gap-3 rounded-[20px] px-4 py-3">
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
            </span>
          </li>
        ))}
      </ol>

      <div className="flex flex-col gap-3">
        <GlassButton variant="teal" size="lg" className="w-full" disabled={running} onClick={() => void run()}>
          {running ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} />} {running ? 'Testing…' : 'Run again'}
        </GlassButton>
        <GlassButton size="lg" className="w-full" disabled={running} onClick={() => void onCopy()}>
          <ClipboardCopy size={18} /> {copied === 'ok' ? 'Report copied' : copied === 'fail' ? 'Could not copy' : 'Copy report'}
        </GlassButton>
      </div>

      {isNativeApp() && (
        <div className="glass rounded-[24px] p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[15px] font-bold text-ink">Use stick Wi-Fi for the whole app</p>
              <p className="mt-1 text-[13px] leading-snug text-ink-3">
                Last resort if nothing else reaches the stick. While it is on, maps, the assistant and cloud sync stop (the stick has no internet). SMS still works. Turn it off afterwards.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={wholeApp}
              aria-label="Use stick Wi-Fi for the whole app"
              disabled={wholeBusy}
              onClick={() => void toggleWholeApp()}
              className={cx('relative h-8 w-14 shrink-0 rounded-full transition-colors duration-150', wholeApp ? 'bg-teal' : 'bg-ink/15')}
            >
              <span className={cx('absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-transform duration-150', wholeApp ? 'translate-x-7' : 'translate-x-1')} />
            </button>
          </div>
          {wholeMsg && <p className="mt-2 text-[13px] text-ink-2">{wholeMsg}</p>}
        </div>
      )}
    </div>
  );
}
