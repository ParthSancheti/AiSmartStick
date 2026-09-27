import { useState, type ReactNode } from 'react';
import { BatteryCharging, BatteryLow, Eye, Footprints, Hand, MessageCircle, PersonStanding, RotateCcw, Send, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { getMock } from '../core/device/bridge';
import { simulateSpeech } from '../core/ai/assistant';
import { setInternet, setStickLinked } from '../core/device/network';
import { requestSnapshot } from '../core/camera/cameraSession';
import { resetPipeline } from '../core/telemetry/pipeline';
import { switchMode } from '../core/runtime/mode';
import { sendGuardianMessage } from '../core/messages';
import { guardianAcknowledge } from '../core/safety/sos';
import { useDevice } from '../core/store/device';
import { useSession } from '../core/store/session';
import { useSafety } from '../core/store/safety';
import { useUI } from '../core/store/ui';
import { useNetworkStrategy } from '../hooks/useNetworkStrategy';
import type { ButtonPattern } from '../core/types';
import { GlassButton, Segmented, Toggle, cx } from './glass';
import { NetworkBadge } from './StatusBits';

const PHRASES = [
  "What's in front of me?",
  'Take me to the nearest mall',
  'Call Mom',
  'Where am I?',
  'मेरे आगे क्या है?',
  'Read this for me',
  'Which note is this?',
  'Tell Mom I’m reaching in ten minutes',
  'Stop navigation',
  'Bachao!',
];

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="border-t border-line py-4 first:border-t-0 first:pt-0">
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      {hint && <p className="mt-0.5 text-[13px] leading-snug text-ink-3">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

const chip = 'h-9 rounded-full px-3.5 text-[13.5px] font-semibold';

/**
 * Stands in for everything that isn't built yet: the stick's hardware,
 * the network, and the other person's phone. DEMO MODE ONLY: App renders it only when mode === 'demo'.
 */
export function DemoPanel({ variant = 'column', onClose }: { variant?: 'column' | 'drawer'; onClose?: () => void }) {
  const [text, setText] = useState('');
  const { strategy, link, internet } = useNetworkStrategy();
  const battery = useDevice((s) => s.battery.percent ?? 50);
  const simSpeed = useSession((s) => s.settings.simSpeed);
  const sos = useSafety((s) => s.phase);
  const press = (p: ButtonPattern) => getMock()?.pressButton(p);
  const stickUp = link === 'connected';

  return (
    <div className={cx('flex h-full min-h-0 flex-col', variant === 'column' && 'glass w-[360px] shrink-0 rounded-[34px]')}>
      <header className="flex items-start justify-between gap-3 px-5 pb-3 pt-5">
        <div>
          <h2 className="text-[19px] font-semibold tracking-[-0.01em] text-ink">Demo controls</h2>
          <p className="mt-0.5 text-[13px] leading-snug text-ink-3">Plays the stick hardware, the network and the other phone.</p>
        </div>
        {onClose && (
          <button type="button" aria-label="Close demo controls" onClick={onClose} className="glass grid h-10 w-10 shrink-0 place-items-center rounded-full">
            <X size={18} />
          </button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 no-scrollbar">
        <Section title="Stick button" hint={stickUp ? 'Exactly what the physical button sends.' : 'Connect the stick first.'}>
          <div className="grid grid-cols-2 gap-2">
            <GlassButton size="sm" disabled={!stickUp} onClick={() => press('single')}>Press once</GlassButton>
            <GlassButton size="sm" disabled={!stickUp} onClick={() => press('double')}>Press twice</GlassButton>
            <GlassButton size="sm" disabled={!stickUp} onClick={() => press('triple')}>Press 3 times</GlassButton>
            <GlassButton size="sm" variant="sos" disabled={!stickUp} onClick={() => press('hold')}>
              <Hand size={15} /> Hold 3 s
            </GlassButton>
          </div>
        </Section>

        <Section title="Say to the assistant" hint="Opens the mic and speaks the phrase.">
          <div className="flex flex-wrap gap-2">
            {PHRASES.map((p) => (
              <button key={p} type="button" onClick={() => void simulateSpeech(p)} className={cx('glass', chip, 'text-ink-2')}>
                {p}
              </button>
            ))}
          </div>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim()) return;
              void simulateSpeech(text.trim());
              setText('');
            }}
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type anything, in any language"
              aria-label="Type something to say to the assistant"
              className="h-11 min-w-0 flex-1 rounded-full border border-line bg-surface/70 px-4 text-[15px] text-ink outline-none placeholder:text-ink-3 focus:border-teal"
            />
            <GlassButton type="submit" variant="teal" size="sm" className="h-11 w-11 !px-0" aria-label="Say it">
              <Send size={16} />
            </GlassButton>
          </form>
        </Section>

        <Section title="Sensors">
          <div className="grid grid-cols-2 gap-2">
            <GlassButton size="sm" disabled={!stickUp} onClick={() => getMock()?.forceObstacle()}>
              <Footprints size={15} /> Obstacle
            </GlassButton>
            <GlassButton size="sm" disabled={!stickUp} onClick={() => getMock()?.simulateFall()}>
              <PersonStanding size={15} /> Fall
            </GlassButton>
            <GlassButton
              size="sm"
              onClick={() => {
                getMock()?.setCharging(false);
                getMock()?.setBattery(Math.min(battery, 21) - 3);
                resetPipeline(); // demo shortcut: behave like a swapped battery so the estimate jumps now
              }}
            >
              <BatteryLow size={15} /> Low battery
            </GlassButton>
            <GlassButton size="sm" onClick={() => getMock()?.setCharging(true)}>
              <BatteryCharging size={15} /> Plug in charger
            </GlassButton>
          </div>
        </Section>

        <Section title="Connection">
          <div className="mb-3">
            <NetworkBadge strategy={strategy} />
          </div>
          <div className="space-y-2.5">
            <label className="flex items-center justify-between gap-3 text-[15px] font-medium text-ink">
              Stick linked to phone
              <Toggle label="Stick linked to phone" on={stickUp} onChange={(v) => setStickLinked(v)} />
            </label>
            <label className="flex items-center justify-between gap-3 text-[15px] font-medium text-ink">
              Phone internet
              <Toggle label="Phone internet" on={internet !== false} onChange={(v) => setInternet(v)} />
            </label>
          </div>
        </Section>

        <Section title="Guardian's phone">
          <div className="grid grid-cols-2 gap-2">
            <GlassButton
              size="sm"
              onClick={() => {
                useUI.setState({ guardianTab: 'vision' });
                void requestSnapshot('snapshot');
              }}
            >
              <Eye size={15} /> View camera
            </GlassButton>
            <GlassButton size="sm" onClick={() => sendGuardianMessage("I'm coming to pick you up at 5.")}>
              <MessageCircle size={15} /> Send message
            </GlassButton>
            {sos === 'active' && (
              <GlassButton size="sm" className="col-span-2" onClick={guardianAcknowledge}>
                <ShieldCheck size={15} /> Acknowledge SOS
              </GlassButton>
            )}
          </div>
        </Section>

        <Section title="Walking speed" hint="Speeds up navigation and battery drain for the demo.">
          <Segmented
            label="Simulation speed"
            size="sm"
            value={simSpeed}
            onChange={(v) => useSession.getState().updateSettings({ simSpeed: v })}
            options={[
              { value: 1, label: 'Real' },
              { value: 6, label: '6×' },
              { value: 15, label: '15×' },
            ]}
          />
        </Section>

        <Section title="Demo">
          <div className="grid grid-cols-2 gap-2">
            <GlassButton
              size="sm"
              onClick={() => {
                setStickLinked(false);
                useSession.setState({ guardianOnboarded: false, userOnboarded: false, linked: false });
                useUI.setState({ guardianTab: 'home', demoOpen: false });
              }}
            >
              <TriangleAlert size={15} /> Show setup
            </GlassButton>
            <GlassButton size="sm" onClick={() => window.location.reload()}>
              <RotateCcw size={15} /> Reset all
            </GlassButton>
            <GlassButton size="sm" className="col-span-2" onClick={() => switchMode('real')}>
              Leave demo (real mode)
            </GlassButton>
          </div>
        </Section>
      </div>
    </div>
  );
}
