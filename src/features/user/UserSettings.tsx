import { AnimatePresence, motion } from 'motion/react';
import { Accessibility, AlertTriangle, Battery, ChevronLeft, ChevronRight, Contrast, Heart, Home, Mic, Minus, Moon, Plus, Shield, Smartphone, Sun, User, Vibrate, Volume2, Wifi, Search, Download, Unplug, ShieldAlert, ScanEye, MessageSquare, Sparkles, Radar, MapPin, Phone } from 'lucide-react';
import { EventRow } from '../guardian/parts';
import { useUI } from '../../core/store/ui';
import { useRuntime, switchMode } from '../../core/runtime/mode';
import { ENV } from '../../core/runtime/env';
import { BRAND } from '../../core/brand/brand';
import { updateProfileFields, deleteAccount } from '../../core/auth/authService';
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
import { friendlyError } from '../../core/errors';
import { useBackground } from '../../core/native/background';
import { useSession } from '../../core/store/session';
import { useDevice, isLinked } from '../../core/store/device';
import { StickVisual } from '../../components/StickVisual';
import { recognitionSupported } from '../../core/voice/recognition';
import { speak } from '../../core/feedback/speech';
import { GlassButton, Segmented, Toggle } from '../../components/glass';
import { clamp } from '../../core/util';
import { Atmosphere } from '../../components/Atmosphere';
import { useState, useEffect, useRef } from 'react';

/* ──────── Shared row component ──────── */
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

/* ──────── Nav row for sub-pages ──────── */
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

/* ──────── Profile Editing Sub-Page ──────── */
function ProfileSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const person = useSession((s) => s.person);
  const setSession = useSession((s) => s.set);
  const [form, setForm] = useState(person);
  const [saved, setSaved] = useState(false);

  // Sync when person changes remotely
  useEffect(() => { setForm(person) }, [person]);

  const [med, setMed] = useState<MedicalProfile>(emptyMedical());
  useEffect(() => {
    if (open) void loadMedical().then((m) => m && setMed(m)).catch(() => undefined);
  }, [open]);
  const handleSave = () => {
    setSession({ person: form });
    // Medical details go only to users/{uid}/medical/profile (guardian-readable for emergencies).
    void saveMedical({ bloodGroup: med.bloodGroup, allergies: med.allergies, medications: med.medications, conditions: med.conditions, notes: form.medicalId || med.notes }).catch(() => undefined);
    // Phone number and name are what the guardian sees and calls (real mode → Firebase profile).
    void updateProfileFields({ phone: form.phone.trim() || null, displayName: form.name.trim() || undefined, homeAddress: form.homeAddress.trim() || null }).catch(() => undefined);
    setSaved(true);
    navigator.vibrate?.([50, 50, 50]);
    setTimeout(() => {
      setSaved(false);
      onClose();
    }, 800);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
          transition={{ type: 'spring', damping: 30, stiffness: 300 }}
          className="absolute inset-0 z-[70] bg-bg overflow-y-auto no-scrollbar"
        >
          <Atmosphere variant="user" />
          <div className="px-4 pb-8" style={{ paddingTop: 'calc(var(--island, 0px) + 12px)' }}>
            <div className="mb-6 mt-8 flex items-center gap-4">
              <button onClick={onClose} className="h-12 w-12 glass interactive rounded-full flex items-center justify-center text-ink shrink-0">
                <ChevronLeft size={24} />
              </button>
              <h1 className="text-[24px] font-bold text-ink">Edit Profile</h1>
            </div>

            {/* Avatar */}
            <div className="flex justify-center mb-8">
              <div className="relative">
                <div className="w-28 h-28 rounded-full bg-gradient-to-br from-teal to-mint flex items-center justify-center text-white text-[42px] font-bold shadow-xl">
                  {person.name.charAt(0)}
                </div>
                <div className="absolute -bottom-1 -right-1 bg-teal text-white w-9 h-9 rounded-full flex items-center justify-center shadow-lg border-2 border-bg">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                </div>
              </div>
            </div>

            {/* Input Fields */}
            <div className="flex flex-col gap-4">
              <div className="glass rounded-[20px] p-4 border border-glass-border">
                <label className="text-[13px] font-bold text-ink-3 uppercase tracking-wider block mb-2">Full Name</label>
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full bg-transparent text-[18px] font-semibold text-ink outline-none placeholder:text-ink-3" placeholder="Your Name" />
              </div>

              <div className="glass rounded-[20px] p-4 border border-glass-border">
                <label className="text-[13px] font-bold text-ink-3 uppercase tracking-wider block mb-2">Phone Number</label>
                <input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="w-full bg-transparent text-[18px] font-semibold text-ink outline-none placeholder:text-ink-3" placeholder="+91 XXXXX XXXXX" />
              </div>

              <div className="glass rounded-[20px] p-4 border border-glass-border">
                <label className="text-[13px] font-bold text-ink-3 uppercase tracking-wider block mb-2">Email Address</label>
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="w-full bg-transparent text-[18px] font-semibold text-ink outline-none placeholder:text-ink-3" placeholder="For account recovery" />
              </div>

              <div className="glass rounded-[20px] p-4 border border-glass-border">
                <label className="text-[13px] font-bold text-ink-3 uppercase tracking-wider block mb-2 flex items-center gap-2"><Home size={14} /> Home Address</label>
                <input type="text" value={form.homeAddress} onChange={(e) => setForm({ ...form, homeAddress: e.target.value })} className="w-full bg-transparent text-[18px] font-semibold text-ink outline-none placeholder:text-ink-3" placeholder="For 'Take me home' command" />
              </div>

              <div className="glass rounded-[20px] p-4 border border-glass-border">
                <label className="text-[13px] font-bold text-ink-3 uppercase tracking-wider block mb-2">Work / College Address</label>
                <input type="text" value={form.workAddress} onChange={(e) => setForm({ ...form, workAddress: e.target.value })} className="w-full bg-transparent text-[18px] font-semibold text-ink outline-none placeholder:text-ink-3" placeholder="For daily routing" />
              </div>

              <div className="glass rounded-[20px] p-4 border border-glass-border">
                <label className="text-[13px] font-bold text-ink-3 uppercase tracking-wider block mb-2 flex items-center gap-2"><Heart size={14} className="text-sos" /> Medical ID (Optional)</label>
                <div className="mb-2 grid grid-cols-2 gap-2">
                  <input type="text" value={med.bloodGroup} onChange={(e) => setMed({ ...med, bloodGroup: e.target.value })} placeholder="Blood group" aria-label="Blood group" className="rounded-[12px] bg-ink/5 px-3 py-2 text-[15px] text-ink outline-none" />
                  <input type="text" value={med.allergies} onChange={(e) => setMed({ ...med, allergies: e.target.value })} placeholder="Allergies" aria-label="Allergies" className="rounded-[12px] bg-ink/5 px-3 py-2 text-[15px] text-ink outline-none" />
                  <input type="text" value={med.medications} onChange={(e) => setMed({ ...med, medications: e.target.value })} placeholder="Medications" aria-label="Medications" className="col-span-2 rounded-[12px] bg-ink/5 px-3 py-2 text-[15px] text-ink outline-none" />
                </div>
                <input type="text" value={form.medicalId} onChange={(e) => setForm({ ...form, medicalId: e.target.value })} className="w-full bg-transparent text-[18px] font-semibold text-ink outline-none placeholder:text-ink-3" placeholder="Blood group, allergies, conditions" />
              </div>
            </div>

            {/* Save Button */}
            <motion.button 
              whileTap={{ scale: 0.97 }}
              onClick={handleSave}
              className={`w-full mt-8 h-[56px] text-[16px] font-bold rounded-[20px] transition-all flex items-center justify-center gap-2 interactive ${
                saved ? 'bg-ok text-white shadow-[0_8px_30px_var(--ok)]' : 'glass text-teal border border-teal/20'
              }`}
            >
              {saved ? '✓ Saved Successfully' : 'Save Changes'}
            </motion.button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

import type { Contact } from '../../core/types';

/* ──────── Contact Editor Sub-Page ──────── */
function ContactSubpage({ open, onClose, contact, onSave, onDelete }: { open: boolean; onClose: () => void; contact: Contact | null; onSave: (c: Contact) => void; onDelete?: () => void }) {
  const [form, setForm] = useState(contact || { id: '', name: '', relation: '', phone: '', aliases: [] });
  const [pickErr, setPickErr] = useState<string | null>(null);

  useEffect(() => { if (contact) setForm(contact); else setForm({ id: Date.now().toString(), name: '', relation: '', phone: '', aliases: [] }); }, [contact, open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 30, stiffness: 300 }} className="absolute inset-0 z-[80] bg-bg overflow-y-auto no-scrollbar">
          <Atmosphere variant="user" />
          <div className="px-4 pb-8" style={{ paddingTop: 'calc(var(--island, 0px) + 12px)' }}>
            <div className="mb-6 mt-8 flex items-center gap-4">
              <button onClick={onClose} className="h-12 w-12 glass interactive rounded-full flex items-center justify-center text-ink shrink-0"><ChevronLeft size={24} /></button>
              <h1 className="text-[24px] font-bold text-ink">{contact ? 'Edit Contact' : 'New Contact'}</h1>
            </div>
            <button
              type="button"
              className="glass interactive mb-4 flex w-full items-center justify-center gap-2 rounded-[20px] border border-glass-border py-3 text-[15.5px] font-semibold text-ink"
              onClick={async () => {
                setPickErr(null);
                try {
                  const r = await AissNative.pickContact();
                  if (!r.cancelled) setForm({ ...form, name: r.name ?? form.name, phone: r.phone ?? form.phone });
                } catch (e) {
                  setPickErr(/not available|implemented/i.test((e as Error).message) ? 'Choosing from contacts works in the Android app. Type the details instead.' : friendlyError(e));
                }
              }}
            >
              Choose from phone contacts
            </button>
            {pickErr && <p className="-mt-2 mb-3 px-1 text-[13.5px] text-amber-ink">{pickErr}</p>}


            <div className="flex flex-col gap-4">
              <div className="glass rounded-[20px] p-4 border border-glass-border">
                <label className="text-[13px] font-bold text-ink-3 uppercase tracking-wider block mb-2">Name</label>
                <input type="text" value={form.name} onChange={e => setForm({...form, name: e.target.value})} className="w-full bg-transparent text-[18px] font-semibold text-ink outline-none" placeholder="e.g. Papa" />
              </div>
              <div className="glass rounded-[20px] p-4 border border-glass-border">
                <label className="text-[13px] font-bold text-ink-3 uppercase tracking-wider block mb-2">Relationship</label>
                <input type="text" value={form.relation} onChange={e => setForm({...form, relation: e.target.value})} className="w-full bg-transparent text-[18px] font-semibold text-ink outline-none" placeholder="e.g. Father" />
              </div>
              <div className="glass rounded-[20px] p-4 border border-glass-border">
                <label className="text-[13px] font-bold text-ink-3 uppercase tracking-wider block mb-2">Phone Number</label>
                <input type="tel" value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} className="w-full bg-transparent text-[18px] font-semibold text-ink outline-none" placeholder="+91..." />
              </div>
            </div>

            <div className="flex items-center gap-3 mt-8">
              {contact && (
                <button onClick={() => { onDelete?.(); onClose(); }} className="flex-1 h-[56px] bg-sos/10 text-sos text-[16px] font-bold rounded-[20px] interactive">
                  Remove Contact
                </button>
              )}
              <motion.button 
                whileTap={{ scale: 0.97 }}
                onClick={() => { onSave(form); onClose(); }}
                className={`flex-1 h-[56px] ${contact ? 'glass text-teal border border-teal/20' : 'bg-gradient-to-r from-teal to-mint text-white shadow-lg'} text-[16px] font-bold rounded-[20px] interactive`}
              >
                Save Contact
              </motion.button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ──────── Emergency SOS Sub-Page ──────── */
function EmergencySubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useSession((s) => s.settings);
  const contacts = useSession((s) => s.contacts);
  const updateSettings = useSession((s) => s.updateSettings);
  const setSession = useSession((s) => s.set);
  
  const [testTriggered, setTestTriggered] = useState(false);
  
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [isAddingContact, setIsAddingContact] = useState(false);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
          transition={{ type: 'spring', damping: 30, stiffness: 300 }}
          className="absolute inset-0 z-[70] bg-bg overflow-hidden"
        >
          <Atmosphere variant="user" />
          
          {/* Scrollable inner content */}
          <div className="absolute inset-0 overflow-y-auto no-scrollbar px-4 pb-8" style={{ paddingTop: 'calc(var(--island, 0px) + 12px)' }}>
            <div className="mb-6 mt-8 flex items-center gap-4">
              <button onClick={onClose} className="h-12 w-12 glass interactive rounded-full flex items-center justify-center text-ink shrink-0">
                <ChevronLeft size={24} />
              </button>
              <h1 className="text-[24px] font-bold text-ink">Emergency & SOS</h1>
            </div>

            {/* Fall Detection */}
            <div className="glass rounded-[24px] p-5 border border-glass-border flex items-center gap-4 mb-5">
              <div className="p-3 bg-sos/10 rounded-[14px] text-sos"><AlertTriangle size={24} /></div>
              <div className="flex-1">
                <p className="text-[17px] font-bold text-ink">Fall Detection</p>
                <p className="text-[14px] text-ink-3 mt-0.5">Auto-triggers SOS when a fall is detected</p>
              </div>
              <Toggle 
                label="Fall Detection" 
                on={settings.sosTriggers.fall} 
                onChange={(v) => updateSettings({ sosTriggers: { ...settings.sosTriggers, fall: v } })} 
              />
            </div>

            {/* SOS Contacts */}
            <h2 className="text-[18px] font-bold text-ink px-1 mb-3">SOS Contacts</h2>
            <div className="glass rounded-[24px] overflow-hidden border border-glass-border [&>*+*]:border-t [&>*+*]:border-line mb-5">
              {contacts.map((c, i) => (
                <button key={c.id} onClick={() => setEditingContact(c)} className="flex items-center gap-4 px-4 py-4 w-full text-left interactive">
                  <div className="w-12 h-12 rounded-full bg-teal/10 flex items-center justify-center text-[22px] font-bold text-teal shrink-0">
                    {c.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[16px] font-bold text-ink">{c.name} <span className="text-[13px] font-normal text-ink-3 ml-1">({c.relation})</span></p>
                    <p className="text-[14px] text-ink-3 mt-0.5">{c.phone}</p>
                  </div>
                  <span className="text-[13px] font-bold text-teal bg-teal/10 px-3 py-1 rounded-full">Slot {i + 1}</span>
                </button>
              ))}
              {contacts.length < 5 && (
                <button onClick={() => setIsAddingContact(true)} className="flex items-center gap-4 px-4 py-4 w-full text-left interactive">
                  <div className="w-12 h-12 rounded-full bg-ink/5 flex items-center justify-center text-ink-3 shrink-0 border-2 border-dashed border-ink/20">
                    <Plus size={22} />
                  </div>
                  <p className="text-[16px] font-semibold text-ink-2">Add New Contact</p>
                </button>
              )}
            </div>

            {/* Emergency Message */}
            <h2 className="text-[18px] font-bold text-ink px-1 mb-3">SOS Message</h2>
            <div className="glass rounded-[20px] p-4 border border-glass-border mb-6">
              <textarea
                value={settings.sosMessage}
                onChange={(e) => updateSettings({ sosMessage: e.target.value.slice(0, 280) })}
                aria-label="SOS message"
                className="w-full bg-transparent text-[16px] text-ink outline-none resize-none h-24 placeholder:text-ink-3" 
                placeholder="Message sent to contacts during SOS"
              />
            </div>

            {/* Test SOS */}
            <motion.button 
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
              className={`w-full h-16 text-[18px] font-bold rounded-[24px] shadow-lg transition-all ${
                testTriggered 
                  ? 'bg-ok text-white shadow-[0_8px_30px_var(--ok)]' 
                  : 'bg-amber/10 text-amber border-2 border-amber/30'
              }`}
            >
              {testTriggered ? '✓ Sound & vibration played. Nothing was sent.' : '⚠️ Test SOS sound & vibration (sends nothing)'}
            </motion.button>
          </div>
          <ContactSubpage 
            open={!!editingContact || isAddingContact} 
            onClose={() => { setEditingContact(null); setIsAddingContact(false); }}
            contact={editingContact}
            onSave={(c) => {
               if (isAddingContact) setSession({ contacts: [...contacts, c] });
               else setSession({ contacts: contacts.map(x => x.id === c.id ? c : x) });
            }}
            onDelete={() => {
               setSession({ contacts: contacts.filter(x => x.id !== editingContact?.id) });
            }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ──────── Easter Egg Game: Flappy Stick ──────── */
function StickGameSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const isDark = useSession(s => s.settings.theme === 'dark' || (s.settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches));
  
  const [playing, setPlaying] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [score, setScore] = useState(0);

  const stickRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<number>(0);
  
  const state = useRef({
    stickY: 50, velocity: 0, score: 0,
    obstacles: [] as { x: number, gapY: number, passed: boolean }[],
  });

  const jump = () => {
    if (!playing && !gameOver) {
      state.current = { stickY: 50, velocity: 0, obstacles: [{ x: 100, gapY: 50, passed: false }], score: 0 };
      setScore(0); setPlaying(true); return;
    }
    if (gameOver) {
      setGameOver(false);
      state.current = { stickY: 50, velocity: 0, obstacles: [{ x: 100, gapY: 50, passed: false }], score: 0 };
      setScore(0); setPlaying(true); return;
    }
    state.current.velocity = -1.2;
    navigator.vibrate?.(20);
  };

  useEffect(() => {
    if (!open) { setPlaying(false); setGameOver(false); return; }
    let lastTime = performance.now();
    const loop = (time: number) => {
      if (!playing) return;
      const dt = (time - lastTime) / 16;
      lastTime = time;
      const s = state.current;
      
      s.velocity += 0.08 * dt; // gravity
      s.stickY += s.velocity * dt;
      if (s.stickY < 0) s.stickY = 0;
      if (s.stickY > 90) { // floor crash
         setPlaying(false); setGameOver(true); navigator.vibrate?.([100, 50, 100]);
      }

      s.obstacles.forEach((obs) => {
        obs.x -= 0.7 * dt;
        // stick box check (stick is at x: 20-25, y: stickY)
        if (obs.x < 25 && obs.x > 15) {
           if (s.stickY < obs.gapY - 15 || s.stickY > obs.gapY + 15) {
              setPlaying(false); setGameOver(true); navigator.vibrate?.([100, 50, 100]);
           }
        }
        if (!obs.passed && obs.x < 15) {
           obs.passed = true; s.score += 1; setScore(s.score);
        }
      });

      if (s.obstacles[0] && s.obstacles[0].x < -10) s.obstacles.shift();
      const lastObs = s.obstacles[s.obstacles.length - 1];
      if (!lastObs || lastObs.x < 60) s.obstacles.push({ x: 100, gapY: 30 + Math.random() * 40, passed: false });

      if (stickRef.current) {
         stickRef.current.style.top = `${s.stickY}%`;
         stickRef.current.style.transform = `rotate(${s.velocity * 10}deg)`;
      }
      
      const obsContainer = document.getElementById('obs-container');
      if (obsContainer) {
         obsContainer.innerHTML = '';
         s.obstacles.forEach(o => {
            const topP = document.createElement('div');
            topP.className = 'absolute w-[10%] bg-gradient-to-b from-teal to-mint rounded-b-xl shadow-lg border border-white/20';
            topP.style.left = `${o.x}%`; topP.style.top = '0'; topP.style.height = `${o.gapY - 20}%`;
            
            const botP = document.createElement('div');
            botP.className = 'absolute w-[10%] bg-gradient-to-t from-teal to-mint rounded-t-xl shadow-lg border border-white/20';
            botP.style.left = `${o.x}%`; botP.style.bottom = '0'; botP.style.height = `${100 - (o.gapY + 20)}%`;
            
            obsContainer.appendChild(topP); obsContainer.appendChild(botP);
         });
      }
      requestRef.current = requestAnimationFrame(loop);
    };

    if (playing) requestRef.current = requestAnimationFrame(loop);
    return () => { if (requestRef.current) cancelAnimationFrame(requestRef.current); };
  }, [playing, open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', damping: 30, stiffness: 300 }} className={`absolute inset-0 z-[80] ${isDark ? 'bg-ink' : 'bg-glass-bg'} overflow-hidden`}>
          <div className="absolute inset-0 opacity-20 pointer-events-none" style={{ backgroundImage: `radial-gradient(circle at 50% 50%, ${isDark ? '#2dd4bf' : '#0fa08e'} 1px, transparent 1px)`, backgroundSize: '20px 20px' }} />
          <div className="absolute top-12 w-full px-6 flex items-center z-20 pointer-events-none">
            <button onClick={onClose} className={`w-12 h-12 rounded-full flex items-center justify-center pointer-events-auto shadow-xl ${isDark ? 'bg-white/10 text-white' : 'bg-black/5 text-ink'}`}><ChevronLeft size={24} /></button>
            <p className={`font-black text-[32px] drop-shadow-md flex-1 text-center ${isDark ? 'text-white' : 'text-ink'}`}>{score}</p>
            <div className="w-12" /> {/* Spacer */}
          </div>
          <div className="w-full h-full relative cursor-pointer active:bg-white/5 transition-colors" onClick={jump}>
             {!playing && !gameOver && (
                <div className={`absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-10 ${isDark ? 'text-white' : 'text-ink'}`}>
                   <div className="text-[64px] mb-4 drop-shadow-[0_0_15px_rgba(45,212,191,0.8)]">🦯</div>
                   <h2 className="text-[28px] font-bold">Flappy Stick</h2>
                   <p className="text-[16px] text-teal mt-2">Tap to jump & survive</p>
                </div>
             )}
             {gameOver && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-white pointer-events-none z-10 bg-black/40 backdrop-blur-md">
                   <h2 className="text-[42px] font-black text-sos drop-shadow-lg">CRASHED!</h2>
                   <p className="text-[24px] font-bold mt-2 bg-white/10 px-6 py-2 rounded-full">Score: {score}</p>
                   <p className="opacity-70 mt-6 animate-pulse text-[18px]">Tap anywhere to restart</p>
                </div>
             )}
             <div id="obs-container" className="absolute inset-0 pointer-events-none" />
             <div ref={stickRef} className="absolute left-[20%] w-[5%] h-[12%] text-[36px] flex items-center justify-center origin-center transition-none pointer-events-none z-20 drop-shadow-[0_0_8px_rgba(45,212,191,0.5)]" style={{ top: '50%' }}>
                🦯
             </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}



/* ──────── Accessibility & Vision Sub-Page ──────── */
function AccessibilitySubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useSession((x) => x.settings);
  const update = useSession((x) => x.updateSettings);

  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 30, stiffness: 300 }} className="absolute inset-0 z-[70] bg-bg overflow-y-auto no-scrollbar">
          <Atmosphere variant="user" />
          <div className="px-4 pb-8" style={{ paddingTop: 'calc(var(--island, 0px) + 12px)' }}>
            <div className="mb-6 mt-8 flex items-center gap-4">
              <button onClick={onClose} className="h-12 w-12 glass interactive rounded-full flex items-center justify-center text-ink shrink-0"><ChevronLeft size={24} /></button>
              <h1 className="text-[24px] font-bold text-ink">Accessibility</h1>
            </div>

            <section className="mb-5">
              <h2 className="mb-2 px-1 text-[17px] font-semibold text-ink-2">Assistant replies in</h2>
              <Segmented label="Reply language" size="lg" value={s.replyLang} onChange={(v) => update({ replyLang: v })} options={[{ value: 'auto', label: 'Same as me' }, { value: 'en', label: 'English' }, { value: 'hi', label: 'हिंदी' }]} />
            </section>

            <section className="mb-5">
              <h2 className="mb-2 px-1 text-[17px] font-semibold text-ink-2">Voice speed</h2>
              <Segmented 
                label="Voice speed" size="lg" value={s.voiceRate} 
                onChange={(v) => { update({ voiceRate: v }); void speak('This is how fast I will talk.', 'en'); }} 
                options={[{ value: 0.85, label: 'Slow' }, { value: 1, label: 'Normal' }, { value: 1.25, label: 'Fast' }]} 
              />
            </section>

            <section className="mb-5">
              <h2 className="mb-2 px-1 text-[17px] font-semibold text-ink-2">Text size</h2>
              <div className="glass flex items-center gap-3 rounded-[24px] p-2">
                <GlassButton size="lg" aria-label="Smaller text" className="w-16 !px-0" onClick={() => update({ textScale: clamp(+(s.textScale - 0.15).toFixed(2), 0.85, 1.6) })}><Minus size={22} /></GlassButton>
                <p className="scaled-text flex-1 text-center font-semibold text-ink" style={{ ['--fs' as string]: '20px' }}>Aa {Math.round(s.textScale * 100)}%</p>
                <GlassButton size="lg" aria-label="Bigger text" className="w-16 !px-0" onClick={() => update({ textScale: clamp(+(s.textScale + 0.15).toFixed(2), 0.85, 1.6) })}><Plus size={22} /></GlassButton>
              </div>
            </section>

            <h2 className="mb-2 px-1 text-[17px] font-semibold text-ink-2">Preferences</h2>
            <div className="glass overflow-hidden rounded-[28px] [&>*+*]:border-t [&>*+*]:border-line mb-5">
              <BigRow icon={<Accessibility size={22} />} label="Screen reader mode" detail="Big buttons instead of taps on the orb. Best with TalkBack or VoiceOver." on={s.screenReaderMode} onChange={(v) => { update({ screenReaderMode: v }); navigator.vibrate?.(50); }} />
              <BigRow icon={<Contrast size={22} />} label="High contrast" detail="Solid surfaces and stronger outlines" on={s.highContrast} onChange={(v) => { update({ highContrast: v }); navigator.vibrate?.(50); }} />
              <BigRow icon={<Volume2 size={22} />} label="Sounds" detail="Ticks, beeps and the thinking tune" on={s.earcons} onChange={(v) => { update({ earcons: v }); navigator.vibrate?.(50); }} />
              <BigRow icon={<Vibrate size={22} />} label="Phone vibration" detail="The stick always vibrates for obstacles" on={s.haptics} onChange={(v) => { update({ haptics: v }); navigator.vibrate?.(50); }} />
              {useRuntime.getState().mode === 'demo' && (
                <BigRow icon={<Mic size={22} />} label="Use the real microphone" detail={recognitionSupported() ? 'Demo only: speech recognition in this browser.' : 'Not available in this browser'} on={s.realMic && recognitionSupported()} onChange={(v) => { update({ realMic: v }); navigator.vibrate?.(50); }} />
              )}
              <BigRow icon={<Sparkles size={22} />} label="Reduce motion" detail="Fewer animations" on={s.reduceMotion} onChange={(v) => update({ reduceMotion: v })} />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ──────── Hardware Management Sub-Page ──────── */
function HardwareSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const d = useDevice();
  const update = useSession((x) => x.updateSettings);
  const cal = useSession((x) => x.settings.imuCalibration);
  const st = useSession((x) => x.settings);
  const [testing, setTesting] = useState(false);
  const [testReport, setTestReport] = useState<string | null>(null);
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
  const mode = useRuntime((x) => x.mode);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [legacyIp, setLegacyIp] = useState('');
  const connected = isLinked(d.link);
  const l = linkLabel(d.link);

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
    setMsg('Stick unpaired from this phone. To pair it again, reset it: hold its button while switching it on (5 s).');
  };

  const [otaChecking, setOtaChecking] = useState(false);
  const [otaProgress, setOtaProgress] = useState<string | null>(null);

  const checkOta = async () => {
    if (!connected || !d.identity) return;
    setOtaChecking(true);
    setMsg('Checking for updates...');
    try {
      const release = await call<any, any>('getLatestFirmwareRelease', {});
      if (!release || release.version <= d.identity.firmware) {
        setMsg('Your stick is already up to date.');
        return;
      }
      setOtaProgress(`Downloading version ${release.version}...`);
      const res = await fetch(release.binaryUrl);
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      setOtaProgress('Verifying signature...');
      const isValid = await verifyFirmware(blob, release.sha256, release.signature);
      if (!isValid) throw new Error('Firmware signature verification failed');

      setOtaProgress('Sending to stick...');
      const t = getTransport();
      if (t && t.pushOTA) {
        await t.pushOTA(blob, release.sha256);
        setMsg(`Firmware update to ${release.version} sent. The stick will reboot now.`);
      } else {
        setMsg('OTA is not supported in this mode.');
      }
    } catch (e) {
      setMsg(`Update failed: ${friendlyError(e)}`);
    } finally {
      setOtaChecking(false);
      setOtaProgress(null);
    }
  };

  const item = (icon: React.ReactNode, tone: string, title: string, sub: string, onClick?: () => void, disabled?: boolean) => (
    <button type="button" disabled={disabled} className="flex items-center gap-4 px-4 py-4 w-full text-left interactive disabled:opacity-50" onClick={onClick}>
      <div className={`w-10 h-10 rounded-full flex items-center justify-center ${tone}`}>{icon}</div>
      <div className="flex-1"><p className="text-[16px] font-bold text-ink">{title}</p><p className="text-[13px] text-ink-3 mt-0.5">{sub}</p></div>
    </button>
  );

  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 30, stiffness: 300 }} className="absolute inset-0 z-[70] bg-bg overflow-y-auto no-scrollbar">
          <Atmosphere variant="user" />
          <div className="px-4 pb-8" style={{ paddingTop: 'calc(var(--island, 0px) + 12px)' }}>
            <div className="mb-6 mt-8 flex items-center gap-4">
              <button onClick={onClose} aria-label="Back" className="h-12 w-12 glass interactive rounded-full flex items-center justify-center text-ink shrink-0"><ChevronLeft size={24} /></button>
              <h1 className="text-[24px] font-bold text-ink">Hardware</h1>
            </div>

            <div className="glass rounded-[24px] p-6 flex flex-col items-center justify-center mb-6 border border-glass-border shadow-sm">
               <StickVisual height={180} />
               <p className="text-[18px] font-bold text-ink mt-4">{BRAND.name}</p>
               <p className="text-[14px] text-ink-3 mt-1">{d.identity ? `${d.identity.deviceId} · firmware ${d.health?.firmware ?? d.identity.firmware} · protocol v${d.identity.protocolVersion}` : 'No stick paired'}</p>
               {d.health && <p className="text-[12.5px] text-ink-3 mt-0.5">Last restart: {d.health.resetReason ?? 'unknown'}{d.health.mode && d.health.mode !== 'normal' ? ` · mode ${d.health.mode}` : ''}{d.health.errors?.length ? ` · issues: ${d.health.errors.join(', ')}` : ''}</p>}
               <p className="text-[14px] font-semibold mt-1 text-ink-2">{l.text}{d.linkDetail ? ` · ${d.linkDetail}` : ''}</p>
            </div>

            {msg && <p className="mb-4 rounded-[18px] bg-teal-soft px-4 py-3 text-[15px] font-medium text-teal-ink" role="status">{msg}</p>}

            <h2 className="mb-2 px-1 text-[17px] font-semibold text-ink-2">Device Management</h2>
            <div className="glass overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line mb-5 border border-glass-border">
              {item(<Search size={20} />, 'bg-info/10 text-info', 'Find My Stick', connected ? 'Vibrate the stick so you can find it' : 'Stick not connected', () => void locate(), !connected)}
              {item(<Radar size={20} />, 'bg-teal/10 text-teal', 'Calibrate orientation', cal ? 'Hold the stick upright, then tap to update' : 'Not calibrated. Hold the stick upright, then tap', calibrate, !connected)}
              {item(<Download size={20} />, 'bg-teal/10 text-teal', otaProgress || (otaChecking ? 'Checking...' : 'Update Firmware'), d.identity ? `Installed ${d.identity.firmware}. Tap to check for updates.` : 'Unknown until a stick is paired', checkOta, !connected || otaChecking)}
              {item(<Wifi size={20} />, 'bg-teal/10 text-teal', d.link === 'unpaired' ? 'Set up stick' : 'Set up again', 'Hold the stick button 5 s, then follow the steps', () => { onClose(); useUI.setState({ userSettings: false, stickSetup: true }); })}
              {d.link !== 'unpaired' && item(<Unplug size={20} />, 'bg-sos/10 text-sos', 'Unpair Stick', 'Forget this stick and its key on this phone', () => setConfirmUnpair(true))}
            </div>
            {confirmUnpair && (
              <div className="glass mb-5 rounded-[24px] border border-sos/30 p-4">
                <p className="text-[15px] font-semibold text-ink">Unpair the stick? It will stop connecting to this phone until you set it up again.</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <GlassButton size="sm" onClick={() => setConfirmUnpair(false)}>Keep</GlassButton>
                  <GlassButton size="sm" variant="sos" onClick={() => void unpair()}>Unpair</GlassButton>
                </div>
              </div>
            )}

            <h2 className="mb-2 px-1 text-[17px] font-semibold text-ink-2">Stick behaviour</h2>
            <div className="glass mb-2 rounded-[24px] border border-glass-border p-4 space-y-4">
              <div>
                <p className="mb-2 text-[15px] font-semibold text-ink">Obstacle sensitivity</p>
                <Segmented label="Obstacle sensitivity" size="sm" value={st.obstacleSensitivity} onChange={(v) => update({ obstacleSensitivity: v })} options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} />
                <p className="mt-1.5 text-[13px] text-ink-3">Danger below {SENSITIVITY[st.obstacleSensitivity].dangerCm} cm, warning below {SENSITIVITY[st.obstacleSensitivity].warningCm} cm, awareness below {SENSITIVITY[st.obstacleSensitivity].awarenessCm} cm. Decided on the stick itself, even without the phone.</p>
              </div>
              <label className="block">
                <span className="flex items-center justify-between text-[15px] font-semibold text-ink">Vibration strength <span className="text-teal">{st.hapticStrength}%</span></span>
                <input type="range" min={20} max={100} step={10} value={st.hapticStrength} onChange={(e) => update({ hapticStrength: Number(e.target.value) })} className="mt-2 w-full accent-teal" aria-label="Vibration strength" />
                <span className="text-[13px] text-ink-3">Obstacle danger alerts never go below 60%.</span>
              </label>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[15px] font-semibold text-ink">Obstacle vibration</span>
                <Toggle label="Obstacle vibration" on={st.obstacleVibration} onChange={(v) => update({ obstacleVibration: v })} />
              </div>
              <div>
                <p className="mb-2 text-[15px] font-semibold text-ink">Sleep when not moving</p>
                <Segmented label="Auto sleep" size="sm" value={String(st.autoSleepMin)} onChange={(v) => update({ autoSleepMin: Number(v) })} options={[{ value: '0', label: 'Never' }, { value: '10', label: '10 min' }, { value: '30', label: '30 min' }]} />
              </div>
              <p className="text-[13.5px] font-semibold" role="status">
                {d.configSync.state === 'applied' && <span className="text-ok">✓ Applied on the stick (v{d.configSync.appliedVersion})</span>}
                {d.configSync.state === 'pending' && <span className="text-teal-ink">Sending to the stick…</span>}
                {d.configSync.state === 'rejected' && <span className="text-sos">The stick rejected these settings: {d.configSync.error}</span>}
                {(d.configSync.state === 'offline' || d.configSync.state === 'idle') && <span className="text-ink-3">Saved. Will apply when the stick connects.</span>}
              </p>
            </div>
            <GlassButton size="sm" className="mb-5 w-full" disabled={!connected || testing} onClick={() => void selfTest()}>{testing ? 'Testing the stick…' : 'Run stick self-test'}</GlassButton>
            {testReport && <pre className="mb-5 max-h-56 overflow-auto whitespace-pre-wrap rounded-[16px] bg-ink/[0.06] p-3 text-[12.5px] text-ink-2">{testReport}</pre>}

            {mode === 'real' && (
              <>
                <h2 className="mb-2 px-1 text-[17px] font-semibold text-ink-2">Hardware test (developers)</h2>
                <div className="glass rounded-[24px] p-4 border border-glass-border">
                  <p className="text-[13.5px] leading-snug text-ink-3">Connect to the old test firmware (/data, /stream) by IP. It has no authentication, so it is labelled “Unverified test firmware” and battery % from it is not trusted.</p>
                  <div className="mt-3 flex gap-2">
                    <input value={legacyIp} onChange={(e) => setLegacyIp(e.target.value)} placeholder="192.168.43.120" aria-label="Test firmware IP address" className="h-11 min-w-0 flex-1 rounded-full border border-line bg-surface/70 px-4 text-[15px] text-ink outline-none" />
                    <GlassButton size="sm" disabled={!/^\d+\.\d+\.\d+\.\d+$/.test(legacyIp)} onClick={() => void connectLegacyTestFirmware(legacyIp)}>Connect</GlassButton>
                  </div>
                </div>
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ──────── Privacy: camera & location ──────── */
function PrivacySubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useSession((x) => x.settings);
  const bg = useBackground();
  const [batt, setBatt] = useState<{ ignoring: boolean; manufacturer: string } | null>(null);
  useEffect(() => {
    if (open && bg.supported) void AissNative.getBatteryOptimization().then(setBatt).catch(() => setBatt(null));
  }, [open, bg.supported]);
  const update = useSession((x) => x.updateSettings);
  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 30, stiffness: 300 }} className="absolute inset-0 z-[70] bg-bg overflow-y-auto no-scrollbar">
          <Atmosphere variant="user" />
          <div className="px-4 pb-8" style={{ paddingTop: 'calc(var(--island, 0px) + 12px)' }}>
            <div className="mb-6 mt-8 flex items-center gap-4">
              <button onClick={onClose} aria-label="Back" className="h-12 w-12 glass interactive rounded-full flex items-center justify-center text-ink shrink-0"><ChevronLeft size={24} /></button>
              <h1 className="text-[24px] font-bold text-ink">Camera & Location</h1>
            </div>
            <div className="glass overflow-hidden rounded-[28px] [&>*+*]:border-t [&>*+*]:border-line mb-5">
              <BigRow icon={<MapPin size={22} />} label="Share live location with guardian" detail="During an SOS your location is always shared." on={s.locationSharing} onChange={(v) => update({ locationSharing: v })} />
              <BigRow
                icon={<Smartphone size={22} />}
                label="Keep running with the screen off"
                detail={!bg.supported ? 'Available in the Android app only' : bg.error ? `Could not start: ${bg.error}` : bg.running ? 'On now: stick, GPS and SOS keep working. Android shows a notification.' : 'Starts when a stick is paired, during SOS or navigation.'}
                on={s.runInBackground}
                onChange={(v) => update({ runInBackground: v })}
              />
              {bg.supported && batt && !batt.ignoring && (
                <div className="px-4 py-3">
                  <p className="text-[14px] leading-snug text-amber-ink">Android battery saving may stop AI SmartStick in the background{/xiaomi|redmi|samsung|oppo|vivo|realme/i.test(batt.manufacturer) ? ` (common on ${batt.manufacturer})` : ''}.</p>
                  <button type="button" className="mt-2 text-[14.5px] font-semibold text-teal-ink underline" onClick={() => void AissNative.openBatteryOptimizationSettings().catch(() => undefined)}>Open battery settings → choose “Don’t optimise”</button>
                </div>
              )}
              <div className="px-4 py-3">
                <p className="mb-2 flex items-center gap-2 text-[16px] font-medium text-ink"><ScanEye size={18} className="text-ink-3" /> When your guardian asks for the camera</p>
                <Segmented label="Camera requests" size="sm" value={s.cameraRequests} onChange={(v) => update({ cameraRequests: v })} options={[{ value: 'auto', label: 'Announce & allow' }, { value: 'ask', label: 'Ask me first' }]} />
                <p className="mt-2 text-[13.5px] leading-snug text-ink-3">You always hear “camera requested”, “camera active” and “camera ended”. Photos go straight to your guardian’s phone and are never stored.</p>
              </div>
              <div className="px-4 py-3">
                <p className="mb-2 flex items-center gap-2 text-[16px] font-medium text-ink"><Phone size={18} className="text-ink-3" /> Calls to your guardian</p>
                <Segmented label="Call mode" size="sm" value={s.callMode} onChange={(v) => { update({ callMode: v }); if (v === 'direct') void AissNative.requestPermissions({ permissions: ['phone'] }).catch(() => undefined); }} options={[{ value: 'direct', label: 'Call directly' }, { value: 'dialer', label: 'Open dialer' }]} />
              </div>
              <div className="px-4 py-3">
                <p className="mb-2 flex items-center gap-2 text-[16px] font-medium text-ink"><MessageSquare size={18} className="text-ink-3" /> Texts to your guardian</p>
                <Segmented label="SMS mode" size="sm" value={s.smsMode} onChange={(v) => { update({ smsMode: v }); if (v === 'direct') void AissNative.requestPermissions({ permissions: ['sms'] }).catch(() => undefined); }} options={[{ value: 'composer', label: 'Open messages' }, { value: 'direct', label: 'Send directly' }]} />
                <p className="mt-2 text-[13.5px] leading-snug text-ink-3">“Send directly” needs Android SMS permission. Otherwise the message opens for you to press send, and the assistant says so.</p>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ──────── Activity history ──────── */
function ActivitySubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const events = useActivity((x) => x.events);
  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 30, stiffness: 300 }} className="absolute inset-0 z-[70] bg-bg overflow-y-auto no-scrollbar">
          <Atmosphere variant="user" />
          <div className="px-4 pb-8" style={{ paddingTop: 'calc(var(--island, 0px) + 12px)' }}>
            <div className="mb-6 mt-8 flex items-center gap-4">
              <button onClick={onClose} aria-label="Back" className="h-12 w-12 glass interactive rounded-full flex items-center justify-center text-ink shrink-0"><ChevronLeft size={24} /></button>
              <h1 className="text-[24px] font-bold text-ink">Activity History</h1>
            </div>
            <p className="mb-4 px-1 text-[14.5px] leading-snug text-ink-3">Events (connections, alerts, walks, camera access) are saved to your account and shared with your linked guardian. Camera photos are never saved.</p>
            <div className="glass overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line">
              {events.length ? events.slice(0, 40).map((e) => <EventRow key={e.id} e={e} now={Date.now()} />) : <p className="px-4 py-6 text-center text-[15px] text-ink-3">No activity yet.</p>}
            </div>
            <GlassButton size="lg" className="mt-4 w-full" onClick={() => useActivity.setState({ events: [] })}>Clear from this screen</GlassButton>
            <p className="mt-2 px-1 text-[13px] text-ink-3">Clearing hides events on this phone only; account history remains for your guardian.</p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ──────── Device information ──────── */
function DeviceInfoSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const p = usePhoneInfo();
  const d = useDevice();
  const mode = useRuntime((x) => x.mode);
  const [confirmMode, setConfirmMode] = useState(false);
  const [delState, setDelState] = useState<string>('idle');
  const row = (k: string, v: string) => (
    <div className="flex items-center justify-between gap-3 px-4 py-3"><span className="text-[15px] text-ink-2">{k}</span><span className="text-right text-[15px] font-semibold text-ink">{v}</span></div>
  );
  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 30, stiffness: 300 }} className="absolute inset-0 z-[70] bg-bg overflow-y-auto no-scrollbar">
          <Atmosphere variant="user" />
          <div className="px-4 pb-8" style={{ paddingTop: 'calc(var(--island, 0px) + 12px)' }}>
            <div className="mb-6 mt-8 flex items-center gap-4">
              <button onClick={onClose} aria-label="Back" className="h-12 w-12 glass interactive rounded-full flex items-center justify-center text-ink shrink-0"><ChevronLeft size={24} /></button>
              <h1 className="text-[24px] font-bold text-ink">Device Information</h1>
            </div>
            <div className="glass overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line mb-5">
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
                <p className="mt-1 text-[13.5px] leading-snug text-ink-3">Permanently deletes your profile, settings, activity, assistant history and SOS records, and unlinks your guardian. This cannot be undone.</p>
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
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Full-Fledged Settings Hub — Profile, Emergency, Accessibility, Hardware */
export function UserSettings() {
  const open = useUI((s) => s.userSettings);
  const s = useSession((x) => x.settings);
  const update = useSession((x) => x.updateSettings);
  const layout = useUI((x) => x.layout);
  const close = () => useUI.setState({ userSettings: false });
  const linkState = useDevice((s) => s.link);
  const battery = useDevice((s) => s.battery);
  const contactsCount = useSession((x) => x.contacts.length);
  const guardianName = useSession((x) => x.guardian.heardAs);
  const mode = useRuntime((x) => x.mode);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  
  const isDark = s.theme === 'dark' || (s.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const [profileOpen, setProfileOpen] = useState(false);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [accessibilityOpen, setAccessibilityOpen] = useState(false);
  const [gameOpen, setGameOpen] = useState(false);
  const [hardwareOpen, setHardwareOpen] = useState(false);
  
  const [osTapCount, setOsTapCount] = useState(0);
  const tapTimeoutRef = useRef<any>(undefined);

  const handleOsTap = () => {
    setOsTapCount((prev) => {
      const next = prev + 1;
      if (next >= 3) {
        setGameOpen(true);
        navigator.vibrate?.([50, 100, 150]);
        return 0; // reset
      }
      return next;
    });
    if (tapTimeoutRef.current) clearTimeout(tapTimeoutRef.current);
    tapTimeoutRef.current = setTimeout(() => setOsTapCount(0), 1000);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          className="absolute inset-0 z-[60] overflow-hidden bg-bg"
          initial={{ clipPath: 'circle(0% at 85% 85%)' }}
          animate={{ clipPath: 'circle(150% at 85% 85%)' }}
          exit={{ clipPath: 'circle(0% at 85% 85%)' }}
          transition={{ duration: 0.35, ease: 'linear' }}
        >
          <Atmosphere variant="user" />
          <motion.div 
            animate={{ 
              opacity: profileOpen || emergencyOpen || accessibilityOpen || hardwareOpen ? 0 : 1, 
              x: profileOpen || emergencyOpen || accessibilityOpen || hardwareOpen ? -50 : 0 
            }} 
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className={`absolute inset-0 overflow-y-auto no-scrollbar px-4 pb-8 ${profileOpen || emergencyOpen || accessibilityOpen || hardwareOpen ? 'pointer-events-none' : ''}`}
            style={{ paddingTop: 'calc(var(--island, 0px) + 12px)' }}
          >
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
                onClick={() => { close(); useUI.setState({ stickPage: true }); }}
                className="glass flex-1 rounded-[28px] p-5 border border-glass-border flex flex-col items-center justify-center relative overflow-hidden shadow-lg interactive"
              >
                <div className="absolute inset-0 bg-gradient-to-br from-teal/10 to-teal/5 pointer-events-none" />
                <div className="absolute -top-10 -left-10 w-40 h-40 bg-teal/15 rounded-full blur-2xl pointer-events-none" />
                <div className="flex-1 flex flex-col justify-center items-center relative z-10 w-full">
                  <StickVisual height={160} />
                  <p className="text-[15px] font-bold text-ink mt-3 tracking-wide uppercase opacity-80">AI SmartStick</p>
                </div>
              </button>

              {/* Info Column - Right */}
              <div className="w-[140px] flex flex-col gap-3 shrink-0">
                {/* Brand box (easter egg trigger: tap 3×) */}
                <button 
                  onClick={handleOsTap}
                  className="glass interactive flex-1 rounded-[24px] p-4 border border-glass-border flex flex-col justify-between shadow-sm relative overflow-hidden"
                >
                  <div className={`absolute inset-0 bg-white transition-opacity duration-300 ${osTapCount > 0 ? 'opacity-20' : 'opacity-0'}`} />
                  <div className="flex items-baseline justify-center mt-2 relative z-10">
                    <span className="text-[40px] font-black text-transparent bg-clip-text bg-gradient-to-br from-teal to-mint leading-none drop-shadow-sm">V1</span>
                  </div>
                  <div className="text-center mb-1 relative z-10">
                    <p className="text-[13px] font-bold text-ink">{BRAND.name}</p>
                    <p className="text-[11px] text-ink-3">v{ENV.appVersion}</p>
                  </div>
                </button>

                {/* Device Health Mini */}
                <button 
                  onClick={() => { close(); useUI.setState({ batteryPage: true }); }}
                  className="glass flex-1 rounded-[24px] p-3 border border-glass-border flex flex-col justify-center shadow-sm interactive"
                >
                  <p className="text-[12px] font-bold text-ink-3 uppercase tracking-wider mb-2 text-center">Health</p>
                  <div className="flex items-center gap-2 justify-center mb-2">
                    <Battery size={16} className={battery.status === 'ok' ? 'text-ok' : 'text-ink-3'} />
                    <span className="text-[16px] font-bold text-ink">{batteryLabel(battery).text}</span>
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

              {/* Emergency SOS Card */}
              <motion.button 
                whileTap={{ scale: 0.98 }}
                onClick={() => setEmergencyOpen(true)}
                className="glass rounded-[24px] p-5 border border-sos/20 bg-sos/5 flex items-center gap-4 w-full text-left interactive shadow-sm"
              >
                <div className="p-3 bg-sos/15 rounded-[14px] text-sos">
                  <Shield size={26} />
                </div>
                <div className="flex-1">
                  <p className="text-[17px] font-bold text-ink">Emergency & SOS</p>
                  <p className="text-[14px] text-ink-3 mt-0.5">{guardianName ? `Guardian: ${guardianName}` : 'No guardian linked'} · {contactsCount} contact{contactsCount === 1 ? '' : 's'} · Fall detection {s.sosTriggers.fall ? 'on' : 'off'}</p>
                </div>
                <ChevronRight size={20} className="text-ink-3" />
              </motion.button>

              {/* Take Me Home */}
              <button 
                onClick={() => setProfileOpen(true)}
                className="glass rounded-[24px] p-5 border border-glass-border flex items-center gap-4 shadow-sm interactive w-full text-left"
              >
                <div className="p-3 bg-info/10 rounded-[14px] text-info">
                  <Home size={24} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[17px] font-bold text-ink">Take Me Home</p>
                  <p className="text-[14px] text-ink-3 mt-0.5 truncate italic">
                    {useSession.getState().person.homeAddress || 'No home address set'}
                  </p>
                </div>
                <ChevronRight size={20} className="text-ink-3 shrink-0" />
              </button>
            </div>

            <div className="flex flex-col gap-6 mb-8">
              {/* AI SMART STICK */}
              <div>
                <h2 className="mb-2 px-1 text-[14px] font-bold text-ink-3 uppercase tracking-wider">AI SMART STICK</h2>
                <div className="glass overflow-hidden rounded-[24px] border border-glass-border">
                  <NavRow 
                    icon={<Smartphone size={20} />} iconBg="bg-teal/10 text-teal" 
                    label="Stick Connection & Hardware" detail="Manage paired stick, battery, firmware"
                    onClick={() => setHardwareOpen(true)} 
                  />
                </div>
              </div>

              {/* ASSISTANCE */}
              <div>
                <h2 className="mb-2 px-1 text-[14px] font-bold text-ink-3 uppercase tracking-wider">ASSISTANCE</h2>
                <div className="glass overflow-hidden rounded-[24px] border border-glass-border">
                  <NavRow 
                    icon={<Mic size={20} />} iconBg="bg-teal/10 text-teal" 
                    label="Voice, Language & Vision" detail="AI behaviour, camera preferences"
                    onClick={() => setAccessibilityOpen(true)} 
                  />
                </div>
              </div>

              {/* SAFETY */}
              <div>
                <h2 className="mb-2 px-1 text-[14px] font-bold text-ink-3 uppercase tracking-wider">SAFETY</h2>
                <div className="glass overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line">
                  <NavRow 
                    icon={<ShieldAlert size={20} />} iconBg="bg-sos/10 text-sos" 
                    label="Emergency & SOS" detail="Contacts, countdown, fall detection"
                    onClick={() => setEmergencyOpen(true)} 
                  />
                  <NavRow 
                    icon={<User size={20} />} iconBg="bg-info/10 text-info" 
                    label="Medical Profile" detail="Medical ID and home address"
                    onClick={() => setProfileOpen(true)} 
                  />
                </div>
              </div>

              {/* ACCESSIBILITY */}
              <div>
                <h2 className="mb-2 px-1 text-[14px] font-bold text-ink-3 uppercase tracking-wider">ACCESSIBILITY</h2>
                <div className="glass overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line">
                  <NavRow 
                    icon={<Accessibility size={20} />} iconBg="bg-amber/10 text-amber" 
                    label="Display & Vision" detail="Text size, high contrast, screen reader"
                    onClick={() => setAccessibilityOpen(true)} 
                  />
                  <NavRow 
                    icon={<Vibrate size={20} />} iconBg="bg-sos/10 text-sos" 
                    label="Haptics & Feedback" detail="Vibration intensity, reduced motion"
                    onClick={() => setAccessibilityOpen(true)} 
                  />
                </div>
              </div>

              {/* PRIVACY */}
              <div>
                <h2 className="mb-2 px-1 text-[14px] font-bold text-ink-3 uppercase tracking-wider">PRIVACY</h2>
                <div className="glass overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line">
                  <NavRow 
                    icon={<ScanEye size={20} />} iconBg="bg-ink-3/10 text-ink-3" 
                    label="Camera & Location" detail={`Location sharing ${s.locationSharing ? 'on' : 'off'} · camera ${s.cameraRequests === 'auto' ? 'announce & allow' : 'ask first'}`}
                    onClick={() => setPrivacyOpen(true)} 
                  />
                  <NavRow 
                    icon={<MessageSquare size={20} />} iconBg="bg-info/10 text-info" 
                    label="Activity History" detail="What is saved and shared"
                    onClick={() => setActivityOpen(true)} 
                  />
                </div>
              </div>

              {/* ABOUT */}
              <div>
                <h2 className="mb-2 px-1 text-[14px] font-bold text-ink-3 uppercase tracking-wider">ABOUT</h2>
                <div className="glass overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line">
                  <NavRow 
                    icon={<Smartphone size={20} />} iconBg="bg-ink-3/10 text-ink-3" 
                    label="Device Information" detail={`App ${ENV.appVersion} · ${mode === 'demo' ? 'Demo mode' : 'Real mode'}`}
                    onClick={() => setInfoOpen(true)} 
                  />
                </div>
              </div>
            </div>

            {layout === 'single' && (
              <GlassButton size="lg" className="mt-3 w-full" onClick={() => useSession.setState({ entryRole: 'guardian' })}>
                Switch to the Guardian app (demo)
              </GlassButton>
            )}

            {/* App Info */}
            <p className="text-center text-[13px] text-ink-3 mt-6 opacity-60">{BRAND.name} · Made with ❤️ in India</p>
          </motion.div>

          {/* Sub-pages */}
          <ProfileSubpage open={profileOpen} onClose={() => setProfileOpen(false)} />
          <EmergencySubpage open={emergencyOpen} onClose={() => setEmergencyOpen(false)} />
          <AccessibilitySubpage open={accessibilityOpen} onClose={() => setAccessibilityOpen(false)} />
          <HardwareSubpage open={hardwareOpen} onClose={() => setHardwareOpen(false)} />
          <StickGameSubpage open={gameOpen} onClose={() => setGameOpen(false)} />
          <PrivacySubpage open={privacyOpen} onClose={() => setPrivacyOpen(false)} />
          <ActivitySubpage open={activityOpen} onClose={() => setActivityOpen(false)} />
          <DeviceInfoSubpage open={infoOpen} onClose={() => setInfoOpen(false)} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
