import { useDevice, selectStrategy } from '../core/store/device';
import type { NetworkStrategy } from '../core/types';

export const STRATEGY_META: Record<NetworkStrategy, { label: string; short: string; tone: 'teal' | 'amber' | 'sos' | 'ink'; user: string }> = {
  full: { label: 'Full Smart', short: 'All systems on', tone: 'teal', user: 'Everything is working.' },
  local: {
    label: 'Local only',
    short: 'Stick on, no internet',
    tone: 'amber',
    user: "No internet. The assistant can't see or search right now. Your stick still detects obstacles.",
  },
  cloud: {
    label: 'Cloud only',
    short: 'Phone online, stick off',
    tone: 'amber',
    user: 'Stick not connected. It still vibrates for obstacles on its own.',
  },
  offline: {
    label: 'Offline',
    short: 'No stick, no internet',
    tone: 'sos',
    user: 'No stick and no internet. Your stick still vibrates for obstacles on its own.',
  },
};

export function useNetworkStrategy() {
  const link = useDevice((s) => s.link);
  const internet = useDevice((s) => s.internet);
  const strategy = selectStrategy({ link, internet } as Parameters<typeof selectStrategy>[0]);
  return { strategy, meta: STRATEGY_META[strategy], link, internet };
}
