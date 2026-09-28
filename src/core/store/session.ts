import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Contact, GlassTier, ReplyLang, Role, ThemePref } from '../types';
import { isWide } from '../util';
import { useRuntime } from '../runtime/mode';
import type { ImuCalibration } from '../telemetry/imu';

export interface Settings {
  theme: ThemePref;
  glass: 'auto' | GlassTier;
  reduceMotion: boolean;
  haptics: boolean;
  earcons: boolean;
  voiceOut: boolean;
  replyLang: 'auto' | ReplyLang;
  voiceRate: number;
  /** Assistant speech + earcon volume, 0–100 (safety siren ignores it). */
  assistantVolume: number;
  textScale: number;
  screenReaderMode: boolean;
  highContrast: boolean;
  /** Demo only: use the browser microphone instead of typed demo phrases. Real mode always uses the mic. */
  realMic: boolean;
  pocketKeepAlive: boolean;
  /** Canonical device-config inputs (sent to the ECU as a versioned DeviceConfig). */
  obstacleSensitivity: 'low' | 'medium' | 'high';
  hapticStrength: number;
  obstacleVibration: boolean;
  autoSleepMin: number;
  /** Android: keep the stick link, GPS, SOS and sync running with the screen off (foreground service). */
  runInBackground: boolean;
  demoTools: boolean;
  simSpeed: number;
  sosTriggers: { button: boolean; voice: boolean; fall: boolean };
  sosCancelSec: number;
  sosMessage: string;
  siren: boolean;
  lowBatteryAt: number;
  /** Share live location with the guardian continuously (SOS always shares location). */
  locationSharing: boolean;
  /** Guardian camera requests: always announced; 'auto' = approved automatically after the announcement. */
  cameraRequests: 'auto' | 'ask';
  /** Direct call/SMS when Android permission is granted, else the system dialer/composer. */
  callMode: 'direct' | 'dialer';
  smsMode: 'direct' | 'composer';
  imuCalibration: ImuCalibration | null;
  /** Guardian-side notification preferences (push). SOS is always on. */
  notify: { deviceDisconnected: boolean; lowBattery: boolean; locationStale: boolean; snapshot: boolean };
  /** Guardian-side geofence around the user's home address. */
  /** Guardian-side geofence. center null = the user's saved home address (geocoded on the server). */
  geofence: { enabled: boolean; radiusM: number; name: string; center: { lat: number; lng: number } | null };
}

export const defaultSettings: Settings = {
  theme: 'system',
  glass: 'auto',
  reduceMotion: false,
  haptics: true,
  earcons: true,
  voiceOut: true,
  replyLang: 'auto',
  voiceRate: 1,
  assistantVolume: 100,
  textScale: 1,
  screenReaderMode: false,
  highContrast: false,
  realMic: false,
  pocketKeepAlive: false,
  runInBackground: true,
  obstacleSensitivity: 'medium',
  hapticStrength: 80,
  obstacleVibration: true,
  autoSleepMin: 0,
  demoTools: true,
  simSpeed: 6,
  sosTriggers: { button: true, voice: true, fall: true },
  sosCancelSec: 5,
  sosMessage: 'Emergency! I need help. My live location is shared in the AI SmartStick app.',
  siren: true,
  lowBatteryAt: 20,
  locationSharing: true,
  cameraRequests: 'auto',
  callMode: 'direct',
  smsMode: 'composer',
  imuCalibration: null,
  notify: { deviceDisconnected: true, lowBattery: true, locationStale: true, snapshot: false },
  geofence: { enabled: false, radiusM: 200, name: 'Home', center: null },
};

const demoContacts: Contact[] = [
  { id: 'mom', name: 'Mom', relation: 'Mother', phone: '+91 00000 00001', aliases: ['mom', 'mummy', 'mumma', 'maa', 'mother', 'माँ', 'मां', 'मम्मी'] },
  { id: 'papa', name: 'Papa', relation: 'Father', phone: '+91 00000 00002', aliases: ['papa', 'dad', 'daddy', 'father', 'पापा'] },
];

interface SessionData {
  /** For the combined dev build only; shipped builds are single-role. */
  entryRole: Role | null;
  guardianOnboarded: boolean;
  userOnboarded: boolean;
  /** The other person in the relationship, as this phone knows them. Empty until paired (real mode). */
  guardian: { name: string; email: string; heardAs: string; phone: string | null };
  person: { name: string; phone: string; email: string; homeAddress: string; workAddress: string; medicalId: string };
  pairingCode: string | null;
  linked: boolean;
  contacts: Contact[];
  settings: Settings;
}

interface SessionState extends SessionData {
  set: (p: Partial<SessionData>) => void;
  updateSettings: (p: Partial<Settings>) => void;
}

const demo = useRuntime.getState().mode === 'demo';
const stage = isWide();

const seeded: SessionData = demo
  ? {
      entryRole: 'user',
      guardianOnboarded: stage,
      userOnboarded: stage,
      guardian: { name: 'Demo Guardian', email: 'demo@example.com', heardAs: 'Mom', phone: '+91 00000 00001' },
      person: { name: 'Aarav', phone: '', email: '', homeAddress: '', workAddress: '', medicalId: '' },
      pairingCode: '482913',
      linked: stage,
      contacts: demoContacts,
      settings: defaultSettings,
    }
  : {
      entryRole: null,
      guardianOnboarded: false,
      userOnboarded: false,
      guardian: { name: '', email: '', heardAs: '', phone: null },
      person: { name: '', phone: '', email: '', homeAddress: '', workAddress: '', medicalId: '' },
      pairingCode: null,
      linked: false,
      contacts: [],
      settings: { ...defaultSettings, demoTools: false },
    };

export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      ...seeded,
      set: (p) => set(p),
      updateSettings: (p) => set((s) => ({ settings: { ...s.settings, ...p } })),
    }),
    {
      // Separate storage per mode: demo data can never leak into real mode.
      name: demo ? 'aiss-session-demo' : 'aiss-session-real',
      version: 2,
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SessionData>;
        return { ...current, ...p, settings: { ...defaultSettings, ...current.settings, ...(p.settings ?? {}) } };
      },
      partialize: (s) => ({
        settings: s.settings,
        contacts: s.contacts,
        person: s.person,
        guardian: s.guardian,
        userOnboarded: s.userOnboarded,
        guardianOnboarded: s.guardianOnboarded,
        entryRole: s.entryRole,
        linked: s.linked,
      }),
    },
  ),
);

export const getSettings = () => useSession.getState().settings;
/** How the stick user hears the guardian, with an honest fallback before pairing. */
export const guardianSpokenName = () => useSession.getState().guardian.heardAs || 'your guardian';
