import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronLeft, Loader2, RefreshCw, Settings2, TriangleAlert, Wifi } from 'lucide-react';
import { StickVisual } from '../../components/StickVisual';
import { Glass, GlassButton } from '../../components/glass';
import { Atmosphere } from '../../components/Atmosphere';
import { useProvisioning, searchForStick, provisionStick, cancelProvisioning, type ProvStep } from '../../core/provisioning/provisioning';
import { AissNative } from '../../core/native/aissNative';
import { useRuntime } from '../../core/runtime/mode';
import { BRAND } from '../../core/brand/brand';

const STEPS: { id: ProvStep; label: string; help: string }[] = [
  { id: 'searching', label: 'Searching for AI Smart Stick', help: 'Hold the stick button for 5 seconds until it buzzes twice. Keep the stick close to the phone.' },
  { id: 'detected', label: 'Stick detected', help: 'Enter the setup code from the stick label and your hotspot details.' },
  { id: 'connecting_ap', label: 'Connecting to Stick', help: 'Android will ask to connect to the stick. Tap Connect.' },
  { id: 'sending_config', label: 'Sending network configuration', help: 'Your hotspot name and a new secret key are sent to the stick. The key never leaves this phone otherwise.' },
  { id: 'joining_network', label: 'Connecting Stick to phone network', help: 'Turn your hotspot ON now (2.4 GHz). The stick joins it within a minute.' },
  { id: 'authenticating', label: 'Authenticating Stick', help: 'Checking the stick really holds this phone’s key.' },
  { id: 'finalizing', label: 'Finalizing', help: 'Saving the pairing on this phone and in your account.' },
];

const order = (s: ProvStep) => STEPS.findIndex((x) => x.id === s);

export function StickSetup({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const p = useProvisioning();
  const demo = useRuntime((s) => s.mode) === 'demo';
  const [code, setCode] = useState(demo ? '12345678' : '');
  const [ssid, setSsid] = useState(demo ? 'Aarav’s phone' : '');
  const [pw, setPw] = useState(demo ? '••••••••' : '');
  const [showDiag, setShowDiag] = useState(false);

  useEffect(() => {
    if (p.step === 'idle') void searchForStick();
    return () => {
      if (useProvisioning.getState().step !== 'connected') cancelProvisioning();
    };
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = STEPS[order(p.step)] ?? null;
  const busy = order(p.step) >= order('connecting_ap') && p.step !== 'failed';
  const canSend = code.trim().length >= 8 && ssid.trim().length > 0 && pw.length >= 8;

  return (
    <div className="absolute inset-0 z-[90] flex flex-col bg-bg">
      <Atmosphere variant="user" />
      <div className="relative z-10 flex items-center gap-4 px-4" style={{ paddingTop: 'calc(var(--island, 0px) + 22px)' }}>
        <button type="button" onClick={() => { cancelProvisioning(); onCancel(); }} aria-label="Cancel setup" className="glass interactive grid h-12 w-12 place-items-center rounded-full text-ink">
          <ChevronLeft size={24} />
        </button>
        <h1 className="text-[24px] font-bold text-ink">Set up your stick</h1>
      </div>

      <div className="relative z-10 flex-1 overflow-y-auto px-4 pb-10 no-scrollbar">
        <div className="flex flex-col items-center pt-4">
          <motion.div animate={p.step === 'searching' ? { rotate: [-3, 3, -3] } : { rotate: 0 }} transition={{ duration: 1.6, repeat: p.step === 'searching' ? Infinity : 0 }}>
            <StickVisual height={170} link={p.step === 'connected' ? 'connected' : busy ? 'connecting' : 'searching'} obstacleCm={null} pose={null} />
          </motion.div>
          <p className="mt-3 text-center text-[22px] font-extrabold text-ink" aria-live="polite">
            {p.step === 'connected' ? `${BRAND.name} Connected` : p.step === 'failed' ? 'Setup did not finish' : current?.label ?? 'Getting ready'}
          </p>
          {current && p.step !== 'failed' && p.step !== 'connected' && <p className="mt-1 max-w-[32ch] text-center text-[15px] leading-snug text-ink-2">{current.help}</p>}
        </div>

        {/* Progress */}
        <Glass className="mt-5 rounded-[26px] p-4">
          <ol className="space-y-2.5">
            {STEPS.map((s, i) => {
              const cur = order(p.step);
              const done = p.step === 'connected' || i < cur;
              const active = i === cur && p.step !== 'connected';
              return (
                <li key={s.id} className="flex items-center gap-3">
                  <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-bold ${done ? 'bg-ok text-white' : active ? 'bg-teal text-on-teal' : 'bg-ink/[0.07] text-ink-3'}`}>
                    {done ? <Check size={15} strokeWidth={3} /> : active ? <Loader2 size={15} className="animate-spin" /> : i + 1}
                  </span>
                  <span className={`text-[15px] ${active ? 'font-bold text-ink' : done ? 'font-medium text-ink-2' : 'text-ink-3'}`}>{s.label}</span>
                </li>
              );
            })}
          </ol>
        </Glass>

        <AnimatePresence mode="wait">
          {p.step === 'detected' && (
            <motion.div key="form" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-4 space-y-3">
              <Glass className="rounded-[22px] p-4">
                <p className="text-[13px] font-bold uppercase tracking-wider text-ink-3">Found</p>
                <p className="mt-1 flex items-center gap-2 text-[17px] font-semibold text-ink"><Wifi size={18} className="text-teal" /> {p.ssid}</p>
              </Glass>
              <Field label="Setup code (8 characters on the stick label)" value={code} onChange={setCode} autoComplete="one-time-code" />
              <Field label="Your phone hotspot name" value={ssid} onChange={setSsid} />
              <Field label="Hotspot password" value={pw} onChange={setPw} type="password" />
              <p className="px-1 text-[13.5px] leading-snug text-ink-3">Android does not let apps read your hotspot password, so it is typed once here and sent only to the stick. Use 2.4 GHz (“Extend compatibility” on some phones).</p>
              {!demo && (
                <GlassButton size="lg" className="w-full" onClick={() => void AissNative.openHotspotSettings().catch(() => undefined)}>
                  <Settings2 size={18} /> Open hotspot settings
                </GlassButton>
              )}
              <GlassButton variant="teal" size="lg" className="w-full" disabled={!canSend} onClick={() => void provisionStick({ setupCode: code, hotspotSsid: ssid, hotspotPassword: pw })}>
                Connect stick
              </GlassButton>
            </motion.div>
          )}

          {p.step === 'failed' && (
            <motion.div key="fail" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-4 space-y-3">
              <p className="flex items-start gap-2 rounded-[18px] bg-amber-soft px-4 py-3 text-[15px] font-medium text-amber-ink" role="alert">
                <TriangleAlert size={18} className="mt-0.5 shrink-0" /> {p.error}
              </p>
              <GlassButton variant="teal" size="lg" className="w-full" onClick={() => { useProvisioning.setState({ step: 'retrying' }); void searchForStick(); }}>
                <RefreshCw size={18} /> Try again
              </GlassButton>
              <button type="button" className="w-full py-2 text-[14px] font-semibold text-ink-2 underline" onClick={() => setShowDiag((v) => !v)}>
                {showDiag ? 'Hide' : 'Show'} diagnostics
              </button>
              {showDiag && (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-[16px] bg-ink/[0.06] p-3 text-[12px] text-ink-2">{p.diagnostics.join('\n') || 'No diagnostics yet.'}</pre>
              )}
            </motion.div>
          )}

          {p.step === 'connected' && (
            <motion.div key="ok" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="mt-4 space-y-3">
              <Glass className="rounded-[22px] p-4 text-[15px] text-ink-2">
                Stick {p.deviceId} · firmware {p.firmware}. From now on it reconnects automatically whenever your hotspot is on.
              </Glass>
              <GlassButton variant="teal" size="lg" className="w-full" onClick={onDone}>
                Done
              </GlassButton>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', autoComplete }: { label: string; value: string; onChange: (v: string) => void; type?: string; autoComplete?: string }) {
  return (
    <label className="glass block rounded-[20px] border border-glass-border p-4">
      <span className="mb-1.5 block text-[13px] font-bold uppercase text-ink-3">{label}</span>
      <input type={type} value={value} autoComplete={autoComplete} onChange={(e) => onChange(e.target.value)} className="w-full bg-transparent text-[18px] font-semibold text-ink outline-none" />
    </label>
  );
}
