import { create } from 'zustand';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { AissNative } from './aissNative';
import { useDevice } from '../store/device';
import { useSafety } from '../store/safety';
import { useSession } from '../store/session';
import { useNavView } from '../navigation/navView';
import { useAssistant } from '../store/assistant';
import { useAuth } from '../auth/authStore';
import { linkLabelText } from './backgroundText';
import { appRole } from '../runtime/appRole';
import { useLocation } from '../location/locationService';

/**
 * Background execution controller (user app, real mode, Android only).
 * Keeps activity tracking, the stick link and navigation alive when the user has enabled it.
 * The notification text always states what is actually happening.
 */
interface BgState {
  supported: boolean;
  running: boolean;
  error: string | null;
}
export const useBackground = create<BgState>(() => ({ supported: Capacitor.isNativePlatform(), running: false, error: null }));

function wanted() {
  const auth = useAuth.getState();
  if (auth.status !== 'signedIn' || auth.role !== 'user' || appRole(useSession.getState().entryRole, auth.role) !== 'user') return false;
  
  // Health/activity tracking needs background location even without the stick.
  // If the user opts into runInBackground, we keep it alive for activity tracking, SOS, and nav.
  return useSession.getState().settings.runInBackground;
}

function text(): { title: string; body: string } {
  const d = useDevice.getState();
  const sos = useSafety.getState().phase;
  const nav = useNavView.getState();
  if (sos === 'active') return { title: 'SOS active', body: 'Sharing your location with your guardian' };
  if (nav.active && nav.destination) return { title: `Walking to ${nav.destination.name}`, body: `Stick ${linkLabelText(d.link)}` };
  
  if (d.link === 'unpaired' || d.link === 'disconnected') {
    return { title: 'AI SmartStick', body: 'Tracking activity in background' };
  }
  
  return { title: 'AI SmartStick', body: d.link === 'connected' || d.link === 'degraded' ? 'Stick connected · SOS ready' : `Stick ${linkLabelText(d.link)}` };
}

function keepAwake() {
  const link = useDevice.getState().link;
  return link === 'connected' || link === 'degraded' || link === 'connecting'
    || useNavView.getState().active || useSafety.getState().phase !== 'idle'
    || useAssistant.getState().phase !== 'idle';
}

let lastKey = '';
let started = false;
let generation = 0;
let pending: Promise<void> = Promise.resolve();
let subscriptions: (() => void)[] = [];
let foreground = true;

function enqueue(work: () => Promise<void>): Promise<void> {
  const next = pending.then(work);
  pending = next.catch(() => undefined);
  return next;
}
/**
 * Starts the service from the foreground (so it acquires location + microphone types), afterwards
 * only updates the notification text: restarting a foreground service from the background is
 * refused on Android 12+ and would drop the while-in-use types on Android 14+.
 */
function sync(promote = false): Promise<void> {
  const owner = generation;
  return enqueue(async () => {
  if (!Capacitor.isNativePlatform() || !started || owner !== generation) return;
  const want = wanted();
  const t = text();
  const awake = keepAwake();
  const key = `${want}|${t.title}|${t.body}|${awake}`;
  if (key === lastKey && !promote) return;
  try {
    if (want) {
      await AissNative.startBackgroundService({ ...t, promote, keepAwake: awake });
      if (owner === generation) useBackground.setState({ running: true, error: null });
    } else {
      await AissNative.stopBackgroundService();
      if (owner === generation) useBackground.setState({ running: false, error: null });
    }
    if (owner === generation) lastKey = key;
  } catch (e) {
    if (owner !== generation) return;
    lastKey = ''; // retry on the next state change / resume
    useBackground.setState({ running: false, error: (e as Error).message });
  }
  });
}

export function startBackgroundController() {
  if (started || !Capacitor.isNativePlatform()) return;
  started = true;
  const owner = ++generation;
  subscriptions = [useDevice, useSafety, useNavView, useAssistant, useSession, useAuth].map((store) => store.subscribe(() => void sync()));
  subscriptions.push(useLocation.subscribe((next, previous) => {
    if (next.permission !== previous.permission || next.precise !== previous.precise || next.servicesOn !== previous.servicesOn) void sync(foreground);
  }));
  // Back on screen: re-acquire service types for permissions granted meanwhile (GPS, microphone).
  void CapApp.addListener('appStateChange', ({ isActive }) => {
    foreground = isActive;
    if (isActive) void sync(true);
  }).then((handle) => {
    if (owner !== generation) void handle.remove();
    else subscriptions.push(() => void handle.remove());
  });
  void sync(true);
}

export async function stopBackground() {
  started = false;
  generation++;
  subscriptions.splice(0).forEach((off) => off());
  lastKey = '';
  await enqueue(async () => {
    if (Capacitor.isNativePlatform()) await AissNative.stopBackgroundService().catch(() => undefined);
    useBackground.setState({ running: false });
  });
}
