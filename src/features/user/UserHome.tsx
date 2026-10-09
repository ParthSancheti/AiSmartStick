import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BatteryFull, BatteryLow, BatteryCharging, Settings, Smartphone, Unlink, Moon, Sun, Footprints, MessageSquare, Map, ChevronRight, Activity, ShieldAlert, Heart, Flame, Phone, Zap, LogOut, Wand2, Link2, Headphones, Mic, StopCircle, Send, Plus, Bluetooth, Speaker, X, Camera } from 'lucide-react';

import { useVoiceAssistant } from '../../hooks/useVoiceAssistant';
import { useDevice, batteryHours, isLinked } from '../../core/store/device';
import { useSession } from '../../core/store/session';
import { useUI } from '../../core/store/ui';
import { useAssistant } from '../../core/store/assistant';
import { handleButton } from '../../core/device/bridge';
import { announce } from '../../core/ai/voiceOut';
import { P } from '../../core/ai/phrases';
import { submitUtterance } from '../../core/ai/assistant';
import { listConversations, loadMessages, type ConversationSummary } from '../../core/ai/history';
import { useNow } from '../../hooks/useNow';
import { useActivity } from '../../core/store/activity';
import { EventRow } from '../guardian/parts';
import { StickVisual } from '../../components/StickVisual';
import { LiveVisionPanel } from '../../components/LiveVisionPanel';
import { CameraView } from './CameraView';
import { LocationStatus } from '../../components/LocationStatus';
import { useBackHandler } from '../../core/backStack';
import { toggleThemeWithTransition } from '../../util/theme';
import { HomeCarousel } from './home/HomeCarousel';
import { WalkCard, AssistantCard, HOME_CARD } from './home/HomeCards';
import { AppScreen, SafeAreaContent, SubPage, SubPageView, BackButton } from '../../components/Layout';
import { AiOrb, orbPhaseFor } from '../../components/AiOrb';
import { useSafety } from '../../core/store/safety';
import { AccountAvatar } from '../../components/Avatar';
import { ModeBadge } from '../../components/ModeBadge';
import { MapView } from '../../components/MapView';
import { ObstacleView } from '../../components/ObstacleView';
import { BrandLogo } from '../../core/brand/BrandLogo';
import { BRAND } from '../../core/brand/brand';
import { startSos, safetyContact } from '../../core/safety/sos';
import { AudioSubpage } from './AudioSubpage';
import { useRuntime } from '../../core/runtime/mode';
import { firebaseConfigured } from '../../core/runtime/env';
import { signOut } from '../../core/auth/authService';
import { useAuth } from '../../core/auth/authStore';
import { useSafetyEval } from '../../core/safety/safetyRuntime';
import { useNavView } from '../../core/navigation/navView';
import { useLocation, freshnessLabel, locationProblem } from '../../core/location/locationService';
import { useProfileName, firstName } from '../../core/profile/profile';
import { useWalking } from '../../core/walking/walkTracker';
import type { Suggestion } from '../../core/maps/mapsService';
import { useDestinationSearch } from '../../core/maps/useDestinationSearch';
import { searchErrorText, type DestinationSuggestion } from '../../core/maps/destinationSearch';
import { OSM_ATTRIBUTION, isOsmPlaceId } from '../../core/maps/osmFallback';
import { activeRouteProvider, navigateTo, pendingDestination, stopRealNavigation } from '../../core/navigation/realNavigator';
import { startNavigation as startDemoNavigation, stopNavigation as stopDemoNavigation } from '../../core/nav/navigation';
import { PLACES } from '../../core/sim/geo';
import { usePhoneInfo, phoneLabel } from '../../core/native/deviceInfo';
import { useBatteryHistory } from '../../core/telemetry/batteryHistory';
import { useAudioRoute } from '../../core/audio/audioRoute';
import { linkLabel, batteryLabel, safetyLabel, TONE_TEXT, km, mins, type Tone } from '../shared/labels';
import { meters, timeAgo } from '../../core/util';
import { friendlyError } from '../../core/errors';
import { DiagnosticsRows } from './Diagnostics';

/*
 * Home and its sub-pages.
 *
 * Layout: the Home header is fixed (outside the one scroll container); every sub-page is a
 * SubPage (components/Layout.tsx) with a fixed header and one scroll container. Sub-pages that
 * show the shared animated background are transparent and Home hides itself underneath them, so
 * only ONE ambient background is ever animated and the content behind is out of TalkBack.
 *
 * Performance (Android WebView): every live-data subscription lives in the smallest component
 * that shows it, with primitive selectors, so a telemetry packet re-renders a few small nodes,
 * not the whole Home; sub-page content mounts only while the page is open.
 */

const openSetup = () => useUI.setState({ stickSetup: true });

/* ───────────────────────────── Header + profile menu ───────────────────────────── */

function ProfileMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const theme = useSession((s) => s.settings.theme);
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const link = useDevice((s) => s.link);
  const mode = useRuntime((s) => s.mode);
  const user = useAuth((s) => s.user);
  const profileName = useProfileName();
  const l = linkLabel(link);
  const item = 'flex min-h-12 w-full items-center gap-3 rounded-[18px] px-4 py-3 text-left text-[15px] font-semibold text-ink active:bg-ink/[0.06]';

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} onClick={onClose} className="fixed inset-0 z-[100] bg-black/10" aria-hidden="true" />
          <motion.div
            role="menu"
            aria-label="Profile menu"
            initial={{ opacity: 0, transform: 'translate3d(0,-8px,0) scale(0.96)' }}
            animate={{ opacity: 1, transform: 'translate3d(0,0,0) scale(1)' }}
            exit={{ opacity: 0, transform: 'translate3d(0,-8px,0) scale(0.96)' }}
            transition={{ duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }}
            className="absolute right-5 top-full z-[101] bg-surface ring-1 ring-line mt-2 flex w-[min(17rem,calc(100vw-40px))] origin-top-right flex-col gap-0.5 rounded-[26px] p-2 shadow-2xl"
          >
            {(user || profileName) && (
              <div className="min-w-0 px-4 pb-2 pt-2">
                <p className="truncate text-[15px] font-bold text-ink">{profileName || user?.displayName || 'Signed in'}</p>
                <p className="truncate text-[13px] text-ink-3">{mode === 'demo' ? 'Demo mode · simulated data' : (user?.email ?? '')}</p>
              </div>
            )}
            <button type="button" role="menuitem" className={item} onClick={() => { onClose(); useUI.setState({ userSettings: true }); }}>
              <Settings size={18} /> Settings
            </button>
            <button type="button" role="menuitem" className={item} onClick={(e) => toggleThemeWithTransition(e)}>
              {isDark ? <Sun size={18} /> : <Moon size={18} />} {isDark ? 'Light theme' : 'Dark theme'}
            </button>
            <button type="button" role="menuitem" className={item} onClick={() => { onClose(); if (link === 'unpaired' || link === 'auth_failed') openSetup(); else useUI.setState({ stickPage: true }); }}>
              {link === 'connected' ? <Link2 size={18} /> : <Unlink size={18} />} <span className="min-w-0 truncate">{link === 'unpaired' ? 'Set up stick' : `Stick ${l.text.replace('…', '')}`}</span>
            </button>
            <button type="button" role="menuitem" className={item} onClick={() => { onClose(); useUI.setState({ pocket: true }); announce(P.pocketOn); }}>
              <Smartphone size={18} /> Pocket mode
            </button>
            {mode === 'real' && (
              <>
                <div className="mx-2 my-1 h-px bg-line" />
                <button type="button" role="menuitem" className={`${item} !text-sos`} onClick={() => { onClose(); void signOut(); }}>
                  <LogOut size={18} /> Log out
                </button>
              </>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

/** Fixed Home header: round logo, name, demo badge, profile. Never scrolls. */
function HomeHeader({ headerRef }: { headerRef: React.Ref<HTMLElement> }) {
  const [menuOpen, setMenuOpen] = useState(false);
  useBackHandler(menuOpen, () => setMenuOpen(false));
  return (
    <header ref={headerRef} className="page-header relative z-30 shrink-0 px-5 pb-3" style={{ paddingTop: 'calc(var(--island, var(--sat)) + 10px)' }}>
      <div className="home-header-bar glass flex h-16 items-center gap-3 rounded-full pl-2.5 pr-2 shadow-[0_10px_30px_-14px_rgba(0,0,0,.25)]">
        <BrandLogo variant="round" size={44} />
        <span className="home-brand-name min-w-0 flex-1 truncate text-[17px] font-bold tracking-tight text-ink">{BRAND.name}</span>
        <span className="home-brand-spacer hidden flex-1" aria-hidden />
        <ModeBadge className="home-mode-badge shrink-0" />
        <button type="button" className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-full active:scale-95" aria-label="Open profile menu" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
          <AccountAvatar size={44} />
        </button>
      </div>
      <ProfileMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
    </header>
  );
}

/* ───────────────────────────── Home cards ───────────────────────────── */

const tileCls = 'stat-tile flex min-h-[48px] w-full min-w-0 items-center gap-2 rounded-[18px] bg-surface/55 px-3 py-1.5 text-left ring-1 ring-line';

function StatTile({ icon, label, value, tone, onClick, ariaLabel }: { icon: ReactNode; label: string; value: string; tone: Tone | 'ink'; onClick?: () => void; ariaLabel: string }) {
  const color = tone === 'ink' ? 'text-ink' : TONE_TEXT[tone];
  const inner = (
    <>
      <span className={`stat-tile-icon grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink/[0.06] ${color}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px] font-bold uppercase tracking-wider text-ink-3">{label}</span>
        <span className={`block text-[14px] font-bold leading-tight ${color} line-clamp-2 break-words`}>{value}</span>
      </span>
    </>
  );
  if (!onClick)
    return (
      <div className={tileCls} aria-label={ariaLabel} role="group">
        {inner}
      </div>
    );
  return (
    <button type="button" onClick={onClick} aria-label={ariaLabel} className={`${tileCls} interactive active:scale-[0.98]`}>
      {inner}
    </button>
  );
}

/** Stick card: the stick, link, battery and phone. Own primitive selectors: re-renders only when a shown value changes. */
const StickCard = memo(function StickCard() {
  const linkState = useDevice((s) => s.link);
  const bStatus = useDevice((s) => s.battery.status);
  const bPercent = useDevice((s) => s.battery.percent);
  const bCharging = useDevice((s) => s.battery.charging);
  const mode = useRuntime((s) => s.mode);
  const phone = usePhoneInfo();
  const link = linkLabel(linkState);
  const bat = batteryLabel({ status: bStatus, percent: bPercent, charging: bCharging });
  const phoneName = mode === 'demo' ? 'Demo phone' : phoneLabel(phone);
  const stickAction = () => (linkState === 'unpaired' || linkState === 'auth_failed' ? openSetup() : useUI.setState({ stickPage: true }));
  const BatIcon = bCharging ? BatteryCharging : bPercent != null && bPercent <= 20 ? BatteryLow : BatteryFull;
  return (
    <div className={`${HOME_CARD} stick-card flex-row items-stretch gap-3`}>
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-teal/5 to-info/10" />
      <button type="button" onClick={stickAction} aria-label="Stick diagnostics" className="stick-card-visual relative flex w-[38%] min-w-[88px] max-w-[160px] shrink-0 flex-col items-center justify-center rounded-[24px] active:scale-[0.98]">
        <StickVisual height={210} />
        <span className="mt-1 max-w-full truncate text-[12px] font-bold uppercase tracking-[0.1em] text-ink-2">Stick</span>
      </button>
      <div className="relative flex min-w-0 flex-1 flex-col justify-center gap-2">
        <StatTile
          icon={linkState === 'connected' ? <Link2 size={18} /> : <Unlink size={18} />}
          label="Stick"
          value={link.text}
          tone={link.tone}
          onClick={stickAction}
          ariaLabel={`Stick: ${link.text}`}
        />
        <StatTile icon={<BatIcon size={18} />} label="Battery" value={bat.text} tone={bat.tone} onClick={() => useUI.setState({ batteryPage: true })} ariaLabel={`Stick battery ${bat.text}, ${bat.sub}`} />
        <StatTile icon={<Smartphone size={18} />} label="Phone" value={phoneName} tone="ink" ariaLabel={`Phone: ${phoneName}`} />
      </div>
    </div>
  );
});

function ActionRow({ icon, iconTone, label, value, valueTone = 'text-ink', onClick }: { icon: ReactNode; iconTone: string; label: string; value: ReactNode; valueTone?: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="action-row glass interactive flex min-h-[84px] w-full min-w-0 items-center gap-4 rounded-[26px] px-5 py-4 text-left">
      <span className={`action-row-icon grid h-12 w-12 shrink-0 place-items-center rounded-full ${iconTone}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-[12px] font-bold uppercase tracking-wider text-ink-3">{label}</span>
        <span className={`mt-0.5 block text-[15.5px] font-bold leading-snug ${valueTone} break-words`}>{value}</span>
      </span>
      <ChevronRight size={20} className="shrink-0 text-ink-3" aria-hidden />
    </button>
  );
}

const QuickActions = memo(function QuickActions({ onSafety, onChat }: { onSafety: () => void; onChat: () => void }) {
  const safety = useSafetyEval((s) => s.state);
  const internet = useDevice((s) => s.internet);
  const aiUnavailable = useAssistant((s) => s.unavailable);
  const mode = useRuntime((s) => s.mode);
  const route = useAudioRoute();
  const walking = useWalking((s) => s.today);
  const safe = safetyLabel(safety);
  const aiState: { text: string; tone: Tone | 'ink' } =
    mode === 'demo' ? { text: 'Ready', tone: 'ink' } : internet === false ? { text: 'Offline', tone: 'muted' } : !firebaseConfigured() ? { text: 'Not set up', tone: 'muted' } : aiUnavailable ? { text: 'Retry', tone: 'warn' } : { text: 'Ready', tone: 'ink' };
  const square = 'glass interactive flex min-h-[124px] min-w-0 flex-col items-center justify-center gap-2 rounded-[26px] px-3 py-4 text-center';
  return (
    <div className="mb-5 grid grid-cols-2 gap-3">
      <button type="button" onClick={onSafety} className={square}>
        <span className="grid h-12 w-12 place-items-center rounded-full bg-info/10 text-info"><ShieldAlert size={26} /></span>
        <span className="max-w-full">
          <span className="block break-words text-[12px] font-bold uppercase tracking-wider text-ink-3">Safety</span>
          <span className={`mt-0.5 block break-words text-[15px] font-bold ${TONE_TEXT[safe.tone]}`}>{safe.text}</span>
        </span>
      </button>
      <button type="button" onClick={() => useUI.setState({ liveAiOpen: true })} className={square}>
        <span className="grid h-12 w-12 place-items-center rounded-full bg-teal/10 text-teal"><Wand2 size={26} /></span>
        <span className="max-w-full">
          <span className="block break-words text-[12px] font-bold uppercase tracking-wider text-ink-3">Assistant</span>
          <span className={`mt-0.5 block break-words text-[15px] font-bold ${aiState.tone === 'ink' ? 'text-ink' : TONE_TEXT[aiState.tone]}`}>{aiState.text}</span>
        </span>
      </button>
      <div className="col-span-2 mt-1 flex flex-col gap-4">
        <ActionRow
          onClick={() => useUI.setState({ audioOpen: true })}
          icon={route.route === 'bluetooth' ? <Bluetooth size={24} /> : route.route === 'speaker' ? <Speaker size={24} /> : <Headphones size={24} />}
          iconTone="bg-info/10 text-info"
          label="Audio output"
          value={route.route === 'bluetooth' ? (route.name ?? 'Bluetooth') : route.route === 'wired' ? 'Wired headphones' : route.route === 'speaker' ? 'Phone speaker' : 'System default'}
          valueTone={route.route === 'unknown' ? 'text-ink-3' : 'text-ink'}
        />
        <ActionRow
          onClick={() => useUI.setState({ healthOpen: true })}
          icon={<Footprints size={24} />}
          iconTone="bg-teal/10 text-teal"
          label="Distance walked today"
          value={
            <>
              {walking.distanceM > 0 ? km(walking.distanceM) : 'No walk yet'}
              {walking.durationS > 0 && <span className="ml-1 text-[13px] font-medium text-ink-3">({mins(walking.durationS)})</span>}
            </>
          }
        />
        <ActionRow onClick={onChat} icon={<MessageSquare size={24} />} iconTone="bg-info/10 text-info" label="Assistant chat" value="Type or review conversations" />
      </div>
    </div>
  );
});

function BottomControls() {
  return (
    <div className="mt-auto flex shrink-0 flex-col pt-2">
      <div className="glass flex flex-col gap-2 rounded-[30px] p-2">
        <button
          type="button"
          className="flex h-[68px] w-full min-w-0 items-center justify-center gap-3 rounded-[24px] bg-sos px-4 text-[19px] font-bold text-white shadow-[0_10px_24px_-10px_var(--sos)] transition-transform active:scale-[0.98]"
          onClick={(e) => {
            e.stopPropagation();
            startSos('button');
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          aria-label="Trigger Emergency SOS"
        >
          <Phone size={26} className="shrink-0" /> <span className="truncate">Emergency SOS</span>
        </button>
        <div className="flex h-[60px] items-center rounded-[24px] bg-ink/5">
          <button type="button" className="flex h-full min-w-0 flex-1 items-center justify-center gap-2.5 rounded-[24px] text-[16px] font-bold text-ink active:bg-ink/10" onClick={() => useUI.setState({ pocket: true })}>
            <Smartphone size={20} className="shrink-0 text-ink-2" /> <span className="truncate">Pocket</span>
          </button>
          <div className="h-8 w-px shrink-0 bg-ink/10" />
          <button type="button" className="flex h-full min-w-0 flex-1 items-center justify-center gap-2.5 rounded-[24px] text-[16px] font-bold text-ink active:bg-ink/10" onClick={() => useUI.setState({ mapOpen: true })}>
            <Map size={20} className="shrink-0 text-ink-2" /> <span className="truncate">Map</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────── AI chat ───────────────────────────── */

function AiChatSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <AnimatePresence>{open && <AiChatPage key="chat" onClose={onClose} />}</AnimatePresence>;
}

function AiChatPage({ onClose }: { onClose: () => void }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const userName = firstName(useProfileName());
  const thread = useAssistant((s) => s.thread);
  const phase = useAssistant((s) => s.phase);
  const [text, setText] = useState('');
  const [convs, setConvs] = useState<ConversationSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!historyOpen) return;
    setConvs(null);
    setErr(null);
    listConversations()
      .then(setConvs)
      .catch(() => setErr('History is unavailable right now.'));
  }, [historyOpen]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [thread.length, phase]);

  const send = () => {
    const t = text.trim();
    if (!t || phase === 'thinking') return;
    setText('');
    void submitUtterance(t, 'typed');
  };

  const openConversation = async (c: ConversationSummary) => {
    const msgs = await loadMessages(c.id).catch(() => []);
    useAssistant.setState({ conversationId: c.id, thread: msgs.map((m) => ({ id: m.id, role: m.role === 'model' ? 'assistant' : 'user', text: m.text, ts: m.ts })) });
    setHistoryOpen(false);
  };

  if (historyOpen)
    return (
      <SubPageView key="history" onClose={() => setHistoryOpen(false)} title="History" background="none" z={50}>
        <button
          type="button"
          className="glass interactive flex h-12 items-center gap-2 self-start rounded-full px-5 text-[15px] font-semibold text-ink"
          onClick={() => {
            useAssistant.setState({ conversationId: null, thread: [] });
            setHistoryOpen(false);
          }}
        >
          <Plus size={20} /> New chat
        </button>
        <section>
          <h2 className="mb-2 px-1 text-[13px] font-bold uppercase tracking-wider text-ink-3">Recent</h2>
          <div className="glass overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line">
            {err && <p className="px-4 py-5 text-[15px] text-ink-3">{err}</p>}
            {!err && convs === null && <p className="px-4 py-5 text-[15px] text-ink-3">Loading…</p>}
            {convs?.length === 0 && <p className="px-4 py-5 text-[15px] text-ink-3">No conversations yet.</p>}
            {convs?.map((c) => (
              <button key={c.id} type="button" onClick={() => void openConversation(c)} className="flex min-h-[56px] w-full min-w-0 items-center gap-3 px-4 py-3 text-left text-ink-2 active:bg-ink/5">
                <MessageSquare size={20} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-[16px] font-medium text-ink">{c.title}</span>
                <span className="shrink-0 text-[12px] text-ink-3">{timeAgo(c.updatedAt, Date.now())}</span>
              </button>
            ))}
          </div>
        </section>
      </SubPageView>
    );

  return (
    <SubPageView
      key="chat"
      onClose={onClose}
      title="Assistant"
      background="none"
      z={50}
      trailing={
        <button type="button" onClick={() => setHistoryOpen(true)} aria-label="Conversation history" className="glass interactive grid h-12 w-12 place-items-center rounded-full text-ink">
          <MessageSquare size={20} />
        </button>
      }
      contentClassName="flex min-h-full flex-col gap-3 px-4 pt-2"
      footer={
        <form
          className="glass flex h-16 w-full items-center gap-1.5 rounded-full p-2"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <button type="button" aria-label="Speak instead" onClick={() => handleButton('single')} className="grid h-12 w-12 shrink-0 place-items-center rounded-full text-ink active:bg-ink/5">
            <Mic size={22} />
          </button>
          <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Ask ${BRAND.name}…`} aria-label="Message to the assistant" className="min-w-0 flex-1 bg-transparent px-1 text-[16px] font-medium text-ink outline-none placeholder:text-ink-3" />
          <button type="submit" disabled={!text.trim() || phase === 'thinking'} className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-teal text-on-teal disabled:opacity-40" aria-label="Send">
            <Send size={20} />
          </button>
        </form>
      }
    >
      {thread.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center py-16 text-center">
          <div className="mb-5 text-info">
            <Wand2 size={56} />
          </div>
          <h2 className="break-words text-[30px] font-bold leading-tight text-ink">
            {userName ? (
              <>
                Hi {userName},<br />what can I do?
              </>
            ) : (
              'What can I do for you?'
            )}
          </h2>
          <p className="mt-3 max-w-[18rem] text-[15px] text-ink-3">Type below, tap the mic, or press the stick button.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 pb-2" aria-live="polite">
          {thread.map((m) => (
            <div
              key={m.id}
              className={`max-w-[85%] break-words rounded-[22px] px-4 py-3 text-[16px] leading-snug ${m.role === 'user' ? 'self-end bg-teal text-on-teal' : m.role === 'system' ? 'self-center bg-amber-soft text-[14px] text-amber-ink' : 'glass self-start text-ink'}`}
            >
              {m.text}
            </div>
          ))}
          {phase === 'thinking' && <div className="glass self-start rounded-[22px] px-4 py-3 text-[15px] text-ink-3">Thinking…</div>}
        </div>
      )}
      <div ref={end} />
    </SubPageView>
  );
}

/* ───────────────────────────── Map / walking ───────────────────────────── */

function DestinationSearch() {
  const demo = useRuntime((s) => s.mode) === 'demo';
  // Real mode: debounced, works without GPS; Cloud Function and in-app Google Places race, OpenStreetMap last.
  const search = useDestinationSearch({ enabled: !demo });
  const q = search.query;
  const [demoItems, setDemoItems] = useState<Suggestion[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const items: Suggestion[] = demo ? demoItems : search.items;
  // Back closes the search first (core/backStack.ts).
  useBackHandler(q.length > 0 || items.length > 0, () => {
    search.clear();
    setDemoItems([]);
    setErr(null);
  });

  useEffect(() => {
    setErr(null);
    if (!demo) return;
    const text = q.trim();
    setDemoItems(text.length < 2 ? [] : PLACES.filter((p) => p.category !== 'home' && p.name.toLowerCase().includes(text.toLowerCase())).map((p) => ({ placeId: p.id, main: p.name, secondary: 'Demo place' })));
  }, [q, demo]);

  const pick = async (s: Suggestion) => {
    setBusy(true);
    setErr(null);
    try {
      if (demo) {
        const p = PLACES.find((x) => x.id === s.placeId);
        if (p) startDemoNavigation(p);
      } else {
        const place = await search.pick(s as DestinationSuggestion);
        if (!place) return; // search.error says why
        // Live fix → directions now; otherwise the destination is set and directions start by themselves once GPS has a position.
        await navigateTo(place);
      }
      search.clear();
      setDemoItems([]);
    } catch (e) {
      const m = (e as Error).message;
      setErr(m === 'no-route' ? 'No walking route found.' : `Could not start directions. ${searchErrorText(e).replace(/^Search unavailable\. /, '')}`);
    } finally {
      setBusy(false);
    }
  };

  const shownErr = err ?? (demo ? null : search.error);
  return (
    <div className="mt-4">
      <input
        value={q}
        onChange={(e) => search.setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Enter (keyboard "Search" key) goes to the top suggestion.
          if (e.key === 'Enter' && items.length && !busy && !search.busy) {
            e.preventDefault();
            void pick(items[0]);
          }
        }}
        placeholder="Search a destination"
        aria-label="Search a destination"
        enterKeyHint="search"
        className="h-12 w-full min-w-0 rounded-full border border-line bg-surface px-5 text-[16px] font-medium text-ink outline-none placeholder:text-ink-3"
      />
      {!demo && search.searching && !items.length && <p className="mt-2 px-2 text-[13.5px] font-semibold text-ink-3" role="status">{search.slow ? 'Still searching… the server is slow to start.' : 'Searching…'}</p>}
      {shownErr && <p className="mt-2 px-2 text-[13.5px] font-semibold text-amber-ink" role="status">{shownErr}</p>}
      {items.length > 0 && (
        <ul className="page-scroll mt-2 max-h-48 rounded-[20px] border border-line bg-surface" role="listbox" aria-label="Suggestions">
          {items.map((it) => (
            <li key={it.placeId}>
              <button type="button" disabled={busy || search.busy} onClick={() => void pick(it)} className="min-h-12 w-full px-4 py-3 text-left disabled:opacity-50">
                <span className="block break-words text-[15.5px] font-semibold text-ink">{it.main}</span>
                {it.secondary && <span className="block break-words text-[13px] text-ink-3">{it.secondary}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* Required attribution when the places come from OpenStreetMap (Google search failed). */}
      {!demo && items.length > 0 && search.source === 'osm' && <p className="mt-1 px-2 text-[11px] text-ink-3">{OSM_ATTRIBUTION}</p>}
    </div>
  );
}

function WalkingSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="map"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="absolute inset-0 z-[80] flex flex-col overflow-hidden bg-map-bg"
          role="dialog"
          aria-modal="true"
          aria-label="Map"
        >
          <WalkingPage onClose={onClose} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function WalkingPage({ onClose }: { onClose: () => void }) {
  const nav = useNavView();
  const fix = useLocation((s) => s.fix);
  const locStatus = useLocation((s) => s.status);
  const locProblem = useLocation((s) => locationProblem(s)?.kind ?? null);
  const demo = useRuntime((s) => s.mode) === 'demo';
  const now = useNow(1000);
  const fresh = freshnessLabel(fix?.ts, now);
  const live = fresh === 'Live';

  return (
    <>
      {/* Map layer: Google Maps in real mode, the simulated street grid in demo mode */}
      <div className="absolute inset-0 z-0">
        <MapView
          className="absolute inset-0 h-full w-full"
          position={fix ? { lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM } : null}
          stale={!live}
          path={nav.path}
          destination={nav.destination?.lat != null && nav.destination.lng != null ? { lat: nav.destination.lat, lng: nav.destination.lng } : null}
        />
      </div>

      {/* Fixed top bar */}
      <div className="pointer-events-none relative z-10 shrink-0 px-4" style={{ paddingTop: 'calc(var(--island, var(--sat)) + 10px)' }}>
        <div className="pointer-events-auto flex items-center gap-2 rounded-[28px] bg-surface/95 p-2 shadow-[0_10px_30px_rgba(0,0,0,0.12)] ring-1 ring-line">
          <BackButton onClick={onClose} className="!bg-transparent !shadow-none" />
          <div className="flex min-w-0 flex-1 items-center justify-center gap-2 px-1">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${live ? 'bg-ok' : 'bg-ink-3'}`} />
            <span className="truncate text-[14px] font-bold uppercase tracking-wider text-ink">{demo ? 'Demo walk' : fix ? (live ? 'Live location' : fresh) : locProblem === 'off' ? 'Location off' : locProblem === 'denied' || locProblem === 'prompt' ? 'Location not allowed' : 'Finding location'}</span>
          </div>
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-ink/5 text-ink-3" aria-hidden>
            <Map size={20} />
          </span>
        </div>
      </div>

      <div className="pointer-events-none relative z-10 flex flex-1 flex-col justify-end px-4" style={{ paddingBottom: 'calc(var(--sab) + 16px)' }}>
        {/* Directions card */}
        <div className="pointer-events-auto relative mb-3 overflow-hidden rounded-[30px] bg-surface/95 p-5 shadow-[0_20px_40px_rgba(0,0,0,0.14)] ring-1 ring-line">
          <div className="flex items-start gap-3.5">
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-[20px] bg-info text-white shadow-lg">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: nav.next?.maneuver === 'left' ? 'rotate(180deg)' : nav.next?.maneuver === 'straight' ? 'rotate(-90deg)' : undefined }}>
                <path d="m9 18 6-6-6-6" />
              </svg>
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="break-words text-[22px] font-extrabold leading-tight tracking-tight text-ink">
                {nav.active ? (nav.arrived ? `Arrived near ${nav.destination?.name}` : nav.next?.text ?? `Walking to ${nav.destination?.name}`) : 'No active route'}
              </p>
              <p className="mt-1 break-words text-[14.5px] font-bold text-info">
                {nav.active && nav.remainingM != null ? `${meters(nav.remainingM)} remaining${nav.offRoute ? ' · off route' : ''}${nav.rerouting ? ' · rerouting' : ''}` : 'Ask the assistant: “Take me to the nearest pharmacy”'}
              </p>
              {nav.error && <p className="mt-1 text-[14px] font-semibold text-amber-ink">{nav.error}</p>}
            </div>
          </div>
          {nav.active ? (
            <>
              {/* Destination set, waiting for a usable position: keep the one action that fixes it (e.g. "Use precise"). */}
              {nav.source === 'real' && pendingDestination() && <LocationStatus className="mt-3" wantPrecise />}
              <button type="button" onClick={() => (nav.source === 'demo' ? stopDemoNavigation() : stopRealNavigation('user'))} className="mt-4 h-12 w-full rounded-full bg-ink/5 text-[15px] font-bold text-ink active:bg-ink/10">
                End route
              </button>
              {/* Required attribution for an OpenStreetMap place or route. */}
              {nav.source === 'real' && (activeRouteProvider() === 'osm' || isOsmPlaceId(nav.destination?.placeId)) && <p className="mt-2 text-center text-[11px] text-ink-3">{OSM_ATTRIBUTION}</p>}
            </>
          ) : (
            <>
              <DestinationSearch />
              <LocationStatus className="mt-3" wantPrecise />
            </>
          )}
        </div>

      </div>
    </>
  );
}

/* ───────────────────────────── Stick details ───────────────────────────── */

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 px-4 py-3">
      <span className="shrink-0 text-[15px] text-ink-2">{k}</span>
      <span className="tabular min-w-0 break-words text-right text-[15px] font-semibold text-ink">{v}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="px-1 text-[13px] font-bold uppercase tracking-wider text-ink-3">{title}</h2>
      {children}
    </section>
  );
}

const listCls = 'glass overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line';

function StickDetailsContent() {
  const events = useActivity((s) => s.events);
  const now = useNow(5000);
  const d = useDevice();
  const obstacles = events.filter((e) => e.kind === 'safety' && e.title.startsWith('Obstacle')).slice(0, 5);
  return (
    <>
      <div className="glass rounded-[28px] p-4">
        <p className="mb-3 text-[13px] font-bold uppercase tracking-wider text-ink-3">Obstacle sensor (ahead)</p>
        <ObstacleView us={d.ultrasonic} live={isLinked(d.link)} />
      </div>
      <Section title="Camera & detection">
        <LiveVisionPanel />
        <button type="button" onClick={() => useUI.setState({ cameraOpen: true })} className="min-h-12 rounded-full bg-teal/10 px-4 text-[15px] font-bold text-teal active:scale-[0.98]">
          Open camera full screen
        </button>
      </Section>
      {d.link === 'auth_failed' && (
        <div className="mb-4 rounded-[24px] bg-sos/10 p-4 ring-1 ring-sos/30" role="alert">
          <p className="text-[15px] font-bold text-sos">This stick needs firmware 1.2</p>
          <p className="mt-1 text-[14px] leading-snug text-ink-2">{d.linkDetail ?? 'It still runs the old secure firmware. Flash firmware 1.2 with the Arduino IDE, then set it up again.'}</p>
          <button type="button" onClick={() => openSetup()} className="mt-3 min-h-11 rounded-full bg-sos px-4 text-[14px] font-bold text-white active:scale-[0.98]">
            Set up SmartStick again
          </button>
        </div>
      )}
      <Section title="Sensors">
        <div className={listCls}>
          <KV k="Link" v={`${linkLabel(d.link).text}${d.linkDetail ? ` · ${d.linkDetail}` : ''}`} />
          <KV k="Connection" v={d.link === 'auth_failed' ? 'Needs firmware 1.2' : 'Stick Wi-Fi (SmartStick_AI) · no key needed'} />
          <KV k="Stick" v={d.identity ? `${d.identity.deviceId} · fw ${d.identity.firmware}` : 'Not paired'} />
          <KV k="Battery" v={d.battery.voltage != null ? `${d.battery.voltage.toFixed(2)} V · ${d.battery.currentMa == null ? '— mA' : `${Math.round(d.battery.currentMa)} mA`}` : batteryLabel(d.battery).sub} />
          <KV k="Motion" v={d.imu.status === 'ok' ? `pitch ${d.imu.pitch}° · roll ${d.imu.roll}°${d.imu.calibrated ? '' : ' · not calibrated'}` : d.imu.status} />
          <KV k="Obstacle" v={d.ultrasonic.status === 'ok' ? `${d.ultrasonic.distanceCm} cm` : d.ultrasonic.status.replace('_', ' ')} />
          <KV k="Camera" v={d.camera.status} />
          <KV k="Wi-Fi signal" v={d.rssi == null ? 'Unavailable' : `${d.rssi} dBm`} />
          <KV k="Last packet" v={d.lastPacketAt ? timeAgo(d.lastPacketAt, now) : 'Never'} />
        </div>
      </Section>
      <Section title="Diagnostics">
        <DiagnosticsRows />
      </Section>
      <Section title="Obstacles logged">
        <div className={listCls}>{obstacles.length ? obstacles.map((e) => <EventRow key={e.id} e={e} now={now} />) : <p className="px-4 py-6 text-center text-[15px] text-ink-3">No obstacles under 60 cm recorded.</p>}</div>
      </Section>
      <Section title="Activity log">
        <div className={listCls}>{events.length ? events.slice(0, 10).map((e) => <EventRow key={e.id} e={e} now={now} />) : <p className="px-4 py-6 text-center text-[15px] text-ink-3">Nothing here yet today.</p>}</div>
      </Section>
    </>
  );
}

/* ───────────────────────────── Health ───────────────────────────── */

function Unavailable({ icon, label, reason }: { icon: ReactNode; label: string; reason: string }) {
  return (
    <div className="flex min-h-[64px] items-center gap-3 px-4 py-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ink/5 text-ink-3">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline justify-between gap-x-2">
          <span className="text-[15.5px] font-bold text-ink-2">{label}</span>
          <span className="text-[13px] font-bold uppercase tracking-wide text-ink-3">Unavailable</span>
        </span>
        <span className="mt-0.5 block text-[13px] leading-snug text-ink-3">{reason}</span>
      </span>
    </div>
  );
}

function HealthContent() {
  const today = useWalking((s) => s.today);
  const cur = useWalking((s) => s.current);
  const paused = useWalking((s) => s.paused);
  const source = useWalking((s) => s.source);
  const pace = today.distanceM > 50 && today.durationS > 0 ? (today.distanceM / today.durationS) * 3.6 : null;
  return (
    <>
      <div className="glass rounded-[28px] p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-bold uppercase tracking-wider text-ink-3">Walked today</p>
            <p className="mt-1 break-words text-[34px] font-bold leading-none text-ink">{km(today.distanceM)}</p>
          </div>
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-info/10 text-info"><Activity size={24} /></span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0 rounded-[18px] bg-ink/5 p-3">
            <p className="text-[12.5px] font-bold text-ink-3">Time walking</p>
            <p className="break-words text-[16px] font-bold text-ink">{mins(today.durationS)}</p>
          </div>
          <div className="min-w-0 rounded-[18px] bg-ink/5 p-3">
            <p className="text-[12.5px] font-bold text-ink-3">Average speed</p>
            <p className="break-words text-[16px] font-bold text-ink">{pace == null ? '—' : `${pace.toFixed(1)} km/h`}</p>
          </div>
        </div>
        <p className="mt-4 text-[13px] leading-snug text-ink-3">
          Source: {source === 'demo' ? 'simulated demo walk' : 'phone GPS'} · readings worse than 25 m accuracy and jumps faster than walking are ignored
          {cur ? ` · walk ${paused ? 'paused' : 'in progress'} (${km(cur.distanceM)})` : ''}.
        </p>
      </div>
      <div className="glass flex items-center gap-3 rounded-[24px] px-4 py-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-teal/10 text-teal"><Activity size={22} /></span>
        <span className="min-w-0 flex-1 text-[15.5px] font-bold text-ink-2">Walks today</span>
        <span className="tabular shrink-0 text-[26px] font-bold leading-none text-ink">{today.sessions + (cur ? 1 : 0)}</span>
      </div>
      <Section title="Not measured">
        <div className={listCls}>
          <Unavailable icon={<Footprints size={20} />} label="Steps" reason="The stick has no step counter; distance comes from GPS." />
          <Unavailable icon={<Heart size={20} />} label="Heart rate" reason="No heart-rate sensor is connected." />
          <Unavailable icon={<Flame size={20} />} label="Energy" reason="Not estimated without a health sensor." />
        </div>
      </Section>
    </>
  );
}

/* ───────────────────────────── Battery ───────────────────────────── */

function BatteryContent() {
  const b = useDevice((s) => s.battery);
  const samples = useBatteryHistory((s) => s.samples);
  const now = useNow(5000);
  const lbl = batteryLabel(b);
  const pct = b.percent ?? 0;
  const bars = samples.filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 12)) === 0).slice(-12);
  const eta = b.status === 'ok' && !b.charging ? batteryHours(samples) : null;
  const fill = lbl.tone === 'sos' ? 'from-sos to-sos/70' : lbl.tone === 'warn' ? 'from-amber to-amber/70' : 'from-teal to-mint';
  return (
    <>
      <div className="glass relative flex items-center gap-4 overflow-hidden rounded-[30px] p-5">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-ok/5 to-teal/5" />
        <div className="relative flex min-w-0 flex-1 flex-col">
          <p className="text-[13px] font-bold uppercase tracking-wider text-ink-3">Stick battery</p>
          <p className="mt-1 text-[52px] font-extrabold leading-none tracking-tight text-ink tabular">
            {b.percent == null ? '—' : pct}
            <span className="text-[24px] text-ink-3">{b.percent == null ? '' : '%'}</span>
          </p>
          <span className={`mt-3 inline-flex max-w-full items-center gap-1.5 self-start rounded-full px-3 py-1.5 ${b.charging ? 'bg-ok/10 text-ok' : 'bg-ink/5 text-ink-2'}`}>
            <Zap size={15} className="shrink-0" />
            <span className="min-w-0 break-words text-[13px] font-bold leading-tight">
              {b.charging == null ? 'Charging state unknown' : b.charging ? `Charging${b.chargingSource === 'inferred' ? ' (inferred)' : ''}` : 'On battery'}
            </span>
          </span>
          <p className="mt-3 break-words text-[15px] font-bold text-ink-2">{eta ? <>Time left: <span className="text-ink">{eta}</span></> : lbl.sub}</p>
          <p className="mt-1 break-words text-[12.5px] leading-snug text-ink-3">{b.measuredAt ? `Measured ${timeAgo(b.measuredAt, now)} · from voltage and current` : 'No measurement yet'}</p>
        </div>
        <div className="relative shrink-0 pt-3" aria-hidden>
          <div className="absolute left-1/2 top-0 h-3 w-7 -translate-x-1/2 rounded-t-lg bg-ink/10" />
          <div className="relative h-[136px] w-[76px] overflow-hidden rounded-[20px] border-4 border-ink/10 bg-bg">
            <div className={`absolute inset-x-0 bottom-0 bg-gradient-to-t ${fill} transition-[height] duration-700 ease-out`} style={{ height: `${b.percent == null ? 0 : pct}%` }}>
              <div className="battery-wave absolute -top-2 left-0 h-4 w-[200%] rounded-[100%] bg-mint/40" />
            </div>
          </div>
        </div>
      </div>

      {b.issue && <p className="rounded-[18px] bg-amber/15 px-4 py-3 text-[14px] font-semibold text-amber-ink" role="status">{b.issue}</p>}

      <div className="glass rounded-[28px] p-5">
        <p className="mb-4 text-[16px] font-bold text-ink">Battery over the last hours</p>
        {bars.length < 2 ? (
          <p className="text-[14px] text-ink-3">Not enough readings yet. One estimate is recorded every minute while the stick is connected.</p>
        ) : (
          <>
            <div className="flex h-32 w-full items-end gap-1" role="img" aria-label="Battery estimate history">
              {bars.map((s, i) => (
                <div key={s.t} className="relative h-full min-w-0 flex-1 overflow-hidden rounded-[4px] bg-ink/5">
                  <div className={`absolute inset-x-0 bottom-0 rounded-[4px] ${i === bars.length - 1 ? 'bg-ok' : 'bg-ink-3'}`} style={{ height: `${s.pct}%` }} />
                </div>
              ))}
            </div>
            <div className="mt-3 flex justify-between text-[12px] font-bold text-ink-3">
              <span>{new Date(bars[0].t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              <span className="text-ok">Now</span>
            </div>
          </>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="glass min-w-0 rounded-[22px] p-4">
          <p className="text-[13px] font-bold text-ink-2">Voltage</p>
          <p className="mt-1 break-words text-[22px] font-bold text-ink tabular">{b.voltage == null ? '—' : `${b.voltage.toFixed(2)} V`}</p>
        </div>
        <div className="glass min-w-0 rounded-[22px] p-4">
          <p className="text-[13px] font-bold text-ink-2">Current</p>
          <p className="mt-1 break-words text-[22px] font-bold text-ink tabular">{b.currentMa == null ? '—' : `${Math.round(b.currentMa)} mA`}</p>
        </div>
      </div>
    </>
  );
}

/* ───────────────────────────── Live assistant ───────────────────────────── */

function LiveAiSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cancel = useVoiceAssistant().cancel;
  // Closing the panel ends the conversation. Only a real open → closed change: on mount (open is
  // false) this must not cancel a session started from the stick button.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) cancel();
    wasOpen.current = open;
  }, [open, cancel]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="live"
          initial={{ opacity: 0, transform: 'translate3d(0,32px,0)' }}
          animate={{ opacity: 1, transform: 'translate3d(0,0,0)' }}
          exit={{ opacity: 0, transform: 'translate3d(0,24px,0)' }}
          transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
          className="absolute inset-0 z-[100] flex flex-col overflow-hidden bg-[#09090b]"
          role="dialog"
          aria-modal="true"
          aria-label="Live assistant"
        >
          <LiveAiPage onClose={onClose} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function LiveAiPage({ onClose }: { onClose: () => void }) {
  const ai = useVoiceAssistant();
  // Opening the assistant starts it: no extra tap needed.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
    if (ai.phase === 'idle') void ai.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const sosPhase = useSafety((x) => x.phase);
  const netState = useDevice((x) => x.internet);
  const navActive = useNavView((x) => x.active);
  const listening = ai.phase === 'listening';
  const toggle = () => (listening ? ai.cancel() : ai.start());
  const status =
    ai.phase === 'listening' ? ai.heard || 'Listening…'
    : ai.phase === 'thinking' ? 'Thinking…'
    : ai.phase === 'vision' ? 'Looking through the stick camera…'
    : ai.phase === 'error' ? (ai.unavailable ? `Didn't work: ${ai.unavailable}` : 'That did not work. Try again.')
    : ai.phase === 'interrupted' ? 'Paused for an important message'
    : ai.phase === 'speaking' ? ai.reply || 'Speaking…'
    : ai.unavailable ? `Assistant unavailable: ${ai.unavailable}`
    : 'How can I help you?';

  return (
    <>
      {/* Aurora: soft radial fields, transform-only CSS animation (no blur filters). */}
      <div className="live-aurora pointer-events-none absolute inset-0 z-0" aria-hidden>
        <span className="live-aurora-a" />
        <span className="live-aurora-b" />
        <span className="live-aurora-c" />
      </div>

      <div className="relative z-10 flex shrink-0 items-center gap-3 px-4" style={{ paddingTop: 'calc(var(--island, var(--sat)) + 10px)' }}>
        <button type="button" onClick={onClose} aria-label="Close assistant" className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-white/10 text-white active:bg-white/20">
          <X size={24} />
        </button>
        <span className="min-w-0 flex-1 truncate text-center text-[15px] font-semibold text-white/80">{BRAND.name}</span>
        <span className="h-12 w-12 shrink-0" aria-hidden />
      </div>

      <div className="page-scroll relative z-10 flex min-h-0 flex-1 flex-col items-center px-6 text-center text-white">
        <p className="mt-6 bg-gradient-to-r from-sos via-info to-teal bg-clip-text pb-1 text-[44px] font-extrabold leading-none tracking-tight text-transparent">Assistant</p>
        <p className="mt-3 max-w-[300px] break-words text-[20px] font-medium leading-snug text-white/85" aria-live="polite">
          {status}
        </p>
        <div className="flex flex-1 items-center justify-center py-6">
          <button type="button" className="rounded-full active:scale-[0.97]" aria-label={listening ? 'Stop listening' : 'Start talking'} onClick={toggle}>
            <AiOrb size={220} phase={orbPhaseFor({ assistant: ai.phase, sosActive: sosPhase === 'active' || sosPhase === 'countdown', internet: netState, navigating: navActive, unavailable: ai.unavailable })} />
          </button>
        </div>
      </div>

      <div className="relative z-10 flex shrink-0 flex-col items-center gap-2 px-6 pt-4" style={{ paddingBottom: 'calc(var(--sab) + 24px)' }}>
        <button type="button" onClick={toggle} className={`grid h-[72px] w-[72px] place-items-center rounded-full shadow-lg ${listening ? 'bg-sos text-white' : 'bg-white text-black'}`} aria-label={listening ? 'Stop' : 'Tap to talk'}>
          {listening ? <StopCircle size={32} /> : <Mic size={32} />}
        </button>
        <span className="text-[14px] font-medium text-white/60">{listening ? 'Stop' : 'Tap to talk'}</span>
      </div>
    </>
  );
}

/* ───────────────────────────── Safety center ───────────────────────────── */

function Check({ ok, label, value }: { ok: boolean | null; label: string; value: string }) {
  return (
    <div className="flex min-h-12 items-center gap-3 px-4 py-2.5">
      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[14px] font-bold ${ok == null ? 'bg-ink/5 text-ink-3' : ok ? 'bg-ok/15 text-ok' : 'bg-amber/15 text-amber-ink'}`} aria-hidden>
        {ok == null ? '–' : ok ? '✓' : '!'}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-[15px] font-semibold text-ink">{label}</span>
        <span className="block break-words text-[13.5px] text-ink-3">{value}</span>
      </span>
    </div>
  );
}

function SafetyCenterContent() {
  const link = useDevice((s) => s.link);
  const usStatus = useDevice((s) => s.ultrasonic.status);
  const imuStatus = useDevice((s) => s.imu.status);
  const bStatus = useDevice((s) => s.battery.status);
  const bPercent = useDevice((s) => s.battery.percent);
  const bCharging = useDevice((s) => s.battery.charging);
  const internet = useDevice((s) => s.internet);
  const ev = useSafetyEval();
  const locStatus = useLocation((s) => s.status);
  const fix = useLocation((s) => s.fix);
  const locProblemText = useLocation((s) => locationProblem(s)?.text ?? null);
  const linked = useSession((s) => s.linked);
  // Re-render when contacts change; the number itself comes from the same lookup SOS uses.
  useSession((s) => s.contacts);
  const guardianPhone = safetyContact().phone;
  const mode = useRuntime((s) => s.mode);
  const [checked, setChecked] = useState<string | null>(null);
  const on = isLinked(link);
  const usOk = usStatus === 'ok' || usStatus === 'no_echo' || usStatus === 'out_of_range';

  const runCheck = () => {
    const issues = ev.reasons;
    const text = issues.length ? `Check before walking: ${issues.join('. ')}.` : 'Everything checked is working: stick connected and verified, battery reading fresh, obstacle sensor reporting.';
    setChecked(text);
    announce(text, { high: true });
  };

  const dot = ev.state === 'healthy' ? 'bg-ok' : ev.state === 'warning' || ev.state === 'initializing' ? 'bg-amber' : ev.state === 'unknown' ? 'bg-ink-3' : 'bg-sos';
  return (
    <>
      <div className="glass rounded-[28px] p-5">
        <div className="flex items-center gap-3">
          <span className={`h-4 w-4 shrink-0 rounded-full ${dot}`} />
          <h2 className="min-w-0 break-words text-[18px] font-bold text-ink">{ev.state === 'healthy' ? 'All safety systems working' : ev.state === 'unknown' ? 'Safety status unknown' : ev.state === 'initializing' ? 'Starting up' : 'Needs attention'}</h2>
        </div>
        {ev.reasons.length > 0 && <ul className="ml-7 mt-3 list-disc text-[14px] text-ink-2">{ev.reasons.map((r) => <li key={r} className="break-words">{r}</li>)}</ul>}
      </div>

      <Section title="Stick hardware">
        <div className={listCls}>
          <Check ok={on} label="Link" value={linkLabel(link).text} />
          <Check ok={on ? usOk : null} label="Obstacle sensor" value={on ? usStatus.replace('_', ' ') : 'no data'} />
          <Check ok={on ? imuStatus === 'ok' : null} label="Motion sensor (fall detection)" value={on ? imuStatus : 'no data'} />
          <Check ok={on ? bStatus === 'ok' : null} label="Battery sensor" value={batteryLabel({ status: bStatus, percent: bPercent, charging: bCharging }).sub} />
        </div>
      </Section>

      <Section title="Phone">
        <div className={listCls}>
          <Check
            ok={mode === 'demo' ? null : locStatus === 'ok' ? true : locStatus === 'idle' ? null : false}
            label="GPS"
            value={mode === 'demo' ? 'simulated in demo' : fix ? `±${Math.round(fix.accuracyM)} m · ${freshnessLabel(fix.ts)}` : locProblemText ?? 'no position yet'}
          />
          <Check ok={internet} label="Internet" value={internet == null ? 'checking' : internet ? 'online' : 'offline'} />
        </div>
      </Section>

      <Section title="Emergency">
        <div className={listCls}>
          <Check ok={linked} label="Safety contact linked" value={linked ? 'yes' : 'not yet'} />
          <Check ok={!!guardianPhone} label="Safety phone number for SMS / call" value={guardianPhone ? 'saved' : 'missing'} />
        </div>
      </Section>

      <div className="glass rounded-[28px] p-5">
        <h3 className="mb-1.5 text-[18px] font-bold text-ink">Pre-walk check</h3>
        <p className="mb-4 text-[14px] text-ink-2">Checks the stick link, battery, obstacle sensor, GPS and internet, and reads the result aloud.</p>
        <button type="button" onClick={runCheck} className="h-12 w-full rounded-full bg-teal font-bold text-on-teal active:scale-[0.98]">
          Run check
        </button>
        {checked && <p className="mt-3 break-words text-[14px] leading-snug text-ink-2" aria-live="polite">{checked}</p>}
      </div>
    </>
  );
}

/* ───────────────────────────── Home ───────────────────────────── */

export function UserHome() {
  const [safetyCenterOpen, setSafetyCenterOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const cameraOpen = useUI((s) => s.cameraOpen);
  const batteryOpen = useUI((s) => s.batteryPage);
  const mapOpen = useUI((s) => s.mapOpen);
  const stickDetailsOpen = useUI((s) => s.stickPage);
  const liveAiOpen = useUI((s) => s.liveAiOpen);
  const healthOpen = useUI((s) => s.healthOpen);
  const audioOpen = useUI((s) => s.audioOpen);
  const otherScreen = useUI((s) => s.userSettings || s.stickSetup);
  // Home hides under full-screen pages: one animated background, nothing behind for TalkBack.
  const covered = safetyCenterOpen || chatOpen || cameraOpen || batteryOpen || mapOpen || stickDetailsOpen || liveAiOpen || healthOpen || audioOpen || otherScreen;

  const header = useRef<HTMLElement>(null);
  const scrolled = useRef(false);
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const s = e.currentTarget.scrollTop > 4;
    if (s === scrolled.current) return;
    scrolled.current = s;
    header.current?.setAttribute('data-scrolled', String(s));
  }, []);
  const openSafety = useCallback(() => setSafetyCenterOpen(true), []);
  const openChat = useCallback(() => setChatOpen(true), []);

  return (
    <AppScreen>
      <div className="home-layer absolute inset-0 flex flex-col" data-covered={covered ? 'true' : 'false'} aria-hidden={covered || undefined} inert={covered}>
        <HomeHeader headerRef={header} />
        <SafeAreaContent topInset={false} className="px-5 pt-1" onScroll={onScroll}>
          {/* Hero carousel: Stick · Walk · Assistant (home/HomeCarousel.tsx) */}
          <HomeCarousel label="Your stick, walk and assistant">
            <StickCard />
            <WalkCard />
            <AssistantCard />
          </HomeCarousel>
          <QuickActions onSafety={openSafety} onChat={openChat} />
          <BottomControls />
        </SafeAreaContent>
      </div>

      <SubPage open={safetyCenterOpen} onClose={() => setSafetyCenterOpen(false)} title="Safety Center" background="none">
        <SafetyCenterContent />
      </SubPage>
      <AiChatSubpage open={chatOpen} onClose={() => setChatOpen(false)} />
      <CameraView open={cameraOpen} onClose={() => useUI.setState({ cameraOpen: false })} />
      <WalkingSubpage open={mapOpen} onClose={() => useUI.setState({ mapOpen: false })} />
      <SubPage open={stickDetailsOpen} onClose={() => useUI.setState({ stickPage: false })} title="Stick diagnostics" background="none">
        <StickDetailsContent />
      </SubPage>
      <SubPage open={batteryOpen} onClose={() => useUI.setState({ batteryPage: false })} title="Power & battery" background="none" z={60}>
        <BatteryContent />
      </SubPage>
      <SubPage open={healthOpen} onClose={() => useUI.setState({ healthOpen: false })} title="Activity & health" background="none">
        <HealthContent />
      </SubPage>
      <LiveAiSubpage open={liveAiOpen} onClose={() => useUI.setState({ liveAiOpen: false })} />
      <AudioSubpage open={audioOpen} onClose={() => useUI.setState({ audioOpen: false })} />
    </AppScreen>
  );
}
