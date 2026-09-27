import { useRuntime } from '../core/runtime/mode';

/** Always visible in demo mode so simulated data can never be mistaken for real data. */
export function ModeBadge({ className = '' }: { className?: string }) {
  const mode = useRuntime((s) => s.mode);
  if (mode !== 'demo') return null;
  return (
    <span className={`inline-flex items-center rounded-full bg-amber-soft px-2 py-0.5 text-[11px] font-extrabold uppercase tracking-wider text-amber-ink ${className}`} role="status" aria-label="Demo mode: simulated data">
      Demo
    </span>
  );
}
