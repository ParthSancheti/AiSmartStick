import { useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useUI } from '../../core/store/ui';
import { useSession } from '../../core/store/session';
import { useDevice } from '../../core/store/device';
import { announce } from '../../core/ai/voiceOut';
import { P } from '../../core/ai/phrases';
import { haptics } from '../../core/feedback/haptics';
import { useNavView } from '../../core/navigation/navView';
import { useLocation } from '../../core/location/locationService';
import { useRuntime } from '../../core/runtime/mode';
import { BRAND } from '../../core/brand/brand';
import { linkLabel } from '../shared/labels';
import { Link2, Unlink, Navigation, Mic } from 'lucide-react';

/**
 * Dim touch shield for walking with the phone in a pocket. Swallows every
 * touch; the stick button keeps working. Exit: two fingers held for 2 seconds.
 */
export function PocketShield() {
  const demo = useRuntime((s) => s.mode) === 'demo';
  const linkState = useDevice((s) => s.link);
  const internet = useDevice((s) => s.internet);
  const navActive = useNavView((s) => s.active);
  const locStatus = useLocation((s) => s.status);
  const gps = demo ? (navActive ? 'NAVIGATING' : 'DEMO') : locStatus === 'ok' ? (navActive ? 'NAVIGATING' : 'ON') : locStatus === 'stale' || locStatus === 'poor' ? 'WEAK' : 'OFF';
  void useSession;
  const pointers = useRef(new Set<number>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [arming, setArming] = useState(false);

  const exit = () => {
    haptics.play('success');
    useUI.setState({ pocket: false });
    announce(P.pocketOff);
  };
  const update = () => {
    const two = pointers.current.size >= 2;
    setArming(two);
    clearTimeout(timer.current);
    if (two) timer.current = setTimeout(exit, 2000);
  };

  return (
    <motion.div
      className="absolute inset-0 z-[75] flex touch-none select-none flex-col items-center justify-center bg-black px-8 text-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onPointerDown={(e) => {
        pointers.current.add(e.pointerId);
        update();
      }}
      onPointerUp={(e) => {
        pointers.current.delete(e.pointerId);
        update();
      }}
      onPointerCancel={(e) => {
        pointers.current.delete(e.pointerId);
        update();
      }}
      onContextMenu={(e) => e.preventDefault()}
      role="dialog"
      aria-label="Pocket mode is active. Screen touches are ignored to prevent accidental interaction. Hold two fingers on the screen for 2 seconds to exit."
    >
      <div className="flex flex-col items-center justify-center gap-8 w-full max-w-sm">
        <div className="flex items-center gap-3">
          <div className="w-3 h-3 rounded-full bg-teal animate-pulse" />
          <h1 className="text-[24px] font-bold tracking-widest uppercase text-white/90">{BRAND.name}</h1>
          <span className="text-[20px] font-bold text-teal ml-2">ACTIVE</span>
        </div>

        <div className="flex flex-col gap-6 w-full text-left">
          <div className="flex items-center justify-between border-b border-white/10 pb-4">
             <div className="flex items-center gap-4 text-white/70">
               <Mic size={24} />
               <span className="text-[18px] font-semibold uppercase tracking-wider">Voice</span>
             </div>
             <span className={`text-[18px] font-bold ${internet === false ? 'text-amber' : 'text-ok'}`}>{internet === false ? 'OFFLINE' : 'AVAILABLE'}</span>
          </div>

          <div className="flex items-center justify-between border-b border-white/10 pb-4">
             <div className="flex items-center gap-4 text-white/70">
               {linkState === 'connected' ? <Link2 size={24} /> : <Unlink size={24} />}
               <span className="text-[18px] font-semibold uppercase tracking-wider">Stick</span>
             </div>
             <span className={`text-[18px] font-bold ${linkState === 'connected' ? 'text-ok' : 'text-sos'}`}>
               {linkLabel(linkState).text.toUpperCase()}
             </span>
          </div>

          <div className="flex items-center justify-between border-b border-white/10 pb-4">
             <div className="flex items-center gap-4 text-white/70">
               <Navigation size={24} />
               <span className="text-[18px] font-semibold uppercase tracking-wider">GPS</span>
             </div>
             <span className={`text-[18px] font-bold ${gps === 'OFF' || gps === 'WEAK' ? 'text-amber' : 'text-ok'}`}>{gps}</span>
          </div>
        </div>

        <div className="mt-8 text-[16px] font-semibold text-white/50 h-8 flex items-center justify-center" aria-live="polite">
          {arming ? 'Keep holding to exit...' : 'Hold two fingers to exit'}
        </div>
      </div>

      {demo && (
        <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={exit} className="absolute bottom-8 rounded-full border border-white/20 px-5 py-2.5 text-[14px] font-semibold text-white/60">
          Exit (demo)
        </button>
      )}
    </motion.div>
  );
}
