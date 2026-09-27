import { AnimatePresence, motion } from 'motion/react';
import { useSession } from '../../core/store/session';
import { useUI } from '../../core/store/ui';
import { useFeed } from '../../core/sync/guardianFeed';
import { useRuntime } from '../../core/runtime/mode';
import { useAuth } from '../../core/auth/authStore';
import { Atmosphere } from '../../components/Atmosphere';
import { GuardianOnboarding } from './GuardianOnboarding';
import { GuardianHome } from './GuardianHome';
import { GuardianMap } from './GuardianMap';
import { GuardianVision } from './GuardianVision';
import { GuardianActivity } from './GuardianActivity';
import { GuardianSettings } from './GuardianSettings';
import { GuardianSos } from './GuardianSos';
import { FloatingNav } from './FloatingNav';
import { TalkSheet } from './TalkSheet';
import { GuardianToast } from './parts';

const SCREENS = { home: GuardianHome, map: GuardianMap, vision: GuardianVision, activity: GuardianActivity, settings: GuardianSettings };

export function GuardianApp() {
  const onboardedFlag = useSession((s) => s.guardianOnboarded);
  const demo = useRuntime((s) => s.mode) === 'demo';
  const authStatus = useAuth((s) => s.status);
  const onboarded = onboardedFlag && (demo || authStatus === 'signedIn' || authStatus === 'loading');
  const tab = useUI((s) => s.guardianTab);
  // The Guardian only knows about an SOS once it reaches the cloud feed (SMS arrives separately).
  const takeover = useFeed((s) => !!s.sos);
  const Screen = SCREENS[tab];

  return (
    <div className="relative h-full w-full overflow-hidden text-ink">
      {!onboarded ? (
        <GuardianOnboarding />
      ) : (
        <>
          <Atmosphere variant="guardian" />
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={tab} className="absolute inset-0" initial={{ opacity: 0, scale: 0.96, y: 15 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: -15 }} transition={{ type: 'spring', stiffness: 400, damping: 30 }}>
              <Screen />
            </motion.div>
          </AnimatePresence>
          <FloatingNav />
          <TalkSheet />
          <GuardianToast />
        </>
      )}
      <AnimatePresence>{onboarded && takeover && <GuardianSos key="sos" />}</AnimatePresence>
    </div>
  );
}
