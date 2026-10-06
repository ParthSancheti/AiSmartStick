import { Children, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../../../components/glass';

/**
 * Home hero carousel. Native scroll-snap (smooth, momentum, and every card stays in the DOM for
 * TalkBack), with per-frame depth written straight to the elements — no React render per frame:
 *   active card: full scale, full opacity, lifted shadow
 *   neighbours:  slightly smaller and dimmer, pushed back
 *   [data-parallax] layers inside a card trail the swipe for depth.
 */
export function HomeCarousel({ children, label = 'Highlights' }: { children: ReactNode; label?: string }) {
  const track = useRef<HTMLDivElement>(null);
  const items = Children.toArray(children);
  const [active, setActive] = useState(0);
  const raf = useRef(0);

  const paint = useCallback(() => {
    const el = track.current;
    if (!el) return;
    const mid = el.scrollLeft + el.clientWidth / 2;
    let best = 0;
    let bestD = Infinity;
    Array.from(el.children).forEach((child, i) => {
      const c = child as HTMLElement;
      const center = c.offsetLeft + c.offsetWidth / 2;
      const d = Math.max(-1, Math.min(1, (center - mid) / c.offsetWidth));
      const a = Math.abs(d);
      c.style.transform = `scale(${1 - 0.07 * a}) translateZ(0)`;
      c.style.opacity = String(1 - 0.38 * a);
      c.style.setProperty('--lift', String(1 - a));
      c.querySelectorAll<HTMLElement>('[data-parallax]').forEach((p) => {
        const k = Number(p.dataset.parallax) || 28;
        p.style.transform = `translateX(${d * -k}px)`;
      });
      if (a < bestD) {
        bestD = a;
        best = i;
      }
    });
    setActive((prev) => (prev === best ? prev : best));
  }, []);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const onScroll = () => {
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(paint);
    };
    paint();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(paint);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      cancelAnimationFrame(raf.current);
    };
  }, [paint, items.length]);

  const goTo = (i: number) => {
    const el = track.current;
    const c = el?.children[i] as HTMLElement | undefined;
    if (!el || !c) return;
    el.scrollTo({ left: c.offsetLeft - (el.clientWidth - c.offsetWidth) / 2, behavior: 'smooth' });
  };

  return (
    <section className="-mx-5 mb-6 shrink-0" aria-roledescription="carousel" aria-label={label}>
      <div ref={track} className="home-carousel no-scrollbar flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-[7%] pb-3 pt-1">
        {items.map((child, i) => (
          <div
            key={i}
            className="home-card relative w-[86%] shrink-0 snap-center snap-always will-change-transform"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${items.length}`}
            aria-current={i === active ? 'true' : undefined}
          >
            {child}
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-center gap-2">
        {items.map((_, i) => (
          <button key={i} type="button" aria-label={`Show card ${i + 1}`} onClick={() => goTo(i)} className="grid h-6 place-items-center px-0.5">
            <span className={cx('block h-1.5 rounded-full transition-all duration-300', i === active ? 'w-6 bg-teal' : 'w-1.5 bg-ink/25')} />
          </button>
        ))}
      </div>
    </section>
  );
}
