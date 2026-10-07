import { AnimatePresence } from 'motion/react';
import { useSession } from '../../core/store/session';
import { useSafety } from '../../core/store/safety';
import { useUI } from '../../core/store/ui';
import { usePocketMode } from '../../hooks/usePocketMode';
import { useResumeLastPage } from '../../hooks/useResumeLastPage';
import { Atmosphere } from '../../components/Atmosphere';
import { UserHome } from './UserHome';
import { UserOnboarding } from './UserOnboarding';
import { UserSos } from './UserSos';
import { PocketShield } from './PocketShield';
import { UserSettings } from './UserSettings';
import { CallOverlay, UserBanner } from './UserOverlays';
import { StickSetup } from './StickSetup';
import { useRuntime } from '../../core/runtime/mode';
import { useAuth } from '../../core/auth/authStore';

export function StickUserApp() {
  const onboardedFlag = useSession((s) => s.userOnboarded);
  const demo = useRuntime((s) => s.mode) === 'demo';
  const authStatus = useAuth((s) => s.status);
  // Real mode: a signed-out phone always goes back through sign-in, even if it was set up before.
  const onboarded = onboardedFlag && (demo || import.meta.env.DEV || authStatus === 'signedIn' || authStatus === 'loading');
  const stickSetup = useUI((s) => s.stickSetup);
  const hc = useSession((s) => s.settings.highContrast);
  const textScale = useSession((s) => s.settings.textScale);
  const sos = useSafety((s) => s.phase);
  const pocket = useUI((s) => s.pocket);
  usePocketMode(pocket);
  useResumeLastPage(onboarded);

  return (
    <div
      className={`relative h-full w-full overflow-hidden text-ink ${hc ? 'bg-bg' : 'bg-transparent'}`}
      data-contrast={hc ? 'high' : undefined}
      style={{ ['--text-scale' as string]: textScale, zoom: textScale } as any}
    >
      {!hc && <Atmosphere variant="user" />}
      {onboarded ? <UserHome /> : <UserOnboarding />}
      <UserBanner />
      <CallOverlay />
      <UserSettings />
      {onboarded && stickSetup && <StickSetup title="Set up SmartStick" onDone={() => useUI.setState({ stickSetup: false })} onBack={() => useUI.setState({ stickSetup: false })} />}
      <AnimatePresence>{pocket && <PocketShield key="pocket" />}</AnimatePresence>
      <AnimatePresence>{onboarded && sos !== 'idle' && <UserSos key="sos" />}</AnimatePresence>
    </div>
  );
}
