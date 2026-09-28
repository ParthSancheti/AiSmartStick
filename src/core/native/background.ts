import { create } from 'zustand';
import { Capacitor } from '@capacitor/core';
import { AissNative } from './aissNative';
import { useDevice } from '../store/device';
import { useSafety } from '../store/safety';
import { useSession } from '../store/session';
import { useNavView } from '../navigation/navView';
import { linkLabelText } from './backgroundText';

/**
 * Background execution controller (user app, real mode, Android only).
 * Runs the foreground service while there is something to protect: a paired stick, an SOS,
 * or active navigation — and the user has not turned "Run in background" off.
 * The notification text always states what is actually happening.
 */
interface BgState {
  supported: boolean;
  running: boolean;
  error: string | null;
}
export const useBackground = create<BgState>(() => ({ supported: Capacitor.isNativePlatform(), running: false, error: null }));

function wanted() {
  const d = useDevice.getState();
  const sos = useSafety.getState().phase;
  const nav = useNavView.getState().active;
  return useSession.getState().settings.runInBackground && (d.link !== 'unpaired' || sos === 'active' || sos === 'countdown' || nav);
}

function text(): { title: string; body: string } {
  const d = useDevice.getState();
  const sos = useSafety.getState().phase;
  const nav = useNavView.getState();
  if (sos === 'active') return { title: 'SOS active', body: 'Sharing your location with your guardian' };
  if (nav.active && nav.destination) return { title: `Walking to ${nav.destination.name}`, body: `Stick ${linkLabelText(d.link)}` };
  return { title: 'AI SmartStick', body: d.link === 'connected' || d.link === 'degraded' ? 'Stick connected · SOS ready' : `Stick ${linkLabelText(d.link)}` };
}

let lastKey = '';
async function sync() {
  if (!Capacitor.isNativePlatform()) return;
  const want = wanted();
  const t = text();
  const key = `${want}|${t.title}|${t.body}`;
  if (key === lastKey) return;
  lastKey = key;
  try {
    if (want) {
      await AissNative.startBackgroundService(t); // also updates the notification text
      useBackground.setState({ running: true, error: null });
    } else if (useBackground.getState().running) {
      await AissNative.stopBackgroundService();
      useBackground.setState({ running: false });
    }
  } catch (e) {
    useBackground.setState({ running: false, error: (e as Error).message });
  }
}

let started = false;
export function startBackgroundController() {
  if (started || !Capacitor.isNativePlatform()) return;
  started = true;
  useDevice.subscribe(() => void sync());
  useSafety.subscribe(() => void sync());
  useNavView.subscribe(() => void sync());
  useSession.subscribe(() => void sync());
  void sync();
}

export async function stopBackground() {
  lastKey = '';
  if (Capacitor.isNativePlatform()) await AissNative.stopBackgroundService().catch(() => undefined);
  useBackground.setState({ running: false });
}
