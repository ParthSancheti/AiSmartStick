import logoUrl from './logo.png';
import { BRAND } from './brand';

/**
 * THE logo. Every screen uses this component; replace `logo.svg` in this folder
 * to rebrand the whole app (the favicon is set from the same file in main.tsx).
 */
export const BRAND_LOGO_URL = logoUrl;

type Variant = 'icon' | 'full' | 'compact';

export function BrandLogo({ variant = 'full', size = 28, className }: { variant?: Variant; size?: number; className?: string }) {
  const img = <img src={logoUrl} width={size} height={size} alt={variant === 'icon' ? BRAND.name : ''} className={`shrink-0 select-none ${className?.includes('rounded') ? 'rounded-full' : ''}`} draggable={false} />;
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
