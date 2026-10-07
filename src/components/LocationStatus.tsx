import { useEffect } from 'react';
import { Loader2, LocateOff, MapPinOff, RotateCcw, Settings } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { ensureLocation, useLocation } from '../core/location/locationService';
import { AissNative } from '../core/native/aissNative';
import { cx } from './glass';

/**
 * Why there is no GPS position, in words, with the one action that fixes it. Also (re)starts GPS
 * when shown, so a permission granted elsewhere or location switched on is picked up immediately.
 */
export function LocationStatus({ className = '' }: { className?: string }) {
  const { status, permission, error, fix } = useLocation();
  useEffect(() => {
    void ensureLocation();
  }, []);
  if (fix && (status === 'ok' || status === 'poor')) return null;

  const native = Capacitor.isNativePlatform();
  const off = !!error && /turned off|disabled|not enabled|location services/i.test(error);
  const denied = permission === 'denied' || status === 'error';
  const searching = !denied && !off && (status === 'acquiring' || status === 'idle' || (status === 'stale' && !error));

  const icon = searching ? <Loader2 size={18} className="animate-spin text-teal" /> : off ? <LocateOff size={18} className="text-amber" /> : <MapPinOff size={18} className="text-amber" />;
  const text = searching
    ? 'Finding your position… (works best near a window or outdoors)'
    : off
      ? 'Location is switched off on this phone.'
      : denied
        ? 'Location permission is blocked for AI SmartStick.'
        : (error ?? 'Your position is not available yet.');

  return (
    <div className={cx('glass flex items-center gap-3 rounded-[18px] px-4 py-3 text-[13.5px] font-semibold text-ink', className)} role="status">
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 leading-snug">{text}</span>
      {!searching && (
        <button
          type="button"
          onClick={() => {
            if (off && native) void AissNative.openLocationSettings().catch(() => undefined);
            else if (denied && native && permission === 'denied') void AissNative.openAppSettings().catch(() => undefined);
            else void ensureLocation();
          }}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-teal px-3 text-[13px] font-bold text-on-teal"
        >
          {off || (denied && permission === 'denied') ? <Settings size={15} /> : <RotateCcw size={15} />}
          {off ? 'Turn on' : denied && permission === 'denied' ? 'Allow' : 'Retry'}
        </button>
      )}
    </div>
  );
}
