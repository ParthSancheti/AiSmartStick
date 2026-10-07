import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Loader2, Radar, RotateCcw, Wifi, WifiOff, Link2 } from 'lucide-react';
import { GlassButton, cx } from '../../components/glass';
import { AppScreen, SafeAreaContent, ScreenHeader } from '../../components/Layout';
import { STICK_AP_SSID } from '../../../shared/deviceProtocol';
import { cancelProvisioning, provPhase, searchForStick, useProvisioning, type ProvPhase } from '../../core/provisioning/provisioning';
import { useDevice, isLinked } from '../../core/store/device';

const PHASES: { id: Exclude<ProvPhase, 'error' | 'idle'>; label: string; detail: string }[] = [
  { id: 'scanning', label: 'Scanning', detail: `Looking for ${STICK_AP_SSID}` },
  { id: 'found', label: 'Found', detail: 'Your SmartStick is nearby' },
  { id: 'connecting', label: 'Connecting', detail: 'Pairing securely with this phone' },
  { id: 'connected', label: 'Connected', detail: 'Live data is flowing' },
];
const ORDER: ProvPhase[] = ['scanning', 'found', 'connecting', 'connected'];

const STEP_TEXT: Partial<Record<string, string>> = {
  connecting_to_stick: 'Approve “Connect to device?” if Android asks',
  stick_connected: 'Joined the stick’s Wi-Fi',
  reading_device_info: 'Reading the stick’s identity',
  configuring_network: 'Giving the stick this phone’s key',
  verifying_stick: 'Checking the stick saved the key',
  authenticating: 'Verifying the stick’s key proof',
};

/**
 * The one SmartStick Wi-Fi setup page (onboarding and Settings → Set up again).
 * Opens straight into scanning: SCANNING → FOUND → CONNECTING → CONNECTED, then hands back.
 */
export function StickSetup({ onDone, onBack, onSkip, skipLabel = 'Cancel', title = 'Connect SmartStick' }: { onDone: () => void; onBack?: () => void; onSkip?: () => void; skipLabel?: string; title?: string }) {
  const step = useProvisioning((s) => s.step);
  const error = useProvisioning((s) => s.error);
  const needsReset = useProvisioning((s) => s.needsFactoryReset);
  const diagnostics = useProvisioning((s) => s.diagnostics);
  const link = useDevice((s) => s.link);
  const phase = provPhase(step);
  const finished = useRef(false);

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

  return (
    <AppScreen className="z-[90] bg-[var(--bg)] text-ink">
      <SafeAreaContent className="px-6 pb-8">
        <ScreenHeader title={title} onBack={onBack} />

        <div className="mt-8 grid place-items-center">
          <div className="relative grid h-44 w-44 place-items-center" aria-hidden>
            {phase === 'scanning' &&
              [0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="absolute inset-0 rounded-full border-2 border-teal/50"
                  initial={{ scale: 0.4, opacity: 0.9 }}
                  animate={{ scale: 1.25, opacity: 0 }}
                  transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.8, ease: 'easeOut' }}
                />
              ))}
            <motion.div
              layout
              className={cx('grid h-24 w-24 place-items-center rounded-[32px] border', phase === 'error' ? 'border-[var(--sos)]/40 bg-[var(--sos)]/10' : 'border-teal/40 bg-teal/15')}
              animate={{ scale: phase === 'connected' ? [1, 1.08, 1] : 1 }}
              transition={{ duration: 0.5 }}
            >
              {phase === 'error' ? <WifiOff size={40} className="text-[var(--sos)]" /> : phase === 'connected' ? <Check size={44} className="text-teal" /> : phase === 'connecting' ? <Link2 size={40} className="text-teal" /> : phase === 'found' ? <Wifi size={40} className="text-teal" /> : <Radar size={40} className="text-teal" />}
            </motion.div>
          </div>
          <AnimatePresence mode="popLayout">
            <motion.p key={phase} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="mt-4 text-center text-[24px] font-extrabold tracking-tight" role="status" aria-live="polite">
              {phase === 'error' ? 'Could not connect' : phase === 'connected' ? 'SmartStick connected' : phase === 'connecting' ? 'Connecting…' : phase === 'found' ? 'SmartStick found' : 'Scanning…'}
            </motion.p>
          </AnimatePresence>
          <p className="mt-1 min-h-[22px] text-center text-[15px] text-ink-2">{phase === 'connecting' ? STEP_TEXT[step] ?? '' : phase === 'error' ? '' : PHASES.find((p) => p.id === phase)?.detail ?? ''}</p>
        </div>

        <ol className="mt-8 flex flex-col gap-3" aria-label="Setup progress">
          {PHASES.map((p) => {
            const done = reached(p.id) && current !== p.id;
            const active = current === p.id && phase !== 'connected';
            return (
              <li key={p.id} className={cx('glass flex items-center gap-4 rounded-[22px] px-4 py-3.5 transition-opacity', !reached(p.id) && !active && 'opacity-50')}>
                <span className={cx('grid h-9 w-9 shrink-0 place-items-center rounded-full', done || (p.id === 'connected' && phase === 'connected') ? 'bg-teal text-[var(--on-teal)]' : 'bg-[var(--line)] text-ink-2')}>
                  {done || (p.id === 'connected' && phase === 'connected') ? <Check size={18} /> : active ? <Loader2 size={18} className="animate-spin" /> : <span className="h-2 w-2 rounded-full bg-current" />}
                </span>
                <span className="flex-1">
                  <span className="block text-[16px] font-bold">{p.label}</span>
                  <span className="block text-[13px] text-ink-3">{p.detail}</span>
                </span>
              </li>
            );
          })}
        </ol>

        {phase === 'error' && (
          <div className="mt-6 rounded-[20px] border border-[var(--sos)]/30 bg-[var(--sos)]/10 p-4 text-[15px] leading-snug" role="alert">
            {error}
            {needsReset && <p className="mt-2 text-[13px] text-ink-2">Resetting only clears the old pairing on the stick. Obstacle vibration keeps working.</p>}
            {diagnostics.length > 0 && (
              <details className="mt-3 text-[12px] text-ink-2">
                <summary className="cursor-pointer font-bold">Show details</summary>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-[12px] bg-ink/5 p-2 font-mono text-[11px] leading-snug">{diagnostics.join('\n')}</pre>
              </details>
            )}
          </div>
        )}

        <div className="mt-auto flex flex-col gap-3 pt-8">
          {phase === 'error' && (
            <GlassButton variant="teal" className="h-14 w-full rounded-[22px] text-[17px] font-bold" onClick={() => void searchForStick()}>
              <RotateCcw size={18} className="mr-2" /> Try again
            </GlassButton>
          )}
          {phase === 'connected' && isLinked(link) && <p className="text-center text-[14px] text-ink-2">Opening Home…</p>}
          {(onSkip ?? onBack) && phase !== 'connected' && (
            <button type="button" className="h-12 w-full text-[15px] font-semibold text-ink-2" onClick={onSkip ?? onBack}>
              {skipLabel}
            </button>
          )}
        </div>
      </SafeAreaContent>
    </AppScreen>
  );
}
