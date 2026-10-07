import { useMemo } from 'react';

/**
 * The one ambient background for every screen (intro, setup, Home, sub-pages, Settings).
 *
 * Soft light fields drift in slow motion. Production constraints:
 *  - no CSS blur filters (they are expensive on Android WebView): the softness is in the
 *    radial gradients themselves, and only transform/opacity animate (compositor only);
 *  - every instance is phase-locked to the wall clock, so a sub-page that mounts its own copy
 *    shows exactly the same frame as the page underneath — the background never jumps;
 *  - reduced motion: static.
 */
const FIELDS = [
  { cls: 'atmo-field atmo-a', dur: 46 },
  { cls: 'atmo-field atmo-b', dur: 58 },
  { cls: 'atmo-field atmo-c', dur: 71 },
  { cls: 'atmo-field atmo-d', dur: 64 },
] as const;

export function Atmosphere({ variant = 'user' }: { variant?: 'guardian' | 'user' | 'calm' }) {
  // Same delay for every instance mounted at the same moment of the cycle → identical frames.
  const delays = useMemo(() => {
    const t = Date.now() / 1000;
    return FIELDS.map((f) => `${-(t % f.dur).toFixed(2)}s`);
  }, []);
  return (
    <div className="atmo-root" data-variant={variant} aria-hidden>
      {FIELDS.map((f, i) => (
        <span key={f.cls} className={f.cls} style={{ animationDuration: `${f.dur}s`, animationDelay: delays[i] }} />
      ))}
    </div>
  );
}
