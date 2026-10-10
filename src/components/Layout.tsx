import React, { useCallback, useRef, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft } from 'lucide-react';
import { useBackHandler } from '../core/backStack';
import { Atmosphere } from './Atmosphere';

/**
 * Screen layout rules (every page and sub-page):
 *  - the header (back + title) is FIXED: it is outside the scroll container and never scrolls;
 *  - exactly ONE scroll container per page (`.page-scroll`: overscroll-behavior contain, no
 *    scroll-linked JS except a one-bit "scrolled" flag for the header edge);
 *  - safe areas come from --sat / --sab (styles.css), never env() directly;
 *  - side gutter 16px (px-4) on sub-pages, 20px (px-5) on Home.
 */

/** Wraps an entire screen, extending edge-to-edge. */
export function AppScreen({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`relative flex h-full w-full flex-col overflow-hidden ${className}`}>{children}</div>;
}

/**
 * The scrolling body of a screen (`style` passed by the caller replaces the inset padding). Clears the status bar itself when the screen has no fixed
 * header above it (`topInset`, default true); pass topInset={false} when a PageHeader sits above.
 */
export function SafeAreaContent({
  children,
  className = '',
  bottomInset = true,
  topInset = true,
  ...props
}: {
  children: ReactNode;
  className?: string;
  /** false when the content places its own bottom bar on --sab */
  bottomInset?: boolean;
  /** false when a fixed PageHeader above already clears the status bar */
  topInset?: boolean;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`page-scroll flex min-h-0 flex-1 flex-col ${className}`}
      style={{
        paddingTop: topInset ? 'calc(var(--island, var(--sat)) + 14px)' : undefined,
        paddingBottom: bottomInset ? 'calc(var(--sab) + 16px)' : 0,
      }}
      {...props}
    >
      {children}
    </div>
  );
}

/** A floating header that respects the top safe area inset (map screens). */
export function FloatingHeader({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`pointer-events-none absolute left-0 right-0 top-0 z-50 flex flex-col px-4 pb-4 ${className}`} style={{ paddingTop: 'calc(var(--island, var(--sat)) + 14px)' }}>
      {children}
    </div>
  );
}

/** Round 48 px back button used by every header. */
export function BackButton({ onClick, label = 'Back', className = '' }: { onClick: () => void; label?: string; className?: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className={`glass interactive grid h-12 w-12 shrink-0 place-items-center rounded-full text-ink ${className}`}>
      <ChevronLeft size={24} aria-hidden />
    </button>
  );
}

/**
 * The canonical centred header (onboarding, stick setup): back button, title, optional trailing
 * action. Registering `onBack` also binds the Android back button (core/backStack.ts).
 */
export function ScreenHeader({ title, onBack, trailing, className = '' }: { title?: ReactNode; onBack?: () => void; trailing?: ReactNode; className?: string }) {
  useBackHandler(!!onBack, () => onBack?.());
  return (
    <div className={`relative z-20 flex min-h-12 items-center gap-3 ${className}`}>
      {onBack ? <BackButton onClick={onBack} /> : <span className="h-12 w-12 shrink-0" aria-hidden />}
      <div className="min-w-0 flex-1 truncate text-center text-[17px] font-bold text-ink">{title}</div>
      <div className="flex h-12 w-12 shrink-0 items-center justify-end">{trailing}</div>
    </div>
  );
}

/**
 * Fixed page header: back button, left-aligned title, optional trailing control. It sits OUTSIDE
 * the scroll container, clears the status bar (--sat) and shows a soft edge once the content
 * below has scrolled (data-scrolled, set by SubPage). Does not register the back button itself
 * (SubPage does); pass `registerBack` when used on its own.
 */
export function PageHeader({
  title,
  onBack,
  trailing,
  className = '',
  registerBack = false,
  headerRef,
}: {
  title: ReactNode;
  onBack?: () => void;
  trailing?: ReactNode;
  className?: string;
  registerBack?: boolean;
  headerRef?: React.Ref<HTMLElement>;
}) {
  useBackHandler(registerBack && !!onBack, () => onBack?.());
  return (
    <header ref={headerRef} className={`page-header shrink-0 px-4 pb-3 ${className}`} style={{ paddingTop: 'calc(var(--island, var(--sat)) + 10px)' }}>
      <div className="flex min-h-12 items-center gap-3">
        {onBack && <BackButton onClick={onBack} />}
        <h1 className="min-w-0 flex-1 truncate text-[22px] font-bold tracking-[-0.01em] text-ink">{title}</h1>
        {trailing && <div className="flex shrink-0 items-center gap-2">{trailing}</div>}
      </div>
    </header>
  );
}

type Enter = 'right' | 'up' | 'fade';
const ENTER: Record<Enter, { initial: Record<string, string | number>; exit: Record<string, string | number> }> = {
  right: { initial: { opacity: 1, transform: 'translate3d(100%,0,0)' }, exit: { opacity: 1, transform: 'translate3d(100%,0,0)' } },
  up: { initial: { opacity: 0, transform: 'translate3d(0,28px,0)' }, exit: { opacity: 0, transform: 'translate3d(0,20px,0)' } },
  fade: { initial: { opacity: 0, transform: 'translate3d(0,0,0)' }, exit: { opacity: 0, transform: 'translate3d(0,0,0)' } },
};

export interface SubPageProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Accessible name when `title` is not plain text. */
  label?: string;
  trailing?: ReactNode;
  children: ReactNode;
  /** Pinned below the scroll area (composer, primary action). Clears --sab itself. */
  footer?: ReactNode;
  /** CSS z-index of the page layer. */
  z?: number;
  enter?: Enter;
  /**
   * 'still': opaque page with a non-animated copy of the ambient background (default; safe anywhere).
   * 'none': transparent - the live background of the screen below shows through (the screen below
   * must hide its own content, as UserHome does).
   * 'custom': caller provides the background through `className`.
   */
  background?: 'still' | 'none' | 'custom';
  className?: string;
  /** Classes of the scroll container (padding, gap). Default: px-4 pt-2 flex column gap-5. */
  contentClassName?: string;
  /** false for pages that must not scroll as a whole (maps). */
  scroll?: boolean;
}

/**
 * A full-screen sub-page: fixed PageHeader + ONE scroll container (+ optional pinned footer).
 * Opening and closing animate only transform/opacity (compositor-only, smooth on Android WebView),
 * never clip-path or blur. The hardware back button closes it. Children are only mounted while
 * open, so put hooks that subscribe to live data inside a child component, not in the caller.
 */
export function SubPage(props: SubPageProps) {
  const { open, ...rest } = props;
  return <AnimatePresence>{open && <SubPageView key="subpage" {...rest} />}</AnimatePresence>;
}

/**
 * The page itself, without its own AnimatePresence: for pages that switch views inside one open
 * state (render it inside the caller's AnimatePresence, as UserHome's chat does).
 */
export function SubPageView({ onClose, title, label, trailing, children, footer, z = 50, enter = 'up', background = 'still', className = '', contentClassName, scroll = true }: Omit<SubPageProps, 'open'>) {
  useBackHandler(true, onClose);
  const header = useRef<HTMLElement | null>(null);
  const scrolled = useRef(false);
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const s = e.currentTarget.scrollTop > 4;
    if (s === scrolled.current) return;
    scrolled.current = s;
    header.current?.setAttribute('data-scrolled', String(s));
  }, []);
  const anim = ENTER[enter];
  const bg = background === 'still' ? 'bg-bg' : '';
  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={label ?? (typeof title === 'string' ? title : undefined)}
      initial={anim.initial}
      animate={{ opacity: 1, transform: 'translate3d(0,0,0)' }}
      exit={anim.exit}
      transition={{ duration: enter === 'right' ? 0.26 : 0.2, ease: [0.2, 0.8, 0.2, 1] }}
      className={`absolute inset-0 flex flex-col overflow-hidden ${bg} ${className}`}
      style={{ zIndex: z }}
    >
      {background === 'still' && <Atmosphere still />}
      <PageHeader title={title} onBack={onClose} trailing={trailing} headerRef={header} className="relative z-20" />
      {scroll ? (
        <div className="page-scroll relative z-10 min-h-0 flex-1" onScroll={onScroll} style={{ paddingBottom: footer ? 16 : 'calc(var(--sab) + 24px)' }}>
          <div className={contentClassName ?? 'flex flex-col gap-5 px-4 pt-2'}>{children}</div>
        </div>
      ) : (
        <div className={`relative z-10 min-h-0 flex-1 ${contentClassName ?? ''}`}>{children}</div>
      )}
      {footer && (
        <div className="relative z-20 shrink-0 px-4 pt-2" style={{ paddingBottom: 'calc(var(--sab) + 12px)' }}>
          {footer}
        </div>
      )}
    </motion.div>
  );
}
