import React, { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useBackHandler } from '../core/backStack';

/** 
 * Wraps an entire screen, extending edge-to-edge. 
 * Allows backgrounds/maps to flow under the status/nav bars.
 */
export function AppScreen({ children, className = '' }: { children: ReactNode, className?: string }) {
  return (
    <div className={`relative w-full h-full flex flex-col overflow-hidden ${className}`}>
      {children}
    </div>
  );
}

/**
 * Ensures content does not overlap the status or navigation bars.
 * Use this for main scrollable or interactable content that isn't a floating overlay.
 */
export function SafeAreaContent({ children, className = '', bottomInset = true, ...props }: { children: ReactNode, className?: string; /** false when the content places its own bottom bar on --sab */ bottomInset?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div 
      className={`flex-1 flex flex-col overflow-y-auto no-scrollbar ${className}`}
      style={{
        paddingTop: 'calc(var(--island, var(--sat)) + 14px)',
        paddingBottom: bottomInset ? 'calc(var(--sab) + 16px)' : 0
      }}
      {...props}
    >
      {children}
    </div>
  );
}

/**
 * A floating header that respects the top safe area inset.
 * Usually contains back buttons, titles, etc.
 */
export function FloatingHeader({ children, className = '' }: { children: ReactNode, className?: string }) {
  return (
    <div 
      className={`absolute top-0 left-0 right-0 z-50 pointer-events-none px-4 pb-4 flex flex-col ${className}`}
      style={{ paddingTop: 'calc(var(--island, var(--sat)) + 14px)' }}
    >
      {children}
    </div>
  );
}

/**
 * The canonical screen header: back button, title, optional trailing action. Registering `onBack`
 * also binds the Android back button (core/backStack.ts), so the on-screen and hardware back
 * paths can never disagree. Place it inside SafeAreaContent (which already clears the status bar).
 */
export function ScreenHeader({ title, onBack, trailing, className = '' }: { title?: ReactNode; onBack?: () => void; trailing?: ReactNode; className?: string }) {
  useBackHandler(!!onBack, () => onBack?.());
  return (
    <div className={`relative z-20 flex min-h-12 items-center gap-3 ${className}`}>
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="glass interactive grid h-12 w-12 shrink-0 place-items-center rounded-full text-ink"
        >
          <ChevronLeft size={24} aria-hidden />
        </button>
      ) : (
        <span className="h-12 w-12 shrink-0" aria-hidden />
      )}
      <div className="min-w-0 flex-1 truncate text-center text-[17px] font-bold text-ink">{title}</div>
      <div className="flex h-12 w-12 shrink-0 items-center justify-end">{trailing}</div>
    </div>
  );
}
