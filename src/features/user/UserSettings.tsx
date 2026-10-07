import { AnimatePresence, motion } from 'motion/react';
import { useBackHandler } from '../../core/backStack';
import { toggleThemeWithTransition } from '../../util/theme';
import { Accessibility, AlertTriangle, Battery, Check, ChevronLeft, ChevronRight, Contrast, Heart, Home, Mic, Minus, Moon, Plus, Shield, Smartphone, Sun, User, Vibrate, Volume2, Wifi, Search, Download, Unplug, ShieldAlert, ScanEye, MessageSquare, Sparkles, Radar, MapPin, Phone, Pencil } from 'lucide-react';
import { EventRow } from '../guardian/parts';
import { useUI } from '../../core/store/ui';
import { useRuntime, switchMode } from '../../core/runtime/mode';
import { ENV } from '../../core/runtime/env';
import { BRAND } from '../../core/brand/brand';
import { deleteAccount } from '../../core/auth/authService';
import { useAuth } from '../../core/auth/authStore';
import { getTransport, getMock } from '../../core/device/bridge';
import { unpairStick, connectLegacyTestFirmware } from '../../core/device/realDevice';
import { verifyFirmware } from '../../core/device/otaVerify';
import { call } from '../../core/backend/api';
import { calibrateImuFromLatest, setImuCalibration } from '../../core/telemetry/pipeline';
import { usePhoneInfo, phoneLabel } from '../../core/native/deviceInfo';
import { useActivity } from '../../core/store/activity';
import { batteryLabel, linkLabel } from '../shared/labels';
import { haptics } from '../../core/feedback/haptics';
import { earcon } from '../../core/feedback/earcons';
import { say } from '../../core/audio/audioManager';
import { AissNative } from '../../core/native/aissNative';
import { SENSITIVITY } from '../../core/device/deviceConfig';
import { emptyMedical, loadMedical, saveMedical, type MedicalProfile } from '../../core/profile/medical';
import { cleanName, setProfileName, useProfileName } from '../../core/profile/profile';
import { friendlyError } from '../../core/errors';
import { useBackground } from '../../core/native/background';
import { useSession } from '../../core/store/session';
import { useDevice, isLinked } from '../../core/store/device';
import { StickVisual } from '../../components/StickVisual';
import { AccountAvatar, ProfilePhotoEditor } from '../../components/Avatar';
import { AppScreen, ScreenHeader } from '../../components/Layout';
import { recognitionSupported } from '../../core/voice/recognition';
import { speak } from '../../core/feedback/speech';
import { GlassButton, Segmented, Toggle } from '../../components/glass';
import { clamp } from '../../core/util';
import { Atmosphere } from '../../components/Atmosphere';
import { HomeLocationStep } from './onboarding/HomeLocationStep';
import { useState, useEffect, useRef, type ReactNode } from 'react';
import type { Contact } from '../../core/types';

/* ──────── Page frame: fixed header, only the content scrolls ──────── */

const EASE: [number, number, number, number] = [0.3, 0, 0.2, 1];
/** Short tween instead of a spring: no overshoot work on slow Android WebViews. */
const SLIDE = { duration: 0.24, ease: EASE };

/**
 * One settings page: opaque background (a still copy of the ambient background, so two animated
 * backgrounds are never composited), the shared ScreenHeader pinned at the top (it also binds the
 * Android back button), and a scroll area under it. `scroll={false}` for full-height content (map).
 */
function Page({ title, onBack, children, scroll = true }: { title: ReactNode; onBack: () => void; children: ReactNode; scroll?: boolean }) {
  return (
    <AppScreen className="bg-bg">
      <Atmosphere variant="user" still />
      <header className="relative z-20 shrink-0 px-4 pb-2" style={{ paddingTop: 'calc(var(--island, var(--sat)) + 10px)' }}>
        <ScreenHeader title={<span className="text-[19px] font-extrabold tracking-[-0.01em]">{title}</span>} onBack={onBack} />
      </header>
      {scroll ? (
        <div className="relative z-10 min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain no-scrollbar" style={{ paddingBottom: 'calc(var(--sab) + 28px)' }}>
          <div className="mx-auto w-full min-w-0 max-w-[560px] px-4 pt-2">{children}</div>
        </div>
      ) : (
        <div className="relative z-10 min-h-0 flex-1">{children}</div>
      )}
    </AppScreen>
  );
}

/** A page that slides in from the right over Settings. Its content mounts only while open. */
function SubPage({ open, onClose, title, z = 70, scroll, children }: { open: boolean; onClose: () => void; title: ReactNode; z?: number; scroll?: boolean; children: ReactNode }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="absolute inset-0" style={{ zIndex: z }} initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={SLIDE}>
          <Page title={title} onBack={onClose} scroll={scroll}>
            {children}
          </Page>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-2 mt-1 px-1 text-[13px] font-bold uppercase tracking-wider text-ink-3">{children}</h2>;
}

/* ──────── Shared row components ──────── */
function BigRow({ icon, label, detail, on, onChange }: { icon: ReactNode; label: string; detail?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex min-h-[72px] items-center gap-3 px-4 py-3">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-teal-soft text-teal-ink">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="break-words text-[17px] font-semibold leading-tight text-ink">{label}</p>
        {detail && <p className="mt-0.5 break-words text-[14px] leading-snug text-ink-3">{detail}</p>}
      </div>
      <span className="shrink-0">
        <Toggle label={label} on={on} onChange={onChange} />
      </span>
    </div>
  );
}

function NavRow({ icon, iconBg, label, detail, onClick }: { icon: ReactNode; iconBg: string; label: string; detail?: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="interactive flex min-h-[68px] w-full items-center gap-3 px-4 py-3 text-left">
      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-[14px] ${iconBg}`}>{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[16.5px] font-semibold leading-tight text-ink">{label}</p>
        {detail && <p className="mt-0.5 line-clamp-2 text-[13.5px] leading-snug text-ink-3">{detail}</p>}
      </div>
      <ChevronRight size={20} className="shrink-0 text-ink-3" />
    </button>
  );
}

function Field({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <label className="glass block min-w-0 rounded-[20px] px-4 py-3">
      <span className="mb-1 flex items-center gap-2 text-[12.5px] font-bold uppercase tracking-wider text-ink-3">
        {icon}
        {label}
      </span>
      {children}
    </label>
  );
}

const inputCls = 'w-full min-w-0 bg-transparent text-[17px] font-semibold text-ink outline-none placeholder:font-medium placeholder:text-ink-3';

/* ──────── Profile: photo, name, phone, home, medical ──────── */
function ProfileForm({ onDone, onEditHome }: { onDone: () => void; onEditHome: () => void }) {
  const person = useSession((s) => s.person);
  const email = useAuth((s) => s.user?.email ?? '');
  const shownName = useProfileName();
  const home = person.savedPlaces.find((p) => p.id === 'home') ?? null;
  // Initialised once when the page opens: a sync arriving while typing never overwrites the typing.
  const [name, setName] = useState(shownName);
  const [phone, setPhone] = useState(person.phone);
  const [work, setWork] = useState(person.workAddress);
  const [med, setMed] = useState<MedicalProfile>({ ...emptyMedical(), notes: person.medicalId });
  const medTouched = useRef(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadMedical()
      .then((m) => {
        if (alive && m && !medTouched.current) setMed(m);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const editMed = (p: Partial<MedicalProfile>) => {
    medTouched.current = true;
    setMed((m) => ({ ...m, ...p }));
  };

  const save = () => {
    // Everything applies on this phone at once (Home greeting, avatar, assistant, SOS);
    // core/sync/profileSync.ts uploads it — nothing here waits for the network.
    if (cleanName(name) && cleanName(name) !== shownName) setProfileName(name);
    const s = useSession.getState();
    useSession.setState({ person: { ...s.person, phone: phone.trim(), workAddress: work.trim(), medicalId: med.notes.trim() } });
    if (medTouched.current) void saveMedical({ bloodGroup: med.bloodGroup, allergies: med.allergies, medications: med.medications, conditions: med.conditions, notes: med.notes }).catch(() => undefined);
    setSaved(true);
    haptics.play('success');
    setTimeout(onDone, 650);
  };

  return (
    <div className="flex flex-col gap-3 pb-2">
      <div className="mb-2 mt-2 flex justify-center">
        <ProfilePhotoEditor size={112} />
      </div>
      <Field label="Your name">
        <input type="text" value={name} maxLength={60} autoComplete="name" onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="Your name" />
      </Field>
      <Field label="Your phone number" icon={<Phone size={13} />}>
        <input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className={inputCls} placeholder="+91 98765 43210" />
      </Field>
      {email && (
        <div className="glass min-w-0 rounded-[20px] px-4 py-3">
          <p className="mb-1 text-[12.5px] font-bold uppercase tracking-wider text-ink-3">Google account</p>
          <p className="truncate text-[16px] font-semibold text-ink-2">{email}</p>
        </div>
      )}
      <button type="button" onClick={onEditHome} className="glass interactive flex min-w-0 items-center gap-3 rounded-[20px] px-4 py-3 text-left">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-info/10 text-info">
          <Home size={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-bold uppercase tracking-wider text-ink-3">Home</span>
          <span className="block truncate text-[16px] font-semibold text-ink">{home ? home.name || home.address : person.homeAddress || 'Not set'}</span>
        </span>
        <span className="shrink-0 text-[13.5px] font-bold text-teal-ink">{home ? 'Change' : 'Set'}</span>
      </button>
      <Field label="Work / college address">
        <input type="text" value={work} onChange={(e) => setWork(e.target.value)} className={inputCls} placeholder="For daily routes" />
      </Field>
      <div className="glass min-w-0 rounded-[20px] px-4 py-3">
        <p className="mb-2 flex items-center gap-2 text-[12.5px] font-bold uppercase tracking-wider text-ink-3">
          <Heart size={13} className="text-sos" /> Medical ID (optional)
        </p>
        <div className="grid grid-cols-2 gap-2">
          <input type="text" value={med.bloodGroup} onChange={(e) => editMed({ bloodGroup: e.target.value })} placeholder="Blood group" aria-label="Blood group" className="min-w-0 rounded-[12px] bg-ink/5 px-3 py-2.5 text-[15px] text-ink outline-none" />
          <input type="text" value={med.allergies} onChange={(e) => editMed({ allergies: e.target.value })} placeholder="Allergies" aria-label="Allergies" className="min-w-0 rounded-[12px] bg-ink/5 px-3 py-2.5 text-[15px] text-ink outline-none" />
          <input type="text" value={med.medications} onChange={(e) => editMed({ medications: e.target.value })} placeholder="Medications" aria-label="Medications" className="col-span-2 min-w-0 rounded-[12px] bg-ink/5 px-3 py-2.5 text-[15px] text-ink outline-none" />
          <input type="text" value={med.conditions} onChange={(e) => editMed({ conditions: e.target.value })} placeholder="Conditions" aria-label="Conditions" className="col-span-2 min-w-0 rounded-[12px] bg-ink/5 px-3 py-2.5 text-[15px] text-ink outline-none" />
          <input type="text" value={med.notes} onChange={(e) => editMed({ notes: e.target.value })} placeholder="Notes for emergencies" aria-label="Medical notes" className="col-span-2 min-w-0 rounded-[12px] bg-ink/5 px-3 py-2.5 text-[15px] text-ink outline-none" />
        </div>
        <p className="mt-2 text-[12.5px] leading-snug text-ink-3">Shared only with your linked safety contact, for emergencies. Never sent to the assistant.</p>
      </div>
      <motion.button
        type="button"
        whileTap={{ scale: 0.97 }}
        onClick={save}
        disabled={saved}
        className={`mt-3 flex h-14 w-full items-center justify-center gap-2 rounded-[20px] text-[16.5px] font-bold transition-colors ${saved ? 'bg-ok text-white' : 'bg-teal text-on-teal shadow-lg'}`}
      >
        {saved ? (
          <>
            <Check size={20} /> Saved
          </>
        ) : (
          'Save changes'
        )}
      </motion.button>
      <p className="px-1 text-center text-[12.5px] text-ink-3">Saved on this phone at once and synced to your account when online.</p>
    </div>
  );
}

function ProfileSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [homeOpen, setHomeOpen] = useState(false);
  useEffect(() => {
    if (!open) setHomeOpen(false);
  }, [open]);
  return (
    <>
      <SubPage open={open} onClose={onClose} title="Profile">
        <ProfileForm onDone={onClose} onEditHome={() => setHomeOpen(true)} />
      </SubPage>
      <HomeSubpage open={open && homeOpen} onClose={() => setHomeOpen(false)} z={75} />
    </>
  );
}

/** Home on the map: the exact point "Take me home" walks to (same picker as setup). */
function HomeSubpage({ open, onClose, z = 70 }: { open: boolean; onClose: () => void; z?: number }) {
  return (
    <SubPage open={open} onClose={onClose} title="Home & places" z={z} scroll={false}>
      <div className="absolute inset-0">
        <HomeLocationStep onSaved={onClose} />
      </div>
    </SubPage>
  );
}

/* ──────── Contact editor ──────── */
function ContactForm({ contact, onSave, onDelete, onClose }: { contact: Contact | null; onSave: (c: Contact) => void; onDelete?: () => void; onClose: () => void }) {
  const [form, setForm] = useState<Contact>(() => contact ?? { id: `c_${Date.now().toString(36)}`, name: '', relation: '', phone: '', aliases: [] });
  const [pickErr, setPickErr] = useState<string | null>(null);
  const valid = form.name.trim().length > 0 && form.phone.replace(/\D/g, '').length >= 10;
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="glass interactive flex w-full items-center justify-center gap-2 rounded-[20px] py-3 text-[15.5px] font-semibold text-ink"
        onClick={async () => {
          setPickErr(null);
          try {
            const r = await AissNative.pickContact();
            if (!r.cancelled) setForm((f) => ({ ...f, name: r.name ?? f.name, phone: r.phone ?? f.phone }));
          } catch (e) {
            setPickErr(/not available|implemented/i.test((e as Error).message) ? 'Choosing from contacts works in the Android app. Type the details instead.' : friendlyError(e));
          }
        }}
      >
        Choose from phone contacts
      </button>
      {pickErr && <p className="px-1 text-[13.5px] text-amber-ink">{pickErr}</p>}
      <Field label="Name">
        <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} placeholder="e.g. Papa" />
      </Field>
      <Field label="Relationship">
        <input type="text" value={form.relation} onChange={(e) => setForm({ ...form, relation: e.target.value })} className={inputCls} placeholder="e.g. Father" />
      </Field>
      <Field label="Phone number">
        <input type="tel" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={inputCls} placeholder="+91 98765 43210" />
      </Field>
      <div className="mt-3 flex gap-3">
        {contact && onDelete && (
          <button type="button" onClick={() => { onDelete(); onClose(); }} className="interactive h-14 min-w-0 flex-1 rounded-[20px] bg-sos/10 text-[15.5px] font-bold text-sos">
            Remove
          </button>
        )}
        <button
          type="button"
          disabled={!valid}
          onClick={() => { onSave({ ...form, name: form.name.trim(), relation: form.relation.trim(), phone: form.phone.trim() }); onClose(); }}
          className="interactive h-14 min-w-0 flex-1 rounded-[20px] bg-teal text-[15.5px] font-bold text-on-teal shadow-lg disabled:opacity-50"
        >
          Save contact
        </button>
      </div>
    </div>
  );
}

/* ──────── Emergency SOS ──────── */
function EmergencySubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useSession((s) => s.settings);
  const contacts = useSession((s) => s.contacts);
  const updateSettings = useSession((s) => s.updateSettings);
  const [testTriggered, setTestTriggered] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (!open) {
      setEditing(null);
      setAdding(false);
    }
  }, [open]);
  const setContacts = (next: Contact[]) => useSession.setState({ contacts: next });

  return (
    <>
      <SubPage open={open} onClose={onClose} title="Emergency & SOS">
        <div className="glass mb-5 flex items-center gap-3 rounded-[24px] p-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-sos/10 text-sos">
            <AlertTriangle size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[16.5px] font-bold text-ink">Fall detection</p>
            <p className="mt-0.5 text-[13.5px] leading-snug text-ink-3">Starts SOS when a fall is detected</p>
          </div>
          <span className="shrink-0">
            <Toggle label="Fall detection" on={settings.sosTriggers.fall} onChange={(v) => updateSettings({ sosTriggers: { ...settings.sosTriggers, fall: v } })} />
          </span>
        </div>

        <SectionTitle>SOS contacts</SectionTitle>
        <div className="glass mb-5 overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line">
          {contacts.map((c, i) => (
            <button type="button" key={c.id} onClick={() => setEditing(c)} className="interactive flex w-full items-center gap-3 px-4 py-3.5 text-left">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-teal/10 text-[19px] font-bold text-teal">{(c.name || '?').charAt(0).toUpperCase()}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[16px] font-bold text-ink">
                  {c.name}
                  {c.relation && <span className="ml-1 text-[13px] font-normal text-ink-3">({c.relation})</span>}
                </span>
                <span className="mt-0.5 block truncate text-[14px] text-ink-3">{c.phone}</span>
              </span>
              <span className="shrink-0 rounded-full bg-teal/10 px-2.5 py-1 text-[12px] font-bold text-teal">#{i + 1}</span>
            </button>
          ))}
          {contacts.length < 5 && (
            <button type="button" onClick={() => setAdding(true)} className="interactive flex w-full items-center gap-3 px-4 py-3.5 text-left">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full border-2 border-dashed border-ink/20 bg-ink/5 text-ink-3">
                <Plus size={20} />
              </span>
              <span className="text-[16px] font-semibold text-ink-2">Add contact</span>
            </button>
          )}
        </div>

        <SectionTitle>SOS message</SectionTitle>
        <div className="glass mb-5 rounded-[20px] p-4">
          <textarea
            value={settings.sosMessage}
            onChange={(e) => updateSettings({ sosMessage: e.target.value.slice(0, 280) })}
            aria-label="SOS message"
            className="h-24 w-full resize-none bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-3"
            placeholder="Message sent to contacts during SOS"
          />
        </div>

        <motion.button
          type="button"
          whileTap={{ scale: 0.97 }}
          onClick={() => {
            setTestTriggered(true);
            haptics.play('sos');
            earcon('alert');
            const t = getTransport();
            if (t) void t.send({ type: 'haptic', pattern: 'sos' }).catch(() => undefined);
            void say('This is a test of the SOS sound and vibration. No alert was sent.', { lang: 'en', priority: 'high' });
            setTimeout(() => setTestTriggered(false), 2500);
          }}
          className={`min-h-14 w-full rounded-[22px] px-4 py-3 text-[16px] font-bold transition-colors ${testTriggered ? 'bg-ok text-white' : 'border-2 border-amber/30 bg-amber/10 text-amber-ink'}`}
        >
          {testTriggered ? '✓ Sound & vibration played. Nothing was sent.' : 'Test SOS sound & vibration (sends nothing)'}
        </motion.button>
      </SubPage>
      <SubPage open={open && (!!editing || adding)} onClose={() => { setEditing(null); setAdding(false); }} title={editing ? 'Edit contact' : 'New contact'} z={80}>
        <ContactForm
          key={editing?.id ?? 'new'}
          contact={editing}
          onClose={() => { setEditing(null); setAdding(false); }}
          onSave={(c) => {
            const cur = useSession.getState().contacts;
            setContacts(cur.some((x) => x.id === c.id) ? cur.map((x) => (x.id === c.id ? c : x)) : [...cur, c]);
          }}
          onDelete={editing ? () => setContacts(useSession.getState().contacts.filter((x) => x.id !== editing.id)) : undefined}
        />
      </SubPage>
    </>
  );
}

/* ──────── Easter Egg Game: Flappy Stick ──────── */
function StickGameSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const isDark = useSession((s) => s.settings.theme === 'dark' || (s.settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches));
  useBackHandler(open, onClose);

  const [playing, setPlaying] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [score, setScore] = useState(0);

  const stickRef = useRef<HTMLDivElement>(null);
  const obsRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<number>(0);

  const state = useRef({
    stickY: 50,
    velocity: 0,
    score: 0,
    obstacles: [] as { x: number; gapY: number; passed: boolean }[],
  });

  const jump = () => {
    if (!playing || gameOver) {
      setGameOver(false);
      state.current = { stickY: 50, velocity: 0, obstacles: [{ x: 100, gapY: 50, passed: false }], score: 0 };
      setScore(0);
      setPlaying(true);
      return;
    }
    state.current.velocity = -1.2;
    navigator.vibrate?.(20);
  };

  useEffect(() => {
    if (!open) {
      setPlaying(false);
      setGameOver(false);
      return;
    }
    let lastTime = performance.now();
    const crash = () => {
      setPlaying(false);
      setGameOver(true);
      navigator.vibrate?.([100, 50, 100]);
    };
    const loop = (time: number) => {
      if (!playing) return;
      const dt = Math.min(3, (time - lastTime) / 16);
      lastTime = time;
      const s = state.current;
      s.velocity += 0.08 * dt;
      s.stickY += s.velocity * dt;
      if (s.stickY < 0) s.stickY = 0;
      if (s.stickY > 90) return crash();
      for (const obs of s.obstacles) {
        obs.x -= 0.7 * dt;
        if (obs.x < 25 && obs.x > 15 && (s.stickY < obs.gapY - 15 || s.stickY > obs.gapY + 15)) return crash();
        if (!obs.passed && obs.x < 15) {
          obs.passed = true;
          s.score += 1;
          setScore(s.score);
        }
      }
      if (s.obstacles[0] && s.obstacles[0].x < -10) s.obstacles.shift();
      const lastObs = s.obstacles[s.obstacles.length - 1];
      if (!lastObs || lastObs.x < 60) s.obstacles.push({ x: 100, gapY: 30 + Math.random() * 40, passed: false });
      if (stickRef.current) {
        stickRef.current.style.top = `${s.stickY}%`;
        stickRef.current.style.transform = `rotate(${s.velocity * 10}deg)`;
      }
      const box = obsRef.current;
      if (box) {
        box.innerHTML = '';
        for (const o of s.obstacles) {
          const topP = document.createElement('div');
          topP.className = 'absolute w-[10%] rounded-b-xl bg-gradient-to-b from-teal to-mint';
          topP.style.left = `${o.x}%`;
          topP.style.top = '0';
          topP.style.height = `${o.gapY - 20}%`;
          const botP = document.createElement('div');
          botP.className = 'absolute w-[10%] rounded-t-xl bg-gradient-to-t from-teal to-mint';
          botP.style.left = `${o.x}%`;
          botP.style.bottom = '0';
          botP.style.height = `${100 - (o.gapY + 20)}%`;
          box.appendChild(topP);
          box.appendChild(botP);
        }
      }
      requestRef.current = requestAnimationFrame(loop);
    };
    if (playing) requestRef.current = requestAnimationFrame(loop);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [playing, open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={SLIDE} className={`absolute inset-0 z-[80] overflow-hidden ${isDark ? 'bg-ink' : 'bg-bg'}`}>
          <div className="absolute inset-x-0 z-20 flex items-center px-4" style={{ top: 'calc(var(--island, var(--sat)) + 10px)' }}>
            <button type="button" aria-label="Back" onClick={onClose} className={`grid h-12 w-12 place-items-center rounded-full shadow-xl ${isDark ? 'bg-white/10 text-white' : 'bg-black/5 text-ink'}`}>
              <ChevronLeft size={24} />
            </button>
            <p className={`flex-1 text-center text-[32px] font-black ${isDark ? 'text-white' : 'text-ink'}`}>{score}</p>
            <div className="w-12" />
          </div>
          <div className="relative h-full w-full cursor-pointer" onClick={jump}>
            {!playing && !gameOver && (
              <div className={`pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center ${isDark ? 'text-white' : 'text-ink'}`}>
                <div className="mb-4 text-[64px]">🦯</div>
                <h2 className="text-[28px] font-bold">Flappy Stick</h2>
                <p className="mt-2 text-[16px] text-teal">Tap to jump & survive</p>
              </div>
            )}
            {gameOver && (
              <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/50 text-white">
                <h2 className="text-[42px] font-black text-sos">CRASHED!</h2>
                <p className="mt-2 rounded-full bg-white/10 px-6 py-2 text-[24px] font-bold">Score: {score}</p>
                <p className="mt-6 text-[18px] opacity-70">Tap anywhere to restart</p>
              </div>
            )}
            <div ref={obsRef} className="pointer-events-none absolute inset-0" />
            <div ref={stickRef} className="pointer-events-none absolute left-[20%] z-20 flex h-[12%] w-[5%] items-center justify-center text-[36px]" style={{ top: '50%' }}>
              🦯
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ──────── Voice, language & display ──────── */
function AccessibilitySubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useSession((x) => x.settings);
  const update = useSession((x) => x.updateSettings);
  const demo = useRuntime((x) => x.mode) === 'demo';
  return (
    <SubPage open={open} onClose={onClose} title="Voice & display">
      <section className="mb-5">
        <SectionTitle>Assistant replies in</SectionTitle>
        <Segmented label="Reply language" value={s.replyLang} onChange={(v) => update({ replyLang: v })} options={[{ value: 'auto', label: 'Auto' }, { value: 'en', label: 'English' }, { value: 'hi', label: 'हिंदी' }]} />
      </section>
      <section className="mb-5">
        <SectionTitle>Voice speed</SectionTitle>
        <Segmented
          label="Voice speed"
          value={s.voiceRate}
          onChange={(v) => {
            update({ voiceRate: v });
            void speak('This is how fast I will talk.', 'en');
          }}
          options={[{ value: 0.85, label: 'Slow' }, { value: 1, label: 'Normal' }, { value: 1.25, label: 'Fast' }]}
        />
      </section>
      <section className="mb-5">
        <SectionTitle>Assistant volume · {s.assistantVolume}%</SectionTitle>
        <div className="glass rounded-[20px] px-4 py-3">
          <input type="range" min={20} max={100} step={10} value={s.assistantVolume} onChange={(e) => update({ assistantVolume: Number(e.target.value) })} className="w-full accent-teal" aria-label="Assistant volume" />
          <p className="text-[12.5px] text-ink-3">The SOS siren is always at full volume.</p>
        </div>
      </section>
      <section className="mb-5">
        <SectionTitle>Text size</SectionTitle>
        <div className="glass flex items-center gap-3 rounded-[24px] p-2">
          <GlassButton size="lg" aria-label="Smaller text" className="w-14 shrink-0 !px-0" onClick={() => update({ textScale: clamp(+(s.textScale - 0.15).toFixed(2), 0.85, 1.6) })}>
            <Minus size={22} />
          </GlassButton>
          <p className="min-w-0 flex-1 text-center text-[19px] font-semibold text-ink">Aa {Math.round(s.textScale * 100)}%</p>
          <GlassButton size="lg" aria-label="Bigger text" className="w-14 shrink-0 !px-0" onClick={() => update({ textScale: clamp(+(s.textScale + 0.15).toFixed(2), 0.85, 1.6) })}>
            <Plus size={22} />
          </GlassButton>
        </div>
      </section>
      <SectionTitle>Preferences</SectionTitle>
      <div className="glass mb-5 overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line">
        <BigRow icon={<Accessibility size={22} />} label="Screen reader mode" detail="Big buttons instead of taps on the orb. Best with TalkBack." on={s.screenReaderMode} onChange={(v) => update({ screenReaderMode: v })} />
        <BigRow icon={<Contrast size={22} />} label="High contrast" detail="Solid surfaces and stronger outlines" on={s.highContrast} onChange={(v) => update({ highContrast: v })} />
        <BigRow icon={<Volume2 size={22} />} label="Sounds" detail="Ticks, beeps and the connecting tune" on={s.earcons} onChange={(v) => update({ earcons: v })} />
        <BigRow icon={<Vibrate size={22} />} label="Phone vibration" detail="The stick always vibrates for obstacles" on={s.haptics} onChange={(v) => update({ haptics: v })} />
        {demo && (
          <BigRow icon={<Mic size={22} />} label="Use the real microphone" detail={recognitionSupported() ? 'Demo only: speech recognition in this browser.' : 'Not available in this browser'} on={s.realMic && recognitionSupported()} onChange={(v) => update({ realMic: v })} />
        )}
        <BigRow icon={<Sparkles size={22} />} label="Reduce motion" detail="Fewer animations" on={s.reduceMotion} onChange={(v) => update({ reduceMotion: v })} />
      </div>
      <p className="px-1 text-[12.5px] text-ink-3">Voice, language, sounds and vibration are saved with your account. Text size, contrast and motion are for this phone.</p>
    </SubPage>
  );
}

/* ──────── Stick hardware ──────── */
function HardwareSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <SubPage open={open} onClose={onClose} title="Stick & hardware">
      <HardwareContent onClose={onClose} />
    </SubPage>
  );
}

function HardwareContent({ onClose }: { onClose: () => void }) {
  const d = useDevice();
  const update = useSession((x) => x.updateSettings);
  const cal = useSession((x) => x.settings.imuCalibration);
  const st = useSession((x) => x.settings);
  const mode = useRuntime((x) => x.mode);
  const [testing, setTesting] = useState(false);
  const [testReport, setTestReport] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [legacyIp, setLegacyIp] = useState('');
  const [otaChecking, setOtaChecking] = useState(false);
  const [otaProgress, setOtaProgress] = useState<string | null>(null);
  const connected = isLinked(d.link);
  const l = linkLabel(d.link);

  const selfTest = async () => {
    const t = getTransport();
    if (!t) return;
    setTesting(true);
    try {
      const ack = await t.send({ type: 'selfTest' }, { ttlMs: 15_000 });
      setTestReport(ack.status === 'completed' ? JSON.stringify(ack.result, null, 2) : `Self-test ${ack.status}: ${ack.error ?? ''}`);
    } catch (e) {
      setTestReport(`Self-test failed. ${friendlyError(e)}`);
    } finally {
      setTesting(false);
    }
  };
  const locate = async () => {
    const t = getTransport();
    if (!t || !connected) return setMsg('The stick is not connected.');
    try {
      const ack = await t.send({ type: 'locate' });
      setMsg(ack.status === 'completed' || ack.status === 'duplicate' ? 'The stick is buzzing now.' : `The stick did not buzz (${ack.error ?? ack.status}).`);
    } catch {
      setMsg('The stick did not respond.');
    }
  };
  const calibrate = () => {
    const c = calibrateImuFromLatest();
    if (!c) return setMsg('No motion-sensor reading yet. Connect the stick first.');
    update({ imuCalibration: c });
    setImuCalibration(c);
    setMsg('Upright position saved. The stick picture now uses this as straight.');
  };
  const unpair = async () => {
    setConfirmUnpair(false);
    if (mode === 'demo') getMock()?.setLinked(false);
    else await unpairStick();
    setMsg('Stick removed from this phone. To connect it again, choose “Set up stick”.');
  };
  const checkOta = async () => {
    if (!connected || !d.identity) return;
    setOtaChecking(true);
    setMsg('Checking for updates…');
    try {
      const release = await call<Record<string, never>, { version: string; binaryUrl: string; sha256: string; signature: string } | null>('getLatestFirmwareRelease', {});
      if (!release || compareVersions(String(release.version), d.identity.firmware) <= 0) {
        setMsg('Your stick is already up to date.');
        return;
      }
      setOtaProgress(`Downloading version ${release.version}…`);
      const res = await fetch(release.binaryUrl);
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      setOtaProgress('Verifying signature…');
      if (!(await verifyFirmware(blob, release.sha256, release.signature))) throw new Error('Firmware signature verification failed');
      setOtaProgress('Sending to stick…');
      const t = getTransport();
      if (t && t.pushOTA) {
        await t.pushOTA(blob, release.sha256);
        setMsg(`Firmware update to ${release.version} sent. The stick will restart now.`);
      } else {
        setMsg('Updates are not supported in this mode.');
      }
    } catch (e) {
      setMsg(`Update failed: ${friendlyError(e)}`);
    } finally {
      setOtaChecking(false);
      setOtaProgress(null);
    }
  };

  const item = (icon: ReactNode, tone: string, title: string, sub: string, onClick?: () => void, disabled?: boolean) => (
    <button type="button" disabled={disabled} className="interactive flex w-full items-center gap-3 px-4 py-3.5 text-left disabled:opacity-50" onClick={onClick}>
      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full ${tone}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[16px] font-bold text-ink">{title}</span>
        <span className="mt-0.5 block text-[13px] leading-snug text-ink-3">{sub}</span>
      </span>
    </button>
  );

  return (
    <>
      <div className="glass mb-5 flex flex-col items-center rounded-[24px] px-4 py-5 text-center">
        <StickVisual height={150} />
        <p className="mt-3 text-[18px] font-bold text-ink">{BRAND.name}</p>
        <p className="mt-1 break-words text-[13.5px] text-ink-3">{d.identity ? `${d.identity.deviceId} · firmware ${d.health?.firmware ?? d.identity.firmware}` : 'No stick paired'}</p>
        {d.health && (
          <p className="mt-0.5 break-words text-[12.5px] text-ink-3">
            Last restart: {d.health.resetReason ?? 'unknown'}
            {d.health.mode && d.health.mode !== 'normal' ? ` · mode ${d.health.mode}` : ''}
            {d.health.errors?.length ? ` · issues: ${d.health.errors.join(', ')}` : ''}
          </p>
        )}
        <p className="mt-1 break-words text-[14px] font-semibold text-ink-2">
          {l.text}
          {d.linkDetail ? ` · ${d.linkDetail}` : ''}
        </p>
      </div>

      {msg && <p className="mb-4 rounded-[18px] bg-teal-soft px-4 py-3 text-[15px] font-medium text-teal-ink" role="status">{msg}</p>}

      <SectionTitle>Device</SectionTitle>
      <div className="glass mb-5 overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line">
        {item(<Wifi size={20} />, 'bg-teal/10 text-teal', d.link === 'unpaired' ? 'Set up stick' : 'Connect again', 'Joins the stick’s Wi-Fi and connects', () => { onClose(); useUI.setState({ userSettings: false, stickSetup: true }); })}
        {item(<Search size={20} />, 'bg-info/10 text-info', 'Find my stick', connected ? 'Vibrate the stick so you can find it' : 'Stick not connected', () => void locate(), !connected)}
        {item(<Radar size={20} />, 'bg-teal/10 text-teal', 'Calibrate orientation', cal ? 'Hold the stick upright, then tap to update' : 'Hold the stick upright, then tap', calibrate, !connected)}
        {item(<Download size={20} />, 'bg-teal/10 text-teal', otaProgress || (otaChecking ? 'Checking…' : 'Update firmware'), d.identity ? `Installed ${d.identity.firmware}` : 'Unknown until a stick is paired', () => void checkOta(), !connected || otaChecking)}
        {d.link !== 'unpaired' && item(<Unplug size={20} />, 'bg-sos/10 text-sos', 'Forget stick', 'Remove this stick from this phone', () => setConfirmUnpair(true))}
      </div>
      {confirmUnpair && (
        <div className="glass mb-5 rounded-[24px] border border-sos/30 p-4">
          <p className="text-[15px] font-semibold text-ink">Forget the stick? It stops connecting to this phone until you set it up again.</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <GlassButton size="sm" onClick={() => setConfirmUnpair(false)}>Keep</GlassButton>
            <GlassButton size="sm" variant="sos" onClick={() => void unpair()}>Forget</GlassButton>
          </div>
        </div>
      )}

      <SectionTitle>Stick behaviour</SectionTitle>
      <div className="glass mb-3 space-y-4 rounded-[24px] p-4">
        <div>
          <p className="mb-2 text-[15px] font-semibold text-ink">Obstacle sensitivity</p>
          <Segmented label="Obstacle sensitivity" size="sm" value={st.obstacleSensitivity} onChange={(v) => update({ obstacleSensitivity: v })} options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} />
          <p className="mt-1.5 text-[13px] leading-snug text-ink-3">
            Danger below {SENSITIVITY[st.obstacleSensitivity].dangerCm} cm, warning below {SENSITIVITY[st.obstacleSensitivity].warningCm} cm. Decided on the stick itself, even without the phone.
          </p>
        </div>
        <label className="block">
          <span className="flex items-center justify-between text-[15px] font-semibold text-ink">
            Vibration strength <span className="text-teal">{st.hapticStrength}%</span>
          </span>
          <input type="range" min={20} max={100} step={10} value={st.hapticStrength} onChange={(e) => update({ hapticStrength: Number(e.target.value) })} className="mt-2 w-full accent-teal" aria-label="Vibration strength" />
          <span className="text-[13px] text-ink-3">Danger alerts never go below 60%.</span>
        </label>
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 text-[15px] font-semibold text-ink">Obstacle vibration</span>
          <Toggle label="Obstacle vibration" on={st.obstacleVibration} onChange={(v) => update({ obstacleVibration: v })} />
        </div>
        <div>
          <p className="mb-2 text-[15px] font-semibold text-ink">Sleep when not moving</p>
          <Segmented label="Auto sleep" size="sm" value={String(st.autoSleepMin)} onChange={(v) => update({ autoSleepMin: Number(v) })} options={[{ value: '0', label: 'Never' }, { value: '10', label: '10 min' }, { value: '30', label: '30 min' }]} />
        </div>
        <p className="text-[13.5px] font-semibold" role="status">
          {d.configSync.state === 'applied' && <span className="text-ok">✓ Applied on the stick</span>}
          {d.configSync.state === 'pending' && <span className="text-teal-ink">Sending to the stick…</span>}
          {d.configSync.state === 'rejected' && <span className="text-sos">The stick rejected these settings: {d.configSync.error}</span>}
          {(d.configSync.state === 'offline' || d.configSync.state === 'idle') && <span className="text-ink-3">Saved. Applies when the stick connects.</span>}
        </p>
      </div>
      <GlassButton size="sm" className="mb-5 w-full" disabled={!connected || testing} onClick={() => void selfTest()}>
        {testing ? 'Testing the stick…' : 'Run stick self-test'}
      </GlassButton>
      {testReport && <pre className="mb-5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-[16px] bg-ink/[0.06] p-3 text-[12.5px] text-ink-2">{testReport}</pre>}

      {mode === 'real' && (
        <>
          <SectionTitle>Hardware test (developers)</SectionTitle>
          <div className="glass rounded-[24px] p-4">
            <p className="text-[13.5px] leading-snug text-ink-3">Connect to the old test firmware (/data, /stream) by IP. Battery % from it is not trusted.</p>
            <div className="mt-3 flex gap-2">
              <input value={legacyIp} onChange={(e) => setLegacyIp(e.target.value)} placeholder="192.168.4.1" inputMode="decimal" aria-label="Test firmware IP address" className="h-11 min-w-0 flex-1 rounded-full border border-line bg-surface/70 px-4 text-[15px] text-ink outline-none" />
              <GlassButton size="sm" className="shrink-0" disabled={!/^\d+\.\d+\.\d+\.\d+$/.test(legacyIp)} onClick={() => void connectLegacyTestFirmware(legacyIp)}>
                Connect
              </GlassButton>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/* ──────── Privacy: camera & location ──────── */
function PrivacySubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <SubPage open={open} onClose={onClose} title="Camera & location">
      <PrivacyContent />
    </SubPage>
  );
}

function PrivacyContent() {
  const s = useSession((x) => x.settings);
  const update = useSession((x) => x.updateSettings);
  const bg = useBackground();
  const [batt, setBatt] = useState<{ ignoring: boolean; manufacturer: string } | null>(null);
  useEffect(() => {
    if (bg.supported) void AissNative.getBatteryOptimization().then(setBatt).catch(() => setBatt(null));
  }, [bg.supported]);
  return (
    <div className="glass mb-5 overflow-hidden rounded-[28px] [&>*+*]:border-t [&>*+*]:border-line">
      <BigRow icon={<MapPin size={22} />} label="Share live location" detail="With your safety contact. During an SOS it is always shared." on={s.locationSharing} onChange={(v) => update({ locationSharing: v })} />
      <BigRow
        icon={<Smartphone size={22} />}
        label="Keep running with the screen off"
        detail={!bg.supported ? 'Available in the Android app only' : bg.error ? `Could not start: ${bg.error}` : bg.running ? 'On now: stick, GPS and SOS keep working.' : 'Starts when a stick is paired, during SOS or navigation.'}
        on={s.runInBackground}
        onChange={(v) => update({ runInBackground: v })}
      />
      {bg.supported && batt && !batt.ignoring && (
        <div className="px-4 py-3">
          <p className="text-[14px] leading-snug text-amber-ink">
            Android battery saving may stop {BRAND.name} in the background{/xiaomi|redmi|samsung|oppo|vivo|realme/i.test(batt.manufacturer) ? ` (common on ${batt.manufacturer})` : ''}.
          </p>
          <button type="button" className="mt-2 text-left text-[14.5px] font-semibold text-teal-ink underline" onClick={() => void AissNative.openBatteryOptimizationSettings().catch(() => undefined)}>
            Open battery settings → choose “Don’t optimise”
          </button>
        </div>
      )}
      <div className="px-4 py-3">
        <p className="mb-2 flex items-center gap-2 text-[15.5px] font-medium text-ink">
          <ScanEye size={18} className="shrink-0 text-ink-3" /> When your safety contact asks for the camera
        </p>
        <Segmented label="Camera requests" size="sm" value={s.cameraRequests} onChange={(v) => update({ cameraRequests: v })} options={[{ value: 'auto', label: 'Announce & allow' }, { value: 'ask', label: 'Ask me' }]} />
        <p className="mt-2 text-[13px] leading-snug text-ink-3">You always hear when the camera starts and ends. Photos are never stored.</p>
      </div>
      <div className="px-4 py-3">
        <p className="mb-2 flex items-center gap-2 text-[15.5px] font-medium text-ink">
          <Phone size={18} className="shrink-0 text-ink-3" /> Calls to your safety contact
        </p>
        <Segmented label="Call mode" size="sm" value={s.callMode} onChange={(v) => { update({ callMode: v }); if (v === 'direct') void AissNative.requestPermissions({ permissions: ['phone'] }).catch(() => undefined); }} options={[{ value: 'direct', label: 'Call directly' }, { value: 'dialer', label: 'Open dialer' }]} />
      </div>
      <div className="px-4 py-3">
        <p className="mb-2 flex items-center gap-2 text-[15.5px] font-medium text-ink">
          <MessageSquare size={18} className="shrink-0 text-ink-3" /> Texts to your safety contact
        </p>
        <Segmented label="SMS mode" size="sm" value={s.smsMode} onChange={(v) => { update({ smsMode: v }); if (v === 'direct') void AissNative.requestPermissions({ permissions: ['sms'] }).catch(() => undefined); }} options={[{ value: 'composer', label: 'Open Messages' }, { value: 'direct', label: 'Send directly' }]} />
        <p className="mt-2 text-[13px] leading-snug text-ink-3">“Send directly” needs Android SMS permission. Otherwise the message opens for you to press Send.</p>
      </div>
    </div>
  );
}

/* ──────── Activity history ──────── */
function ActivitySubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const events = useActivity((x) => x.events);
  return (
    <SubPage open={open} onClose={onClose} title="Activity">
      <p className="mb-4 px-1 text-[14px] leading-snug text-ink-3">Connections, alerts, walks and camera access are saved to your account and shared with your linked safety contact. Camera photos are never saved.</p>
      <div className="glass overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line">
        {events.length ? events.slice(0, 40).map((e) => <EventRow key={e.id} e={e} now={Date.now()} />) : <p className="px-4 py-6 text-center text-[15px] text-ink-3">No activity yet.</p>}
      </div>
      <GlassButton size="lg" className="mt-4 w-full" onClick={() => useActivity.setState({ events: [] })}>
        Clear from this screen
      </GlassButton>
      <p className="mt-2 px-1 text-[13px] text-ink-3">Clearing hides events on this phone only.</p>
    </SubPage>
  );
}

/* ──────── Device information ──────── */
function DeviceInfoSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <SubPage open={open} onClose={onClose} title="About this phone">
      <DeviceInfoContent />
    </SubPage>
  );
}

function DeviceInfoContent() {
  const p = usePhoneInfo();
  const d = useDevice();
  const mode = useRuntime((x) => x.mode);
  const [confirmMode, setConfirmMode] = useState(false);
  const [delState, setDelState] = useState<string>('idle');
  const row = (k: string, v: string) => (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <span className="shrink-0 text-[15px] text-ink-2">{k}</span>
      <span className="min-w-0 break-words text-right text-[15px] font-semibold text-ink">{v}</span>
    </div>
  );
  return (
    <>
      <div className="glass mb-5 overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line">
        {row('App', `${BRAND.name} ${p.appVersion}`)}
        {row('Mode', mode === 'demo' ? 'Demo (simulated data)' : 'Real')}
        {row('Phone', phoneLabel(p))}
        {row('System', p.osVersion ?? 'Unavailable')}
        {row('Phone battery', p.batteryPct == null ? 'Unavailable' : `${p.batteryPct}%${p.charging ? ', charging' : ''}`)}
        {row('Stick', d.identity ? d.identity.deviceId : 'Not paired')}
        {row('Stick firmware', d.identity?.firmware ?? 'Unavailable')}
        {row('Stick battery', batteryLabel(d.battery).text)}
      </div>
      <div className="glass rounded-[24px] p-4">
        <p className="text-[16px] font-bold text-ink">{mode === 'demo' ? 'Leave demo mode' : 'Demo mode'}</p>
        <p className="mt-1 text-[13.5px] leading-snug text-ink-3">{mode === 'demo' ? 'Switch to real mode: real account, stick, GPS and assistant.' : 'Shows a simulated stick, street and assistant for demonstrations. Real data is never mixed in.'}</p>
        {confirmMode ? (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <GlassButton size="sm" onClick={() => setConfirmMode(false)}>Cancel</GlassButton>
            <GlassButton size="sm" variant="teal" onClick={() => switchMode(mode === 'demo' ? 'real' : 'demo')}>Switch & restart</GlassButton>
          </div>
        ) : (
          <GlassButton size="sm" className="mt-3 w-full" onClick={() => setConfirmMode(true)}>{mode === 'demo' ? 'Switch to real mode' : 'Switch to demo mode'}</GlassButton>
        )}
      </div>
      {mode === 'real' && (
        <div className="glass mt-4 rounded-[24px] border border-sos/20 p-4">
          <p className="text-[16px] font-bold text-ink">Delete account</p>
          <p className="mt-1 text-[13.5px] leading-snug text-ink-3">Permanently deletes your profile, settings, activity, assistant history and SOS records, and unlinks your safety contact. This cannot be undone.</p>
          {delState === 'confirm' ? (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <GlassButton size="sm" onClick={() => setDelState('idle')}>Cancel</GlassButton>
              <GlassButton size="sm" variant="sos" onClick={() => { setDelState('busy'); void deleteAccount().catch((e) => setDelState(`error:${friendlyError(e)}`)); }}>Delete forever</GlassButton>
            </div>
          ) : (
            <GlassButton size="sm" className="mt-3 w-full" disabled={delState === 'busy'} onClick={() => setDelState('confirm')}>{delState === 'busy' ? 'Deleting…' : 'Delete my account'}</GlassButton>
          )}
          {delState.startsWith('error:') && <p className="mt-2 text-[13.5px] font-semibold text-sos" role="alert">{delState.slice(6)}</p>}
        </div>
      )}
      <p className="mt-4 px-1 text-[13px] text-ink-3">Open-source licences are listed in the repository (package.json dependencies).</p>
    </>
  );
}

/* ──────── Settings hub ──────── */
export function UserSettings() {
  const open = useUI((s) => s.userSettings);
  const close = () => useUI.setState({ userSettings: false });
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          className="absolute inset-0 z-[60]"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 24 }}
          transition={{ duration: 0.2, ease: EASE }}
        >
          <SettingsHub onClose={close} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function SettingsHub({ onClose }: { onClose: () => void }) {
  const s = useSession((x) => x.settings);
  const linkState = useDevice((x) => x.link);
  const battery = useDevice((x) => x.battery);
  const contactsCount = useSession((x) => x.contacts.length);
  const guardianName = useSession((x) => x.guardian.heardAs);
  const home = useSession((x) => x.person.savedPlaces.find((p) => p.id === 'home') ?? null);
  const homeText = useSession((x) => x.person.homeAddress);
  const name = useProfileName();
  const email = useAuth((x) => x.user?.email ?? '');
  const mode = useRuntime((x) => x.mode);
  const [page, setPage] = useState<null | 'profile' | 'home' | 'emergency' | 'access' | 'hardware' | 'privacy' | 'activity' | 'info' | 'game'>(null);
  const closePage = () => setPage(null);
  const isDark = s.theme === 'dark' || (s.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const batt = batteryLabel(battery);
  const link = linkLabel(linkState);

  const [taps, setTaps] = useState(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const versionTap = () => {
    const next = taps + 1;
    clearTimeout(tapTimer.current);
    if (next >= 3) {
      setTaps(0);
      setPage('game');
      navigator.vibrate?.([50, 100, 150]);
      return;
    }
    setTaps(next);
    tapTimer.current = setTimeout(() => setTaps(0), 1000);
  };

  return (
    <>
      <Page title="Settings" onBack={onClose}>
        {/* Profile */}
        <button type="button" onClick={() => setPage('profile')} className="glass interactive mb-4 flex w-full min-w-0 items-center gap-3 rounded-[26px] p-3.5 text-left">
          <span className="shrink-0 overflow-hidden rounded-full ring-2 ring-teal/30">
            <AccountAvatar size={58} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[19px] font-extrabold leading-tight text-ink">{name || 'Add your name'}</span>
            <span className="mt-0.5 block truncate text-[13.5px] text-ink-3">{mode === 'demo' ? 'Demo mode · simulated data' : email || 'Profile, photo, home'}</span>
          </span>
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-teal-soft text-teal-ink" aria-hidden>
            <Pencil size={17} />
          </span>
        </button>

        {/* Stick + version + health */}
        <div className="mb-4 grid grid-cols-2 gap-3">
          <button type="button" onClick={() => { onClose(); useUI.setState({ stickPage: true }); }} className="glass interactive relative row-span-2 flex min-h-[200px] min-w-0 flex-col items-center justify-center overflow-hidden rounded-[26px] px-2 py-4">
            <span className="pointer-events-none absolute inset-0 bg-gradient-to-br from-teal/10 to-transparent" aria-hidden />
            <StickVisual height={140} />
            <span className="relative mt-2 max-w-full truncate text-[12.5px] font-bold uppercase tracking-wider text-ink-2">Your stick</span>
          </button>
          <button type="button" onClick={versionTap} className="glass interactive relative flex min-h-[94px] min-w-0 flex-col items-center justify-center overflow-hidden rounded-[22px] px-2 py-3">
            <span className={`pointer-events-none absolute inset-0 bg-white transition-opacity duration-200 ${taps > 0 ? 'opacity-20' : 'opacity-0'}`} aria-hidden />
            <span className="bg-gradient-to-br from-teal to-mint bg-clip-text text-[30px] font-black leading-none text-transparent">V1</span>
            <span className="mt-1 max-w-full truncate text-[12px] font-semibold text-ink-3">v{ENV.appVersion}</span>
          </button>
          <button type="button" onClick={() => { onClose(); useUI.setState({ batteryPage: true }); }} className="glass interactive flex min-h-[94px] min-w-0 flex-col items-center justify-center gap-1 rounded-[22px] px-2 py-3">
            <span className="flex max-w-full items-center gap-1.5">
              <Battery size={16} className={`shrink-0 ${batt.tone === 'ok' ? 'text-ok' : batt.tone === 'sos' ? 'text-sos' : batt.tone === 'warn' ? 'text-amber' : 'text-ink-3'}`} />
              <span className="truncate text-[17px] font-bold text-ink">{batt.text}</span>
            </span>
            <span className="flex max-w-full items-center gap-1.5">
              <Wifi size={13} className={`shrink-0 ${linkState === 'connected' ? 'text-teal' : 'text-ink-3'}`} />
              <span className="truncate text-[12px] font-medium text-ink-2">{link.text}</span>
            </span>
          </button>
        </div>

        {/* Quick actions */}
        <div className="mb-5 flex flex-col gap-3">
          <button type="button" onClick={(e) => toggleThemeWithTransition(e)} className="glass interactive flex w-full min-w-0 items-center gap-3 rounded-[24px] p-4 text-left">
            <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-[14px] ${isDark ? 'bg-info/10 text-info' : 'bg-amber/10 text-amber'}`}>{isDark ? <Moon size={22} /> : <Sun size={22} />}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[16.5px] font-bold text-ink">Appearance</span>
              <span className="mt-0.5 block text-[13.5px] text-ink-3">{isDark ? 'Dark' : 'Light'}</span>
            </span>
            <span className="relative h-8 w-[52px] shrink-0 rounded-full border border-ink/5 bg-ink/10 p-1" aria-hidden>
              <span className={`block h-6 w-6 rounded-full shadow-sm transition-transform duration-150 ${isDark ? 'translate-x-5 bg-info' : 'translate-x-0 bg-amber'}`} />
            </span>
          </button>
          <button type="button" onClick={() => setPage('emergency')} className="glass interactive flex w-full min-w-0 items-center gap-3 rounded-[24px] border border-sos/20 p-4 text-left">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-sos/15 text-sos">
              <Shield size={22} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[16.5px] font-bold text-ink">Emergency & SOS</span>
              <span className="mt-0.5 line-clamp-2 block text-[13.5px] leading-snug text-ink-3">
                {guardianName ? `Linked: ${guardianName}` : 'No safety contact linked'} · {contactsCount} contact{contactsCount === 1 ? '' : 's'} · Fall detection {s.sosTriggers.fall ? 'on' : 'off'}
              </span>
            </span>
            <ChevronRight size={20} className="shrink-0 text-ink-3" />
          </button>
          <button type="button" onClick={() => setPage('home')} className="glass interactive flex w-full min-w-0 items-center gap-3 rounded-[24px] p-4 text-left">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-info/10 text-info">
              <Home size={22} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[16.5px] font-bold text-ink">Take me home</span>
              <span className="mt-0.5 block truncate text-[13.5px] text-ink-3">{home ? home.name || home.address : homeText || 'No home saved. Tap to choose it on the map.'}</span>
            </span>
            <ChevronRight size={20} className="shrink-0 text-ink-3" />
          </button>
        </div>

        <SectionTitle>Stick</SectionTitle>
        <div className="glass mb-5 overflow-hidden rounded-[24px]">
          <NavRow icon={<Smartphone size={20} />} iconBg="bg-teal/10 text-teal" label="Stick & hardware" detail="Connect, find, firmware, vibration" onClick={() => setPage('hardware')} />
        </div>

        <SectionTitle>Assistant & accessibility</SectionTitle>
        <div className="glass mb-5 overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line">
          <NavRow icon={<Mic size={20} />} iconBg="bg-teal/10 text-teal" label="Voice & display" detail="Language, voice speed, text size, sounds" onClick={() => setPage('access')} />
          <NavRow icon={<User size={20} />} iconBg="bg-info/10 text-info" label="Profile & medical ID" detail="Name, photo, phone, home, medical" onClick={() => setPage('profile')} />
        </div>

        <SectionTitle>Safety & privacy</SectionTitle>
        <div className="glass mb-5 overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line">
          <NavRow icon={<ShieldAlert size={20} />} iconBg="bg-sos/10 text-sos" label="Emergency & SOS" detail="Contacts, message, fall detection" onClick={() => setPage('emergency')} />
          <NavRow icon={<ScanEye size={20} />} iconBg="bg-ink-3/10 text-ink-3" label="Camera & location" detail={`Location sharing ${s.locationSharing ? 'on' : 'off'} · camera ${s.cameraRequests === 'auto' ? 'announce & allow' : 'ask first'}`} onClick={() => setPage('privacy')} />
          <NavRow icon={<MessageSquare size={20} />} iconBg="bg-info/10 text-info" label="Activity" detail="What is saved and shared" onClick={() => setPage('activity')} />
        </div>

        <SectionTitle>About</SectionTitle>
        <div className="glass mb-5 overflow-hidden rounded-[24px]">
          <NavRow icon={<Smartphone size={20} />} iconBg="bg-ink-3/10 text-ink-3" label="About this phone" detail={`App ${ENV.appVersion} · ${mode === 'demo' ? 'Demo mode' : 'Real mode'}`} onClick={() => setPage('info')} />
        </div>

        <p className="mb-2 mt-2 text-center text-[13px] text-ink-3 opacity-70">{BRAND.name} · Made with ❤️ in India</p>
      </Page>

      <ProfileSubpage open={page === 'profile'} onClose={closePage} />
      <HomeSubpage open={page === 'home'} onClose={closePage} />
      <EmergencySubpage open={page === 'emergency'} onClose={closePage} />
      <AccessibilitySubpage open={page === 'access'} onClose={closePage} />
      <HardwareSubpage open={page === 'hardware'} onClose={closePage} />
      <PrivacySubpage open={page === 'privacy'} onClose={closePage} />
      <ActivitySubpage open={page === 'activity'} onClose={closePage} />
      <DeviceInfoSubpage open={page === 'info'} onClose={closePage} />
      <StickGameSubpage open={page === 'game'} onClose={closePage} />
    </>
  );
}

/** Numeric, part by part: 1.10.0 is newer than 1.9.0 (string comparison says otherwise). */
function compareVersions(a: string, b: string) {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
