import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Activity, Check, ChevronDown, Loader2, Radar, RotateCcw, Settings2, Wifi, WifiOff, Link2 } from 'lucide-react';
import { GlassButton, cx } from '../../components/glass';
import { Atmosphere } from '../../components/Atmosphere';
import { AppScreen, ScreenHeader } from '../../components/Layout';
import { STICK_AP_PASSPHRASE, STICK_AP_SSID } from '../../../shared/deviceProtocol';
import { cancelProvisioning, provPhase, searchForStick, useProvisioning, type ProvPhase, type ProvStep } from '../../core/provisioning/provisioning';
import { AissNative } from '../../core/native/aissNative';
import { useDevice, isLinked } from '../../core/store/device';
import { ConnectionTest } from './ConnectionTest';

const PHASES: { id: Exclude<ProvPhase, 'error' | 'idle'>; label: string; detail: string }[] = [
  { id: 'scanning', label: 'Scanning', detail: `Looking for ${STICK_AP_SSID}` },
  { id: 'found', label: 'Found', detail: 'The phone joined the stick’s Wi-Fi' },
  { id: 'connecting', label: 'Connecting', detail: 'Reading the stick and its sensors' },
  { id: 'connected', label: 'Connected', detail: 'Live data is flowing' },
];
const ORDER: ProvPhase[] = ['scanning', 'found', 'connecting', 'connected'];

const STEP_TEXT: Partial<Record<ProvStep, string>> = {
  searching: 'Checking the phone’s Wi-Fi',
  joining: `If Android asks, choose ${STICK_AP_SSID} and tap Connect`,
  stick_found: `On ${STICK_AP_SSID}`,
  reading_device_info: 'Saying hello to the stick',
  waiting_for_data: 'Waiting for the first sensor reading',
};

/**
 * The one SmartStick setup page (onboarding and Settings → Set up SmartStick).
 * v1 simple link: join the stick's Wi-Fi, read its data. SCANNING → FOUND → CONNECTING → CONNECTED.
 * The header stays fixed; only the content below it scrolls.
 */
export function StickSetup({ onDone, onBack, onSkip, skipLabel = 'Cancel', title = 'Connect SmartStick' }: { onDone: () => void; onBack?: () => void; onSkip?: () => void; skipLabel?: string; title?: string }) {
  const step = useProvisioning((s) => s.step);
  const error = useProvisioning((s) => s.error);
  const errorKind = useProvisioning((s) => s.errorKind);
  const diagnostics = useProvisioning((s) => s.diagnostics);
  const link = useDevice((s) => s.link);
  const phase = provPhase(step);
  const finished = useRef(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showTest, setShowTest] = useState(false);

  useEffect(() => {
    finished.current = false;
    void searchForStick();
    return () => {
      if (!finished.current) cancelProvisioning();
    };
  }, []);

  useEffect(() => {
    if (phase !== 'connected') return;
    finished.current = true;
    const t = setTimeout(onDone, 1100);
    return () => clearTimeout(t);
  }, [phase, onDone]);

  const reached = (id: ProvPhase) => phase !== 'error' && ORDER.indexOf(phase) >= ORDER.indexOf(id);
  const current = phase === 'error' ? null : phase;
  const failed = phase === 'error';
  const wifiHelp = errorKind === 'wifi_off' || errorKind === 'not_found' || errorKind === 'unsupported' || errorKind === 'no_answer' || errorKind === 'not_a_stick';

  return (
    // Overlay that always covers its parent. Opened from Home/Settings it is a sibling AFTER the
    // full-height Home screen inside an overflow-hidden container, where an in-flow block is invisible.
    <div className="absolute inset-0 z-[90]">
      <AppScreen className="text-ink">
        <Atmosphere />
        {/* Fixed header: never scrolls away. */}
        <div className="relative z-20 shrink-0 px-4 pb-2" style={{ paddingTop: 'calc(var(--island, var(--sat)) + 14px)' }}>
          <ScreenHeader title={title} onBack={onBack} />
        </div>

        <div className="no-scrollbar relative z-10 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-5" style={{ paddingBottom: 'calc(var(--sab) + 16px)' }}>
          <div className="mt-2 grid place-items-center">
            <div className={cx('relative grid place-items-center', failed ? 'h-28 w-28' : 'h-40 w-40')} aria-hidden>
              {phase === 'scanning' &&
                [0, 1].map((i) => (
                  <motion.span
                    key={i}
                    className="absolute inset-0 rounded-full border-2 border-teal/50"
                    style={{ willChange: 'transform, opacity' }}
                    initial={{ scale: 0.45, opacity: 0.9 }}
                    animate={{ scale: 1.2, opacity: 0 }}
                    transition={{ duration: 2.2, repeat: Infinity, delay: i * 1.1, ease: 'easeOut' }}
                  />
                ))}
              <motion.div
                className={cx('grid h-24 w-24 place-items-center rounded-full border', failed ? 'border-[var(--sos)]/40 bg-[var(--sos)]/10' : 'border-teal/40 bg-teal/15')}
                animate={{ scale: phase === 'connected' ? [1, 1.08, 1] : 1 }}
                transition={{ duration: 0.4 }}
              >
                {failed ? <WifiOff size={40} className="text-[var(--sos)]" /> : phase === 'connected' ? <Check size={44} className="text-teal" /> : phase === 'connecting' ? <Link2 size={40} className="text-teal" /> : phase === 'found' ? <Wifi size={40} className="text-teal" /> : <Radar size={40} className="text-teal" />}
              </motion.div>
            </div>
            <AnimatePresence mode="wait" initial={false}>
              <motion.p key={phase} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }} className="mt-3 text-center text-[24px] font-extrabold tracking-tight" role="status" aria-live="polite">
                {failed ? 'Could not connect' : phase === 'connected' ? 'SmartStick connected' : phase === 'connecting' ? 'Connecting…' : phase === 'found' ? 'SmartStick found' : 'Looking for your stick…'}
              </motion.p>
            </AnimatePresence>
            {!failed && <p className="mt-1 min-h-[22px] max-w-full break-words px-2 text-center text-[15px] text-ink-2">{STEP_TEXT[step] ?? PHASES.find((p) => p.id === phase)?.detail ?? ''}</p>}
          </div>

          {failed ? (
            <>
              <div className="mt-4 break-words rounded-[20px] border border-[var(--sos)]/30 bg-[var(--sos)]/10 p-4 text-[15px] leading-snug" role="alert">
                {error}
                {errorKind === 'old_firmware' && <p className="mt-2 text-[13px] text-ink-2">Obstacle vibration keeps working on the stick in the meantime.</p>}
                {wifiHelp && (
                  <p className="mt-2 text-[13px] text-ink-2">
                    Manual way: Wi-Fi settings → {STICK_AP_SSID} → password <b>{STICK_AP_PASSPHRASE}</b>. If Android says “no internet”, choose to stay connected, then come back here.
                  </p>
                )}
              </div>
              <div className="mt-4 flex flex-col gap-3">
                <GlassButton variant="teal" className="h-14 w-full rounded-[22px] text-[17px] font-bold" onClick={() => void searchForStick()}>
                  <RotateCcw size={18} className="mr-2" /> Try again
                </GlassButton>
                {wifiHelp && (
                  <GlassButton className="h-12 w-full rounded-[20px] text-[15px] font-semibold" onClick={() => void AissNative.openWifiSettings().catch(() => undefined)}>
                    <Wifi size={18} className="mr-2" /> Open Wi-Fi settings
                  </GlassButton>
                )}
                {errorKind === 'permission' && (
                  <GlassButton className="h-12 w-full rounded-[20px] text-[15px] font-semibold" onClick={() => void AissNative.openAppSettings().catch(() => undefined)}>
                    <Settings2 size={18} className="mr-2" /> Open app settings
                  </GlassButton>
                )}
                <GlassButton className="h-12 w-full rounded-[20px] text-[15px] font-semibold" aria-expanded={showTest} onClick={() => setShowTest((v) => !v)}>
                  <Activity size={18} className="mr-2" /> {showTest ? 'Hide connection test' : 'Run connection test'}
                </GlassButton>
              </div>
              {showTest && (
                <div className="mt-4">
                  <ConnectionTest />
                </div>
              )}
            </>
          ) : (
            <>
              <ol className="mt-5 flex flex-col gap-2.5" aria-label="Setup progress">
                {PHASES.map((p) => {
                  const done = reached(p.id) && current !== p.id;
                  const active = current === p.id && phase !== 'connected';
                  const tick = done || (p.id === 'connected' && phase === 'connected');
                  return (
                    <li key={p.id} className={cx('glass flex min-w-0 items-center gap-3.5 rounded-[22px] px-4 py-3 transition-opacity duration-150', !reached(p.id) && !active && 'opacity-50')}>
                      <span className={cx('grid h-9 w-9 shrink-0 place-items-center rounded-full', tick ? 'bg-teal text-[var(--on-teal)]' : 'bg-[var(--line)] text-ink-2')}>
                        {tick ? <Check size={18} /> : active ? <Loader2 size={18} className="animate-spin" /> : <span className="h-2 w-2 rounded-full bg-current" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[16px] font-bold">{p.label}</span>
                        <span className="block break-words text-[13px] text-ink-3">{p.detail}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
              {(phase === 'scanning' || phase === 'found') && (
                <p className="mt-4 rounded-[18px] bg-ink/[0.05] px-4 py-3 text-[13.5px] leading-snug text-ink-2">
                  Switch the stick on and keep it next to the phone. Android may show a “Connect to device” box: choose <b>{STICK_AP_SSID}</b> and tap Connect. Mobile data keeps working for maps and the assistant.
                </p>
              )}
            </>
          )}

          {diagnostics.length > 0 && (
            <div className="mt-4">
              <button type="button" className="flex min-h-11 items-center gap-1.5 text-[13px] font-bold text-ink-2" aria-expanded={showDetails} onClick={() => setShowDetails((v) => !v)}>
                Details <ChevronDown size={16} className={cx('transition-transform duration-150', showDetails && 'rotate-180')} />
              </button>
              {showDetails && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-[12px] bg-ink/5 p-2 font-mono text-[11px] leading-snug text-ink-2">{diagnostics.join('\n')}</pre>}
            </div>
          )}

          <div className="mt-auto flex flex-col gap-3 pt-6">
            {phase === 'connected' && isLinked(link) && <p className="text-center text-[14px] text-ink-2">Opening Home…</p>}
            {(onSkip ?? onBack) && phase !== 'connected' && (
              <button type="button" className="h-12 w-full text-[15px] font-semibold text-ink-2" onClick={onSkip ?? onBack}>
                {skipLabel}
              </button>
            )}
          </div>
        </div>
      </AppScreen>
    </div>
  );
}
