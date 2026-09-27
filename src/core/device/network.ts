import { Capacitor } from '@capacitor/core';
import { Network } from '@capacitor/network';
import { useDevice } from '../store/device';
import { logEvent } from '../store/activity';
import { announce } from '../ai/voiceOut';
import { P } from '../ai/phrases';
import { earcon } from '../feedback/earcons';
import { haptics } from '../feedback/haptics';
import { userSurfaceActive } from '../surfaces';
import { deliverQueuedSos } from '../safety/sos';
import { getMock } from './bridge';
import { isDemo } from '../runtime/mode';

/**
 * Internet reachability. "Connected to Wi-Fi" is not "online" (the stick's own AP has no
 * internet), so we combine the OS network status with a real HTTP probe.
 */
const PROBE_URL = 'https://www.gstatic.com/generate_204';

export function applyInternet(on: boolean) {
  const d = useDevice.getState();
  if (d.internet === on) return;
  const first = d.internet === null;
  d.set(on ? { internet: true } : { internet: false });
  if (first) return;
  if (on) {
    announce(P.netUp);
    if (userSurfaceActive()) earcon('connect');
    logEvent({ kind: 'device', severity: 'success', title: 'Phone back online' });
    deliverQueuedSos();
  } else {
    announce(P.netDown);
    if (userSurfaceActive()) {
      earcon('disconnect');
      haptics.play('warning');
    }
    logEvent({ kind: 'device', severity: 'warning', title: 'Phone lost internet', detail: 'Stick safety keeps working offline' });
  }
}

async function probe() {
  try {
    await fetch(PROBE_URL, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(4000) });
    return true;
  } catch {
    return false;
  }
}

let timer: ReturnType<typeof setInterval> | undefined;

export async function startNetworkMonitor() {
  const check = async () => applyInternet(await probe());
  await check();
  clearInterval(timer);
  timer = setInterval(check, 15000);
  if (Capacitor.isNativePlatform() || 'onLine' in navigator) {
    void Network.addListener('networkStatusChange', (s) => {
      if (!s.connected) applyInternet(false);
      else void check();
    });
  }
}

/** Demo panel only. */
export function setInternet(on: boolean) {
  if (!isDemo()) return;
  applyInternet(on);
}

export function setStickLinked(on: boolean) {
  getMock()?.setLinked(on);
}
