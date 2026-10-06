import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { animate, motion, useMotionValue, useReducedMotion, useTransform, type MotionValue } from 'motion/react';
import { MapPin } from 'lucide-react';
import { StickVisual } from '../../../components/StickVisual';
import { GlassButton, cx } from '../../../components/glass';
import { useBackHandler } from '../../../core/backStack';

const SLIDES = [
  { eyebrow: 'INDEPENDENCE', title: 'Move with confidence.', body: 'Your SmartStick feels what is ahead and tells you, so every step is your own.' },
  { eyebrow: 'SMART AWARENESS', title: 'The stick senses. AI understands.', body: 'Ultrasonic sensing, motion and a camera, understood on your phone in real time.' },
  { eyebrow: 'EVERYWHERE WITH YOU', title: 'Your guide, wherever you go.', body: 'Ask for a place, say yes, and walk. Turn-by-turn guidance through your stick and your ears.' },
] as const;

/**
 * Three cards, one continuous story. A single drag-driven track: the artwork moves slower than the
 * cards (parallax) and turns in 3D with the swipe; text staggers in per card. Compositor-only
 * properties (transform, opacity); no animated blur.
 */
export function IntroStory({ onDone, initial = 0 }: { onDone: () => void; initial?: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(360);
  const [index, setIndex] = useState(initial);
  const x = useMotionValue(-initial * 360);
  const reduce = useReducedMotion();

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 360));
    ro.observe(el);
    setW(el.clientWidth || 360);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = animate(x, -index * w, reduce ? { duration: 0 } : { type: 'spring', stiffness: 260, damping: 32, mass: 0.9 });
    return () => c.stop();
  }, [index, w, reduce, x]);

  const go = (i: number) => setIndex(Math.max(0, Math.min(SLIDES.length - 1, i)));
  useBackHandler(index > 0, () => go(index - 1));

  // 0 … 2 as the track moves; drives parallax, the dots and the background.
  const progress = useTransform(x, (v) => -v / Math.max(1, w));
  const bgX = useTransform(progress, [0, 2], ['0%', '-18%']);

  return (
    <div className="relative flex h-full flex-col overflow-hidden" ref={wrap}>
      {/* Atmosphere: one oversized gradient plane, drifting with the story */}
      <motion.div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-[140%]" style={{ x: bgX }}>
        <div className="intro-atmo absolute inset-0" />
      </motion.div>

      <motion.div
        className="relative flex flex-1 touch-pan-y"
        style={{ x, width: w * SLIDES.length }}
        drag={reduce ? false : 'x'}
        dragConstraints={{ left: -w * (SLIDES.length - 1), right: 0 }}
        dragElastic={0.12}
        dragMomentum={false}
        onDragEnd={(_, info) => {
          const shift = info.offset.x + info.velocity.x * 0.2;
          if (shift < -w * 0.18) go(index + 1);
          else if (shift > w * 0.18) go(index - 1);
          else animate(x, -index * w, { type: 'spring', stiffness: 300, damping: 34 });
        }}
      >
        {SLIDES.map((s, i) => (
          <section key={s.eyebrow} className="relative flex h-full shrink-0 flex-col" style={{ width: w }} aria-hidden={i !== index} aria-roledescription="slide" aria-label={`${i + 1} of 3: ${s.title}`}>
            <Art i={i} progress={progress} />
            <SlideText i={i} active={i === index} />
          </section>
        ))}
      </motion.div>

      <div className="relative z-10 px-6 pb-[calc(var(--sab)+20px)]">
        <div className="mb-6 flex justify-center gap-2" aria-hidden>
          {SLIDES.map((_, i) => (
            <Dot key={i} i={i} progress={progress} />
          ))}
        </div>
        <div className="flex gap-3">
          {index < SLIDES.length - 1 && (
            <GlassButton className="h-14 w-1/3 rounded-[20px]" onClick={onDone}>
              Skip
            </GlassButton>
          )}
          <GlassButton variant="teal" className="h-14 flex-1 rounded-[20px] text-[17px] font-bold" onClick={() => (index < SLIDES.length - 1 ? go(index + 1) : onDone())}>
            {index === SLIDES.length - 1 ? 'Get started' : 'Next'}
          </GlassButton>
        </div>
      </div>
    </div>
  );
}

function Dot({ i, progress }: { i: number; progress: MotionValue<number> }) {
  const width = useTransform(progress, [i - 1, i, i + 1], [8, 28, 8], { clamp: true });
  const opacity = useTransform(progress, [i - 1, i, i + 1], [0.3, 1, 0.3], { clamp: true });
  return <motion.span className="h-2 rounded-full bg-teal" style={{ width, opacity }} />;
}

function SlideText({ i, active }: { i: number; active: boolean }) {
  const s = SLIDES[i];
  const item = { hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 240, damping: 26 } } };
  return (
    <motion.div className="relative z-10 px-8 pb-6 text-center" initial="hidden" animate={active ? 'show' : 'hidden'} variants={{ hidden: {}, show: { transition: { staggerChildren: 0.08, delayChildren: 0.12 } } }}>
      <motion.p variants={item} className="mb-3 text-[11px] font-bold tracking-[0.24em] text-teal">
        {s.eyebrow}
      </motion.p>
      <motion.h1 variants={item} className="mb-3 text-[30px] font-extrabold leading-[1.08] tracking-tight text-ink">
        {s.title}
      </motion.h1>
      <motion.p variants={item} className="mx-auto min-h-[72px] max-w-[320px] text-[15.5px] font-medium leading-[1.55] text-ink-2">
        {s.body}
      </motion.p>
    </motion.div>
  );
}

/** Artwork per card. Parallax: it trails the card (0.35×) and turns in 3D while swiped. */
function Art({ i, progress }: { i: number; progress: MotionValue<number> }) {
  const reduce = useReducedMotion();
  const rel = useTransform(progress, (p) => i - p); // 0 when centred, ±1 at the neighbours
  const x = useTransform(rel, (r) => `${r * -35}%`);
  const rotateY = useTransform(rel, [-1, 0, 1], [24, 0, -24]);
  const scale = useTransform(rel, [-1, 0, 1], [0.86, 1, 0.86]);
  const opacity = useTransform(rel, [-1, -0.6, 0, 0.6, 1], [0, 0.6, 1, 0.6, 0]);
  return (
    <div className="relative flex-1" style={{ perspective: 1100 }}>
      <motion.div className="absolute inset-0 flex items-center justify-center" style={{ x, rotateY, scale, opacity, transformStyle: 'preserve-3d' }}>
        {i === 0 && <HeroReveal reduce={!!reduce} />}
        {i === 1 && <RadarField reduce={!!reduce} />}
        {i === 2 && <RouteScene reduce={!!reduce} />}
      </motion.div>
    </div>
  );
}

function HeroReveal({ reduce }: { reduce: boolean }) {
  return (
    <div className="relative grid place-items-center">
      <div className="intro-spotlight absolute h-[420px] w-[420px] rounded-full" aria-hidden />
      <div className="absolute bottom-[-6px] h-6 w-40 rounded-[50%] bg-black/25" style={{ filter: 'blur(6px)' }} aria-hidden />
      <motion.div
        initial={{ opacity: 0, y: 30, scale: 0.92 }}
        animate={reduce ? { opacity: 1, y: 0, scale: 1 } : { opacity: 1, y: [0, -8, 0], scale: 1, rotate: [-2.5, 2.5, -2.5] }}
        transition={reduce ? { duration: 0.4 } : { opacity: { duration: 0.8 }, scale: { duration: 0.9, ease: [0.2, 0.8, 0.2, 1] }, y: { duration: 6, repeat: Infinity, ease: 'easeInOut' }, rotate: { duration: 9, repeat: Infinity, ease: 'easeInOut' } }}
      >
        <StickVisual height={330} pose={{ pitch: 8, roll: 0 }} link="connected" obstacleCm={null} />
      </motion.div>
    </div>
  );
}

function RadarField({ reduce }: { reduce: boolean }) {
  return (
    <div className="relative grid h-[360px] w-[360px] place-items-center">
      {[150, 230, 310].map((d) => (
        <span key={d} className="absolute rounded-full border border-teal/20" style={{ width: d, height: d }} aria-hidden />
      ))}
      {!reduce &&
        [0, 1, 2].map((k) => (
          <motion.span
            key={k}
            className="absolute h-[320px] w-[320px] rounded-full border-2 border-teal/50"
            initial={{ scale: 0.25, opacity: 0.7 }}
            animate={{ scale: 1.15, opacity: 0 }}
            transition={{ duration: 3, repeat: Infinity, delay: k, ease: 'easeOut' }}
            aria-hidden
          />
        ))}
      <span className="absolute h-[300px] w-[300px] rounded-full bg-[conic-gradient(from_200deg,transparent_0deg,var(--teal-soft)_40deg,transparent_80deg)]" aria-hidden />
      <StickVisual height={250} pose={{ pitch: 22, roll: 4 }} link="connected" obstacleCm={70} />
      <SensedChip className="left-2 top-16" label="Person · 2 m" delay={0.4} />
      <SensedChip className="right-0 top-36" label="Step · 1 m" delay={0.9} />
      <SensedChip className="bottom-16 left-6" label="Door · left" delay={1.4} />
    </div>
  );
}

function SensedChip({ className, label, delay }: { className: string; label: string; delay: number }) {
  return (
    <motion.span initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay, duration: 0.5 }} className={cx('glass absolute rounded-full px-3 py-1.5 text-[12px] font-bold text-ink', className)}>
      <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-teal align-middle" aria-hidden />
      {label}
    </motion.span>
  );
}

function RouteScene({ reduce }: { reduce: boolean }) {
  const d = 'M70 330 C 90 250, 230 260, 220 190 S 120 120, 250 50';
  return (
    <div className="relative h-[380px] w-[320px]">
      <svg viewBox="0 0 320 380" className="absolute inset-0 h-full w-full" aria-hidden>
        <path d={d} fill="none" stroke="var(--line)" strokeWidth="18" strokeLinecap="round" />
        <motion.path d={d} fill="none" stroke="var(--teal)" strokeWidth="6" strokeLinecap="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: reduce ? 0 : 1.6, ease: [0.3, 0.7, 0.2, 1] }} />
        {!reduce && <motion.path d={d} fill="none" stroke="var(--on-teal)" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="2 14" animate={{ strokeDashoffset: [0, -32] }} transition={{ duration: 1.1, repeat: Infinity, ease: 'linear' }} />}
      </svg>
      <motion.div className="absolute left-[226px] top-[6px] text-teal" initial={{ y: -24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: reduce ? 0 : 1.3, type: 'spring', stiffness: 300, damping: 14 }}>
        {!reduce && <motion.span className="absolute left-1/2 top-[30px] h-6 w-6 -translate-x-1/2 rounded-full bg-teal/30" animate={{ scale: [1, 2.2], opacity: [0.7, 0] }} transition={{ duration: 1.6, repeat: Infinity }} aria-hidden />}
        <MapPin size={48} fill="currentColor" stroke="var(--on-teal)" strokeWidth={1.5} />
      </motion.div>
      <div className="absolute bottom-0 left-2">
        <StickVisual height={190} pose={{ pitch: -4, roll: -3 }} link="connected" obstacleCm={null} />
      </div>
    </div>
  );
}
