import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Delete, Mic, Vibrate } from 'lucide-react';
import { useSession } from '../../core/store/session';
import { useAssistant } from '../../core/store/assistant';
import { getTransport } from '../../core/device/bridge';
import { announce } from '../../core/ai/voiceOut';
import { P } from '../../core/ai/phrases';
import { speak } from '../../core/feedback/speech';
import { haptics } from '../../core/feedback/haptics';
import { earcon } from '../../core/feedback/earcons';
import { wait } from '../../core/util';
import { AiOrb } from '../../components/AiOrb';
import { GlassButton, cx } from '../../components/glass';
import { StickSetup } from './StickSetup';
import { useRuntime, switchMode } from '../../core/runtime/mode';
import { useAuth } from '../../core/auth/authStore';
import { signInWithGoogle } from '../../core/auth/authService';
import { claimPairingCode, useRelationship } from '../../core/pairing/pairingService';
import { firebaseConfigured } from '../../core/runtime/env';
import { BRAND } from '../../core/brand/brand';
import { BrandLogo } from '../../core/brand/BrandLogo';
import { useDevice, isLinked } from '../../core/store/device';
import { scanPairingQr } from '../../core/pairing/qr';
import { friendlyError } from '../../core/errors';

type Step = 'hello' | 'signin' | 'code' | 'linking' | 'stick' | 'buzz' | 'done';

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col px-5 pb-5" style={{ paddingTop: 'calc(var(--island, 0px) + 18px)' }}>
      {children}
    </div>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return <h1 className="scaled-text font-bold leading-[1.12] tracking-[-0.02em] text-ink" style={{ ['--fs' as string]: '30px' }}>{children}</h1>;
}

function Body({ children }: { children: React.ReactNode }) {
  return <p className="scaled-text mt-2 leading-relaxed text-ink-2" style={{ ['--fs' as string]: '18px' }}>{children}</p>;
}


/**
 * First run on the stick user's phone. Usually a family member does this,
 * but every step is spoken so the user can follow along or do it alone.
 */
export function UserOnboarding() {
  const code = useSession((s) => s.pairingCode);
  const heardAs = useSession((s) => s.guardian.heardAs);
  const demo = useRuntime((s) => s.mode) === 'demo';
  const phase = useAssistant((s) => s.phase);
  const auth = useAuth();
  const relStatus = useRelationship((s) => s.status);
  const link = useDevice((s) => s.link);
  const [step, setStep] = useState<Step>('hello');
  const [digits, setDigits] = useState('');
  const [shake, setShake] = useState(0);
  const [codeError, setCodeError] = useState<string | null>(null);
  const typing = useRef(false);

  // Resume where a real user left off: already signed in → code; already linked → stick.
  useEffect(() => {
    if (demo || step !== 'signin' || auth.status !== 'signedIn') return;
    setStep(relStatus === 'active' ? 'stick' : 'code');
  }, [demo, step, auth.status, relStatus]);

  // Spoken guidance per step
  useEffect(() => {
    const lines: Partial<Record<Step, string>> = {
      hello: P.hello.en,
      code: P.askCode.en,
      signin: 'Sign in with your Google account to keep your settings and alerts safe.',
      stick: 'Now set up the stick. Hold its button for five seconds until it buzzes twice.',
      buzz: 'Did the stick just buzz?',
      done: P.setupDone.en,
    };
    const line = lines[step];
    if (line) announce(line, { lang: 'en' });
  }, [step]);

  const buzz = () => {
    const t = getTransport();
    if (t) void t.send({ type: 'haptic', pattern: 'confirm' }).catch(() => undefined);
    haptics.play('arrive');
  };

  useEffect(() => {
    if (step === 'buzz') buzz();
  }, [step]);

  const submitCode = async (full: string) => {
    await wait(250);
    setCodeError(null);
    if (!demo) {
      setStep('linking');
      try {
        const r = await claimPairingCode(full);
        haptics.play('success');
        earcon('success');
        announce(P.linked(r.heardAs), { lang: 'en' });
        await wait(1600);
        setStep('stick');
      } catch (e) {
        haptics.play('error');
        setStep('code');
        setShake((n) => n + 1);
        setCodeError(friendlyError(e, 'Could not link. Please try again.'));
        announce(P.codeWrong, { lang: 'en' });
        setDigits('');
      }
      return;
    }
    if (full === code) {
      setStep('linking');
      await wait(1100);
      useSession.setState({ linked: true });
      haptics.play('success');
      earcon('success');
      announce(P.linked(heardAs), { lang: 'en' });
      await wait(1600);
      setStep('stick');
    } else {
      haptics.play('error');
      setShake((n) => n + 1);
      announce(P.codeWrong, { lang: 'en' });
      setDigits('');
    }
  };

  const press = (d: string) => {
    if (digits.length >= 6) return;
    haptics.play('tick');
    void speak(d, 'en');
    const next = digits + d;
    setDigits(next);
    if (next.length === 6) void submitCode(next);
  };

  const speakCode = async () => {
    if (typing.current) return;
    typing.current = true;
    setDigits('');
    earcon('listen');
    let acc = '';
    if (!code) {
      typing.current = false;
      return;
    }
    for (const d of code) {
      await wait(380);
      acc += d;
      setDigits(acc);
      haptics.play('tick');
    }
    typing.current = false;
    void submitCode(acc);
  };

  return (
    <div className="absolute inset-0">
      <AnimatePresence mode="wait">
        <motion.div key={step} className="absolute inset-0" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -16 }} transition={{ duration: 0.25 }}>
          {step === 'hello' && (
            <Frame>
              <div className="grid flex-1 place-items-center">
                <AiOrb size={220} phase={phase === 'speaking' ? 'speaking' : 'ready'} />
              </div>
              <div className="mb-3"><BrandLogo variant="full" size={34} /></div>
              <Title>Hi, I'm your {BRAND.name} assistant</Title>
              <Body>I'll walk with you and tell you what's around. First, let's link this phone with your family.</Body>
              <GlassButton variant="teal" size="xl" className="mt-6 w-full" onClick={() => setStep(demo ? 'code' : 'signin')}>
                Continue
              </GlassButton>
            </Frame>
          )}

          {step === 'signin' && (
            <Frame>
              <div className="grid flex-1 place-items-center">
                <BrandLogo variant="icon" size={120} />
              </div>
              <Title>Sign in</Title>
              <Body>Your account keeps your guardian link, settings and assistant history safe. Only you and your linked guardian can see them.</Body>
              {!firebaseConfigured() ? (
                <>
                  <p className="mt-4 rounded-[18px] bg-amber-soft px-4 py-3 text-[15px] font-medium text-amber-ink">This build has no Firebase configuration, so real sign-in is unavailable. See .env.example.</p>
                  <GlassButton size="lg" className="mt-4 w-full" onClick={() => switchMode('demo')}>Try demo mode instead</GlassButton>
                </>
              ) : (
                <>
                  {auth.error && <p className="mt-4 rounded-[18px] bg-amber-soft px-4 py-3 text-[15px] font-medium text-amber-ink" role="alert">{auth.error}</p>}
                  <GlassButton variant="teal" size="xl" className="mt-6 w-full" disabled={auth.busy} onClick={() => void signInWithGoogle('user').catch(() => undefined)}>
                    {auth.busy ? 'Signing in…' : 'Continue with Google'}
                  </GlassButton>
                </>
              )}
            </Frame>
          )}

          {step === 'code' && (
            <Frame>
              <Title>Enter the family code</Title>
              <Body>It's on your family member's phone.</Body>
              <motion.div key={shake} animate={shake ? { x: [0, -12, 12, -8, 8, 0] } : undefined} transition={{ duration: 0.4 }} className="my-6 flex justify-center gap-2" aria-live="polite" aria-label={`${digits.length} of 6 digits entered`}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <span
                    key={i}
                    className={cx(
                      'grid h-16 w-12 place-items-center rounded-[16px] text-[30px] font-bold tabular',
                      i < digits.length ? 'chip-solid' : 'glass text-ink-3',
                      i === 3 && 'ml-2',
                    )}
                  >
                    {digits[i] ?? ''}
                  </span>
                ))}
              </motion.div>
              <div className="grid flex-1 grid-cols-3 content-end gap-2.5">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                  <button key={d} type="button" onClick={() => press(d)} className="glass h-[68px] rounded-[22px] text-[30px] font-bold text-ink active:bg-teal-soft">
                    {d}
                  </button>
                ))}
                <button type="button" onClick={() => void speakCode()} className="flex h-[68px] items-center justify-center gap-1.5 rounded-[22px] bg-teal text-[16px] font-bold text-on-teal" aria-label="Say the code">
                  <Mic size={22} /> Say it
                </button>
                <button type="button" onClick={() => press('0')} className="glass h-[68px] rounded-[22px] text-[30px] font-bold text-ink active:bg-teal-soft">
                  0
                </button>
                <button type="button" onClick={() => setDigits((d) => d.slice(0, -1))} className="glass grid h-[68px] place-items-center rounded-[22px] text-ink" aria-label="Delete last digit">
                  <Delete size={26} />
                </button>
              </div>
              {codeError && <p className="mt-3 text-center text-[15px] font-semibold text-amber-ink" role="alert">{codeError}</p>}
              <button
                type="button"
                className="mx-auto mt-3 block rounded-full px-5 py-2.5 text-[15.5px] font-semibold text-teal-ink underline"
                onClick={async () => {
                  const r = await scanPairingQr();
                  if ('code' in r) {
                    setDigits(r.code);
                    void submitCode(r.code);
                  } else if (r.error !== 'cancelled') setCodeError(r.message);
                }}
              >
                Scan QR code instead
              </button>
              {demo && code && <p className="mt-3 text-center text-[14px] text-ink-3">Demo code: {code.slice(0, 3)} {code.slice(3)}</p>}
            </Frame>
          )}

          {step === 'linking' && (
            <Frame>
              <div className="flex flex-1 flex-col items-center justify-center text-center">
                <AiOrb size={170} phase={useSession.getState().linked ? 'speaking' : 'thinking'} />
                <p className="mt-8 text-[26px] font-bold text-ink" aria-live="polite">
                  {useSession.getState().linked ? `Linked with ${heardAs || 'your guardian'}` : 'Linking…'}
                </p>
              </div>
            </Frame>
          )}

          {step === 'stick' && (
            <StickSetup
              onDone={() => setStep('buzz')}
              onCancel={() => setStep('done')}
            />
          )}

          {step === 'buzz' && (
            <Frame>
              <div className="grid flex-1 place-items-center">
                <motion.span className="grid h-40 w-40 place-items-center rounded-full bg-teal text-on-teal" animate={{ x: [0, -4, 4, -3, 3, 0] }} transition={{ duration: 0.5, repeat: Infinity, repeatDelay: 1.2 }}>
                  <Vibrate size={70} strokeWidth={1.6} />
                </motion.span>
              </div>
              <Title>Did the stick just buzz?</Title>
              <Body>That's how it warns you about obstacles, even when the phone is off.</Body>
              <div className="mt-6 grid gap-2.5">
                <GlassButton variant="teal" size="xl" className="w-full" onClick={() => setStep('done')}>
                  Yes, it buzzed
                </GlassButton>
                <GlassButton size="lg" className="w-full" onClick={buzz}>
                  Buzz again
                </GlassButton>
              </div>
            </Frame>
          )}

          {step === 'done' && (
            <Frame>
              <div className="grid flex-1 place-items-center">
                <AiOrb size={220} phase={phase === 'speaking' ? 'speaking' : 'ready'} />
              </div>
              <Title>{isLinked(link) ? 'All set' : 'Almost set'}</Title>
              {!isLinked(link) && <Body>The stick is not set up yet. You can do it any time from Home → Set up stick.</Body>}
              <Body>Press your stick button once, anytime, to talk to me. Twice tells you where you are. Three times, what's in front of you. Hold it for SOS.</Body>
              <GlassButton variant="teal" size="xl" className="mt-6 w-full" onClick={() => useSession.setState({ userOnboarded: true })}>
                Start walking
              </GlassButton>
            </Frame>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
