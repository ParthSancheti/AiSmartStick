import type { ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Camera, Check, Footprints, MessageCircle, Navigation, ShieldAlert, ShieldCheck, ShieldQuestion, Smartphone, TriangleAlert, Settings, Moon, Sun, LogOut } from 'lucide-react';
import { useSession } from '../../core/store/session';
import { useUI } from '../../core/store/ui';
import { useNow } from '../../hooks/useNow';
import { clock, meters, timeAgo } from '../../core/util';
import { useFeed, feedFresh } from '../../core/sync/guardianFeed';
import { useRuntime } from '../../core/runtime/mode';
import { signOut } from '../../core/auth/authService';
import { useAuth } from '../../core/auth/authStore';
import { AccountAvatar } from '../../components/Avatar';
import { ModeBadge } from '../../components/ModeBadge';
import { BrandLogo } from '../../core/brand/BrandLogo';
import { BRAND } from '../../core/brand/brand';
import type { ActivityEvent } from '../../core/types';
import { cx } from '../../components/glass';

export function GScreen({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="absolute inset-0 overflow-y-auto no-scrollbar" style={{ paddingTop: 'calc(var(--island, 0px) + 10px)' }}>
      <div className={cx('mx-auto px-4 pb-32', wide ? 'max-w-[980px]' : 'max-w-[680px]')}>{children}</div>
    </div>
  );
}

export function GuardianProfileMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const theme = useSession((s) => s.settings.theme);
  const updateSettings = useSession((s) => s.updateSettings);
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const setSession = useSession((s) => s.set);
  const setUI = useUI((s) => s.set);
  const mode = useRuntime((s) => s.mode);
  const user = useAuth((s) => s.user);
  const canSwitch = true;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-[100] bg-ink/5 backdrop-blur-[2px]"
            aria-hidden="true"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.8, y: -20, x: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0, x: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: -20, x: 20 }}
            transition={{ type: 'spring', stiffness: 500, damping: 25 }}
            className="fixed top-24 right-6 z-[101] glass w-64 rounded-[28px] p-2 flex flex-col gap-1 shadow-2xl origin-top-right"
          >
            {user && (
              <div className="px-4 pb-2 pt-2">
                <p className="truncate text-[15px] font-bold text-ink">{user.displayName ?? 'Signed in'}</p>
                <p className="truncate text-[13px] text-ink-3">{mode === 'demo' ? 'Demo mode · simulated data' : (user.email ?? '')}</p>
              </div>
            )}
            <button type="button" className="glass interactive flex items-center gap-3 px-4 py-3 rounded-[20px] text-[15px] font-semibold text-ink w-full" onClick={() => { onClose(); setUI({ guardianTab: 'settings' }); }}>
              <Settings size={18} /> Settings
            </button>
            <button type="button" className="glass interactive flex items-center gap-3 px-4 py-3 rounded-[20px] text-[15px] font-semibold text-ink w-full" onClick={() => { updateSettings({ theme: isDark ? 'light' : 'dark' }); }}>
              {isDark ? <Sun size={18} /> : <Moon size={18} />} Toggle Theme
            </button>
            {canSwitch && (
              <button type="button" className="glass interactive flex items-center gap-3 px-4 py-3 rounded-[20px] text-[15px] font-semibold text-ink w-full" onClick={() => { onClose(); setSession({ entryRole: 'user' }); }}>
                <Smartphone size={18} /> Switch to User App
              </button>
            )}
            {mode === 'real' && (
              <>
                <div className="h-px bg-ink/10 my-1 mx-2" />
                <button type="button" className="glass interactive flex items-center gap-3 px-4 py-3 rounded-[20px] text-[15px] font-semibold text-sos w-full" onClick={() => { onClose(); void signOut(); }}>
                  <LogOut size={18} /> Log out
                </button>
              </>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

import { useState } from 'react';

export function TopNav() {
  const [menuOpen, setMenuOpen] = useState(false);
  
  return (
    <div className="w-full relative z-[50] pt-10 flex-shrink-0 mb-4 px-1">
      <motion.div 
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className="glass flex items-center justify-between h-[68px] rounded-[34px] px-2 shadow-2xl"
      >
        <div className="flex items-center gap-3 pl-2">
          <BrandLogo variant="icon" size={44} />
          <span className="text-[17px] font-bold text-ink tracking-tight">{BRAND.name}</span>
          <ModeBadge />
        </div>
        <button 
          type="button" 
          className="h-11 w-11 rounded-full p-[2px] overflow-hidden interactive mr-2 shrink-0 bg-teal/10" 
          aria-label="Profile menu"
          onClick={() => setMenuOpen(true)}
        >
          <AccountAvatar size={40} />
        </button>
      </motion.div>
      <GuardianProfileMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
    </div>
  );
}

export function GHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <header className="mb-5 flex items-end justify-between gap-3 px-1 pt-1">
      <div className="min-w-0">
        {subtitle && <p className="text-[15px] text-ink-3">{subtitle}</p>}
        <h1 className="text-[32px] font-bold leading-[1.1] tracking-[-0.02em] text-ink">{title}</h1>
      </div>
      {right}
    </header>
  );
}

export function PersonAvatar({ size = 44 }: { size?: number }) {
  const name = useFeed((s) => s.userName);
  const dev = useFeed((s) => s.device);
  const now = useNow(5000);
  const ok = !!dev && (dev.link === 'connected' || dev.link === 'degraded') && dev.phoneInternet && feedFresh(dev.updatedAt, now);
  return (
    <span className="relative inline-grid shrink-0 place-items-center rounded-full glass" style={{ width: size, height: size }} aria-label={`${name || 'User'}: ${ok ? 'online' : 'not live'}`}>
      <span className="text-[17px] font-bold text-teal-ink">{(name || '?')[0]}</span>
      <span className="absolute bottom-0 right-0 block h-3.5 w-3.5 rounded-full border-2 border-surface" style={{ background: ok ? 'var(--ok)' : 'var(--amber)' }} />
    </span>
  );
}

export type SafetyLevel = 'safe' | 'attention' | 'critical' | 'unknown';

/**
 * "Is the user okay right now?" — from the cloud feed only (never this phone's local stores).
 * Stale data is labelled stale; missing data is "waiting", never "safe".
 */
export function useSafetyStatus() {
  const now = useNow(1000);
  const f = useFeed();
  const name = f.userName || 'Your person';
  const d = f.device;
  const n = f.navigation;
  const fresh = feedFresh(d?.updatedAt, now);
  const updated = !d ? 'No data yet' : now - d.updatedAt < 15_000 ? 'Live' : fresh ? `Updated ${timeAgo(d.updatedAt, now)}` : `Last seen ${timeAgo(d.updatedAt, now)}`;

  let activity = f.locationLabel ?? (f.location ? `GPS position ±${Math.round(f.location.accuracyM)} m` : f.permissions && !f.permissions.location ? 'Location not shared' : 'Location unavailable');
  if (n?.active && n.destination && !n.arrived) activity = `Walking to ${n.destination.name}${n.remainingM != null ? `, ${meters(n.remainingM)} to go` : ''}`;
  else if (n?.arrived && n.destination) activity = `Just arrived at ${n.destination.name}`;

  if (f.status === 'no_relationship') return { level: 'unknown' as SafetyLevel, reasons: [], headline: 'No one linked yet', activity: 'Link a stick user in Settings', updated };
  if (f.status !== 'ready' || !d) return { level: 'unknown' as SafetyLevel, reasons: f.error ? [f.error] : [], headline: `Waiting for ${name}'s phone`, activity, updated };
  if (!fresh) return { level: 'unknown' as SafetyLevel, reasons: [`No update for ${timeAgo(d.updatedAt, now).replace(' ago', '')}. The phone may be off or offline.`], headline: `No recent update from ${name}`, activity, updated };

  const st = f.safety?.state ?? 'unknown';
  const reasons = [...(f.safety?.reasons ?? [])];
  if (!d.phoneInternet && !reasons.some((r) => /offline/i.test(r))) reasons.push(`${name}'s phone is offline.`);
  const level: SafetyLevel = st === 'healthy' ? 'safe' : st === 'warning' ? 'attention' : st === 'critical' || st === 'connectionLost' || st === 'sos' ? 'critical' : 'unknown';
  const headline =
    st === 'healthy' ? `${name} is safe` : st === 'warning' ? `Check on ${name}` : st === 'connectionLost' ? `${name}'s stick is disconnected` : st === 'critical' || st === 'sos' ? `${name} may need help` : `Waiting for ${name}'s stick`;
  return { level, reasons, headline, activity, updated };
}

/** The Guardian's hero: one calm, living ring that answers "is he okay?" at a glance. */
export function SafetyHalo({ level, size = 188 }: { level: SafetyLevel; size?: number }) {
  const reduce = useReducedMotion();
  const color = level === 'safe' ? 'var(--teal)' : level === 'attention' ? 'var(--amber)' : level === 'critical' ? 'var(--sos)' : 'var(--ink-3)';
  const Icon = level === 'safe' ? ShieldCheck : level === 'unknown' ? ShieldQuestion : ShieldAlert;
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }} aria-hidden>
      <motion.div
        className="absolute rounded-full"
        style={{ inset: -size * 0.16, background: `radial-gradient(closest-side, color-mix(in oklab, ${color} 38%, transparent), transparent)` }}
        animate={reduce ? undefined : { scale: [1, 1.07, 1], opacity: [0.7, 1, 0.7] }}
        transition={{ duration: 4.2, repeat: Infinity, ease: 'easeInOut' }}
      />
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
        <circle cx="50" cy="50" r="46" fill="none" stroke={color} strokeOpacity=".16" strokeWidth="5" />
        <motion.circle
          cx="50"
          cy="50"
          r="46"
          fill="none"
          stroke={color}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray="70 219"
          style={{ transformOrigin: '50px 50px' }}
          animate={reduce ? undefined : { rotate: 360 }}
          transition={{ duration: level === 'safe' ? 9 : level === 'unknown' ? 14 : 3.5, repeat: Infinity, ease: 'linear' }}
        />
      </svg>
      <div className="glass grid place-items-center rounded-full" style={{ width: size * 0.7, height: size * 0.7 }}>
        <Icon size={size * 0.26} strokeWidth={1.8} style={{ color }} />
      </div>
    </div>
  );
}

const KIND_ICON = { safety: ShieldAlert, navigation: Navigation, device: Smartphone, vision: Camera, message: MessageCircle };

export function EventRow({ e, now }: { e: ActivityEvent; now: number }) {
  const Icon = e.severity === 'success' && e.kind === 'safety' ? ShieldCheck : e.kind === 'safety' && e.title.startsWith('Obstacle') ? Footprints : e.severity === 'warning' && e.kind === 'device' ? TriangleAlert : KIND_ICON[e.kind];
  const tone =
    e.severity === 'critical'
      ? 'bg-sos text-white'
      : e.severity === 'warning'
        ? 'bg-amber-soft text-amber-ink'
        : e.severity === 'success'
          ? 'bg-teal-soft text-teal-ink'
          : 'bg-ink/[0.07] text-ink-2';
  return (
    <div className="flex gap-3 px-4 py-3">
      <span className={cx('mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-[12px]', tone)}>
        <Icon size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[15.5px] font-semibold leading-snug text-ink">{e.title}</p>
          <time className="shrink-0 text-[13px] text-ink-3 tabular" dateTime={new Date(e.ts).toISOString()}>
            {now - e.ts < 3_600_000 ? timeAgo(e.ts, now) : clock(e.ts)}
          </time>
        </div>
        {e.detail && <p className="mt-0.5 text-[14px] leading-snug text-ink-3">{e.detail}</p>}
      </div>
    </div>
  );
}

export function GuardianToast() {
  const toast = useUI((s) => s.guardianToast);
  return (
    <div className="pointer-events-none absolute inset-x-0 z-[60] flex justify-center px-4" style={{ top: 'calc(var(--island, 0px) + 10px)' }} aria-live="polite">
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            initial={{ y: -24, opacity: 0, scale: 0.96 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -20, opacity: 0 }}
            className="glass flex max-w-full items-center gap-2 rounded-full py-2.5 pl-3 pr-4 text-[14.5px] font-semibold text-ink"
          >
            <span className="grid h-6 w-6 place-items-center rounded-full bg-teal text-on-teal">
              <Check size={14} strokeWidth={3} />
            </span>
            <span className="truncate">{toast.text}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
