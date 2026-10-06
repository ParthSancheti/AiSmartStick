import { ChevronRight, Map, Mic, Navigation, Square } from 'lucide-react';
import { useNavView } from '../../../core/navigation/navView';
import { useWalking } from '../../../core/walking/walkTracker';
import { useAssistant } from '../../../core/store/assistant';
import { useDevice } from '../../../core/store/device';
import { useUI } from '../../../core/store/ui';
import { startListening, cancelListening } from '../../../core/ai/assistant';
import { AiOrb, orbPhaseFor } from '../../../components/AiOrb';
import { km, mins } from '../../shared/labels';
import { meters } from '../../../core/util';

const CARD = 'glass relative flex h-full min-h-[260px] flex-col overflow-hidden rounded-[36px] border border-glass-border p-5 shadow-2xl';

/** Walking: the active route at a glance, or "Where to?" into the map. */
export function WalkCard() {
  const nav = useNavView();
  const today = useWalking((s) => s.today);
  const open = () => useUI.setState({ mapOpen: true });
  return (
    <button type="button" onClick={open} className={`${CARD} interactive text-left`} aria-label={nav.active && nav.destination ? `Walking to ${nav.destination.name}. Open map.` : 'Where to? Open the map.'}>
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-info/10 to-teal/5" />
      <svg data-parallax="36" viewBox="0 0 200 120" className="pointer-events-none absolute -right-6 top-6 h-36 w-56 text-teal/40" aria-hidden>
        <path d="M10 110 C 40 60, 90 100, 110 60 S 170 20, 190 12" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeDasharray="1 12" />
        <circle cx="190" cy="12" r="7" fill="currentColor" />
      </svg>
      <span className="relative grid h-12 w-12 place-items-center rounded-full bg-teal/15 text-teal">{nav.active ? <Navigation size={24} /> : <Map size={24} />}</span>
      <p className="relative mt-auto text-[13px] font-bold uppercase tracking-wider text-ink-2">{nav.active ? (nav.arrived ? 'Arrived' : nav.offRoute ? 'Off route · rerouting' : 'Walking to') : 'Where to?'}</p>
      <p className="relative mt-1 line-clamp-2 text-[24px] font-extrabold leading-tight text-ink">{nav.active ? (nav.destination?.name ?? 'Destination') : 'Search a place or ask the assistant'}</p>
      <p className="relative mt-2 flex items-center gap-1 text-[14px] font-semibold text-ink-3">
        {nav.active ? (
          <>
            {nav.remainingM != null ? `${meters(nav.remainingM)} left` : 'Calculating…'}
            {nav.etaSec != null ? ` · ${Math.max(1, Math.round(nav.etaSec / 60))} min` : ''}
            {nav.next?.text ? ` · ${nav.next.text}` : ''}
          </>
        ) : (
          <>
            Today: {today.distanceM > 0 ? `${km(today.distanceM)}${today.durationS > 0 ? ` in ${mins(today.durationS)}` : ''}` : 'no walk yet'} <ChevronRight size={16} />
          </>
        )}
      </p>
    </button>
  );
}

/** Assistant: tap to talk (same as one stick press), with the last thing it said. */
export function AssistantCard() {
  const phase = useAssistant((s) => s.phase);
  const reply = useAssistant((s) => s.reply);
  const heard = useAssistant((s) => s.heard);
  const unavailable = useAssistant((s) => s.unavailable);
  const internet = useDevice((s) => s.internet);
  const busy = phase !== 'idle' && phase !== 'error';
  const status = phase === 'listening' ? 'Listening…' : phase === 'thinking' ? 'Thinking…' : phase === 'speaking' ? 'Speaking' : phase === 'error' ? (unavailable ?? 'Unavailable') : internet === false ? 'Offline' : 'Ready';
  return (
    <div className={CARD}>
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-teal/10 to-info/5" />
      <div data-parallax="22" className="pointer-events-none absolute -right-10 -top-10 opacity-80" aria-hidden>
        <AiOrb phase={orbPhaseFor({ assistant: phase, sosActive: false, internet, navigating: false, unavailable })} size={120} />
      </div>
      <p className="relative text-[13px] font-bold uppercase tracking-wider text-ink-2">AI Assistant</p>
      <p className="relative mt-1 max-w-[65%] text-[22px] font-extrabold text-ink" aria-live="polite">{status}</p>
      <p className="relative mt-3 line-clamp-3 text-[14.5px] leading-snug text-ink-2">{heard && busy ? `“${heard}”` : reply || 'Press the stick button or tap Talk. Try “Take me to the nearest pharmacy”.'}</p>
      <button
        type="button"
        onClick={() => (busy ? cancelListening() : startListening())}
        className={`interactive relative mt-auto flex h-14 items-center justify-center gap-2 rounded-[20px] text-[17px] font-bold ${busy ? 'bg-ink/10 text-ink' : 'bg-teal text-on-teal'}`}
      >
        {busy ? <Square size={18} /> : <Mic size={20} />} {busy ? 'Stop' : 'Talk'}
      </button>
    </div>
  );
}
