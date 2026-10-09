import { useEffect, useRef } from 'react';

/**
 * One back model for the whole app (Android hardware back, gesture back, Escape on desktop).
 *
 * Any open layer — a modal, a sheet, a subpage, an onboarding step after the first — registers a
 * handler while it is visible. A back press runs the most recently registered handler, so the top
 * layer always closes first. When nothing is registered the global screen flags in useUI are
 * closed (see App.tsx), and on the root Home the app exits normally.
 */
type Handler = () => void;
const stack: { id: number; fn: { current: Handler } }[] = [];
let seq = 0;

/** Runs the top handler; false when no layer claimed the press. */
export function popBack(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.fn.current();
  return true;
}

export function backDepth() {
  return stack.length;
}

/** Registers `onBack` while `active`. The handler may change every render; registration order does not. */
export function useBackHandler(active: boolean, onBack: Handler) {
  const fn = useRef(onBack);
  fn.current = onBack;
  useEffect(() => {
    if (!active) return;
    const id = ++seq;
    stack.push({ id, fn });
    return () => {
      const i = stack.findIndex((e) => e.id === id);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}
