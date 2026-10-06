import { flushSync } from 'react-dom';
import { useSession } from '../core/store/session';

export function toggleThemeWithTransition(e: React.MouseEvent | React.TouchEvent | PointerEvent | MouseEvent) {
  
  const isDark = document.documentElement.dataset.theme === 'dark';
  const next = isDark ? 'light' : 'dark';

  if (!document.startViewTransition) {
    useSession.getState().updateSettings({ theme: next });
    return;
  }

  // Get coordinates for the ripple center
  let x = 0;
  let y = 0;
  
  if ('clientX' in e) {
    x = e.clientX;
    y = e.clientY;
  } else if ('touches' in e && e.touches.length > 0) {
    x = e.touches[0].clientX;
    y = e.touches[0].clientY;
  } else {
    x = window.innerWidth / 2;
    y = window.innerHeight / 2;
  }

  const endRadius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));

  const transition = document.startViewTransition(() => {
    flushSync(() => {
      useSession.getState().updateSettings({ theme: next });
    });
  });

  transition.ready.then(() => {
    const clipPath = [
      `circle(0px at ${x}px ${y}px)`,
      `circle(${endRadius}px at ${x}px ${y}px)`,
    ];
    
    document.documentElement.animate(
      {
        clipPath: clipPath,
      },
      {
        duration: 400,
        easing: 'ease-out',
        pseudoElement: '::view-transition-new(root)',
      }
    );
  });
}
