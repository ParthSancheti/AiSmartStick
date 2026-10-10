import { Children, useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../../../components/glass';

/**
 * Home hero carousel: one full-width card at a time, dots below.
 *
 * Native horizontal scroll-snap does all the motion (momentum, snapping, 60 fps on the compositor);
 * there is NO scroll-linked JavaScript: the active slide is tracked with an IntersectionObserver
 * (fires once per slide change, not per frame). Every card stays in the DOM for TalkBack.
 *
 * Geometry: the track spans the full screen width (it cancels the page's 20 px gutter with -mx-5)
 * and pads itself by the same 20 px, so every card is exactly screen - 40 px wide, centred, and
 * the next card starts 20 px off-screen. Cards are `min-w-0` boxes with `w-full`: nothing inside
 * can widen them beyond the screen.
 */
export function HomeCarousel({ children, label = 'Highlights' }: { children: ReactNode; label?: string }) {
  const track = useRef<HTMLDivElement>(null);
  const items = Children.toArray(children);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const el = track.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const i = Number((e.target as HTMLElement).dataset.index);
          if (Number.isFinite(i)) setActive(i);
        }
      },
      { root: el, threshold: 0.6 },
    );
    Array.from(el.children).forEach((c) => io.observe(c));
    return () => io.disconnect();
  }, [items.length]);

  const goTo = (i: number) => {
    const el = track.current;
    const c = el?.children[i] as HTMLElement | undefined;
    if (!el || !c) return;
    el.scrollTo({ left: c.offsetLeft - (el.clientWidth - c.offsetWidth) / 2, behavior: 'smooth' });
  };

  return (
    <section className="-mx-5 mb-5 shrink-0" aria-roledescription="carousel" aria-label={label}>
      <div ref={track} className="home-carousel no-scrollbar flex snap-x snap-mandatory gap-5 overflow-x-auto overflow-y-hidden overscroll-x-contain scroll-px-5 px-5 pb-6 pt-1">
        {items.map((child, i) => (
          <div
            key={i}
            data-index={i}
            className="home-card relative flex w-full min-w-0 shrink-0 snap-center snap-always"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${items.length}`}
            aria-current={i === active ? 'true' : undefined}
          >
            {child}
          </div>
        ))}
      </div>
      <div className="-mt-2 flex justify-center gap-1">
        {items.map((_, i) => (
          <button key={i} type="button" aria-label={`Show card ${i + 1}`} aria-pressed={i === active} onClick={() => goTo(i)} className="grid h-8 min-w-8 place-items-center px-1">
            <span className={cx('block h-2 rounded-full transition-[width,background-color] duration-200', i === active ? 'w-6 bg-teal' : 'w-2 bg-ink/25')} />
          </button>
        ))}
      </div>
    </section>
  );
}
