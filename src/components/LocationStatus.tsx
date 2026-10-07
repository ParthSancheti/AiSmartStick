import { useEffect, useState } from 'react';
import { Loader2, LocateOff, MapPinOff, RotateCcw, Settings, Crosshair } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { ensureLocation, locationProblem, runLocationAction, useLocation } from '../core/location/locationService';
import { cx } from './glass';

/**
 * Why there is no GPS position, in words, with the one action that fixes it. Also (re)starts GPS
 * when shown, so a permission granted elsewhere or location switched on is picked up immediately.
 * `wantPrecise` (walking directions) also flags an "Approximate only" grant.
 */
export function LocationStatus({ className = '', wantPrecise = false }: { className?: string; wantPrecise?: boolean }) {
  const s = useLocation();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // Never pops a permission dialog by itself; the button does.
    void ensureLocation({ request: false });
  }, []);
  const native = Capacitor.isNativePlatform();
  const p = locationProblem(s, { native, wantPrecise });
  if (!p) return null;

  const searching = p.kind === 'searching';
  const icon = searching ? (
    <Loader2 size={18} className="animate-spin text-teal" />
  ) : p.kind === 'off' ? (
    <LocateOff size={18} className="text-amber" />
  ) : p.kind === 'approximate' ? (
    <Crosshair size={18} className="text-amber" />
  ) : (
    <MapPinOff size={18} className="text-amber" />
  );
  const settingsIcon = p.action === 'app_settings' || p.action === 'location_settings';

  return (
    <div className={cx('glass flex min-w-0 items-center gap-3 rounded-[18px] px-4 py-3 text-[13.5px] font-semibold text-ink', className)} role="status" aria-live="polite">
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 break-words leading-snug">{p.text}</span>
      {p.action && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await runLocationAction(p.action);
            } finally {
              setBusy(false);
            }
          }}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-teal px-3 text-[13px] font-bold text-on-teal disabled:opacity-60"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : settingsIcon ? <Settings size={15} /> : <RotateCcw size={15} />}
          {p.actionLabel}
        </button>
      )}
    </div>
  );
}
