import { connectStick, disconnectStick } from './device/bridge';
import { stopDiscovery } from './device/discovery';
import { useDevice } from './store/device';
import { liveSession } from './ai/liveSession';
import { visionEngine } from './vision/visionLoop';
import { guidanceEngine } from './guidance/guidanceEngine';
import { MockTransport } from './transport/mockTransport';
import { startWorld } from './sim/world';
import { unlockAudio } from './feedback/earcons';
import { useSession } from './store/session';
import { useRuntime } from './runtime/mode';
import { startAuth, clearLocalAccountData } from './auth/authService';
import { mirrorNameToAuth } from './profile/profile';
import { seedTextScaleFromSystem } from './native/textScale';
import { useAuth } from './auth/authStore';
import { watchRelationship, stopRelationshipWatch, useRelationship } from './pairing/pairingService';
import { startUserSync, stopUserSync, stopSosWatch } from './sync/userSync';
import { startRealFeed, startDemoFeed, stopFeed } from './sync/guardianFeed';
import { startCameraResponder, stopCameraResponder } from './camera/cameraSession';
import { startRealDevice } from './device/realDevice';
import { applyInternet, startNetworkMonitor } from './device/network';
import { startLocation, stopLocation } from './location/locationService';
import { onFix } from './location/locationService';
import { walkFix, demoWalk, startNativeWalking, stopNativeWalking } from './walking/walkTracker';
import { startSafetyRuntime } from './safety/safetyRuntime';
import { loadPhoneInfo } from './native/deviceInfo';
import { registerPush } from './native/notifications';
import { useNav } from './store/nav';
import { useNavView, emptyNav } from './navigation/navView';
import { UNIT_M } from './sim/geo';
import { startSettingsSync, stopSettingsSync } from './sync/settingsSync';
import { startBackgroundController, stopBackground } from './native/background';
import { startCommandRelay, stopCommandRelay } from './sync/commandRelay';
import { resumeSavedNavigation, stopRealNavigation } from './navigation/realNavigator';
import { appRole } from './runtime/appRole';

let booted = false;

/**
 * Two completely separate worlds:
 *  DEMO  → MockTransport + simulated street + keyword brain + local guardian feed.
 *  REAL  → Firebase auth → relationship → (user phone) stick + GPS + cloud sync
 *                                       → (guardian phone) Firestore feed only.
 */
export function boot() {
  if (booted) return;
  booted = true;
  const unlock = () => {
    unlockAudio();
    window.removeEventListener('pointerdown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  if (appRole(useSession.getState().entryRole) === 'user' || useRuntime.getState().mode === 'demo') startSafetyRuntime();
  void loadPhoneInfo();

  if (useRuntime.getState().mode === 'demo') return bootDemo();
  bootReal();
}

function bootDemo() {
  applyInternet(true);
  // Demo identity (no Firebase account). Clearly labelled "Demo" in the UI.
  useAuth.setState({ status: 'signedIn', user: { uid: 'demo-user', displayName: 'Demo user', email: null, photoURL: null }, role: null, profile: null });
  void connectStick(new MockTransport({ startLinked: useSession.getState().userOnboarded }));
  visionEngine.start();
  guidanceEngine.start();
  startWorld();
  useSession.setState({ person: { ...useSession.getState().person, name: useSession.getState().person.name || 'Aarav' } });
  // The profile menu reads the auth name: show the same demo name everywhere.
  mirrorNameToAuth(useSession.getState().person.name);
  // Demo navigation feeds the same normalised view the real navigator uses.
  let walked = 0;
  let lastTravelled = 0;
  useNav.subscribe((n) => {
    if (!n.active) {
      if (useNavView.getState().source === 'demo') useNavView.setState(emptyNav());
      lastTravelled = 0;
      return;
    }
    walked += Math.max(0, n.travelled - lastTravelled) * UNIT_M;
    lastTravelled = n.travelled;
    demoWalk(walked);
    const next = n.steps[n.stepIdx + 1];
    const remaining = Math.max(0, (n.total - n.travelled) * UNIT_M);
    useNavView.setState({
      active: true,
      source: 'demo',
      destination: n.place ? { name: n.place.name, placeId: null, lat: null, lng: null } : null,
      totalM: n.total * UNIT_M,
      remainingM: remaining,
      etaSec: Math.round(remaining / 1.4),
      next: next ? { text: next.turn === 'arrive' ? `Arrive at ${n.place?.name ?? 'destination'}` : `Turn ${next.turn} onto ${next.street}`, maneuver: next.turn === 'left' || next.turn === 'right' ? next.turn : next.turn === 'arrive' ? 'arrive' : 'straight', inM: null } : null,
      arrived: n.arrived,
      updatedAt: Date.now(),
    });
  });
  startDemoFeed();
}

function bootReal() {
  void startNetworkMonitor();
  void seedTextScaleFromSystem();
  const isUserApp = () => {
    return appRole(useSession.getState().entryRole, useAuth.getState().role) === 'user';
  };
  let relUnsub: (() => void) | null = null;
  let wasSignedIn = false;
  let userRun = 0;
  // The uid the stick link was started for (started early from the uid, before the profile loads).
  let deviceUid: string | null = null;
  let offWalk: (() => void) | null = null;
  let offResume: (() => void) | null = null;
  const startDeviceFor = (uid: string) => {
    if (deviceUid === uid) return;
    deviceUid = uid;
    void startRealDevice();
  };
  // GPS as soon as the app opens (never a dialog), not only after sign-in and the Firestore profile
  // load, which can be slow or stall while the phone is on the stick's Wi-Fi.
  const earlyLocation: Promise<void> = isUserApp() ? startLocation({ request: false }).catch(() => undefined) : Promise.resolve();
  startAuth(
    (uid) => {
      wasSignedIn = true;
      const run = ++userRun;
      const userSide = isUserApp();
      const currentAccount = () => run === userRun && useAuth.getState().status === 'signedIn'
        && useAuth.getState().user?.uid === uid && isUserApp() === userSide;
      startSettingsSync(uid);
      watchRelationship(uid, userSide ? 'user' : 'guardian');
      if (userSide) {
        startDeviceFor(uid);
        // Android shows one permission dialog at a time: ask for notifications only after location.
        // After the quiet early start: this is the one start that may show the permission dialog
        // (a no-op when GPS already runs).
        const settled = Promise.race([earlyLocation, new Promise<void>((r) => setTimeout(r, 15_000))]);
        void settled.then(async () => {
          if (!currentAccount()) return;
          await startLocation().catch(() => undefined);
          if (currentAccount()) await registerPush(uid, 'user', currentAccount);
        }).catch(() => undefined);
        offWalk?.();
        offWalk = onFix(walkFix);
        // Directions that were running when the app/process died resume from the first fresh fix.
        offResume?.();
        offResume = onFix(() => {
          offResume?.();
          offResume = null;
          if (currentAccount()) void resumeSavedNavigation().catch(() => undefined);
        });
        void startUserSync(uid);
        startCameraResponder(uid);
        void startNativeWalking(uid).then(() => {
          if (currentAccount()) startBackgroundController();
        });
        startCommandRelay(uid);
        visionEngine.start();
        guidanceEngine.start();
      } else {
        void stopNativeWalking();
        // Started early from the uid but this account turned out to be a guardian: no stick here.
        if (deviceUid) {
          deviceUid = null;
          disconnectStick();
          useDevice.setState({ link: 'unpaired', identity: null, linkDetail: null });
        }
        relUnsub?.();
        relUnsub = useRelationship.subscribe((r, prev) => {
          if (r.rel && r.rel.relationshipId !== prev.rel?.relationshipId) startRealFeed(r.rel);
          if (!r.rel && prev.rel) stopFeed();
        });
        const cur = useRelationship.getState().rel;
        if (cur) startRealFeed(cur);
        void registerPush(uid, 'guardian', currentAccount);
      }
    },
    () => {
      userRun++;
      // Signed out: nothing from the previous account may stay on screen.
      if (useAuth.getState().status === 'signedOut' && wasSignedIn) void clearLocalAccountData();
      deviceUid = null;
      offWalk?.();
      offWalk = null;
      void stopNativeWalking();
      offResume?.();
      offResume = null;
      stopUserSync();
      stopSosWatch();
      // The previous account's stick link, GPS, directions and voice session end with it.
      liveSession.stop();
      stopRealNavigation();
      void stopLocation();
      void stopDiscovery();
      disconnectStick();
      useDevice.setState({ link: 'unpaired', identity: null, linkDetail: null });
      visionEngine.stop();
      guidanceEngine.stop();
      stopCameraResponder();
      void stopBackground();
      stopCommandRelay();
      stopRelationshipWatch();
      stopSettingsSync();
      stopFeed();
      relUnsub?.();
      relUnsub = null;
    },
    (uid) => {
      // The stick link starts from the uid alone (profile load can stall offline for ~10 s).
      // Account role is verified before starting the user's stick services.
    },
  );
}
