import { BrandLogo } from '../core/brand/BrandLogo';

/** Kept for existing imports; both delegate to the single BrandLogo. */
export const LogoMark = ({ size = 28 }: { size?: number }) => <BrandLogo variant="icon" size={size} />;
export const Wordmark = ({ size = 18 }: { size?: number }) => <BrandLogo variant="full" size={size + 10} />;
