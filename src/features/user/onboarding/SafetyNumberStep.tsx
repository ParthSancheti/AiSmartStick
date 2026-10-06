import { useState } from 'react';
import { motion } from 'motion/react';
import { Check, Loader2, MessageSquare, Shield, TriangleAlert } from 'lucide-react';
import { GlassButton, cx } from '../../../components/glass';
import { useSession } from '../../../core/store/session';
import { sendSms } from '../../../core/phone';
import { AissNative } from '../../../core/native/aissNative';
import { Capacitor } from '@capacitor/core';

/** Indian mobile numbers: 10 digits starting 6–9 (after the +91 country code). */
export const validIndianMobile = (digits: string) => /^[6-9]\d{9}$/.test(digits);
export const digitsOf = (s: string) => s.replace(/\D/g, '').replace(/^(91|0)(?=[6-9]\d{9}$)/, '');

type TestState = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'composer' } | { kind: 'failed'; why: string };

/**
 * The SOS contact. Saved on the phone (SOS texts it — directly when Android allows SMS, otherwise
 * through the Messages app). The optional test message reports exactly what happened.
 */
export function SafetyNumberStep({ onSaved }: { onSaved: () => void }) {
  const existing = useSession((s) => s.contacts.find((c) => c.id === 'emergency')?.phone ?? '');
  const [digits, setDigits] = useState(() => digitsOf(existing));
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState(!!existing && validIndianMobile(digitsOf(existing)));
  const [smsPerm, setSmsPerm] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const valid = validIndianMobile(digits);
  const full = `+91${digits}`;
  const pretty = digits.length > 5 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : digits;

  const save = async () => {
    setTouched(true);
    if (!valid) return;
    useSession.setState((s) => ({
      contacts: [...s.contacts.filter((c) => c.id !== 'emergency'), { id: 'emergency', name: 'Safety contact', relation: 'emergency', phone: full, aliases: ['safety contact', 'emergency contact'] }],
    }));
    setSaved(true);
    // SOS texts must go out without a tap: ask for SMS permission now, while the user can answer.
    if (Capacitor.isNativePlatform()) {
      try {
        const r = await AissNative.requestPermissions({ permissions: ['sms'] });
        setSmsPerm(r.sms);
      } catch {
        setSmsPerm('unavailable');
      }
    }
  };

  const sendTest = async () => {
    setTest({ kind: 'sending' });
    try {
      const r = await sendSms('Safety contact', full, 'You were added as the safety contact for an AI SmartStick user. In an emergency you will get an SMS with their location.', { direct: true });
      if (r === 'sent') setTest({ kind: 'sent' });
      else if (r === 'composer_opened') setTest({ kind: 'composer' });
      else if (r === 'demo') setTest({ kind: 'failed', why: 'Demo mode: no SMS was sent.' });
      else setTest({ kind: 'failed', why: 'No number to send to.' });
    } catch (e) {
      setTest({ kind: 'failed', why: (e as Error).message });
    }
  };

  return (
    <div className="flex h-full flex-col px-6">
      <div className="mt-4 grid h-14 w-14 place-items-center rounded-[20px] border border-teal/30 bg-teal/15">
        <Shield size={28} className="text-teal" />
      </div>
      <h1 className="mt-6 text-[28px] font-extrabold leading-tight tracking-tight text-ink">Safety number</h1>
      <p className="mt-2 text-[15.5px] leading-relaxed text-ink-2">Who should get your location if you hold the stick button for SOS?</p>

      <div className="mt-8 flex gap-3">
        <div className="glass grid h-16 w-[84px] shrink-0 place-items-center rounded-[20px] text-[19px] font-extrabold text-ink" aria-label="Country code plus 91">
          +91
        </div>
        <label className={cx('glass flex h-16 flex-1 items-center rounded-[20px] px-4 transition-colors', touched && !valid && 'ring-2 ring-sos/60')}>
          <span className="sr-only">Mobile number</span>
          <input
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            autoFocus
            value={pretty}
            onChange={(e) => {
              setDigits(digitsOf(e.target.value).slice(0, 10));
              setSaved(false);
              setTest({ kind: 'idle' });
            }}
            onBlur={() => setTouched(true)}
            placeholder="98765 43210"
            className="w-full bg-transparent text-[22px] font-bold tracking-wide text-ink outline-none placeholder:font-medium placeholder:text-ink-3"
          />
        </label>
      </div>
      <p className={cx('mt-2 min-h-[20px] px-1 text-[13.5px] font-semibold', touched && !valid ? 'text-sos' : 'text-ink-3')} role="status">
        {touched && !valid ? (digits.length < 10 ? `Enter all 10 digits (${digits.length}/10)` : 'Indian mobile numbers start with 6, 7, 8 or 9') : 'A mobile number that can receive SMS'}
      </p>

      {saved && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="glass mt-4 rounded-[22px] p-4">
          <p className="flex items-center gap-2 text-[15px] font-bold text-ink">
            <Check size={18} className="text-ok" /> Saved on this phone: +91 {pretty}
          </p>
          {smsPerm && smsPerm !== 'granted' && (
            <p className="mt-2 flex gap-2 text-[13.5px] text-ink-2">
              <TriangleAlert size={16} className="mt-0.5 shrink-0 text-amber" /> SMS permission was not given, so SOS opens the Messages app and someone must press Send. You can allow it later in Android settings.
            </p>
          )}
          <button type="button" disabled={test.kind === 'sending'} onClick={() => void sendTest()} className="mt-3 flex h-11 items-center gap-2 rounded-full bg-ink/5 px-4 text-[14px] font-bold text-ink disabled:opacity-60">
            {test.kind === 'sending' ? <Loader2 size={16} className="animate-spin" /> : <MessageSquare size={16} />} Send a test message
          </button>
          {test.kind !== 'idle' && test.kind !== 'sending' && (
            <p className={cx('mt-2 text-[13.5px] font-semibold', test.kind === 'failed' ? 'text-sos' : test.kind === 'composer' ? 'text-amber-ink' : 'text-ok')} role="status">
              {test.kind === 'sent' && 'Handed to your phone’s SMS service. Ask them if it arrived.'}
              {test.kind === 'composer' && 'Messages app opened. It is not sent until you press Send there.'}
              {test.kind === 'failed' && `Not sent: ${test.why}`}
            </p>
          )}
        </motion.div>
      )}

      <div className="mt-auto pb-[calc(var(--sab)+20px)] pt-6">
        {saved ? (
          <GlassButton variant="teal" className="h-14 w-full rounded-[20px] text-[17px] font-bold" onClick={onSaved}>
            Continue
          </GlassButton>
        ) : (
          <GlassButton variant="teal" className="h-14 w-full rounded-[20px] text-[17px] font-bold" disabled={!valid} onClick={() => void save()}>
            Save number
          </GlassButton>
        )}
      </div>
    </div>
  );
}
