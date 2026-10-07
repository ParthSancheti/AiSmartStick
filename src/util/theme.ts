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

const DURATION = 720;
const EASE = 'cubic-bezier(0.65, 0, 0.35, 1)';
let busy = false;

/**
 * Light ⇄ dark with a circular reveal growing from the touch point.
 *
 * Smoothness rules: inside the transition only the <html data-theme> attribute changes (pure CSS,
 * no React work while the browser captures snapshots); the setting is stored after the animation.
 * Only clip-path animates (GPU). CSS colour transitions are frozen during the switch.
 * Without the View Transitions API (older WebViews) a painted overlay performs the same reveal.
 */
export function toggleThemeWithTransition(e?: PointLike | null) {
  if (busy) return;
  const root = document.documentElement;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  const commit = () => useSession.getState().updateSettings({ theme: next });
  const reduce = useSession.getState().settings.reduceMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    root.dataset.theme = next;
    commit();
    return;
  }
  const { x, y } = originOf(e);
  const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const from = `circle(0px at ${x}px ${y}px)`;
  const to = `circle(${r}px at ${x}px ${y}px)`;
  busy = true;
  root.classList.add('theme-switching');
  const done = () => {
    root.classList.remove('theme-switching');
    busy = false;
    commit();
  };

  const vt = (document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> } }).startViewTransition;
  if (vt) {
    const t = vt.call(document, () => {
      root.dataset.theme = next;
    });
    t.ready.then(() => root.animate({ clipPath: [from, to] }, { duration: DURATION, easing: EASE, pseudoElement: '::view-transition-new(root)' })).catch(() => undefined);
    t.finished.then(done, done);
    return;
  }

  // Fallback: paint the new background as a growing circle, switch underneath, then fade it out.
  const bg = next === 'dark' ? '#050508' : '#f0f4f8';
  const veil = document.createElement('div');
  veil.style.cssText = `position:fixed;inset:0;z-index:2147483647;pointer-events:none;background:${bg};clip-path:${from};will-change:clip-path,opacity;`;
  document.body.appendChild(veil);
  veil
    .animate({ clipPath: [from, to] }, { duration: DURATION, easing: EASE, fill: 'forwards' })
    .finished.then(() => {
      root.dataset.theme = next;
      return veil.animate({ opacity: [1, 0] }, { duration: 260, easing: 'ease-out', fill: 'forwards' }).finished;
    })
    .catch(() => {
      root.dataset.theme = next;
    })
    .finally(() => {
      veil.remove();
      done();
    });
}
