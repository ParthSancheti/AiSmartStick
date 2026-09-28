import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronLeft, Loader2, RefreshCw, Wifi, Settings2 } from 'lucide-react';
import { StickVisual } from '../../components/StickVisual';
import { Glass, GlassButton } from '../../components/glass';
import { Atmosphere } from '../../components/Atmosphere';
import { AppScreen, SafeAreaContent, FloatingHeader } from '../../components/Layout';
import { useProvisioning, searchForStick, provisionStick, cancelProvisioning } from '../../core/provisioning/provisioning';
import { AissNative } from '../../core/native/aissNative';
import { useRuntime } from '../../core/runtime/mode';

const STEPS = [
  { id: 'searching', label: 'Searching for SmartStick', desc: 'Finding the setup network...' },
  { id: 'stick_found', label: 'Stick Found', desc: 'Enter setup details below.' },
  { id: 'connecting_to_stick', label: 'Connecting', desc: 'Connecting to stick Wi-Fi...' },
  { id: 'stick_connected', label: 'Connected', desc: 'Reading device information...' },
  { id: 'reading_device_info', label: 'Reading Info', desc: 'Verifying protocol...' },
  { id: 'configuring_network', label: 'Configuring', desc: 'Sending network credentials...' },
  { id: 'waiting_for_stick_network', label: 'Waiting', desc: 'Waiting for stick to join hotspot...' },
  { id: 'verifying_stick', label: 'Verifying', desc: 'Checking connection...' },
  { id: 'authenticating', label: 'Authenticating', desc: 'Securing the link...' },
  { id: 'completed', label: 'Completed', desc: 'Stick is ready.' },
];

export function StickSetup({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const p = useProvisioning();
  const demo = useRuntime((s) => s.mode) === 'demo';
  const [code, setCode] = useState(demo ? '12345678' : '');
  const [ssid, setSsid] = useState(demo ? 'AndroidAP' : '');
  const [pw, setPw] = useState(demo ? 'password' : '');
  const [showDiag, setShowDiag] = useState(false);

  useEffect(() => {
    if (p.step === 'idle') void searchForStick();
    return () => {
      if (useProvisioning.getState().step !== 'completed') cancelProvisioning();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const currentStepInfo = STEPS.find(s => s.id === p.step) || { label: p.step, desc: '' };
  const isError = p.step === 'error';
  const isCompleted = p.step === 'completed';

  return (
    <AppScreen className="z-[90] bg-bg">
      <Atmosphere variant="user" />
      <FloatingHeader className="pt-4 pb-0 items-center">
        <div className="flex items-center gap-4 w-full">
          <button type="button" onClick={() => { cancelProvisioning(); onCancel(); }} aria-label="Cancel setup" className="glass interactive grid h-12 w-12 shrink-0 place-items-center rounded-full text-ink">
            <ChevronLeft size={24} />
          </button>
          <h1 className="text-[24px] font-bold text-ink">Set up your SmartStick</h1>
        </div>
      </FloatingHeader>

      <SafeAreaContent className="px-4 pb-10 z-10">
        <div className="h-16 shrink-0" />
        
        <div className="flex flex-col items-center pt-4 mb-6">
          <motion.div animate={p.step === 'searching' ? { rotate: [-3, 3, -3] } : { rotate: 0 }} transition={{ duration: 1.6, repeat: p.step === 'searching' ? Infinity : 0 }}>
            <StickVisual height={170} link={isCompleted ? 'connected' : isError ? 'searching' : 'connecting'} obstacleCm={null} pose={null} />
          </motion.div>
          <p className="mt-4 text-center text-[22px] font-extrabold text-ink" aria-live="polite">
            {isError ? 'Setup Failed' : currentStepInfo.label}
          </p>
          <p className="mt-1 text-center text-[15px] leading-snug text-ink-2">
            {isError ? p.error : currentStepInfo.desc}
          </p>
        </div>

        <AnimatePresence mode="wait">
          {/* STEP 1: SEARCHING */}
          {p.step === 'searching' && (
            <motion.div key="searching" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex justify-center p-6">
              <Loader2 className="animate-spin text-teal" size={32} />
            </motion.div>
          )}

          {/* STEP 2: STICK FOUND (Form) */}
          {p.step === 'stick_found' && (
            <motion.div key="form" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="space-y-4">
              <Glass className="rounded-[22px] p-5 flex items-center justify-between">
                <div>
                  <p className="text-[13px] font-bold uppercase tracking-wider text-ink-3">Found Stick</p>
                  <p className="mt-1 flex items-center gap-2 text-[17px] font-semibold text-ink"><Wifi size={18} className="text-teal" /> {p.ssid}</p>
                </div>
                <Check size={24} className="text-teal" />
              </Glass>
              
              <div className="space-y-3">
                <Field label="Setup Code (8 characters on stick)" value={code} onChange={setCode} />
                <Field label="Phone Hotspot Name" value={ssid} onChange={setSsid} />
                <Field label="Hotspot Password" value={pw} onChange={setPw} type="password" />
              </div>
              
              <p className="text-[13px] text-ink-3 px-2 text-center mt-2">
                Your hotspot details will be sent directly to the stick over a secure local connection.
              </p>

              {!demo && (
                <GlassButton size="lg" className="w-full mt-2" onClick={() => void AissNative.openHotspotSettings().catch(() => undefined)}>
                  <Settings2 size={18} /> Open Hotspot Settings
                </GlassButton>
              )}

              <GlassButton variant="teal" size="lg" className="w-full mt-4" disabled={code.trim().length < 8 || ssid.trim().length === 0 || pw.length < 8} onClick={() => provisionStick({ setupCode: code, hotspotSsid: ssid, hotspotPassword: pw })}>
                Connect Automatically
              </GlassButton>
            </motion.div>
          )}

          {/* STEP 3: PROGRESS / PROVISIONING */}
          {(!isError && p.step !== 'idle' && p.step !== 'searching' && p.step !== 'stick_found' && p.step !== 'completed') && (
            <motion.div key="progress" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-4">
              <Glass className="rounded-[26px] p-5">
                <div className="flex items-center gap-4">
                  <div className="bg-teal/10 p-3 rounded-full">
                    <Loader2 className="animate-spin text-teal" size={24} />
                  </div>
                  <div>
                    <p className="text-[16px] font-bold text-ink">{currentStepInfo.label}</p>
                    <p className="text-[14px] text-ink-2">{currentStepInfo.desc}</p>
                  </div>
                </div>
              </Glass>
            </motion.div>
          )}

          {/* STEP 4: ERROR */}
          {isError && (
            <motion.div key="error" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-4">
              <GlassButton variant="teal" size="lg" className="w-full" onClick={() => searchForStick()}>
                <RefreshCw size={18} /> Try Again
              </GlassButton>
              <button type="button" className="w-full py-2 text-[14px] font-semibold text-ink-2 underline" onClick={() => setShowDiag((v) => !v)}>
                {showDiag ? 'Hide' : 'Show'} diagnostics
              </button>
              {showDiag && (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-[16px] bg-ink/[0.06] p-3 text-[12px] text-ink-2">{p.diagnostics.join('\n') || 'No diagnostics available.'}</pre>
              )}
            </motion.div>
          )}

          {/* STEP 5: COMPLETED */}
          {isCompleted && (
            <motion.div key="completed" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="space-y-4">
              <Glass className="rounded-[22px] p-5 text-[15px] text-ink-2 text-center">
                SmartStick {p.deviceId} is fully paired and configured! It will automatically reconnect whenever your hotspot is active.
              </Glass>
              <GlassButton variant="teal" size="lg" className="w-full" onClick={onDone}>
                Continue
              </GlassButton>
            </motion.div>
          )}
        </AnimatePresence>
      </SafeAreaContent>
    </AppScreen>
  );
}

function Field({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <label className="glass block rounded-[20px] border border-glass-border p-4">
      <span className="mb-1.5 block text-[13px] font-bold uppercase text-ink-3">{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} className="w-full bg-transparent text-[18px] font-semibold text-ink outline-none" />
    </label>
  );
}
