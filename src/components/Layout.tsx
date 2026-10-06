import React, { ReactNode } from 'react';

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
export function SafeAreaContent({ children, className = '', ...props }: { children: ReactNode, className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div 
      className={`flex-1 flex flex-col overflow-y-auto no-scrollbar ${className}`}
      style={{
        paddingTop: 'calc(var(--island, env(safe-area-inset-top, 0px)) + 32px)',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)'
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
      style={{ paddingTop: 'calc(var(--island, env(safe-area-inset-top, 0px)) + 32px)' }}
    >
      {children}
    </div>
  );
}
