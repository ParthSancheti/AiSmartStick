import { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BatteryFull, Settings, Smartphone, Unlink, Moon, Sun, Footprints, MessageSquare, Map, ChevronLeft, Activity, ShieldAlert, Heart, Flame, Phone, Zap, LogOut, Wand2, Link2, Headphones, Mic, StopCircle, Send, Plus, Bluetooth, Speaker } from 'lucide-react';

import { usePressPatterns } from '../../hooks/usePressPatterns';
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
import { Atmosphere } from '../../components/Atmosphere';
import { LiveVisionPanel } from '../../components/LiveVisionPanel';
import { AppScreen, SafeAreaContent, FloatingHeader } from '../../components/Layout';
import { AiOrb, orbPhaseFor } from '../../components/AiOrb';
import { useSafety } from '../../core/store/safety';
import { AccountAvatar } from '../../components/Avatar';
import { ModeBadge } from '../../components/ModeBadge';
import { MapView } from '../../components/MapView';
import { ObstacleView } from '../../components/ObstacleView';
import { BrandLogo } from '../../core/brand/BrandLogo';
import { BRAND } from '../../core/brand/brand';
import { startSos } from '../../core/safety/sos';
import { AudioSubpage } from './AudioSubpage';
import { useRuntime } from '../../core/runtime/mode';
import { firebaseConfigured } from '../../core/runtime/env';
import { signOut } from '../../core/auth/authService';
import { useAuth } from '../../core/auth/authStore';
import { useSafetyEval } from '../../core/safety/safetyRuntime';
import { useNavView } from '../../core/navigation/navView';
import { useLocation, freshnessLabel } from '../../core/location/locationService';
import { useWalking, startWalk, pauseWalk, resumeWalk, endWalk } from '../../core/walking/walkTracker';
import { autocomplete, placeDetails, type Suggestion } from '../../core/maps/mapsService';
import { startRealNavigation, stopRealNavigation } from '../../core/navigation/realNavigator';
import { startNavigation as startDemoNavigation, stopNavigation as stopDemoNavigation } from '../../core/nav/navigation';
import { PLACES } from '../../core/sim/geo';
import { usePhoneInfo, phoneLabel } from '../../core/native/deviceInfo';
import { useBatteryHistory } from '../../core/telemetry/batteryHistory';
import { useAudioRoute } from '../../core/audio/audioRoute';
import { linkLabel, batteryLabel, safetyLabel, TONE_TEXT, km, mins } from '../shared/labels';
import { meters, timeAgo } from '../../core/util';
import { friendlyError } from '../../core/errors';

const openSetup = () => useUI.setState({ stickSetup: true });

function ProfileMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const theme = useSession((s) => s.settings.theme);
  const updateSettings = useSession((s) => s.updateSettings);
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const link = useDevice((s) => s.link);
  const mode = useRuntime((s) => s.mode);
  const user = useAuth((s) => s.user);
  const l = linkLabel(link);
  const canSwitchRole = true;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-[100] bg-ink/5 backdrop-blur-[2px]"
            aria-hidden="true"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.8, y: -20, x: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0, x: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: -20, x: 20 }}
            transition={{ type: 'spring', stiffness: 500, damping: 25 }}
            className="absolute top-20 right-4 z-[101] glass w-64 rounded-[28px] p-2 flex flex-col gap-1 shadow-2xl origin-top-right"
          >
            {user && (
              <div className="px-4 pb-2 pt-2">
                <p className="truncate text-[15px] font-bold text-ink">{user.displayName ?? 'Signed in'}</p>
                <p className="truncate text-[13px] text-ink-3">{mode === 'demo' ? 'Demo mode · simulated data' : (user.email ?? '')}</p>
              </div>
            )}
            <button type="button" className="glass interactive flex items-center gap-3 px-4 py-3 rounded-[20px] text-[15px] font-semibold text-ink w-full" onClick={() => { onClose(); useUI.setState({ userSettings: true }); }}>
              <Settings size={18} /> Settings
            </button>
            <button type="button" className="glass interactive flex items-center gap-3 px-4 py-3 rounded-[20px] text-[15px] font-semibold text-ink w-full" onClick={() => { updateSettings({ theme: isDark ? 'light' : 'dark' }); }}>
              {isDark ? <Sun size={18} /> : <Moon size={18} />} Toggle Theme
            </button>
            <button type="button" className="glass interactive flex items-center gap-3 px-4 py-3 rounded-[20px] text-[15px] font-semibold text-ink w-full" onClick={() => { onClose(); if (link === 'unpaired' || link === 'auth_failed') openSetup(); else useUI.setState({ stickPage: true }); }}>
              {link === 'connected' ? <Link2 size={18} /> : <Unlink size={18} />} {link === 'unpaired' ? 'Set up stick' : `Stick ${l.text.replace('…', '')}`}
            </button>
            <button type="button" className="glass interactive flex items-center gap-3 px-4 py-3 rounded-[20px] text-[15px] font-semibold text-ink w-full" onClick={() => { onClose(); useUI.setState({ pocket: true }); announce(P.pocketOn); }}>
              <Smartphone size={18} /> Pocket Mode
            </button>
            {false && canSwitchRole && (
              <button type="button" className="glass interactive flex items-center gap-3 px-4 py-3 rounded-[20px] text-[15px] font-semibold text-ink w-full" onClick={() => { onClose(); useSession.setState({ entryRole: 'guardian' }); }}>
                <ShieldAlert size={18} /> Switch to Guardian
              </button>
            )}
            {mode === 'real' && (
              <>
                <div className="h-px bg-ink/10 my-1 mx-2" />
                <button type="button" className="glass interactive flex items-center gap-3 px-4 py-3 rounded-[20px] text-[15px] font-semibold text-sos w-full" onClick={() => { onClose(); void signOut(); }}>
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

function TopNav() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="relative z-50 mb-6 pt-8">
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className="glass flex items-center justify-between h-[68px] rounded-[34px] px-2 shadow-2xl pointer-events-auto"
      >
        <div className="flex items-center gap-3 pl-2">
          <BrandLogo variant="icon" size={44} className="rounded-full overflow-hidden" />
          <span className="text-[17px] font-bold text-ink tracking-tight">{BRAND.name}</span>
          <ModeBadge />
        </div>
        <button
          type="button"
          className="h-11 w-11 rounded-full p-[2px] overflow-hidden interactive mr-2 shrink-0"
          aria-label="Open profile menu"
          onClick={() => setMenuOpen(true)}
        >
          <AccountAvatar size={40} />
        </button>
      </motion.div>
      <div className="pointer-events-auto">
        <ProfileMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
      </div>
    </div>
  );
}

function AiChatSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const userName = useSession((s) => s.person.name) || useAuth.getState().user?.displayName?.split(' ')[0] || '';
  const thread = useAssistant((s) => s.thread);
  const phase = useAssistant((s) => s.phase);
  const [text, setText] = useState('');
  const [convs, setConvs] = useState<ConversationSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!historyOpen) return;
    setConvs(null);
    setErr(null);
    listConversations()
      .then(setConvs)
      .catch(() => setErr('History is unavailable right now.'));
  }, [historyOpen]);

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

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ clipPath: 'circle(0% at 50% 60%)' }}
          animate={{ clipPath: 'circle(150% at 50% 60%)' }}
          exit={{ clipPath: 'circle(0% at 50% 60%)' }}
          transition={{ duration: 0.35, ease: 'linear' }}
          className="absolute inset-0 z-50 flex flex-col bg-bg"
        >
          <Atmosphere variant="user" />
          {historyOpen ? (
            <div className="px-4 pb-8 flex-1 flex flex-col overflow-y-auto no-scrollbar" style={{ paddingTop: 'calc(var(--island, var(--sat)) + 12px)' }}>
              <div className="mb-5 mt-8 flex items-center justify-between gap-4 z-10 shrink-0">
                <h1 className="text-[28px] font-bold tracking-[-0.02em] text-ink pl-2">History</h1>
                <button onClick={() => setHistoryOpen(false)} aria-label="Close history" className="h-12 w-12 glass interactive rounded-full flex items-center justify-center text-ink shrink-0">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                </button>
              </div>
              <button
                className="glass interactive self-start h-12 px-6 rounded-full flex items-center gap-2 text-[15px] font-medium text-ink mb-8 mt-2 ml-2"
                onClick={() => {
                  useAssistant.setState({ conversationId: null, thread: [] });
                  setHistoryOpen(false);
                }}
              >
                <Plus size={20} />
                New chat
              </button>
              <h2 className="text-[14px] font-bold text-ink mb-4 ml-2">Recent</h2>
              <div className="flex flex-col gap-4 pb-8 ml-2">
                {err && <p className="text-[15px] text-ink-3">{err}</p>}
                {!err && convs === null && <p className="text-[15px] text-ink-3">Loading…</p>}
                {convs?.length === 0 && <p className="text-[15px] text-ink-3">No conversations yet.</p>}
                {convs?.map((c) => (
                  <button key={c.id} type="button" onClick={() => void openConversation(c)} className="flex items-center gap-4 text-ink-2 text-left">
                    <MessageSquare size={20} />
                    <span className="text-[16px] font-medium text-ink truncate flex-1">{c.title}</span>
                    <span className="text-[12px] text-ink-3 shrink-0">{timeAgo(c.updatedAt, Date.now())}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="px-4 pb-8 flex-1 flex flex-col overflow-y-auto no-scrollbar" style={{ paddingTop: 'calc(var(--island, var(--sat)) + 12px)' }}>
              <div className="mb-5 mt-8 flex items-center justify-between gap-4 z-10 shrink-0">
                <div className="flex items-center gap-4">
                  <button onClick={onClose} aria-label="Back" className="h-12 w-12 glass interactive rounded-full flex items-center justify-center text-ink shrink-0">
                    <ChevronLeft size={24} />
                  </button>
                  <h1 className="text-[28px] font-bold tracking-[-0.02em] text-ink">Assistant</h1>
                </div>
                <button onClick={() => setHistoryOpen(true)} className="glass px-5 h-12 interactive rounded-full flex items-center justify-center text-[15px] font-semibold text-ink gap-2">
                  <MessageSquare size={18} /> History
                </button>
              </div>

              {thread.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center pb-20">
                  <div className="text-info mb-6">
                    <Wand2 size={64} />
                  </div>
                  <h1 className="text-[36px] font-bold text-ink text-center leading-tight">
                    What's the vibe{userName ? ',' : '?'}<br />{userName ? `${userName}?` : ''}
                  </h1>
                </div>
              ) : (
                <div className="flex-1 flex flex-col gap-3 pb-28" aria-live="polite">
                  {thread.map((m) => (
                    <div key={m.id} className={`max-w-[85%] rounded-[22px] px-4 py-3 text-[16px] leading-snug ${m.role === 'user' ? 'self-end bg-teal text-on-teal' : m.role === 'system' ? 'self-center bg-amber-soft text-amber-ink text-[14px]' : 'self-start glass text-ink'}`}>
                      {m.text}
                    </div>
                  ))}
                  {phase === 'thinking' && <div className="self-start glass rounded-[22px] px-4 py-3 text-[15px] text-ink-3">Thinking…</div>}
                </div>
              )}

              <div className="absolute bottom-6 left-4 right-4 z-10">
                <form
                  className="glass w-full rounded-full p-2 flex items-center gap-2 shadow-lg h-16"
                  onSubmit={(e) => {
                    e.preventDefault();
                    send();
                  }}
                >
                  <button type="button" aria-label="Speak instead" onClick={() => handleButton('single')} className="h-12 w-12 rounded-full flex items-center justify-center shrink-0 text-ink">
                    <Mic size={22} />
                  </button>
                  <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Ask ${BRAND.name}...`} aria-label="Message to the assistant" className="flex-1 bg-transparent outline-none text-ink text-[16px] px-2 font-medium" />
                  <button type="submit" disabled={!text.trim() || phase === 'thinking'} className="h-12 w-12 bg-teal/20 interactive rounded-full flex items-center justify-center text-teal shrink-0 disabled:opacity-40" aria-label="Send">
                    <Send size={20} />
                  </button>
                </form>
                <div className="mt-4 flex justify-center">
                  <div className="w-1/3 h-1 bg-ink/20 rounded-full" />
                </div>
              </div>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function DestinationSearch() {
  const demo = useRuntime((s) => s.mode) === 'demo';
  const fix = useLocation((s) => s.fix);
  const internet = useDevice((s) => s.internet);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Suggestion[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token] = useState(() => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())));

  useEffect(() => {
    setErr(null);
    const text = q.trim();
    if (text.length < 2) return setItems([]);
    if (demo) {
      setItems(PLACES.filter((p) => p.category !== 'home' && p.name.toLowerCase().includes(text.toLowerCase())).map((p) => ({ placeId: p.id, main: p.name, secondary: 'Demo place' })));
      return;
    }
    if (!fix) return setErr('Waiting for GPS before searching nearby.');
    if (internet === false) return setErr('Search needs internet.');
    const t = setTimeout(() => {
      autocomplete(text, fix.lat, fix.lng, token)
        .then((r) => setItems(r.suggestions))
        .catch((e) => setErr(`Search unavailable. ${friendlyError(e)}`));
    }, 300); // debounce: one request per pause in typing
    return () => clearTimeout(t);
  }, [q, demo, fix?.lat, fix?.lng, internet, token]);

  const pick = async (s: Suggestion) => {
    setBusy(true);
    setErr(null);
    try {
      if (demo) {
        const p = PLACES.find((x) => x.id === s.placeId);
        if (p) startDemoNavigation(p);
      } else {
        const { place } = await placeDetails(s.placeId, token);
        await startRealNavigation(place);
      }
      setQ('');
      setItems([]);
    } catch (e) {
      const m = (e as Error).message;
      setErr(m === 'location-unavailable' ? 'No GPS position yet.' : m === 'no-route' ? 'No walking route found.' : `Could not start directions. ${friendlyError(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search a destination"
        aria-label="Search a destination"
        className="h-12 w-full rounded-full border border-line bg-surface/80 px-5 text-[16px] font-medium text-ink outline-none"
      />
      {err && <p className="mt-2 px-2 text-[13.5px] font-semibold text-amber-ink" role="status">{err}</p>}
      {items.length > 0 && (
        <ul className="mt-2 max-h-48 overflow-y-auto rounded-[20px] border border-line bg-surface/95" role="listbox" aria-label="Suggestions">
          {items.map((it) => (
            <li key={it.placeId}>
              <button type="button" disabled={busy} onClick={() => void pick(it)} className="w-full px-4 py-3 text-left disabled:opacity-50">
                <span className="block text-[15.5px] font-semibold text-ink">{it.main}</span>
                {it.secondary && <span className="block text-[13px] text-ink-3">{it.secondary}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WalkingSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavView();
  const fix = useLocation((s) => s.fix);
  const locStatus = useLocation((s) => s.status);
  const now = useNow(1000);
  const fresh = freshnessLabel(fix?.ts, now);
  const live = fresh === 'Live';

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ clipPath: 'circle(0% at 50% 75%)' }}
          animate={{ clipPath: 'circle(150% at 50% 75%)' }}
          exit={{ clipPath: 'circle(0% at 50% 75%)' }}
          transition={{ duration: 0.4, ease: 'easeInOut' }}
          className="absolute inset-0 z-[80] bg-map-bg flex flex-col overflow-hidden"
        >
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

          {/* Top Bar Floating */}
          <div className="pt-12 px-4 z-10 shrink-0 pointer-events-none">
             <div className="glass bg-surface/90 backdrop-blur-md rounded-[28px] p-2 flex items-center justify-between shadow-[0_10px_30px_rgba(0,0,0,0.08)] pointer-events-auto border border-glass-border">
               <button onClick={onClose} aria-label="Back" className="h-12 w-12 rounded-full flex items-center justify-center text-ink hover:bg-black/5 transition-colors shrink-0 interactive">
                 <ChevronLeft size={24} />
               </button>
               <div className="flex-1 px-2">
                  <div className="flex items-center justify-center gap-2">
                    <div className={`w-2.5 h-2.5 rounded-full ${live ? 'bg-ok animate-pulse' : 'bg-ink-3'}`} />
                    <span className="text-[14px] font-bold tracking-widest text-ink uppercase">
                      {useRuntime.getState().mode === 'demo' ? 'Demo walk' : fix ? (live ? 'Live location' : fresh) : locStatus === 'error' ? 'Location off' : 'Finding location'}
                    </span>
                  </div>
               </div>
               <div className="h-12 w-12 rounded-full bg-ink/5 flex items-center justify-center text-ink-3">
                 <Map size={20} />
               </div>
             </div>
          </div>

          <div className="flex-1 flex flex-col justify-end px-4 pb-6 z-10 pointer-events-none">

             {/* Directions Floating Card */}
             <div className="glass bg-surface/95 backdrop-blur-md rounded-[32px] p-6 shadow-[0_20px_40px_rgba(0,0,0,0.12)] pointer-events-auto border border-glass-border mb-4 relative overflow-hidden">
                <div className="absolute top-0 right-0 p-6 opacity-[0.03] text-info pointer-events-none">
                   <Footprints size={120} />
                </div>
                <div className="flex items-start gap-4">
                   <div className="w-14 h-14 bg-info text-white rounded-[20px] flex items-center justify-center shadow-lg shrink-0">
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: nav.next?.maneuver === 'left' ? 'rotate(180deg)' : nav.next?.maneuver === 'straight' ? 'rotate(-90deg)' : undefined }}><path d="m9 18 6-6-6-6"/></svg>
                   </div>
                   <div className="flex-1 pt-0.5">
                     <p className="text-[26px] font-extrabold text-ink leading-tight tracking-tight pr-4">
                       {nav.active ? (nav.arrived ? `Arrived near ${nav.destination?.name}` : nav.next?.text ?? `Walking to ${nav.destination?.name}`) : 'No active route'}
                     </p>
                     <p className="text-[15px] font-bold text-info/80 mt-1 flex items-center gap-2">
                       {nav.active && nav.remainingM != null ? `${meters(nav.remainingM)} remaining${nav.offRoute ? ' · off route' : ''}${nav.rerouting ? ' · rerouting' : ''}` : 'Ask the assistant: “Take me to the nearest pharmacy”'}
                     </p>
                     {nav.error && <p className="mt-1 text-[14px] font-semibold text-amber-ink">{nav.error}</p>}
                   </div>
                </div>
                {nav.active ? (
                  <button type="button" onClick={() => (nav.source === 'demo' ? stopDemoNavigation() : stopRealNavigation('user'))} className="mt-4 h-11 w-full rounded-full bg-ink/5 text-[15px] font-bold text-ink interactive">
                    End route
                  </button>
                ) : (
                  <DestinationSearch />
                )}
             </div>

             {/* SOS Bottom Button */}
             <button
                className="w-full bg-sos text-white rounded-[28px] h-[72px] flex items-center justify-center gap-3 font-bold text-[20px] shadow-[0_10px_30px_-8px_var(--sos)] active:scale-95 transition-transform pointer-events-auto interactive"
                onClick={(e) => {
                   e.stopPropagation();
                   startSos('button');
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                aria-label="Trigger Emergency SOS"
             >
                <Phone size={24} fill="currentColor" /> Emergency SOS
             </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function StickDetailsSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const events = useActivity((s) => s.events);
  const now = useNow(5000);
  const d = useDevice();
  const obstacles = events.filter((e) => e.kind === 'safety' && e.title.startsWith('Obstacle')).slice(0, 5);
  const row = (k: string, v: string) => (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="text-[15px] text-ink-2">{k}</span>
      <span className="text-right text-[15px] font-semibold text-ink tabular">{v}</span>
    </div>
  );

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ clipPath: 'circle(0% at 50% 30%)' }}
          animate={{ clipPath: 'circle(150% at 50% 30%)' }}
          exit={{ clipPath: 'circle(0% at 50% 30%)' }}
          transition={{ duration: 0.35, ease: 'linear' }}
          className="absolute inset-0 z-50 bg-bg flex flex-col overflow-hidden"
        >
          <Atmosphere variant="user" />
          <div className="pt-[calc(var(--sat)+16px)] px-4 flex items-center gap-4 z-10 shrink-0">
            <button onClick={onClose} aria-label="Back" className="h-12 w-12 glass interactive rounded-full flex items-center justify-center text-ink shrink-0">
              <ChevronLeft size={24} />
            </button>
            <span className="text-[20px] font-bold text-ink">Stick Diagnostics</span>
          </div>

          <div className="flex-1 overflow-y-auto no-scrollbar p-4 flex flex-col gap-6 z-10 pb-20">
            <div className="glass rounded-[28px] p-5 shadow-lg relative border border-glass-border">
              <p className="text-[14px] font-bold text-ink-3 uppercase tracking-widest mb-4 w-full text-left">Obstacle sensor (ahead)</p>
              <ObstacleView us={d.ultrasonic} live={isLinked(d.link)} />
            </div>

            <div className="flex flex-col gap-3">
              <h3 className="text-[18px] font-bold text-ink px-1">Camera &amp; detection</h3>
              <LiveVisionPanel />
              <h3 className="text-[18px] font-bold text-ink px-1 mt-2">Sensors</h3>
              <div className="glass rounded-[24px] overflow-hidden border border-glass-border [&>*+*]:border-t [&>*+*]:border-line">
                {row('Link', `${linkLabel(d.link).text}${d.linkDetail ? ` · ${d.linkDetail}` : ''}`)}
                {row('Stick', d.identity ? `${d.identity.deviceId} · fw ${d.identity.firmware}` : 'Not paired')}
                {row('Battery', d.battery.voltage != null ? `${d.battery.voltage.toFixed(2)} V · ${d.battery.currentMa == null ? '— mA' : `${Math.round(d.battery.currentMa)} mA`}` : batteryLabel(d.battery).sub)}
                {row('Motion sensor', d.imu.status === 'ok' ? `pitch ${d.imu.pitch}° · roll ${d.imu.roll}°${d.imu.calibrated ? '' : ' · not calibrated'}` : d.imu.status)}
                {row('Obstacle sensor', d.ultrasonic.status === 'ok' ? `${d.ultrasonic.distanceCm} cm` : d.ultrasonic.status.replace('_', ' '))}
                {row('Camera', d.camera.status)}
                {row('Wi-Fi signal', d.rssi == null ? 'Unavailable' : `${d.rssi} dBm`)}
                {row('Last packet', d.lastPacketAt ? timeAgo(d.lastPacketAt, now) : 'Never')}
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <h3 className="text-[18px] font-bold text-ink px-1">Obstacles logged</h3>
              <div className="glass rounded-[24px] overflow-hidden border border-glass-border [&>*+*]:border-t [&>*+*]:border-line">
                {obstacles.length ? obstacles.map((e) => <EventRow key={e.id} e={e} now={now} />) : <p className="px-4 py-6 text-center text-[15px] text-ink-3">No obstacles under 60 cm recorded.</p>}
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <h3 className="text-[18px] font-bold text-ink px-1">Activity log</h3>
              <div className="glass rounded-[24px] overflow-hidden border border-glass-border [&>*+*]:border-t [&>*+*]:border-line bg-glass-bg/50 backdrop-blur-md">
                {events.length ? (
                  events.slice(0, 10).map((e) => <EventRow key={e.id} e={e} now={now} />)
                ) : (
                  <p className="px-4 py-6 text-center text-[15px] text-ink-3">Nothing here yet today.</p>
                )}
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Unavailable({ icon, label, reason }: { icon: React.ReactNode; label: string; reason: string }) {
  return (
    <div className="glass rounded-[24px] p-5 flex flex-col gap-3 border border-glass-border shadow-sm">
      <div className="p-3 bg-ink/5 text-ink-3 rounded-full w-max">{icon}</div>
      <div>
        <p className="text-[14px] font-bold text-ink-2">{label}</p>
        <p className="text-[17px] font-bold text-ink-3 leading-tight">Unavailable</p>
        <p className="mt-1 text-[12.5px] leading-snug text-ink-3">{reason}</p>
      </div>
    </div>
  );
}

function HealthSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWalking();
  const cur = w.current;
  const pace = w.today.distanceM > 50 && w.today.durationS > 0 ? (w.today.distanceM / w.today.durationS) * 3.6 : null;
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ clipPath: 'circle(0% at 50% 50%)' }}
          animate={{ clipPath: 'circle(150% at 50% 50%)' }}
          exit={{ clipPath: 'circle(0% at 50% 50%)' }}
          transition={{ duration: 0.35, ease: 'linear' }}
          className="absolute inset-0 z-50 bg-bg flex flex-col overflow-hidden"
        >
          <Atmosphere variant="user" />
          <div className="pt-[calc(var(--sat)+16px)] px-4 flex items-center gap-4 z-10 shrink-0">
            <button onClick={onClose} aria-label="Back" className="h-12 w-12 glass interactive rounded-full flex items-center justify-center text-ink shrink-0">
              <ChevronLeft size={24} />
            </button>
            <span className="text-[20px] font-bold text-ink">Activity & Health</span>
          </div>

          <div className="flex-1 overflow-y-auto no-scrollbar p-4 flex flex-col gap-6 z-10 pb-20">
            <div className="glass rounded-[28px] p-6 shadow-lg border border-glass-border">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <p className="text-[14px] font-bold text-ink-3 uppercase tracking-widest">Walked today</p>
                  <p className="text-[32px] font-bold text-ink flex items-baseline gap-1 mt-1 leading-none">{km(w.today.distanceM)}</p>
                </div>
                <div className="p-3 bg-info/10 text-info rounded-full"><Activity size={24} /></div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-[15px]">
                <div className="rounded-[16px] bg-ink/5 p-3"><p className="text-ink-3 text-[13px] font-bold">Time walking</p><p className="font-bold text-ink">{mins(w.today.durationS)}</p></div>
                <div className="rounded-[16px] bg-ink/5 p-3"><p className="text-ink-3 text-[13px] font-bold">Average speed</p><p className="font-bold text-ink">{pace == null ? '—' : `${pace.toFixed(1)} km/h`}</p></div>
              </div>
              
              <p className="mt-4 text-[13px] leading-snug text-ink-3">
                Source: {w.source === 'demo' ? 'simulated demo walk' : 'phone GPS'} · readings worse than 25 m accuracy and jumps faster than walking are ignored
                {cur ? ` · walk ${w.paused ? 'paused' : 'in progress'} (${km(cur.distanceM)})` : ''}.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Unavailable icon={<Heart size={24} />} label="Heart Rate" reason="No heart-rate sensor is connected." />
              <Unavailable icon={<Flame size={24} />} label="Energy" reason="Not estimated without a health sensor." />
              <Unavailable icon={<Footprints size={24} />} label="Steps" reason="The stick has no step counter; distance comes from GPS." />
              <div className="glass rounded-[24px] p-5 flex flex-col gap-3 border border-glass-border shadow-sm">
                <div className="p-3 bg-teal/10 text-teal rounded-full w-max"><Activity size={24} /></div>
                <div>
                  <p className="text-[14px] font-bold text-ink-2">Walks today</p>
                  <p className="text-[24px] font-bold text-ink leading-tight">{w.today.sessions + (cur ? 1 : 0)}</p>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function BatterySubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const b = useDevice((s) => s.battery);
  const samples = useBatteryHistory((s) => s.samples);
  const now = useNow(5000);
  const lbl = batteryLabel(b);
  const pct = b.percent ?? 0;
  const bars = samples.filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 12)) === 0).slice(-12);
  const eta = b.status === 'ok' && !b.charging ? batteryHours(samples) : null;
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ clipPath: 'circle(0% at 85% 35%)' }}
          animate={{ clipPath: 'circle(150% at 85% 35%)' }}
          exit={{ clipPath: 'circle(0% at 85% 35%)' }}
          transition={{ duration: 0.35, ease: 'linear' }}
          className="absolute inset-0 z-[60] bg-bg flex flex-col overflow-hidden"
        >
          <Atmosphere variant="user" />
          <div className="pt-[calc(var(--sat)+16px)] px-4 flex items-center gap-4 z-10 shrink-0">
            <button onClick={onClose} aria-label="Back" className="h-12 w-12 glass interactive rounded-full flex items-center justify-center text-ink shrink-0">
              <ChevronLeft size={24} />
            </button>
            <span className="text-[20px] font-bold text-ink">Power & Battery</span>
          </div>

          <div className="flex-1 overflow-y-auto no-scrollbar p-4 flex flex-col gap-6 z-10 pb-20">
            <div className="glass rounded-[32px] py-10 px-6 shadow-xl border border-glass-border flex gap-6 items-center overflow-hidden relative min-h-[220px]">
              <div className="absolute inset-0 bg-gradient-to-br from-ok/5 to-teal/5 pointer-events-none" />

              <div className="flex-1 flex flex-col justify-center z-10">
                <p className="text-[42px] xs:text-[54px] font-extrabold text-ink leading-none tracking-tight overflow-visible">{b.percent == null ? '—' : pct}<span className="text-[24px] text-ink-3">{b.percent == null ? '' : '%'}</span></p>
                <div className={`mt-4 flex items-center gap-2 w-max px-3 py-1.5 rounded-full shadow-sm ${b.charging ? 'text-ok bg-ok/10' : 'text-ink-2 bg-ink/5'}`}>
                  <Zap size={16} className={b.charging ? 'animate-pulse' : ''} />
                  <span className="text-[13px] font-bold">
                    {b.charging == null ? 'Charging state unknown' : b.charging ? `Charging${b.chargingSource === 'inferred' ? ' (inferred from current)' : ''}` : 'On battery'}
                  </span>
                </div>
                <p className="text-[15px] font-bold text-ink-2 mt-4">
                  {eta ? <>Time left: <span className="text-ink">{eta}</span></> : lbl.sub}
                </p>
                <p className="text-[12.5px] text-ink-3 mt-1">{b.measuredAt ? `Measured ${timeAgo(b.measuredAt, now)} · estimate from voltage and current` : 'No measurement yet'}</p>
              </div>

              <div className="relative shrink-0 z-10 mr-2" aria-hidden>
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 w-8 h-3 bg-ink/10 rounded-t-lg" />
                <div className="w-[100px] h-[160px] rounded-[24px] border-4 border-ink/10 relative overflow-hidden bg-bg shadow-inner">
                  <motion.div
                    className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t ${lbl.tone === 'sos' ? 'from-sos to-sos/70' : lbl.tone === 'warn' ? 'from-amber to-amber/70' : 'from-teal to-mint'}`}
                    initial={{ height: '0%' }}
                    animate={{ height: `${b.percent == null ? 0 : pct}%` }}
                    transition={{ duration: 1.5, type: 'spring' }}
                  >
                    <motion.div
                      animate={{ x: ['0%', '-50%'] }}
                      transition={{ repeat: Infinity, duration: 2, ease: 'linear' }}
                      className="absolute -top-4 left-0 w-[200%] h-8 bg-mint/30 rounded-[100%] blur-sm"
                    />
                  </motion.div>
                </div>
              </div>
            </div>

            <div className="glass rounded-[28px] p-6 border border-glass-border">
              <p className="text-[16px] font-bold text-ink mb-4">Battery over the last hours</p>
              {bars.length < 2 ? (
                <p className="text-[14px] text-ink-3">Not enough readings yet. One estimate is recorded every minute while the stick is connected.</p>
              ) : (
                <>
                  <div className="h-32 w-full flex items-end gap-1 px-1" role="img" aria-label="Battery estimate history">
                    {bars.map((s, i) => (
                      <div key={s.t} className="flex-1 h-full bg-ink/5 rounded-[4px] relative flex flex-col justify-end overflow-hidden">
                        <motion.div initial={{ height: 0 }} animate={{ height: `${s.pct}%` }} transition={{ duration: 1, delay: i * 0.05 }} className={`w-full rounded-[4px] ${i === bars.length - 1 ? 'bg-ok' : 'bg-ink-3'}`} />
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between text-[12px] font-bold text-ink-3 mt-3 px-1">
                    <span>{new Date(bars[0].t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    <span className="text-ok">Now</span>
                  </div>
                </>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="glass rounded-[20px] p-5 border border-glass-border shadow-sm">
                <p className="text-[13px] font-bold text-ink-2">Voltage</p>
                <p className="text-[24px] font-bold text-ink mt-1">{b.voltage == null ? '—' : `${b.voltage.toFixed(2)} V`}</p>
              </div>
              <div className="glass rounded-[20px] p-5 border border-glass-border shadow-sm">
                <p className="text-[13px] font-bold text-ink-2">Current</p>
                <p className="text-[24px] font-bold text-ink mt-1">{b.currentMa == null ? '—' : `${Math.round(b.currentMa)} mA`}</p>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function LiveAiSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ai = useVoiceAssistant();
  const sosPhase = useSafety((x) => x.phase);
  const netState = useDevice((x) => x.internet);
  const navActive = useNavView((x) => x.active);
  
  useEffect(() => {
    if (!open) {
      ai.cancel();
    }
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: 50, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 50, scale: 0.95 }}
          transition={{ duration: 0.4, type: 'spring', damping: 25 }}
          className="absolute inset-0 z-[100] bg-[#09090b] flex flex-col justify-end overflow-hidden"
        >
          {/* Top text */}
          <div className="absolute top-16 left-0 right-0 flex flex-col items-center z-10 text-white px-6 text-center">
            <div className="bg-white/10 backdrop-blur-md px-4 py-1.5 rounded-full flex items-center gap-2 mb-6">
              <span className="text-[14px] font-semibold text-white/90">{BRAND.name}</span>
            </div>
            <motion.div
              animate={{ opacity: [0.7, 1, 0.7] }}
              transition={{ duration: 3, repeat: Infinity }}
              className="text-[48px] font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-sos via-info to-teal tracking-tight leading-none pb-2"
            >
              Assistant
            </motion.div>
            <p className="text-[22px] font-medium text-white/80 mt-2 leading-tight max-w-[280px]">
              {ai.phase === 'listening' ? (ai.heard || 'Listening...') :
               ai.phase === 'thinking' ? 'Thinking...' :
               ai.phase === 'vision' ? 'Looking through the stick camera...' :
               ai.phase === 'error' ? (ai.unavailable ? `Didn't work: ${ai.unavailable}` : 'That did not work. Try again.') :
               ai.phase === 'interrupted' ? 'Paused for an important message' :
               ai.phase === 'speaking' ? (ai.reply || 'Speaking...') :
               ai.unavailable ? `Assistant unavailable: ${ai.unavailable}` : `How can I help you?`}
            </p>
          </div>

          {/* Gemini-like Aurora Background */}
          <div className="absolute inset-0 z-0 flex items-end justify-center pointer-events-none">
            {/* Bottom glow */}
            <div className="w-[150%] h-[60%] absolute bottom-0 bg-gradient-to-t from-[#0d1b2a] via-[#1b263b] to-transparent" />

            {/* Animated waves */}
            <motion.div
              animate={{
                x: ['-20%', '20%', '-20%'],
                scaleY: [1, 1.2, 1],
                rotate: [0, 5, 0]
              }}
              transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
              className="w-[120%] h-[400px] absolute -bottom-[150px] bg-info/40 blur-[80px] rounded-[100%]"
            />
            <motion.div
              animate={{
                x: ['20%', '-20%', '20%'],
                scaleY: [1, 1.5, 1],
                rotate: [0, -5, 0]
              }}
              transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut' }}
              className="w-[100%] h-[350px] absolute -bottom-[100px] bg-teal/50 blur-[90px] rounded-[100%]"
            />
            <motion.div
              animate={{
                y: ['0%', '-10%', '0%'],
                scaleX: [1, 1.2, 1]
              }}
              transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
              className="w-[80%] h-[300px] absolute -bottom-[50px] bg-mint/30 blur-[70px] rounded-[100%]"
            />
          </div>
          
          <div className="absolute inset-0 flex flex-col items-center justify-center z-20 pointer-events-none mt-16">
             <button 
               className="pointer-events-auto rounded-full active:scale-95 transition-transform interactive"
               onClick={() => ai.phase === 'listening' ? ai.cancel() : ai.start()}
             >
                <AiOrb size={260} phase={orbPhaseFor({ assistant: ai.phase, sosActive: sosPhase === 'active' || sosPhase === 'countdown', internet: netState, navigating: navActive, unavailable: ai.unavailable })} />
             </button>
          </div>

          {/* Controls */}
          <div className="relative z-10 w-full pb-16 pt-10 flex justify-between items-center px-12 bg-gradient-to-t from-black via-black/80 to-transparent">
             <button onClick={onClose} className="w-[52px] h-[52px] rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20 transition-colors backdrop-blur-md interactive">
               <ChevronLeft size={24} />
             </button>
             <div className="flex flex-col items-center gap-2 -mt-4">
               <button 
                  onClick={() => ai.phase === 'listening' ? ai.cancel() : ai.start()}
                  className={`w-[72px] h-[72px] rounded-full flex items-center justify-center transition-colors shadow-lg interactive ${ai.phase === 'listening' ? 'bg-sos text-white hover:bg-sos' : 'bg-white text-black hover:bg-white/90'}`}
               >
                 {ai.phase === 'listening' ? <StopCircle size={32} /> : <Mic size={32} />}
               </button>
               <span className="text-[14px] font-medium text-white/60">{ai.phase === 'listening' ? 'Stop' : 'Tap to talk'}</span>
             </div>
             <div className="w-[52px]" />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}




function SafetyCenterSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const d = useDevice();
  const ev = useSafetyEval();
  const loc = useLocation();
  const linked = useSession((s) => s.linked);
  const guardianPhone = useSession((s) => s.guardian.phone);
  const mode = useRuntime((s) => s.mode);
  const [checked, setChecked] = useState<string | null>(null);
  const good = (ok: boolean | null) => (ok == null ? <div className="w-5 flex justify-center text-ink-3">–</div> : <div className={`w-5 flex justify-center ${ok ? 'text-ok' : 'text-amber'}`}>{ok ? '✓' : '⚠'}</div>);
  const usOk = d.ultrasonic.status === 'ok' || d.ultrasonic.status === 'no_echo' || d.ultrasonic.status === 'out_of_range';

  const runCheck = () => {
    const issues = ev.reasons;
    const text = issues.length ? `Check before walking: ${issues.join('. ')}.` : 'Everything checked is working: stick connected and verified, battery reading fresh, obstacle sensor reporting.';
    setChecked(text);
    announce(text, { high: true });
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ clipPath: 'circle(0% at 50% 50%)' }}
          animate={{ clipPath: 'circle(150% at 50% 50%)' }}
          exit={{ clipPath: 'circle(0% at 50% 50%)' }}
          transition={{ duration: 0.35, ease: 'linear' }}
          className="absolute inset-0 z-50 bg-bg flex flex-col"
        >
          <Atmosphere variant="user" />
          <div className="pt-10 px-4 flex items-center gap-4 z-10 shrink-0 mb-4">
            <button onClick={onClose} className="h-12 w-12 glass interactive rounded-full flex items-center justify-center text-ink shrink-0" aria-label="Back">
              <ChevronLeft size={24} />
            </button>
            <h1 className="text-[20px] font-bold text-ink">Safety Center</h1>
          </div>

          <div className="flex-1 overflow-y-auto no-scrollbar px-4 pb-20">
             <div className="glass rounded-[28px] p-6 mb-6">
                <div className="flex items-center gap-3 mb-2">
                   <div className={`w-4 h-4 rounded-full ${ev.state === 'healthy' ? 'bg-ok' : ev.state === 'warning' || ev.state === 'initializing' ? 'bg-amber' : ev.state === 'unknown' ? 'bg-ink-3' : 'bg-sos'}`} />
                   <h2 className="text-[18px] font-bold text-ink">{ev.state === 'healthy' ? 'All safety systems working' : ev.state === 'unknown' ? 'Safety status unknown' : ev.state === 'initializing' ? 'Starting up' : 'Needs attention'}</h2>
                </div>
                {ev.reasons.length > 0 && <ul className="mb-5 ml-7 list-disc text-[14px] text-ink-2">{ev.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}

                <h3 className="text-[14px] font-bold text-ink-3 uppercase mb-3 mt-4">Stick Hardware</h3>
                <div className="flex flex-col gap-2 mb-6 text-ink font-medium">
                   <div className="flex items-center gap-2">{good(isLinked(d.link))} Link: {linkLabel(d.link).text}</div>
                   <div className="flex items-center gap-2">{good(isLinked(d.link) ? usOk : null)} Obstacle sensor: {isLinked(d.link) ? d.ultrasonic.status.replace('_', ' ') : 'no data'}</div>
                   <div className="flex items-center gap-2">{good(isLinked(d.link) ? d.imu.status === 'ok' : null)} Motion sensor (fall detection): {isLinked(d.link) ? d.imu.status : 'no data'}</div>
                   <div className="flex items-center gap-2">{good(isLinked(d.link) ? d.battery.status === 'ok' : null)} Battery sensor: {batteryLabel(d.battery).sub}</div>
                </div>

                <h3 className="text-[14px] font-bold text-ink-3 uppercase mb-3">Phone</h3>
                <div className="flex flex-col gap-2 mb-6 text-ink font-medium">
                   <div className="flex items-center gap-2">{good(mode === 'demo' ? null : loc.status === 'ok' ? true : loc.status === 'idle' ? null : false)} GPS: {mode === 'demo' ? 'simulated in demo' : loc.fix ? `±${Math.round(loc.fix.accuracyM)} m · ${freshnessLabel(loc.fix.ts)}` : loc.status === 'error' ? 'permission denied' : 'no position yet'}</div>
                   <div className="flex items-center gap-2">{good(d.internet)} Internet: {d.internet == null ? 'checking' : d.internet ? 'online' : 'offline'}</div>
                </div>

                <h3 className="text-[14px] font-bold text-ink-3 uppercase mb-3">Emergency</h3>
                <div className="flex flex-col gap-2 text-ink font-medium">
                   <div className="flex items-center gap-2">{good(linked)} Safety contact linked: {linked ? 'yes' : 'not yet'}</div>
                   <div className="flex items-center gap-2">{good(!!guardianPhone)} Safety phone number for SMS/call: {guardianPhone ? 'saved' : 'missing'}</div>
                </div>
             </div>

             <div className="glass rounded-[28px] p-6">
                <h3 className="text-[18px] font-bold text-ink mb-2">Pre-Walk Check</h3>
                <p className="text-[14px] text-ink-2 mb-4">Checks the stick link, battery, obstacle sensor, GPS and internet, and reads the result aloud.</p>
                <button type="button" onClick={runCheck} className="w-full bg-teal text-on-teal rounded-full h-12 font-bold interactive">
                  Run check
                </button>
                {checked && <p className="mt-3 text-[14px] leading-snug text-ink-2" aria-live="polite">{checked}</p>}
             </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function UserHome() {
  const linkState = useDevice((s) => s.link);
  const battery = useDevice((s) => s.battery);
  const { bind } = usePressPatterns(handleButton);
  const safety = useSafetyEval((s) => s.state);
  const internet = useDevice((s) => s.internet);
  const aiUnavailable = useAssistant((s) => s.unavailable);
  const mode = useRuntime((s) => s.mode);
  const phone = usePhoneInfo();
  const walking = useWalking((s) => s.today);
  const route = useAudioRoute();

  const [safetyCenterOpen, setSafetyCenterOpen] = useState(false);
  const batteryOpen = useUI((s) => s.batteryPage);
  const setBatteryOpen = (v: boolean) => useUI.setState({ batteryPage: v });

  const [chatOpen, setChatOpen] = useState(false);
  const mapOpen = useUI((s) => s.mapOpen);
    const setMapOpen = (v: boolean) => useUI.setState({ mapOpen: v });
  const stickDetailsOpen = useUI((s) => s.stickPage);
  const setStickDetailsOpen = (v: boolean) => useUI.setState({ stickPage: v });
  const liveAiOpen = useUI((s) => s.liveAiOpen);
    const setLiveAiOpen = (v: boolean) => useUI.setState({ liveAiOpen: v });
  const healthOpen = useUI((s) => s.healthOpen);
    const setHealthOpen = (v: boolean) => useUI.setState({ healthOpen: v });
  const audioOpen = useUI((s) => s.audioOpen);
    const setAudioOpen = (v: boolean) => useUI.setState({ audioOpen: v });

  const link = linkLabel(linkState);
  const bat = batteryLabel(battery);
  const safe = safetyLabel(safety);
  const aiState = mode === 'demo' ? { text: 'READY', tone: 'ink' } : internet === false ? { text: 'OFFLINE', tone: 'muted' } : !firebaseConfigured() ? { text: 'NOT SET UP', tone: 'muted' } : aiUnavailable ? { text: 'RETRY', tone: 'warn' } : { text: 'READY', tone: 'ink' };
  const phoneName = mode === 'demo' ? 'Demo phone' : phoneLabel(phone);

  return (
    <AppScreen>
      <SafeAreaContent className="px-5 pb-4" {...bind}>
          <TopNav />

        {/* Big Stick Card */}
        <div className="glass rounded-[36px] p-5 flex border border-glass-border shadow-2xl relative overflow-hidden shrink-0 min-h-[260px] mb-6">
          <div className="absolute inset-0 bg-gradient-to-br from-teal/5 to-info/10 pointer-events-none" />

          <button onClick={() => (linkState === 'unpaired' ? openSetup() : setStickDetailsOpen(true))} aria-label="Stick diagnostics" className="w-[160px] flex flex-col items-center justify-center relative interactive rounded-[20px] p-2 hover:bg-glass-bg transition-colors">
             <StickVisual height={200} />
             <p className="absolute bottom-1 font-bold text-[14px] tracking-widest text-ink uppercase opacity-90 drop-shadow-md">{BRAND.name}</p>
          </button>

          <div className="flex-1 flex flex-col justify-center gap-3 pl-2 pr-1">
             <button
               onClick={() => (linkState === 'unpaired' || linkState === 'auth_failed' ? openSetup() : setStickDetailsOpen(true))}
               aria-label={`Stick: ${link.text}`}
               className="glass rounded-[20px] px-4 py-3 flex flex-col items-center justify-center border border-glass-border interactive text-center"
             >
               {linkState === 'connected' ? <Link2 size={22} className={`${TONE_TEXT[link.tone]} mb-1.5`} /> : <Unlink size={22} className={`${TONE_TEXT[link.tone]} mb-1.5`} />}
               <span className={`${TONE_TEXT[link.tone]} font-bold text-[13px]`}>{link.text}</span>
             </button>
             <button onClick={() => setBatteryOpen(true)} aria-label={`Stick battery ${bat.text}, ${bat.sub}`} className="glass rounded-[20px] px-4 py-3 flex flex-col items-center justify-center border border-glass-border interactive text-center">
               <BatteryFull size={22} className={`${TONE_TEXT[bat.tone]} mb-1.5`} />
               <span className="text-ink font-bold text-[14px]">{bat.text}</span>
             </button>
             <div className="glass rounded-[20px] px-4 py-3 flex flex-col items-center justify-center border border-glass-border" aria-label={`Phone: ${phoneName}`}>
               <Smartphone size={22} className="text-ink-3 mb-1.5" />
               <span className="text-ink font-bold text-[13px] truncate max-w-full">{phoneName}</span>
             </div>
          </div>
        </div>

        {/* Quick Actions Row */}
        <div className="grid grid-cols-2 gap-4 mb-6">
             <button onClick={() => setSafetyCenterOpen(true)} className="flex flex-col items-center justify-center gap-2 glass p-5 rounded-[28px] interactive text-center border border-glass-border h-[130px]">
               <div className="p-3 bg-info/10 rounded-full text-info shrink-0"><ShieldAlert size={28}/></div>
               <div>
                 <p className="text-[13px] text-ink-2 font-bold uppercase tracking-wider">Safety</p>
                 <p className={`text-[15px] font-bold mt-0.5 ${TONE_TEXT[safe.tone]}`}>{safe.text}</p>
               </div>
             </button>

             <button onClick={() => setLiveAiOpen(true)} className="flex flex-col items-center justify-center gap-2 glass p-5 rounded-[28px] interactive text-center border border-glass-border h-[130px]">
               <div className="p-3 bg-teal/10 rounded-full text-teal shrink-0"><Wand2 size={28}/></div>
               <div>
                 <p className="text-[13px] text-ink-2 font-bold uppercase tracking-wider">AI Assistant</p>
                 <p className={`text-[15px] font-bold mt-0.5 ${aiState.tone === 'ink' ? 'text-ink' : TONE_TEXT[aiState.tone as 'muted' | 'warn']}`}>{aiState.text}</p>
               </div>
             </button>

             <button onClick={() => setAudioOpen(true)} className="col-span-2 flex items-center justify-between gap-4 glass p-5 rounded-[28px] interactive border border-glass-border hover:bg-glass-bg transition-colors">
               <div className="flex items-center gap-4">
                 <div className="p-3 bg-info/10 rounded-full text-info shrink-0">
                   {route.route === 'bluetooth' ? <Bluetooth size={28} /> : route.route === 'speaker' ? <Speaker size={28} /> : <Headphones size={28}/>}
                 </div>
                 <div className="text-left">
                   <p className="text-[13px] text-ink-2 font-bold uppercase tracking-wider">Audio Output</p>
                   <p className={`${route.route === 'unknown' ? 'text-ink-3' : 'text-ink'} text-[15px] font-bold mt-0.5`}>
                     {route.route === 'bluetooth' ? (route.name ?? 'BLUETOOTH').toUpperCase() : route.route === 'wired' ? 'WIRED HEADPHONES' : route.route === 'speaker' ? 'PHONE SPEAKER' : 'SYSTEM DEFAULT'}
                   </p>
                 </div>
               </div>
               <div className="w-10 h-10 rounded-full bg-ink/5 flex items-center justify-center text-ink-3">
                 <ChevronLeft size={20} className="rotate-180" />
               </div>
             </button>

             <button onClick={() => setHealthOpen(true)} className="col-span-2 flex items-center justify-between gap-4 glass p-5 rounded-[28px] interactive border border-glass-border hover:bg-glass-bg transition-colors mt-2">
               <div className="flex items-center gap-4">
                 <div className="p-3 bg-teal/10 rounded-full text-teal shrink-0">
                   <Footprints size={28}/>
                 </div>
                 <div className="text-left">
                   <p className="text-[13px] text-ink-2 font-bold uppercase tracking-wider">Distance Walked</p>
                   <p className="text-[15px] font-bold text-ink mt-0.5">{walking.distanceM > 0 ? km(walking.distanceM) : 'No walk yet today'} {walking.durationS > 0 && <span className="text-ink-3 font-normal text-[13px] ml-1">({mins(walking.durationS)})</span>}</p>
                 </div>
               </div>
               <div className="w-10 h-10 rounded-full bg-ink/5 flex items-center justify-center text-ink-3">
                 <ChevronLeft size={20} className="rotate-180" />
               </div>
             </button>
             <button onClick={() => setChatOpen(true)} className="col-span-2 flex items-center justify-between gap-4 glass p-5 rounded-[28px] interactive border border-glass-border hover:bg-glass-bg transition-colors mt-2">
               <div className="flex items-center gap-4">
                 <div className="p-3 bg-info/10 rounded-full text-info shrink-0">
                   <MessageSquare size={28}/>
                 </div>
                 <div className="text-left">
                   <p className="text-[13px] text-ink-2 font-bold uppercase tracking-wider">AI History</p>
                   <p className="text-[15px] font-bold text-ink mt-0.5">OPEN CONVERSATIONS</p>
                 </div>
               </div>
               <div className="w-10 h-10 rounded-full bg-ink/5 flex items-center justify-center text-ink-3">
                 <ChevronLeft size={20} className="rotate-180" />
               </div>
             </button>
        </div>

        {/* Unified Bottom Control Card */}
        <div className="mt-auto shrink-0 pt-2 pb-6 flex flex-col">
          <div className="glass rounded-[32px] p-2 border border-glass-border flex flex-col gap-2 shadow-lg bg-bg/40 backdrop-blur-md">
             <button
                className={`w-full bg-sos text-white rounded-[24px] h-[72px] flex items-center justify-center gap-3 font-bold text-[20px] shadow-[0_10px_30px_-8px_var(--sos)] active:scale-95 transition-all interactive`}
                onClick={(e) => {
                   e.stopPropagation();
                   startSos('button');
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                aria-label="Trigger Emergency SOS"
             >
                <>
                  <Phone size={28} /> Trigger Emergency SOS
                </>
             </button>

             <div className="flex items-center justify-between h-[64px] bg-ink/5 rounded-[24px] shadow-inner">
                <button
                  className="flex-1 h-full flex items-center justify-center gap-3 font-bold text-[16px] text-ink interactive rounded-[24px] hover:bg-ink/10 transition-colors"
                  onClick={() => useUI.setState({ pocket: true })}
                >
                  <Smartphone size={20} className="text-ink-2" />
                  <span className="tracking-wide">Pocket</span>
                </button>
                <div className="w-[1px] h-8 bg-ink/10 shrink-0" />
                <button
                  className="flex-1 h-full flex items-center justify-center gap-3 font-bold text-[16px] text-ink interactive rounded-[24px] hover:bg-ink/10 transition-colors"
                  onClick={() => setMapOpen(true)}
                >
                  <Map size={20} className="text-ink-2" />
                  <span className="tracking-wide">Map</span>
                </button>
             </div>
          </div>
        </div>
      </SafeAreaContent>

      <SafetyCenterSubpage open={safetyCenterOpen} onClose={() => setSafetyCenterOpen(false)} />
      <AiChatSubpage open={chatOpen} onClose={() => setChatOpen(false)} />
      <WalkingSubpage open={mapOpen} onClose={() => setMapOpen(false)} />
      <StickDetailsSubpage open={stickDetailsOpen} onClose={() => setStickDetailsOpen(false)} />
      <BatterySubpage open={batteryOpen} onClose={() => setBatteryOpen(false)} />
      <HealthSubpage open={healthOpen} onClose={() => setHealthOpen(false)} />
      <LiveAiSubpage open={liveAiOpen} onClose={() => setLiveAiOpen(false)} />
      <AudioSubpage open={audioOpen} onClose={() => setAudioOpen(false)} />
    </AppScreen>
  );
}
