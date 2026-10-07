import logoUrl from './logo.png';
import roundLogoUrl from './logo-round.png';
import { BRAND } from './brand';

/**
 * THE logo. Every screen uses this component; replace `logo.png` in this folder and run
 * `node scripts/generate-icons.mjs` to rebrand the whole app (Android launcher icons and
 * `logo-round.png` are generated from it; the favicon is set from the same file in main.tsx).
 */
export const BRAND_LOGO_URL = logoUrl;
export const BRAND_ROUND_LOGO_URL = roundLogoUrl;

type Variant = 'icon' | 'full' | 'compact' | 'round';

export function BrandLogo({ variant = 'full', size = 28, className }: { variant?: Variant; size?: number; className?: string }) {
  if (variant === 'round') {
    // Small pre-rendered circle (192 px, ~50 KB) instead of decoding the 1254 px badge for a 44 px icon.
    return (
      <span
        className={`inline-grid shrink-0 place-items-center overflow-hidden rounded-full bg-[#072129] shadow-[0_4px_12px_-4px_rgba(0,0,0,.35)] ring-1 ring-black/5 ${className ?? ''}`}
        style={{ width: size, height: size }}
      >
        <img src={roundLogoUrl} width={size} height={size} alt={BRAND.name} className="block h-full w-full select-none" draggable={false} decoding="async" />
      </span>
    );
  }
  const img = <img src={logoUrl} width={size} height={size} alt={variant === 'icon' ? BRAND.name : ''} className={`shrink-0 select-none ${className?.includes('rounded') ? 'rounded-full' : ''}`} draggable={false} decoding="async" />;
  if (variant === 'icon') return <span className={`inline-flex items-center justify-center shrink-0 ${className ?? ''}`}>{img}</span>;
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      {img}
      <span className="font-bold tracking-[-0.01em] text-ink" style={{ fontSize: variant === 'compact' ? size * 0.55 : size * 0.62 }}>
        {BRAND.name}
      </span>
    </span>
  );
}
