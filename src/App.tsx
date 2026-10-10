import { useEffect, useRef } from 'react';
import { App as CapApp } from '@capacitor/app';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { boot } from './core/boot';
import { useSession } from './core/store/session';
import { useUI } from './core/store/ui';
import { useApplySettings } from './hooks/useApplySettings';
import { SvgDefs } from './components/SvgDefs';
import { DemoPanel } from './components/DemoPanel';
import { StickUserApp } from './features/user/StickUserApp';
import { Stage } from './features/stage/Stage';
import { DetectionDebugView } from './features/debug/DetectionDebugView';
import { useRuntime } from './core/runtime/mode';
import { popBack } from './core/backStack';

function SinglePhone() {
  const demoOpen = useUI((s) => s.demoOpen);
  const visionDebug = useUI((s) => s.visionDebug);
  const entryRole = useSession((s) => s.entryRole);
  const demo = useRuntime((s) => s.mode) === 'demo';
  // Shipped builds are single-role; the combined dev build asks once.
  const role = entryRole;
  const taps = useRef<number[]>([]);
  const vTaps = useRef<number[]>([]);

  const visionTap = () => {
    const now = Date.now();
    vTaps.current = [...vTaps.current.filter((t) => now - t < 700), now];
    if (vTaps.current.length >= 3) {
      vTaps.current = [];
      useUI.setState({ visionDebug: true });
    }
  };

  const cornerTap = () => {
    const now = Date.now();
    taps.current = [...taps.current.filter((t) => now - t < 700), now];
    if (taps.current.length >= 3) {
      taps.current = [];
      useUI.setState({ demoOpen: true });
    }
  };

  return (
    <div className="relative mx-auto h-full w-full max-w-[430px] overflow-hidden bg-transparent">
      <StickUserApp />
      {demo && <button type="button" aria-label="Open demo controls" onClick={cornerTap} className="absolute left-0 top-0 z-[95] h-11 w-11 opacity-0" />}
      <button type="button" aria-label="Open vision debug" onClick={visionTap} className="absolute right-0 bottom-0 z-[95] h-12 w-12 opacity-0" />
      <AnimatePresence>
        {visionDebug && <DetectionDebugView onClose={() => useUI.setState({ visionDebug: false })} />}
      {demo && demoOpen && (
          <motion.div
            className="absolute inset-0 z-[100] flex justify-end bg-[#0b1820]/35"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => useUI.setState({ demoOpen: false })}
          >
            <motion.div
              className="glass h-full w-full max-w-[400px] rounded-l-[30px]"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', stiffness: 360, damping: 38 }}
              onClick={(e) => e.stopPropagation()}
            >
              <DemoPanel variant="drawer" onClose={() => useUI.setState({ demoOpen: false })} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function App() {
  useApplySettings();
  const reduceMotion = useSession((s) => s.settings.reduceMotion);
  const layout = useUI((s) => s.layout);

  useEffect(() => {
    boot();
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
      if (e.key.toLowerCase() === 'd' && useRuntime.getState().mode === 'demo') useUI.setState({ demoOpen: !useUI.getState().demoOpen });
      if (e.key.toLowerCase() === 'v') useUI.setState({ visionDebug: !useUI.getState().visionDebug });
    };
    window.addEventListener('keydown', onKey);

    // One back model (core/backStack.ts): the top registered layer first, then global screen flags,
    // then normal Android exit from the root screen. The app has no browser history to go back in.
    const back = () => {
      if (popBack()) return true;
      const st = useUI.getState();
      const flags = ['demoOpen', 'visionDebug', 'talkSheet', 'stickSetup', 'userSettings', 'batteryPage', 'stickPage', 'healthOpen', 'liveAiOpen', 'audioOpen', 'mapOpen', 'pocket'] as const;
      const open = flags.find((f) => st[f]);
      if (open) {
        useUI.setState({ [open]: false });
        return true;
      }
      return false;
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') back();
    };
    window.addEventListener('keydown', onEscape);
    const handle = CapApp.addListener('backButton', () => {
      if (!back()) void CapApp.exitApp();
    });

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onEscape);
      void handle.then((h) => h.remove());
    };
  }, []);

  return (
    <MotionConfig reducedMotion={reduceMotion ? 'always' : 'user'}>
      <SvgDefs />
      {layout === 'stage' ? <Stage /> : <SinglePhone />}
    </MotionConfig>
  );
}
