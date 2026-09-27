import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { motion, type HTMLMotionProps } from 'motion/react';
import { ChevronRight } from 'lucide-react';
import { haptics } from '../core/feedback/haptics';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

export function Glass({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx('glass', className)} {...rest}>
      {children}
    </div>
  );
}

type Variant = 'glass' | 'teal' | 'ink' | 'sos' | 'white' | 'ghost';
type Size = 'sm' | 'md' | 'lg' | 'xl';

const VARIANTS: Record<Variant, string> = {
  glass: 'glass interactive text-ink',
  teal: 'bg-teal text-on-teal shadow-[0_12px_28px_-12px_var(--teal)] [text-shadow:0_1px_1px_rgba(0,0,0,.15)]',
  ink: 'chip-solid',
  sos: 'bg-sos text-white shadow-[0_14px_30px_-12px_var(--sos)]',
  white: 'bg-white text-[#10242a] shadow-[0_10px_24px_-12px_rgba(0,0,0,.4)]',
  ghost: 'text-ink-2 hover:bg-teal-soft',
};
const SIZES: Record<Size, string> = {
  sm: 'h-10 px-4 text-[14px] gap-1.5 rounded-full',
  md: 'h-12 px-5 text-[16px] gap-2 rounded-full',
  lg: 'h-14 px-6 text-[17px] gap-2.5 rounded-[22px]',
  xl: 'h-[68px] px-7 text-[20px] gap-3 rounded-[26px]',
};

export function GlassButton({
  variant = 'glass',
  size = 'md',
  className,
  children,
  haptic = 'tap',
  onPointerDown,
  ...rest
}: HTMLMotionProps<'button'> & { variant?: Variant; size?: Size; haptic?: 'tap' | 'tick' | null }) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.965 }}
      transition={{ type: 'spring', stiffness: 520, damping: 30 }}
      onPointerDown={(e) => {
        if (haptic) haptics.play(haptic);
        onPointerDown?.(e);
      }}
      className={cx(
        'inline-flex select-none items-center justify-center whitespace-nowrap font-semibold tracking-[-0.005em] disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {children}
    </motion.button>
  );
}

export function IconButton({
  label,
  children,
  className,
  onClick,
  size = 44,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  size?: number;
}) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      whileTap={{ scale: 0.92 }}
      onPointerDown={() => haptics.play('tap')}
      onClick={onClick}
      className={cx('glass interactive grid place-items-center rounded-full text-ink', className)}
      style={{ width: size, height: size }}
    >
      {children}
    </motion.button>
  );
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        haptics.play('tick');
        onChange(!on);
      }}
      className={cx(
        'relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors duration-200 disabled:opacity-60',
        on ? 'bg-teal' : 'bg-ink/15',
      )}
    >
      <motion.span
        className="absolute top-[2px] block h-[27px] w-[27px] rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,.25),inset_0_1px_0_#fff]"
        animate={{ left: on ? 22 : 2 }}
        transition={{ type: 'spring', stiffness: 600, damping: 34 }}
      />
    </button>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  size = 'md',
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const id = useId();
  const h = size === 'lg' ? 'h-14 text-[17px]' : size === 'sm' ? 'h-9 text-[13px]' : 'h-11 text-[15px]';
  return (
    <div role="radiogroup" aria-label={label} className="flex w-full rounded-full bg-ink/[0.06] p-1">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => {
              haptics.play('tick');
              onChange(o.value);
            }}
            className={cx('relative flex-1 whitespace-nowrap rounded-full px-2 font-semibold transition-colors', h, active ? 'text-ink' : 'text-ink-3')}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 rounded-full bg-surface shadow-[0_2px_8px_-2px_rgba(0,0,0,.18)]"
                transition={{ type: 'spring', stiffness: 500, damping: 36 }}
              />
            )}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Group({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-6">
      {title && <h3 className="mb-2 px-4 text-[15px] font-semibold text-ink-2">{title}</h3>}
      <Glass className="overflow-hidden rounded-[26px] [&>*+*]:border-t [&>*+*]:border-line">{children}</Glass>
      {footer && <p className="mt-2 px-4 text-[13px] leading-snug text-ink-3">{footer}</p>}
    </section>
  );
}

export function Row({
  icon,
  label,
  detail,
  right,
  onClick,
  tone = 'teal',
}: {
  icon?: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  right?: ReactNode;
  onClick?: () => void;
  tone?: 'teal' | 'amber' | 'sos' | 'ink';
}) {
  const toneCls = {
    teal: 'bg-teal-soft text-teal-ink',
    amber: 'bg-amber-soft text-amber-ink',
    sos: 'bg-sos/15 text-sos',
    ink: 'bg-ink/[0.07] text-ink-2',
  }[tone];
  const inner = (
    <>
      {icon && <span className={cx('grid h-9 w-9 shrink-0 place-items-center rounded-[12px]', toneCls)}>{icon}</span>}
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-[16px] font-medium leading-tight text-ink">{label}</span>
        {detail && <span className="mt-0.5 block text-[13.5px] leading-snug text-ink-3">{detail}</span>}
      </span>
      {right ?? (onClick && <ChevronRight size={18} className="text-ink-3" />)}
    </>
  );
  const cls = 'flex min-h-[60px] w-full items-center gap-3 px-4 py-2.5';
  if (onClick)
    return (
      <button
        type="button"
        className={cx(cls, 'active:bg-teal-soft')}
        onClick={() => {
          haptics.play('tap');
          onClick();
        }}
      >
        {inner}
      </button>
    );
  return <div className={cls}>{inner}</div>;
}

/** Press-and-hold to confirm. Used for "I'm safe" and "Mark resolved" so they can't happen by accident. */
export function HoldButton({
  label,
  holdingLabel = 'Keep holding',
  ms = 1600,
  onComplete,
  className,
  tone = 'white',
}: {
  label: string;
  holdingLabel?: string;
  ms?: number;
  onComplete: () => void;
  className?: string;
  tone?: 'white' | 'glass' | 'teal';
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  const [p, setP] = useState(0);
  const raf = useRef(0);
  const start = useRef(0);
  const done = useRef(false);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const begin = () => {
    done.current = false;
    start.current = performance.now();
    haptics.play('tap');
    const loop = () => {
      const v = Math.min(1, (performance.now() - start.current) / ms);
      setP(v);
      if (v >= 1) {
        done.current = true;
        haptics.play('success');
        onComplete();
        return;
      }
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
  };
  const end = () => {
    cancelAnimationFrame(raf.current);
    if (!done.current) setP(0);
  };
  const toneCls = tone === 'white' ? 'bg-white text-[#10242a]' : tone === 'teal' ? 'bg-teal text-on-teal' : 'glass interactive text-ink';
  return (
    <button
      type="button"
      onPointerDown={begin}
      onPointerUp={end}
      onPointerLeave={end}
      onPointerCancel={end}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onComplete();
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
      className={cx('relative h-16 overflow-hidden rounded-[24px] text-[18px] font-semibold', toneCls, className)}
    >
      <span className="absolute inset-y-0 left-0 bg-teal/25" style={{ width: `${p * 100}%` }} />
      <span className="relative">{p > 0 && p < 1 ? holdingLabel : label}</span>
    </button>
  );
}

export function Sheet({ open, onClose, children, label, className }: { open: boolean; onClose: () => void; children: ReactNode; label: string; className?: string }) {
  return (
    <>
      <motion.div
        className="absolute inset-0 z-40 bg-[#0b1820]/30"
        initial={false}
        animate={{ opacity: open ? 1 : 0 }}
        style={{ pointerEvents: open ? 'auto' : 'none' }}
        onClick={onClose}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        initial={false}
        animate={{ y: open ? 0 : '110%' }}
        transition={{ type: 'spring', stiffness: 380, damping: 38 }}
        className={cx('glass absolute inset-x-2 bottom-2 z-50 max-h-[88%] overflow-y-auto rounded-[34px] p-5 no-scrollbar', className)}
        aria-hidden={!open}
      >
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-ink/20" />
        {children}
      </motion.div>
    </>
  );
}
