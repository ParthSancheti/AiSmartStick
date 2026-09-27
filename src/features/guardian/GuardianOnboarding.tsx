import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronLeft, Loader2 } from 'lucide-react';
import { useSession } from '../../core/store/session';
import { getMock } from '../../core/device/bridge';
import { haptics } from '../../core/feedback/haptics';
import { earcon } from '../../core/feedback/earcons';
import { wait } from '../../core/util';
import { Atmosphere } from '../../components/Atmosphere';
import { GlassButton, Glass, cx } from '../../components/glass';
import { StickVisual } from '../../components/StickVisual';
import { AiOrb } from '../../components/AiOrb';
import { PairingQr } from '../../components/PairingQr';
import { Wordmark } from '../../components/Logo';
import { SafetyHalo } from './parts';
import { useRuntime } from '../../core/runtime/mode';
import { useAuth } from '../../core/auth/authStore';
import { signInWithGoogle } from '../../core/auth/authService';
import { createPairingCode, useRelationship } from '../../core/pairing/pairingService';
import { firebaseConfigured } from '../../core/runtime/env';
import { BRAND } from '../../core/brand/brand';
import { friendlyError } from '../../core/errors';

type Step = 'intro' | 'signin' | 'person' | 'pair' | 'done';

const SLIDES = [
  {
    title: 'Independence, with you close by',
    body: 'The stick feels obstacles and the assistant describes the way. You can see he’s safe without hovering.',
  },
  {
    title: 'A friend who sees the street',
    body: 'He asks “what’s in front of me?” in English, Hindi or Hinglish, and the assistant answers out loud.',
  },
  {
    title: 'Help in one press',
    body: 'If he holds the button, says “bachao” or falls, you get his location and a photo within seconds.',
  },
];

function GoogleG() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

function Shell({ children, onBack }: { children: React.ReactNode; onBack?: () => void }) {
  return (
    <div className="absolute inset-0 flex flex-col" style={{ paddingTop: 'calc(var(--island, 0px) + 12px)' }}>
      <div className="flex h-12 items-center px-4">
        {onBack ? (
          <button type="button" onClick={onBack} aria-label="Back" className="glass grid h-10 w-10 place-items-center rounded-full">
            <ChevronLeft size={20} />
          </button>
        ) : (
          <Wordmark size={17} />
        )}
      </div>
      <div className="mx-auto flex w-full max-w-[520px] min-h-0 flex-1 flex-col px-6 pb-6">{children}</div>
    </div>
  );
}

export function GuardianOnboarding() {
  const session = useSession();
  const demo = useRuntime((x) => x.mode) === 'demo';
  const auth = useAuth();
  const rel = useRelationship();
  const [step, setStep] = useState<Step>(!demo && auth.status === 'signedIn' ? 'person' : 'intro');
  const [phone, setPhone] = useState(session.guardian.phone ?? '');
  const [pairErr, setPairErr] = useState<string | null>(null);
  const linked = demo ? session.linked : rel.status === 'active';
  const code = demo ? session.pairingCode : (rel.code?.code ?? null);
  const expired = !demo && !!rel.code && Date.now() > rel.code.expiresAt;

  const requestCode = async () => {
    setPairErr(null);
    try {
      await createPairingCode({ userName: session.person.name, heardAs: session.guardian.heardAs || 'Guardian', guardianPhone: session.guardian.phone });
    } catch (e) {
      setPairErr(`Could not create a code. ${friendlyError(e)}`);
    }
  };

  useEffect(() => {
    if (!demo && step === 'pair' && !linked && (!rel.code || expired)) void requestCode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, step, linked, expired]);

  useEffect(() => {
    if (!demo && step === 'signin' && auth.status === 'signedIn') setStep('person');
  }, [demo, step, auth.status]);
  const [slide, setSlide] = useState(0);
  const [signing, setSigning] = useState(false);
  const [name, setName] = useState(session.person.name);
  const [heardAs, setHeardAs] = useState(session.guardian.heardAs);

  useEffect(() => {
    if (step === 'pair' && linked) {
      haptics.play('success');
      earcon('success');
    }
  }, [step, linked]);

  const go = (s: Step) => {
    haptics.play('tick');
    setStep(s);
  };

  return (
    <div className="absolute inset-0 overflow-hidden">
      <Atmosphere variant="calm" />
      <AnimatePresence mode="wait">
        <motion.div key={step} className="absolute inset-0" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={{ duration: 0.28 }}>
          {step === 'intro' && (
            <Shell>
              <div className="grid flex-1 place-items-center">
                <AnimatePresence mode="wait">
                  <motion.div key={slide} initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.3 }} className="grid place-items-center">
                    {slide === 0 && <StickVisual height={250} link="connected" obstacleCm={90} />}
                    {slide === 1 && (
                      <div className="relative">
                        <AiOrb size={170} phase="speaking" />
                        <Glass className="absolute -bottom-10 left-1/2 w-[240px] -translate-x-1/2 rounded-[22px] px-4 py-3 text-center text-[15px] font-medium text-ink">
                          A scooter is two steps ahead, on your left.
                        </Glass>
                      </div>
                    )}
                    {slide === 2 && (
                      <div className="flex flex-col items-center">
                        <SafetyHalo level="safe" size={170} />
                        <p className="mt-4 text-[22px] font-bold text-ink">See they're okay at a glance</p>
                      </div>
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>
              <div className="flex justify-center gap-2 pb-5" aria-label={`Slide ${slide + 1} of 3`}>
                {SLIDES.map((_, i) => (
                  <span key={i} className={cx('h-2 rounded-full transition-all', i === slide ? 'w-6 bg-teal' : 'w-2 bg-ink/20')} />
                ))}
              </div>
              <h1 className="text-[30px] font-bold leading-[1.1] tracking-[-0.02em] text-ink">{SLIDES[slide].title}</h1>
              <p className="mt-2 text-[17px] leading-relaxed text-ink-2">{SLIDES[slide].body}</p>
              <div className="mt-6 flex gap-2">
                {slide < 2 && (
                  <GlassButton size="lg" className="flex-1" onClick={() => go('signin')}>
                    Skip
                  </GlassButton>
                )}
                <GlassButton size="lg" variant="teal" className="flex-[2]" onClick={() => (slide < 2 ? setSlide(slide + 1) : go('signin'))}>
                  {slide < 2 ? 'Next' : 'Get started'}
                </GlassButton>
              </div>
            </Shell>
          )}

          {step === 'signin' && (
            <Shell onBack={() => setStep('intro')}>
              <div className="flex flex-1 flex-col justify-center">
                <h1 className="text-[30px] font-bold leading-[1.1] tracking-[-0.02em] text-ink">Sign in to look after someone</h1>
                <p className="mt-2 text-[17px] leading-relaxed text-ink-2">Your account keeps alerts, location and photos private to your family.</p>
              </div>
              <GlassButton
                variant="white"
                size="lg"
                className="w-full"
                disabled={signing || auth.busy || (!demo && !firebaseConfigured())}
                onClick={async () => {
                  if (demo) {
                    // DEMO ONLY: no account is created.
                    setSigning(true);
                    await wait(900);
                    setSigning(false);
                    go('person');
                    return;
                  }
                  await signInWithGoogle('guardian').catch(() => undefined);
                }}
              >
                {signing || auth.busy ? <Loader2 size={20} className="animate-spin" /> : <GoogleG />}
                {signing || auth.busy ? 'Signing in…' : 'Continue with Google'}
              </GlassButton>
              {!demo && !firebaseConfigured() && <p className="mt-3 rounded-[16px] bg-amber-soft px-4 py-3 text-[14px] font-medium text-amber-ink">This build has no Firebase configuration, so sign-in is unavailable.</p>}
              {auth.error && <p className="mt-3 rounded-[16px] bg-amber-soft px-4 py-3 text-[14px] font-medium text-amber-ink" role="alert">{auth.error}</p>}
              <p className="mt-3 text-center text-[13px] text-ink-3">We never post anything or read your email.</p>
            </Shell>
          )}

          {step === 'person' && (
            <Shell onBack={() => setStep('signin')}>
              <h1 className="mt-4 text-[30px] font-bold leading-[1.1] tracking-[-0.02em] text-ink">Who will use the stick?</h1>
              <label className="mt-6 block text-[15px] font-semibold text-ink-2" htmlFor="pname">
                Their first name
              </label>
              <input
                id="pname"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="glass mt-2 h-14 w-full rounded-[20px] px-4 text-[18px] text-ink outline-none"
                autoComplete="off"
              />
              <p className="mt-6 text-[15px] font-semibold text-ink-2">They'll hear you as</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {['Mom', 'Papa', 'Didi', 'Bhaiya', 'Nani'].map((h) => (
                  <button
                    key={h}
                    type="button"
                    aria-pressed={heardAs === h}
                    onClick={() => {
                      haptics.play('tick');
                      setHeardAs(h);
                    }}
                    className={cx('h-11 rounded-full px-5 text-[16px] font-semibold', heardAs === h ? 'bg-teal text-on-teal' : 'glass text-ink-2')}
                  >
                    {h}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-[14px] leading-snug text-ink-3">The assistant uses this name, for example “{heardAs} is viewing your camera”.</p>
              <label className="mt-6 block text-[15px] font-semibold text-ink-2" htmlFor="gphone">
                Your mobile number
              </label>
              <input id="gphone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 …" className="glass mt-2 h-14 w-full rounded-[20px] px-4 text-[18px] text-ink outline-none" autoComplete="tel" />
              <p className="mt-2 text-[13.5px] leading-snug text-ink-3">Used for SOS text messages and calls when there is no internet.</p>
              <div className="flex-1" />
              <GlassButton
                variant="teal"
                size="lg"
                className="w-full"
                disabled={!name.trim()}
                onClick={() => {
                  useSession.setState({ person: { ...session.person, name: name.trim() }, guardian: { ...session.guardian, heardAs, phone: phone.trim() || null } });
                  go('pair');
                }}
              >
                Continue
              </GlassButton>
            </Shell>
          )}

          {step === 'pair' && (
            <Shell onBack={() => setStep('person')}>
              <h1 className="mt-4 text-[28px] font-bold leading-[1.1] tracking-[-0.02em] text-ink">Link {session.person.name}'s phone</h1>
              <p className="mt-2 text-[16px] leading-relaxed text-ink-2">
                Install {BRAND.name} on their phone, sign in, then scan this QR or type the code.
              </p>
              <Glass className="mt-5 flex items-center gap-4 rounded-[28px] p-4">
                {code && !expired && (
                  <div className="rounded-[16px] bg-white p-1.5">
                    <PairingQr code={code} size={118} />
                  </div>
                )}
                <div>
                  <p className="text-[14px] font-semibold text-ink-3">Pairing code</p>
                  {code ? (
                    <p className="whitespace-nowrap text-[30px] font-bold tracking-[0.06em] text-ink tabular" aria-label={code.split('').join(' ')}>
                      {code.slice(0, 3)} {code.slice(3)}
                    </p>
                  ) : (
                    <p className="text-[18px] font-semibold text-ink-3">{pairErr ? 'Unavailable' : 'Creating…'}</p>
                  )}
                  <p className="text-[13px] text-ink-3">{expired ? 'Expired. Getting a new one…' : 'Expires in 10 minutes'}</p>
                </div>
              </Glass>
              {pairErr && (
                <p className="mt-3 rounded-[16px] bg-amber-soft px-4 py-3 text-[14px] font-medium text-amber-ink" role="alert">
                  {pairErr} <button type="button" className="underline" onClick={() => void requestCode()}>Try again</button>
                </p>
              )}
              <div className="mt-5 flex items-center gap-3 rounded-[20px] px-1 text-[16px] font-medium" aria-live="polite">
                {linked ? (
                  <>
                    <span className="grid h-8 w-8 place-items-center rounded-full bg-teal text-on-teal">
                      <Check size={18} strokeWidth={3} />
                    </span>
                    <span className="text-ink">{session.person.name}'s phone is linked</span>
                  </>
                ) : (
                  <>
                    <Loader2 size={22} className="animate-spin text-teal" />
                    <span className="text-ink-2">Waiting for {session.person.name}'s phone</span>
                  </>
                )}
              </div>
              <div className="flex-1" />
              {!linked && demo && (
                <GlassButton
                  size="md"
                  className="mb-2 w-full"
                  onClick={() => {
                    useSession.setState({ linked: true, userOnboarded: true });
                    getMock()?.setLinked(true);
                  }}
                >
                  Demo: {session.person.name} enters the code
                </GlassButton>
              )}
              <GlassButton variant="teal" size="lg" className="w-full" disabled={!linked} onClick={() => go('done')}>
                Continue
              </GlassButton>
            </Shell>
          )}

          {step === 'done' && (
            <Shell>
              <div className="flex flex-1 flex-col items-center justify-center text-center">
                <SafetyHalo level="safe" size={150} />
                <h1 className="mt-6 text-[30px] font-bold leading-[1.1] tracking-[-0.02em] text-ink">You're all set</h1>
                <p className="mt-2 max-w-[32ch] text-[17px] leading-relaxed text-ink-2">
                  You'll get an alert the moment {session.person.name} needs help. Everything else waits quietly on your dashboard.
                </p>
              </div>
              <GlassButton variant="teal" size="lg" className="w-full" onClick={() => useSession.setState({ guardianOnboarded: true })}>
                Open dashboard
              </GlassButton>
            </Shell>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
