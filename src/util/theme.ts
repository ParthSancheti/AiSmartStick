import { flushSync } from 'react-dom';
import { useSession } from '../core/store/session';

type PointLike = { clientX?: number; clientY?: number; currentTarget?: EventTarget | null; touches?: ArrayLike<{ clientX: number; clientY: number }> };

/** Where the reveal starts: the finger, or the control's centre for keyboard / switch access. */
function originOf(e?: PointLike | null): { x: number; y: number } {
  const t = e?.touches?.[0];
  if (t) return { x: t.clientX, y: t.clientY };
  if (e && typeof e.clientX === 'number' && typeof e.clientY === 'number' && (e.clientX !== 0 || e.clientY !== 0)) return { x: e.clientX, y: e.clientY };
  const el = e?.currentTarget as Element | null | undefined;
  if (el && 'getBoundingClientRect' in el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

const isDarkNow = () => document.documentElement.dataset.theme === 'dark';

/**
 * Light ⇄ dark with a circular reveal that grows from the touch point (View Transitions API, GPU
 * clip-path on the new snapshot). The theme is applied to <html> synchronously inside the transition
 * so the "new" snapshot really is the new theme, and CSS colour transitions are frozen while the
 * snapshots are taken. Falls back to an instant switch without the API or with reduced motion.
 */
export function toggleThemeWithTransition(e?: PointLike | null) {
  const next = isDarkNow() ? 'light' : 'dark';
  const root = document.documentElement;
  const apply = () => {
    root.dataset.theme = next;
    flushSync(() => useSession.getState().updateSettings({ theme: next }));
  };
  const reduce = useSession.getState().settings.reduceMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const vt = (document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> } }).startViewTransition;
  if (!vt || reduce) {
    apply();
    return;
  }

  const { x, y } = originOf(e);
  const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  root.classList.add('theme-switching');
  const transition = vt.call(document, apply);
  transition.ready
    .then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] },
        { duration: 560, easing: 'cubic-bezier(0.22, 0.8, 0.2, 1)', pseudoElement: '::view-transition-new(root)' },
      );
      // A soft dim on the outgoing theme gives the edge depth instead of a hard wipe.
      root.animate({ filter: ['brightness(1)', next === 'dark' ? 'brightness(0.82)' : 'brightness(1.08)'] }, { duration: 560, easing: 'ease-out', pseudoElement: '::view-transition-old(root)' });
    })
    .catch(() => undefined);
  void transition.finished.finally(() => root.classList.remove('theme-switching'));
}
