import { create } from 'zustand';
import { isWide } from '../util';
import { useRuntime } from '../runtime/mode';

export type GuardianTab = 'home' | 'map' | 'vision' | 'activity' | 'settings';

export interface Banner {
  id: number;
  tone: 'teal' | 'ink' | 'amber';
  title: string;
  body?: string;
  icon: 'eye' | 'message' | 'link' | 'info';
}

interface UIData {
  layout: 'stage' | 'single';
  guardianTab: GuardianTab;
  talkSheet: boolean;
  userSettings: boolean;
  pocket: boolean;
  demoOpen: boolean;
  visionDebug: boolean;
  call: { name: string; startedAt: number } | null;
  userBanner: Banner | null;
  guardianToast: { id: number; text: string } | null;
  batteryPage: boolean;
  stickPage: boolean;
  mapOpen: boolean;
  healthOpen: boolean;
  liveAiOpen: boolean;
  audioOpen: boolean;
  /** First-time / re-pair stick provisioning screen. */
  stickSetup: boolean;
}

interface UIState extends UIData {
  set: (p: Partial<UIData>) => void;
}

export const useUI = create<UIState>((set) => ({
  // Two phones on one page only makes sense with simulated state: demo only.
  layout: isWide() && useRuntime.getState().mode === 'demo' ? 'stage' : 'single',
  guardianTab: 'home',
  talkSheet: false,
  userSettings: false,
  pocket: false,
  demoOpen: false,
  visionDebug: false,
  call: null,
  userBanner: null,
  guardianToast: null,
  batteryPage: false,
  stickPage: false,
  mapOpen: false,
  healthOpen: false,
  liveAiOpen: false,
  audioOpen: false,
  stickSetup: false,
  set: (p) => set(p),
}));

let bannerTimer: ReturnType<typeof setTimeout> | undefined;
export function showUserBanner(b: Omit<Banner, 'id'>, ms = 6000) {
  clearTimeout(bannerTimer);
  useUI.setState({ userBanner: { ...b, id: Date.now() } });
  bannerTimer = setTimeout(() => useUI.setState({ userBanner: null }), ms);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toastGuardian(text: string) {
  clearTimeout(toastTimer);
  useUI.setState({ guardianToast: { id: Date.now(), text } });
  toastTimer = setTimeout(() => useUI.setState({ guardianToast: null }), 3200);
}
