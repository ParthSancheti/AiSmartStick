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
import { useAuth } from './auth/authStore';
import { watchRelationship, stopRelationshipWatch, useRelationship } from './pairing/pairingService';
import { startUserSync, stopUserSync, stopSosWatch } from './sync/userSync';
import { startRealFeed, startDemoFeed, stopFeed } from './sync/guardianFeed';
import { startCameraResponder, stopCameraResponder } from './camera/cameraSession';
import { startRealDevice } from './device/realDevice';
import { startNetworkMonitor } from './device/network';
import { startLocation, stopLocation } from './location/locationService';
import { onFix } from './location/locationService';
import { walkFix, demoWalk } from './walking/walkTracker';
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
  startSafetyRuntime();
  void loadPhoneInfo();

  if (useRuntime.getState().mode === 'demo') return bootDemo();
  bootReal();
}

function bootDemo() {
  // Demo identity (no Firebase account). Clearly labelled "Demo" in the UI.
  useAuth.setState({ status: 'signedIn', user: { uid: 'demo-user', displayName: 'Demo user', email: null, photoURL: null }, role: null, profile: null });
  void connectStick(new MockTransport({ startLinked: useSession.getState().userOnboarded }));
  visionEngine.start();
  guidanceEngine.start();
  startWorld();
  useSession.setState({ person: { ...useSession.getState().person, name: useSession.getState().person.name || 'Aarav' } });
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
  const isUserApp = () => {
    const role = useAuth.getState().role ?? useSession.getState().entryRole;
    return role !== 'guardian';
  };
  let relUnsub: (() => void) | null = null;
  let wasSignedIn = false;
  startAuth(
    (uid) => {
      wasSignedIn = true;
      const userSide = isUserApp();
      startSettingsSync(uid);
      watchRelationship(uid, userSide ? 'user' : 'guardian');
      if (userSide) {
        void startRealDevice();
        void startLocation();
        onFix(walkFix);
        // Directions that were running when the app/process died resume from the first fresh fix.
        const offResume = onFix(() => {
          offResume();
          void resumeSavedNavigation();
        });
        void startUserSync(uid);
        startCameraResponder(uid);
        void registerPush(uid, 'user');
        startBackgroundController();
        startCommandRelay(uid);
        visionEngine.start();
        guidanceEngine.start();
      } else {
        relUnsub?.();
        relUnsub = useRelationship.subscribe((r, prev) => {
          if (r.rel && r.rel.relationshipId !== prev.rel?.relationshipId) startRealFeed(r.rel);
          if (!r.rel && prev.rel) stopFeed();
        });
        const cur = useRelationship.getState().rel;
        if (cur) startRealFeed(cur);
        void registerPush(uid, 'guardian');
      }
    },
    () => {
      // Signed out: nothing from the previous account may stay on screen.
      if (useAuth.getState().status === 'signedOut' && wasSignedIn) void clearLocalAccountData();
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
  );
}
