import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import type { ButtonPattern, LinkState } from '../types';
import type { StickTransport } from '../transport/types';
import { MockTransport } from '../transport/mockTransport';
import { useDevice } from '../store/device';
import { useSession, getSettings } from '../store/session';
import { useSafety } from '../store/safety';
import { useUI } from '../store/ui';
import { logEvent } from '../store/activity';
import { announce } from '../ai/voiceOut';
import { P } from '../ai/phrases';
import { earcon } from '../feedback/earcons';
import { haptics } from '../feedback/haptics';
import { userSurfaceActive } from '../surfaces';
import { startListening, runDirect } from '../ai/assistant';
import { startSos, cancelSos } from '../safety/sos';
import { endCall } from '../phone';
import { startDeviceConfigSync } from './deviceConfig';
import { configurePipeline, ingestPacket, resetPipeline, setImuCalibration, startStalenessWatch } from '../telemetry/pipeline';

/**
 * Wires a StickTransport into the app: packets → telemetry pipeline → device store,
 * link changes → announcements, classified button gestures → actions.
 */
let transport: StickTransport | null = null;
let unsubs: (() => void)[] = [];

/** Foreground again: a link waiting out its reconnect backoff retries at once. */
function watchForeground(t: StickTransport): () => void {
  if (typeof document === 'undefined' || !t.nudge) return () => {};
  const onVis = () => {
    if (document.visibilityState === 'visible') t.nudge?.();
  };
  document.addEventListener('visibilitychange', onVis);
  // Android: the WebView may not fire visibilitychange on every resume; appStateChange does.
  let handle: { remove: () => Promise<void> } | null = null;
  let gone = false;
  if (Capacitor.isNativePlatform()) {
    CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) t.nudge?.();
    })
      .then((h) => {
        if (gone) void h.remove();
        else handle = h;
      })
      .catch(() => undefined);
  }
  return () => {
    gone = true;
    document.removeEventListener('visibilitychange', onVis);
    void handle?.remove().catch(() => undefined);
  };
}
const buttonListeners = new Set<(p: ButtonPattern) => boolean | void>();

export const getTransport = () => transport;
/** Demo controls only. Returns null in real mode. */
export const getMock = () => (transport instanceof MockTransport ? transport : null);

export function onStickButton(cb: (p: ButtonPattern) => boolean | void) {
  buttonListeners.add(cb);
  return () => {
    buttonListeners.delete(cb);
  };
}

export async function connectStick(t: StickTransport) {
  disconnectStick();
  transport = t;
  resetPipeline();
  setImuCalibration(getSettings().imuCalibration);
  useDevice.setState({ source: t.kind });
  configurePipeline({
    onButton: handleButton,
    onFall: () => {
      if (useSession.getState().userOnboarded && getSettings().sosTriggers.fall) startSos('fall');
    },
    // Shown on Home / Stick details / Connection test; cleared when data is accepted again.
    onRejected: (reason) => {
      if (reason) useDevice.setState({ linkDetail: reason });
      else if (useDevice.getState().linkDetail?.startsWith('Stick data rejected')) useDevice.setState({ linkDetail: null });
    },
  });
  unsubs = [
    t.on('packet', (p, at) => ingestPacket(p, at)),
    t.on('link', (s, d) => onLink(s, d)),
    t.on('identity', (id) => useDevice.setState({ identity: id })),
    watchForeground(t),
  ];
  startStalenessWatch();
  startDeviceConfigSync();
  await t.connect();
}

export function disconnectStick() {
  unsubs.forEach((u) => u());
  unsubs = [];
  transport?.disconnect();
  transport = null;
}

function onLink(s: LinkState, detail?: string) {
  const prev = useDevice.getState().link;
  useDevice.setState({ link: s, linkDetail: detail ?? null });
  if (prev === s) return;
  const fx = userSurfaceActive();
  const wasUp = prev === 'connected' || prev === 'degraded';
  if (s === 'degraded' || (s === 'connected' && wasUp)) return; // quality change, not a (re)connection
  if (s === 'connected') {
    announce(P.linkUp);
    if (fx) {
      earcon('connect');
      haptics.play('connect');
    }
    logEvent({ kind: 'device', severity: 'success', title: 'Stick connected', detail: 'Live data over the stick’s Wi-Fi' });
  } else if ((s === 'disconnected' || s === 'reconnecting') && wasUp) {
    announce(P.linkDown, { high: true });
    if (fx) {
      earcon('disconnect');
      haptics.play('disconnect');
    }
    logEvent({ kind: 'device', severity: 'warning', title: 'Stick disconnected from phone', detail: 'Obstacle vibration keeps running on the stick' });
  } else if (s === 'protocol_mismatch') {
    announce({ en: 'Your stick needs a firmware update before it can connect.', hi: 'स्टिक को जोड़ने से पहले उसका फ़र्मवेयर अपडेट करना होगा।' }, { high: true });
    logEvent({ kind: 'device', severity: 'critical', title: 'Stick firmware incompatible', detail: detail ?? 'Protocol version mismatch' });
  } else if (s === 'auth_failed') {
    // v1 simple link: a 401 only means the stick still runs the old secure firmware (1.1).
    announce({ en: 'Your stick needs new firmware before it can connect.', hi: 'स्टिक को जोड़ने से पहले उसमें नया फ़र्मवेयर डालना होगा।' }, { high: true });
    logEvent({ kind: 'device', severity: 'critical', title: 'Stick needs firmware 1.2', detail: detail ?? 'Flash the new firmware, then set the stick up again' });
  }
}

/** P0 spoken complement to the ECU's own vibration: interrupts lower-priority speech. Rate-limited. */
let lastDangerSpeech = 0;
useDevice.subscribe((s, prev) => {
  if (s.zone === 'danger' && prev.zone !== 'danger' && Date.now() - lastDangerSpeech > 8000 && getSettings().obstacleVibration) {
    lastDangerSpeech = Date.now();
    announce({ en: 'Stop. Obstacle very close ahead.', hi: 'रुकिए। सामने बहुत पास रुकावट है।' }, { critical: true, dedupeKey: 'obstacle-danger' });
  }
});

/** Derived alerts from the filtered state (not raw values). */
let lastObstacleLog = 0;
let lowBatteryAnnounced = false;
let criticalLogged = false;
useDevice.subscribe((s, prev) => {
  const th = getSettings().lowBatteryAt;
  const pct = s.battery.status === 'ok' ? s.battery.percent : null;
  if (pct != null && !s.battery.charging && pct <= th && !lowBatteryAnnounced) {
    lowBatteryAnnounced = true;
    announce(P.lowBattery(pct), { high: true });
    if (userSurfaceActive()) {
      haptics.play('warning');
      earcon('warning');
    }
    logEvent({ kind: 'device', severity: 'warning', title: `Stick battery low, about ${pct}%`, detail: 'Estimated from the battery sensor' });
  }
  if (pct != null && pct > th + 5) lowBatteryAnnounced = false;
  if (pct != null && !s.battery.charging && pct <= 5 && !criticalLogged) {
    criticalLogged = true;
    announce({ en: `Stick battery is critically low, about ${pct} percent. Please charge it now.`, hi: `स्टिक की बैटरी बहुत कम है, करीब ${pct} प्रतिशत। अभी चार्ज कीजिए।` }, { critical: true });
    logEvent({ kind: 'device', severity: 'critical', title: `Stick battery critical, about ${pct}%`, detail: 'Estimated from the battery sensor' });
  }
  if (pct != null && pct > 10) criticalLogged = false;
  if (s.battery.charging != null && prev.battery.charging != null && s.battery.charging !== prev.battery.charging) {
    logEvent({ kind: 'device', severity: 'info', title: s.battery.charging ? 'Stick charging' : 'Stick unplugged', detail: s.battery.chargingSource === 'inferred' ? 'Inferred from battery current' : 'From the charger' });
  }

  const d = s.ultrasonic.status === 'ok' ? s.ultrasonic.distanceCm : null;
  const pd = prev.ultrasonic.status === 'ok' ? prev.ultrasonic.distanceCm : null;
  if (d != null && d < 60 && (pd == null || pd >= 60) && Date.now() - lastObstacleLog > 20000) {
    lastObstacleLog = Date.now();
    logEvent({ kind: 'safety', severity: 'warning', title: `Obstacle ahead at ${d} cm`, detail: 'Measured by the stick’s ultrasonic sensor' });
  }
});

/** The button map: 1 = talk, 2 = where am I, 3 = what's ahead, hold 3 s = SOS. Any press cancels a countdown. */
export function handleButton(p: ButtonPattern) {
  // A listener (confirmation prompt, camera permission) may consume the press.
  for (const cb of buttonListeners) if (cb(p) === true) return;
  if (p === 'setup-hold') return;
  if (!useSession.getState().userOnboarded) return;

  if (useSafety.getState().phase === 'countdown') {
    cancelSos();
    return;
  }
  if (useUI.getState().call && p === 'single') {
    endCall();
    return;
  }
  switch (p) {
    case 'single':
      startListening();
      break;
    case 'double':
      void runDirect('where_am_i', 'Where am I?');
      break;
    case 'triple':
      void runDirect('describe_scene', 'What’s in front of me?');
      break;
    case 'hold':
      if (getSettings().sosTriggers.button) startSos('button');
      break;
  }
}
