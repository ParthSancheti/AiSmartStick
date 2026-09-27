import { BatteryCharging, BatteryFull, BatteryLow, BatteryMedium, CloudOff, Unlink, Wifi, WifiOff } from 'lucide-react';
import type { NetworkStrategy } from '../core/types';
import { STRATEGY_META } from '../hooks/useNetworkStrategy';
import { cx } from './glass';

const TONE = {
  teal: 'bg-teal-soft text-teal-ink',
  amber: 'bg-amber-soft text-amber-ink',
  sos: 'bg-sos/15 text-sos',
  ink: 'bg-ink/[0.07] text-ink-2',
};

export function NetworkBadge({ strategy, className }: { strategy: NetworkStrategy; className?: string }) {
  const m = STRATEGY_META[strategy];
  const Icon = strategy === 'full' ? Wifi : strategy === 'local' ? CloudOff : strategy === 'cloud' ? Unlink : WifiOff;
  return (
    <span className={cx('inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold', TONE[m.tone], className)}>
      <Icon size={15} strokeWidth={2.4} />
      {m.label}
    </span>
  );
}

export function BatteryIcon({ pct, charging, size = 18 }: { pct: number; charging?: boolean; size?: number }) {
  if (charging) return <BatteryCharging size={size} />;
  if (pct <= 20) return <BatteryLow size={size} />;
  if (pct <= 70) return <BatteryMedium size={size} />;
  return <BatteryFull size={size} />;
}

export function Meter({ value, tone = 'teal', className }: { value: number; tone?: 'teal' | 'amber' | 'sos'; className?: string }) {
  const color = tone === 'teal' ? 'var(--teal)' : tone === 'amber' ? 'var(--amber)' : 'var(--sos)';
  return (
    <div className={cx('h-2 w-full overflow-hidden rounded-full bg-ink/10', className)}>
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(3, Math.min(100, value))}%`, background: color }} />
    </div>
  );
}
