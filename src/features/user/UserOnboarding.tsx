import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Bell, Check, Loader2, MapPin, Mic, Radar, Wifi, X } from 'lucide-react';
import { useSession } from '../../core/store/session';
import { GlassButton, cx } from '../../components/glass';
import { AppScreen, SafeAreaContent, ScreenHeader } from '../../components/Layout';
import { AccountAvatar } from '../../components/Avatar';
import { StickVisual } from '../../components/StickVisual';
import { BrandLogo } from '../../core/brand/BrandLogo';
import { BRAND } from '../../core/brand/brand';
import { useAuth } from '../../core/auth/authStore';
import { signInWithGoogle } from '../../core/auth/authService';
import { firebaseConfigured } from '../../core/runtime/env';
import { useRuntime } from '../../core/runtime/mode';
import { useBackHandler } from '../../core/backStack';
import { cacheProfilePhoto } from '../../core/profile/photoCache';
import { ensureLocation } from '../../core/location/locationService';
import { requestSetupPermissions, type PermState, type SetupPermission } from '../../core/setup/permissions';
import { IntroStory } from './onboarding/IntroStory';
import { HomeLocationStep } from './onboarding/HomeLocationStep';
import { SafetyNumberStep } from './onboarding/SafetyNumberStep';
import { StickSetup } from './StickSetup';

/**
 * Personal setup, in this order and nothing else:
 *   intro (3 cards) → Google sign-in → Set up SmartStick → Profile photo → Location → Safety number
 *   → Wi-Fi (connect the stick) → Home
 * The current step is saved, so closing the app mid-setup resumes where the user was. Android back
 * goes to the previous step (core/backStack.ts).
 */
const FLOW = ['intro', 'signin', 'stick', 'photo', 'location', 'safety', 'wifi'] as const;
type Step = (typeof FLOW)[number];
const SETUP: Step[] = ['stick', 'photo', 'location', 'safety', 'wifi'];
const isStep = (s: unknown): s is Step => typeof s === 'string' && (FLOW as readonly string[]).includes(s);

export function UserOnboarding() {
  const saved = useSession((s) => s.onboardingStep);
  const auth = useAuth();
  const demo = useRuntime((s) => s.mode) === 'demo';
  const signedIn = auth.status === 'signedIn' || demo || import.meta.env.DEV;
  const [step, setStepState] = useState<Step>(() => (isStep(saved) ? saved : 'intro'));
  const [dir, setDir] = useState(1);

  const setStep = (next: Step) => {
    setDir(FLOW.indexOf(next) >= FLOW.indexOf(step) ? 1 : -1);
    setStepState(next);
    useSession.setState({ onboardingStep: next });
  };
  const back = () => {
    const i = FLOW.indexOf(step);
    // Never back into sign-in once signed in: the first setup step is the start.
    if (step === 'stick' && auth.status === 'signedIn') return;
    if (i > 0) setStep(FLOW[i - 1]);
  };
  const next = () => {
    const i = FLOW.indexOf(step);
    if (i < FLOW.length - 1) setStep(FLOW[i + 1]);
  };
  const finish = () => useSession.setState({ userOnboarded: true, onboardingStep: 'done' });

  // Signed in → skip past sign-in; signed out on a setup step → back to sign-in.
  useEffect(() => {
    if (auth.status === 'signedIn' && (step === 'intro' || step === 'signin')) setStep('stick');
    else if (!signedIn && auth.status === 'signedOut' && SETUP.includes(step)) setStep('signin');
    if (auth.status === 'signedIn') void cacheProfilePhoto(auth.user?.photoURL);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status, auth.user?.photoURL]);

  // Back: each screen's own header registers it (ScreenHeader → core/backStack.ts); the intro
  // handles its slides; the first setup step has no back (Android exits normally).

  const setupIdx = SETUP.indexOf(step);

  return (
    <AppScreen className="bg-bg text-ink">
      <AnimatePresence mode="popLayout" initial={false} custom={dir}>
        <motion.div
          key={step}
          custom={dir}
          className="absolute inset-0 flex flex-col"
          initial={{ opacity: 0, x: dir * 48 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: dir * -48 }}
          transition={{ type: 'spring', stiffness: 300, damping: 34 }}
        >
          {step === 'intro' && <IntroStory onDone={() => setStep('signin')} />}

          {step === 'signin' && <SignIn onBack={() => setStep('intro')} onDemo={() => setStep('stick')} />}

          {setupIdx >= 0 && step !== 'wifi' && (
            <SafeAreaContent bottomInset={false}>
              <div className="px-5">
                <ScreenHeader onBack={step === 'stick' ? undefined : back} title={<SetupProgress index={setupIdx} />} />
              </div>
              <div className="relative mt-2 flex flex-1 flex-col">
                {step === 'stick' && <SetUpStick onNext={next} />}
                {step === 'photo' && <ProfilePhoto onNext={next} />}
                {step === 'location' && <HomeLocationStep onSaved={next} />}
                {step === 'safety' && <SafetyNumberStep onSaved={next} />}
              </div>
            </SafeAreaContent>
          )}

          {step === 'wifi' && <StickSetup title="Connect SmartStick" onDone={finish} onBack={back} onSkip={finish} skipLabel="Connect later" />}
        </motion.div>
      </AnimatePresence>
    </AppScreen>
  );
}

function SetupProgress({ index }: { index: number }) {
  return (
    <span className="flex items-center justify-center gap-1.5" aria-label={`Step ${index + 1} of ${SETUP.length}`}>
      {SETUP.map((s, i) => (
        <span key={s} className={cx('h-1.5 rounded-full transition-all duration-300', i === index ? 'w-7 bg-teal' : i < index ? 'w-3 bg-teal/60' : 'w-3 bg-line')} />
      ))}
    </span>
  );
}

function SignIn({ onBack, onDemo }: { onBack: () => void; onDemo: () => void }) {
  const auth = useAuth();
  useBackHandler(true, onBack);
  return (
    <SafeAreaContent className="px-6" bottomInset={false}>
      <div className="intro-atmo pointer-events-none absolute inset-0 -z-10" aria-hidden />
      <div className="grid flex-1 place-items-center">
        <div className="flex flex-col items-center gap-6">
          <motion.div initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 220, damping: 18 }} className="relative">
            <div className="intro-spotlight absolute -inset-16 rounded-full" aria-hidden />
            <BrandLogo variant="icon" size={132} className="relative overflow-hidden rounded-[38px] shadow-2xl" />
          </motion.div>
          <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="text-[28px] font-extrabold tracking-tight text-ink">
            {BRAND.name}
          </motion.p>
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.25 }} className="max-w-[300px] text-center text-[15px] leading-relaxed text-ink-2">
            Sign in to keep your places, safety number and settings with your account.
          </motion.p>
        </div>
      </div>
      <div className="pb-[calc(var(--sab)+12px)]">
        {!firebaseConfigured() ? (
          <>
            <p className="mb-4 rounded-[18px] bg-amber/15 px-4 py-3 text-[14px] font-medium text-amber-ink">Firebase is not configured in this build.</p>
            <GlassButton className="h-14 w-full rounded-[20px]" onClick={onDemo}>
              Continue in demo
            </GlassButton>
          </>
        ) : (
          <>
            {auth.error && <p className="mb-4 rounded-[18px] bg-amber/15 px-4 py-3 text-[14px] font-medium text-amber-ink" role="alert">{auth.error}</p>}
            <GlassButton variant="teal" className="flex h-14 w-full items-center justify-center rounded-[20px] text-[16px] font-bold" disabled={auth.busy} onClick={() => void signInWithGoogle('user').catch(() => undefined)}>
              {auth.busy ? (
                <Loader2 size={20} className="animate-spin" />
              ) : (
                <>
                  <svg viewBox="0 0 24 24" width="22" height="22" className="mr-3 rounded-full bg-white p-[2px]" aria-hidden>
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                  </svg>
                  Continue with Google
                </>
              )}
            </GlassButton>
            {import.meta.env.DEV && (
              <button type="button" className="mt-4 w-full text-center text-[13px] text-ink-3 underline" onClick={onDemo}>
                [Dev] Skip sign-in
              </button>
            )}
          </>
        )}
      </div>
    </SafeAreaContent>
  );
}

const PERMS: { id: SetupPermission; icon: typeof MapPin; title: string; why: string }[] = [
  { id: 'location', icon: MapPin, title: 'Location', why: 'Walking directions and your SOS location' },
  { id: 'nearby', icon: Wifi, title: 'Nearby devices', why: 'Find and connect to your SmartStick' },
  { id: 'microphone', icon: Mic, title: 'Microphone', why: 'Talk to the assistant with the stick button' },
  { id: 'notifications', icon: Bell, title: 'Notifications', why: 'Keeps the stick running with the screen locked' },
];

function SetUpStick({ onNext }: { onNext: () => void }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Record<SetupPermission, PermState> | null>(null);
  const ask = async () => {
    setBusy(true);
    try {
      setRes(await requestSetupPermissions());
      // GPS was first started right after sign-in; pick up the permission granted just now.
      void ensureLocation();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full flex-col px-6">
      <div className="relative mx-auto mt-2 grid h-44 w-44 place-items-center">
        <div className="intro-spotlight absolute inset-0 rounded-full" aria-hidden />
        <StickVisual height={168} pose={{ pitch: 10, roll: 0 }} link="connected" obstacleCm={null} />
      </div>
      <h1 className="mt-2 text-[28px] font-extrabold leading-tight tracking-tight text-ink">Set up SmartStick</h1>
      <p className="mt-2 text-[15.5px] leading-relaxed text-ink-2">Four quick steps: your photo, your home, a safety number, then the stick connects. First, allow what the stick needs.</p>
      <ul className="mt-5 flex flex-col gap-2.5">
        {PERMS.map(({ id, icon: Icon, title, why }) => {
          const st = res?.[id];
          return (
            <li key={id} className="glass flex items-center gap-3 rounded-[20px] px-4 py-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-teal/12 text-teal">
                <Icon size={20} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15.5px] font-bold text-ink">{title}</span>
                <span className="block text-[13px] text-ink-3">{why}</span>
              </span>
              {st && (
                <span className={cx('flex items-center gap-1 text-[12.5px] font-bold', st === 'granted' ? 'text-ok' : st === 'denied' ? 'text-sos' : 'text-ink-3')}>
                  {st === 'granted' ? <Check size={16} /> : st === 'denied' ? <X size={16} /> : null}
                  {st === 'granted' ? 'Allowed' : st === 'denied' ? 'Denied' : st === 'unavailable' ? 'n/a' : 'Ask later'}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {res && Object.values(res).includes('denied') && <p className="mt-3 text-[13.5px] text-ink-2">Denied items can be allowed later in Android settings → Apps → {BRAND.name}. The stick still vibrates for obstacles without them.</p>}
      <div className="mt-auto pb-[calc(var(--sab)+20px)] pt-6">
        {res ? (
          <GlassButton variant="teal" className="h-14 w-full rounded-[20px] text-[17px] font-bold" onClick={onNext}>
            Continue
          </GlassButton>
        ) : (
          <GlassButton variant="teal" className="h-14 w-full rounded-[20px] text-[17px] font-bold" disabled={busy} onClick={() => void ask()}>
            {busy ? <Loader2 size={20} className="animate-spin" /> : <Radar size={20} className="mr-2" />} Allow access
          </GlassButton>
        )}
      </div>
    </div>
  );
}

function ProfilePhoto({ onNext }: { onNext: () => void }) {
  const user = useAuth((s) => s.user);
  return (
    <div className="flex h-full flex-col items-center px-6 text-center">
      <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 220, damping: 18 }} className="relative mt-10">
        <motion.span className="absolute -inset-3 rounded-full border-2 border-teal/40" animate={{ scale: [1, 1.08, 1], opacity: [0.8, 0.3, 0.8] }} transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }} aria-hidden />
        <div className="h-36 w-36 overflow-hidden rounded-full shadow-2xl ring-4 ring-surface">
          <AccountAvatar size={144} />
        </div>
      </motion.div>
      <h1 className="mt-8 text-[28px] font-extrabold tracking-tight text-ink">{user?.displayName ? `Hi, ${user.displayName.split(' ')[0]}` : 'Your profile photo'}</h1>
      <p className="mt-2 max-w-[320px] text-[15.5px] leading-relaxed text-ink-2">
        {user?.photoURL ? 'Your Google photo is saved on this phone, so Home shows it instantly, even offline.' : 'Your Google account has no photo, so your initials are used. You can add a photo to your Google account anytime.'}
      </p>
      {user?.email && <p className="mt-3 text-[13.5px] text-ink-3">{user.email}</p>}
      <div className="mt-auto w-full pb-[calc(var(--sab)+20px)] pt-6">
        <GlassButton variant="teal" className="h-14 w-full rounded-[20px] text-[17px] font-bold" onClick={onNext}>
          Looks good
        </GlassButton>
      </div>
    </div>
  );
}
