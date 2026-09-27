import { BUTTON_TIMING } from '../core/telemetry/button';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ButtonPattern } from '../core/types';
import { haptics } from '../core/feedback/haptics';

/**
 * Mirrors the stick button on a touch target: tap / double / triple within a
 * short window, and a 3-second hold (with visible progress) for SOS.
 */
export function usePressPatterns(onPattern: (p: ButtonPattern) => void, holdMs: number = BUTTON_TIMING.longPressMs, windowMs: number = BUTTON_TIMING.multiPressWindowMs) {
  const taps = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const raf = useRef(0);
  const held = useRef(false);
  const down = useRef(false);
  const [holdProgress, setHoldProgress] = useState(0);

  const stopProgress = () => {
    cancelAnimationFrame(raf.current);
    setHoldProgress(0);
  };

  useEffect(
    () => () => {
      clearTimeout(tapTimer.current);
      clearTimeout(holdTimer.current);
      cancelAnimationFrame(raf.current);
    },
    [],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      down.current = true;
      held.current = false;
      const t0 = performance.now();
      const loop = () => {
        const p = (performance.now() - t0) / holdMs;
        if (p > 0.12) setHoldProgress(Math.min(1, p));
        if (p < 1 && down.current) raf.current = requestAnimationFrame(loop);
      };
      raf.current = requestAnimationFrame(loop);
      holdTimer.current = setTimeout(() => {
        held.current = true;
        taps.current = 0;
        clearTimeout(tapTimer.current);
        stopProgress();
        onPattern('hold');
      }, holdMs);
    },
    [holdMs, onPattern],
  );

  const release = useCallback(
    (countTap: boolean) => {
      if (!down.current) return;
      down.current = false;
      clearTimeout(holdTimer.current);
      stopProgress();
      if (held.current || !countTap) return;
      haptics.play('tap');
      taps.current += 1;
      clearTimeout(tapTimer.current);
      tapTimer.current = setTimeout(() => {
        const n = taps.current;
        taps.current = 0;
        onPattern(n === 1 ? 'single' : n === 2 ? 'double' : 'triple');
      }, windowMs);
    },
    [onPattern, windowMs],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onPattern('single');
      }
    },
    [onPattern],
  );

  return {
    holdProgress,
    bind: {
      onPointerDown,
      onPointerUp: () => release(true),
      onPointerLeave: () => release(false),
      onPointerCancel: () => release(false),
      onKeyDown,
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    },
  };
}
