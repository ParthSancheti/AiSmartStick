import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Bell, Contrast, Cpu, Eye, Globe, Hand, Languages, LogOut, Mic, MonitorSmartphone, Moon, Sun, PersonStanding, RefreshCw, SlidersHorizontal, Sparkles, Timer, UserRound, Users, ChevronLeft, ChevronRight, Battery, Wifi, Smartphone, ShieldAlert, Trash2, Radar, Vibrate, ScanEye } from 'lucide-react';
import { useSession, type Settings } from '../../core/store/session';
import { useUI, toastGuardian } from '../../core/store/ui';
import { useFeed, feedFresh, guardianActions } from '../../core/sync/guardianFeed';
import { friendlyError } from '../../core/errors';
import { useRuntime, switchMode } from '../../core/runtime/mode';
import { ENV } from '../../core/runtime/env';
import { BRAND } from '../../core/brand/brand';
import { useAuth } from '../../core/auth/authStore';
import { signOut, deleteAccount } from '../../core/auth/authService';
import { revokeRelationship, updateRelationship } from '../../core/pairing/pairingService';
import { writeUserSafetySettings } from '../../core/sync/settingsSync';
import { linkLabel, batteryLabel } from '../shared/labels';
import type { LinkState } from '../../core/types';
import { Segmented, Toggle } from '../../components/glass';
import { PersonAvatar } from './parts';
import { Atmosphere } from '../../components/Atmosphere';
import { StickVisual } from '../../components/StickVisual';

function GuardianProfileSheet({ open, onClose }: { open: boolean, onClose: () => void }) {
  const person = useSession(s => s.person);
  const guardian = useSession(s => s.guardian);
  const setSession = useSession(s => s.set);
  const feedName = useFeed((s) => s.userName);
  const demo = useRuntime((s) => s.mode) === 'demo';
  const [personName, setPersonName] = useState(feedName || person.name);
  const [heardAs, setHeardAs] = useState(guardian.heardAs);
  const [phone, setPhone] = useState(guardian.phone ?? '');
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setErr(null);
    setSession({ person: { ...person, name: personName }, guardian: { ...guardian, heardAs, phone: phone.trim() || null } });
    if (!demo) {
      try {
        await updateRelationship({ heardAs: heardAs.trim(), guardianPhone: phone.trim() || null, userName: personName.trim() });
      } catch (e) {
        setErr((e as Error).message);
        return;
      }
    }
    onClose();
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="absolute inset-0 z-40 bg-black/40 backdrop-blur-sm" />
          <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', damping: 25, stiffness: 300 }} className="absolute bottom-0 left-0 right-0 z-50 bg-bg rounded-t-[32px] p-6 pb-safe">
            <div className="w-12 h-1.5 bg-ink/20 rounded-full mx-auto mb-6" />
            <h2 className="text-[22px] font-bold text-ink mb-6">Edit Profile</h2>
            
            <div className="flex flex-col gap-4 mb-8">
              <div className="glass rounded-[20px] p-4 border border-glass-border">
                <label className="text-[13px] font-bold text-ink-3 uppercase block mb-2">{BRAND.name} user's name</label>
                <input type="text" value={personName} onChange={e => setPersonName(e.target.value)} className="w-full bg-transparent text-[18px] font-semibold text-ink outline-none" />
              </div>
              <div className="glass rounded-[20px] p-4 border border-glass-border">
                <label className="text-[13px] font-bold text-ink-3 uppercase block mb-2">User hears you as</label>
                <input type="text" value={heardAs} onChange={e => setHeardAs(e.target.value)} className="w-full bg-transparent text-[18px] font-semibold text-ink outline-none" />
              </div>
              <div className="glass rounded-[20px] p-4 border border-glass-border">
                <label className="text-[13px] font-bold text-ink-3 uppercase block mb-2">Your number (SOS texts & calls)</label>
                <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+91 …" className="w-full bg-transparent text-[18px] font-semibold text-ink outline-none" />
              </div>
              {err && <p className="rounded-[16px] bg-amber-soft px-4 py-3 text-[14px] font-medium text-amber-ink" role="alert">{err}</p>}
            </div>

            <button onClick={() => void save()} className="w-full h-14 bg-teal text-white text-[16px] font-bold rounded-[20px] shadow-lg active:scale-95 transition-transform">
              Save Changes
            </button>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

/* ──────── Shared components from UserSettings ──────── */
function BigRow({ icon, label, detail, on, onChange }: { icon: React.ReactNode; label: string; detail?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex min-h-[76px] items-center gap-4 px-4 py-3">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-teal-soft text-teal-ink">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[19px] font-semibold leading-tight text-ink">{label}</p>
        {detail && <p className="mt-0.5 text-[15px] leading-snug text-ink-3">{detail}</p>}
      </div>
      <Toggle label={label} on={on} onChange={onChange} />
    </div>
  );
}

function NavRow({ icon, iconBg, label, detail, onClick }: { icon: React.ReactNode; iconBg: string; label: string; detail?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex min-h-[72px] items-center gap-4 px-4 py-3 w-full text-left interactive">
      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-[14px] ${iconBg}`}>{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[17px] font-semibold leading-tight text-ink">{label}</p>
        {detail && <p className="mt-0.5 text-[14px] leading-snug text-ink-3">{detail}</p>}
      </div>
      <ChevronRight size={20} className="text-ink-3 shrink-0" />
    </button>
  );
}

function GuardianSafetySubpage({ open, onClose, onEditNumber }: { open: boolean, onClose: () => void, onEditNumber: () => void }) {
  const local = useSession((x) => x.settings);
  const demo = useRuntime((x) => x.mode) === 'demo';
  const remote = useFeed((x) => x.userSafety);
  const permitted = useFeed((x) => !!x.permissions?.safetySettings);
  const canEdit = demo || permitted;
  const phone = useSession((x) => x.guardian.phone);
  // Real mode: these are the STICK USER's SOS settings (read from their account, written with permission).
  const s = demo || !remote ? local : { ...local, ...remote };
  const update = (p: Partial<Pick<Settings, 'sosTriggers' | 'sosCancelSec'>>) => {
    if (demo) return useSession.getState().updateSettings(p);
    if (!canEdit) return toastGuardian('You do not have permission to change their SOS settings');
    void writeUserSafetySettings(p).then(() => toastGuardian('Saved to their phone')).catch((e) => toastGuardian(`Not saved. ${friendlyError(e)}`));
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="absolute inset-0 z-[70] bg-bg overflow-y-auto no-scrollbar"
        >
          <Atmosphere variant="guardian" />
          <div className="px-4 pb-8" style={{ paddingTop: 'calc(var(--island, 0px) + 12px)' }}>
            <div className="mb-6 mt-8 flex items-center gap-4">
              <button onClick={onClose} className="h-12 w-12 glass interactive rounded-full flex items-center justify-center text-ink shrink-0">
                <ChevronLeft size={24} />
              </button>
              <h1 className="text-[28px] font-bold tracking-[-0.02em] text-ink">Safety & SOS</h1>
            </div>
            
            <div className="glass overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line border border-glass-border">
              <BigRow icon={<Hand size={20} />} label="Hold button for 3s" on={s.sosTriggers.button} onChange={(v) => update({ sosTriggers: { ...s.sosTriggers, button: v } })} />
              <BigRow icon={<Mic size={20} />} label="Say 'bachao' or 'emergency'" on={s.sosTriggers.voice} onChange={(v) => update({ sosTriggers: { ...s.sosTriggers, voice: v } })} />
              <BigRow icon={<PersonStanding size={20} />} label="Fall detection" detail="Motion sensor on stick" on={s.sosTriggers.fall} onChange={(v) => update({ sosTriggers: { ...s.sosTriggers, fall: v } })} />
              <div className="px-4 py-3">
                <p className="mb-2 flex items-center gap-2 text-[16px] font-medium text-ink">
                  <Timer size={18} className="text-ink-3" /> Time to cancel
                </p>
                <Segmented label="Time to cancel" size="sm" value={s.sosCancelSec} onChange={(v) => update({ sosCancelSec: v })} options={[3, 5, 8, 10].map((n) => ({ value: n, label: `${n} s` }))} />
              </div>
              <BigRow icon={<Bell size={20} />} label="Siren on this phone" detail="Plays until you acknowledge" on={local.siren} onChange={(v) => useSession.getState().updateSettings({ siren: v })} />
              <NavRow icon={<Users size={20} />} iconBg="bg-info/10 text-info" label="Your number for SOS texts" detail={phone ?? 'No number saved: offline SOS texts cannot reach you'} onClick={onEditNumber} />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function GuardianPrivacySubpage({ open, onClose }: { open: boolean, onClose: () => void }) {
  const s = useSession((x) => x.settings);
  const update = useSession((x) => x.updateSettings);
  const name = useFeed((x) => x.userName) || 'They';

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="absolute inset-0 z-[70] bg-bg overflow-y-auto no-scrollbar"
        >
          <Atmosphere variant="guardian" />
          <div className="px-4 pb-8" style={{ paddingTop: 'calc(var(--island, 0px) + 12px)' }}>
            <div className="mb-6 mt-8 flex items-center gap-4">
              <button onClick={onClose} className="h-12 w-12 glass interactive rounded-full flex items-center justify-center text-ink shrink-0">
                <ChevronLeft size={24} />
              </button>
              <h1 className="text-[28px] font-bold tracking-[-0.02em] text-ink">Privacy & Prefs</h1>
            </div>
            
            <div className="glass overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line border border-glass-border">
              <div className="flex min-h-[76px] items-center gap-4 px-4 py-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-teal-soft text-teal-ink"><Eye size={20} /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-[19px] font-semibold leading-tight text-ink">Camera view is always announced</p>
                  <p className="mt-0.5 text-[15px] leading-snug text-ink-3">{name} always hears when you request or view the camera. This cannot be turned off.</p>
                </div>
              </div>
              <BigRow icon={<Bell size={20} />} label="Notify: stick disconnected" on={s.notify.deviceDisconnected} onChange={(v) => update({ notify: { ...s.notify, deviceDisconnected: v } })} />
              <BigRow icon={<Battery size={20} />} label="Notify: stick battery low" on={s.notify.lowBattery} onChange={(v) => update({ notify: { ...s.notify, lowBattery: v } })} />
              <BigRow icon={<Wifi size={20} />} label="Notify: location out of date" on={s.notify.locationStale} onChange={(v) => update({ notify: { ...s.notify, locationStale: v } })} />
              <div className="px-4 py-3">
                <p className="mb-2 flex items-center gap-2 text-[16px] font-medium text-ink">
                  <Contrast size={18} className="text-ink-3" /> Glass effect
                </p>
                <Segmented label="Glass effect" size="sm" value={s.glass} onChange={(v) => update({ glass: v })} options={[{ value: 'auto', label: 'Auto' }, { value: 'full', label: 'Full' }, { value: 'lite', label: 'Light' }, { value: 'solid', label: 'Solid' }]} />
              </div>
              <BigRow icon={<Sparkles size={20} />} label="Reduce motion" on={s.reduceMotion} onChange={(v) => update({ reduceMotion: v })} />
              <BigRow icon={<SlidersHorizontal size={20} />} label="Vibration" on={s.haptics} onChange={(v) => update({ haptics: v })} />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function GuardianSettings() {
  const s = useSession((x) => x.settings);
  const update = useSession((x) => x.updateSettings);
  const guardian = useSession((x) => x.guardian);
  const f = useFeed();
  const person = { name: f.userName || 'Your person' };
  const layout = useUI((x) => x.layout);
  const mode = useRuntime((x) => x.mode);
  const user = useAuth((x) => x.user);
  const fresh = feedFresh(f.device?.updatedAt);
  const linkState: LinkState | 'unknown' = f.device && fresh ? (f.device.link as LinkState) : 'unknown';
  const bat = batteryLabel(f.device ? { status: fresh ? (f.device.battery.status as 'ok') : 'stale', percent: f.device.battery.percent, charging: f.device.battery.charging } : null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [cmdBusy, setCmdBusy] = useState<string | null>(null);
  const remote = async (type: 'locate' | 'nudge' | 'scan') => {
    if (cmdBusy) return;
    setCmdBusy(type);
    try {
      const r = await guardianActions.remoteCommand(type);
      if (r.status === 'completed') toastGuardian(type === 'scan' ? `Scan: ${String(r.result?.spoken ?? 'done')}` : type === 'locate' ? 'The stick is vibrating' : 'Nudge delivered');
      else toastGuardian(`Not done: ${r.error ?? r.status}`);
    } catch (e) {
      toastGuardian(friendlyError(e));
    } finally {
      setCmdBusy(null);
    }
  };

  const [profileOpen, setProfileOpen] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const isDark = s.theme === 'dark' || (s.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const close = () => useUI.setState({ guardianTab: 'home' });

  return (
    <div className="absolute inset-0 z-[60] bg-bg overflow-y-auto no-scrollbar">
      <Atmosphere variant="guardian" />
      <div className="px-4 pb-8" style={{ paddingTop: 'calc(var(--island, 0px) + 12px)' }}>
        <div className="mb-5 mt-8 flex items-center gap-4">
          <button onClick={close} className="h-12 w-12 glass interactive rounded-full flex items-center justify-center text-ink shrink-0">
            <ChevronLeft size={24} />
          </button>
          <h1 className="text-[28px] font-bold tracking-[-0.02em] text-ink">Settings</h1>
        </div>

        {/* ──── MIUI-Style Hero Grid ──── */}
        <div className="flex gap-3 mb-6 h-[240px]">
          {/* Stick Visual Box - Left (Big) */}
          <button 
            onClick={() => useUI.setState({ guardianTab: 'vision' })}
            aria-label="Stick sensor view"
            className="glass flex-1 rounded-[28px] p-5 border border-glass-border flex flex-col items-center justify-center relative overflow-hidden shadow-lg interactive"
          >
            <div className="absolute inset-0 bg-gradient-to-br from-teal/10 to-teal/5 pointer-events-none" />
            <div className="absolute -top-10 -left-10 w-40 h-40 bg-teal/15 rounded-full blur-2xl pointer-events-none" />
            <div className="flex-1 flex flex-col justify-center items-center relative z-10 w-full">
              <StickVisual link={linkState === 'unknown' ? 'disconnected' : linkState} obstacleCm={null} pose={null} height={160} />
              <p className="text-[15px] font-bold text-ink mt-3 tracking-wide uppercase opacity-80">{BRAND.name}</p>
            </div>
          </button>

          {/* Info Column - Right */}
          <div className="w-[140px] flex flex-col gap-3 shrink-0">
            {/* Brand / version box */}
            <div 
              className="glass flex-1 rounded-[24px] p-4 border border-glass-border flex flex-col justify-between shadow-sm relative overflow-hidden"
            >
              <div className="flex items-baseline justify-center mt-2 relative z-10">
                <span className="text-[40px] font-black text-transparent bg-clip-text bg-gradient-to-br from-teal to-mint leading-none drop-shadow-sm">V1</span>
              </div>
              <div className="text-center mb-1 relative z-10">
                <p className="text-[13px] font-bold text-ink">{BRAND.name}</p>
                <p className="text-[11px] text-ink-3">v{ENV.appVersion}</p>
              </div>
            </div>

            {/* Device Health Mini */}
            <button 
              onClick={() => useUI.setState({ guardianTab: 'home' })}
              className="glass flex-1 rounded-[24px] p-3 border border-glass-border flex flex-col justify-center shadow-sm interactive"
            >
              <p className="text-[12px] font-bold text-ink-3 uppercase tracking-wider mb-2 text-center">Health</p>
              <div className="flex items-center gap-2 justify-center mb-2">
                <Battery size={16} className={bat.tone === 'ok' ? 'text-ok' : bat.tone === 'warn' ? 'text-amber' : bat.tone === 'sos' ? 'text-sos' : 'text-ink-3'} />
                <span className="text-[16px] font-bold text-ink">{bat.text}</span>
              </div>
              <div className="flex items-center justify-center gap-1.5">
                <Wifi size={14} className={linkState === 'connected' ? "text-teal" : "text-ink-3"} />
                <span className="text-[12px] font-medium text-ink-2">{linkLabel(linkState).text}</span>
              </div>
            </button>
          </div>
        </div>

        {/* ──── Quick Action Cards ──── */}
        <div className="flex flex-col gap-3 mb-6">
          {/* Theme Toggle */}
          <motion.button 
            whileTap={{ scale: 0.98 }}
            onClick={() => update({ theme: isDark ? 'light' : 'dark' })}
            className="glass rounded-[24px] p-5 border border-glass-border flex items-center gap-4 w-full text-left interactive shadow-sm"
          >
            <div className={`p-3 rounded-[14px] ${isDark ? 'bg-info/10 text-info' : 'bg-amber/10 text-amber'}`}>
              {isDark ? <Moon size={24} /> : <Sun size={24} />}
            </div>
            <div className="flex-1">
              <p className="text-[17px] font-bold text-ink">Appearance</p>
              <p className="text-[14px] text-ink-3 mt-0.5">{isDark ? 'Dark Mode' : 'Light Mode'}</p>
            </div>
            <div className="w-[52px] h-8 bg-ink/10 rounded-full relative p-1 shrink-0 border border-ink/5">
              <motion.div 
                initial={false}
                animate={{ x: isDark ? 24 : 0 }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
                className={`w-6 h-6 rounded-full shadow-sm ${isDark ? 'bg-info' : 'bg-amber'}`}
              />
            </div>
          </motion.button>
          
          {/* Profile Card */}
          <button 
            onClick={() => setProfileOpen(true)}
            className="glass rounded-[24px] p-5 border border-glass-border flex items-center gap-4 shadow-sm interactive w-full text-left"
          >
            <div className="p-3 bg-info/10 rounded-[14px] text-info">
              <UserRound size={24} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[17px] font-bold text-ink">{person.name}'s Profile</p>
              <p className="text-[14px] text-ink-3 mt-0.5 truncate italic">
                {guardian.heardAs ? `Hears you as "${guardian.heardAs}"` : 'Set how they hear you'}
              </p>
            </div>
            <ChevronRight size={20} className="text-ink-3 shrink-0" />
          </button>
        </div>

        {/* ──── Settings Groups (NavRow style) ──── */}
        <div className="flex flex-col gap-6 mb-8">
          {/* AI SMART STICK */}
          <div>
            <h2 className="mb-2 px-1 text-[14px] font-bold text-ink-3 uppercase tracking-wider">AI SMART STICK</h2>
            <div className="glass overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line border border-glass-border">
              <NavRow 
                icon={<Cpu size={20} />} iconBg="bg-teal/10 text-teal" 
                label={f.device?.deviceId ?? 'No stick reported'} detail={f.device?.firmware ? `Firmware ${f.device.firmware}` : 'Firmware unknown'}
                onClick={() => useUI.setState({ guardianTab: 'home' })} 
              />
              <NavRow 
                icon={<Radar size={20} />} iconBg="bg-teal/10 text-teal" 
                label="Find the stick" detail={cmdBusy === 'locate' ? 'Waiting for their phone…' : 'Vibrates the stick through their phone'}
                onClick={() => void remote('locate')} 
              />
              <NavRow 
                icon={<Vibrate size={20} />} iconBg="bg-teal/10 text-teal" 
                label="Send a nudge" detail={cmdBusy === 'nudge' ? 'Waiting for their phone…' : 'A gentle vibration and spoken note'}
                onClick={() => void remote('nudge')} 
              />
              <NavRow 
                icon={<ScanEye size={20} />} iconBg="bg-info/10 text-info" 
                label="Ask for an AI scan" detail={cmdBusy === 'scan' ? 'Waiting for their phone…' : `${person.name} hears the request; you get a text summary`}
                onClick={() => void remote('scan')} 
              />
              <NavRow 
                icon={<RefreshCw size={20} />} iconBg="bg-info/10 text-info" 
                label="Set up the stick again" detail={`Done on ${person.name}'s phone`}
                onClick={() => toastGuardian(`On ${person.name}'s phone: Settings → Hardware → Set up again`)} 
              />
            </div>
          </div>

          {/* SAFETY */}
          <div>
            <h2 className="mb-2 px-1 text-[14px] font-bold text-ink-3 uppercase tracking-wider">SAFETY & SOS</h2>
            <div className="glass overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line border border-glass-border">
              <NavRow 
                icon={<ShieldAlert size={20} />} iconBg="bg-sos/10 text-sos" 
                label="Emergency & SOS" detail="Contacts, countdown, fall detection"
                onClick={() => setSafetyOpen(true)} 
              />
            </div>
          </div>

          {/* PRIVACY & APPEARANCE */}
          <div>
            <h2 className="mb-2 px-1 text-[14px] font-bold text-ink-3 uppercase tracking-wider">PRIVACY & PREFERENCES</h2>
            <div className="glass overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line border border-glass-border">
              <NavRow 
                icon={<Eye size={20} />} iconBg="bg-ink-3/10 text-ink-3" 
                label="Privacy & Preferences" detail="Announce camera, haptics, motion"
                onClick={() => setPrivacyOpen(true)} 
              />
            </div>
          </div>

          {/* LANGUAGE */}
          <div>
            <h2 className="mb-2 px-1 text-[14px] font-bold text-ink-3 uppercase tracking-wider">LANGUAGE</h2>
            <div className="glass overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line border border-glass-border">
              <NavRow 
                icon={<Globe size={20} />} iconBg="bg-ink-3/10 text-ink-3" 
                label="App language" detail="English (the only interface language for now)"
                onClick={() => toastGuardian('More interface languages are planned. The assistant already speaks Hindi and English.')} 
              />
              <NavRow 
                icon={<Languages size={20} />} iconBg="bg-info/10 text-info" 
                label="Assistant replies in" detail={`Set on ${person.name}'s phone (Accessibility)`}
                onClick={() => toastGuardian(`${person.name} chooses the reply language on their phone`)} 
              />
            </div>
          </div>

          {/* DEMO (demo mode only) */}
          {mode === 'demo' && (<div>
            <h2 className="mb-2 px-1 text-[14px] font-bold text-ink-3 uppercase tracking-wider">DEMO</h2>
            <div className="glass overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line border border-glass-border">
              <NavRow 
                icon={<MonitorSmartphone size={20} />} iconBg="bg-amber/10 text-amber" 
                label="Demo controls" detail="Simulate the stick, network and other phone"
                onClick={() => useUI.setState({ demoOpen: true })} 
              />
              {layout === 'single' && (
                <NavRow 
                  icon={<Smartphone size={20} />} iconBg="bg-teal/10 text-teal" 
                  label="Switch to stick user's app" detail=""
                  onClick={() => useSession.setState({ entryRole: 'user' })} 
                />
              )}
            </div>
          </div>)}

          {/* ACCOUNT */}
          <div>
            <h2 className="mb-2 px-1 text-[14px] font-bold text-ink-3 uppercase tracking-wider">ACCOUNT</h2>
            <div className="glass overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line border border-glass-border">
              <div className="flex items-center gap-4 px-4 py-3 w-full text-left">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-ink/5">
                  <PersonAvatar size={36} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[17px] font-semibold leading-tight text-ink">{user?.displayName ?? guardian.name ?? 'Guardian'}</p>
                  <p className="mt-0.5 text-[14px] leading-snug text-ink-3">{mode === 'demo' ? 'Demo mode · no account' : `Signed in as ${user?.email ?? 'unknown'}`}</p>
                </div>
              </div>
              {mode === 'real' && f.userUid && (
                <NavRow 
                  icon={<Users size={20} />} iconBg="bg-amber/10 text-amber" 
                  label={`Unlink ${person.name}`} detail="Stop receiving their location and alerts"
                  onClick={() => setConfirmUnlink(true)} 
                />
              )}
              <NavRow 
                icon={<MonitorSmartphone size={20} />} iconBg="bg-ink/5 text-ink-2" 
                label={mode === 'demo' ? 'Leave demo mode' : 'Demo mode'} detail={mode === 'demo' ? 'Restart with real accounts and data' : 'Restart with simulated data'}
                onClick={() => switchMode(mode === 'demo' ? 'real' : 'demo')} 
              />
              {mode === 'real' && (
                <NavRow 
                  icon={<Trash2 size={20} />} iconBg="bg-sos/10 text-sos" 
                  label="Delete account" detail="Removes your account and unlinks"
                  onClick={() => setConfirmDelete(true)} 
                />
              )}
              <NavRow 
                icon={<LogOut size={20} />} iconBg="bg-sos/10 text-sos" 
                label="Sign out" detail=""
                onClick={() => {
                  if (mode === 'real') void signOut();
                  useSession.setState({ guardianOnboarded: false, entryRole: layout === 'single' && ENV.appTarget === 'both' ? null : useSession.getState().entryRole });
                }} 
              />
            </div>
          </div>

        </div>
      </div>
      <GuardianProfileSheet open={profileOpen} onClose={() => setProfileOpen(false)} />
      <GuardianSafetySubpage open={safetyOpen} onClose={() => setSafetyOpen(false)} onEditNumber={() => { setSafetyOpen(false); setProfileOpen(true); }} />
      {confirmDelete && (
        <div className="absolute inset-x-4 bottom-28 z-[80] glass rounded-[24px] border border-sos/30 p-4 shadow-2xl">
          <p className="text-[15px] font-semibold text-ink">Delete your guardian account permanently? You will be unlinked and your settings removed.</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" className="h-11 rounded-full glass font-semibold text-ink" onClick={() => setConfirmDelete(false)}>Cancel</button>
            <button type="button" className="h-11 rounded-full bg-sos font-semibold text-white" onClick={() => { setConfirmDelete(false); void deleteAccount().catch((e) => toastGuardian(`Not deleted. ${friendlyError(e)}`)); }}>Delete</button>
          </div>
        </div>
      )}
      {confirmUnlink && (
        <div className="absolute inset-x-4 bottom-28 z-[80] glass rounded-[24px] border border-sos/30 p-4 shadow-2xl">
          <p className="text-[15px] font-semibold text-ink">Unlink {person.name}? You will stop seeing their location, activity and SOS alerts.</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" className="h-11 rounded-full glass font-semibold text-ink" onClick={() => setConfirmUnlink(false)}>Cancel</button>
            <button type="button" className="h-11 rounded-full bg-sos font-semibold text-white" onClick={() => { setConfirmUnlink(false); void revokeRelationship().then(() => useSession.setState({ guardianOnboarded: false })).catch((e) => toastGuardian(`Not unlinked. ${friendlyError(e)}`)); }}>Unlink</button>
          </div>
        </div>
      )}
      <GuardianPrivacySubpage open={privacyOpen} onClose={() => setPrivacyOpen(false)} />
    </div>
  );
}
