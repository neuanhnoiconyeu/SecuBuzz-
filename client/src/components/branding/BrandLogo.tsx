import Image from 'next/image';
import { BRAND_ASSETS, BRAND_NAME } from './brandConstants';

export type BrandLogoVariant = 'full' | 'compact' | 'icon';
export type BrandLogoSize = 'sm' | 'md' | 'lg';

const iconSizes: Record<BrandLogoSize, string> = { sm: '20px', md: '48px', lg: '80px' };
const fullSizes: Record<BrandLogoSize, string> = {
  sm: '192px',
  md: '352px',
  lg: '(max-width: 680px) 280px, 416px',
};

export interface BrandLogoProps {
  variant?: BrandLogoVariant;
  size?: BrandLogoSize;
  label?: string;
  decorative?: boolean;
  className?: string;
}

/** The supplied artwork stays intact; compact layouts add a readable text label. */
export function BrandLogo({
  className = '',
  decorative = false,
  label = BRAND_NAME,
  size = 'md',
  variant = 'full',
}: BrandLogoProps) {
  const compact = variant === 'compact';
  const full = variant === 'full';

  return (
    <span
      className={`brand-logo brand-logo--${variant} brand-logo--${size} ${className}`.trim()}
      aria-hidden={decorative || undefined}
      role={compact && !decorative ? 'img' : undefined}
      aria-label={compact && !decorative ? label : undefined}
    >
      <Image
        className="brand-logo-artwork"
        src={full ? BRAND_ASSETS.full : BRAND_ASSETS.icon}
        alt={decorative || compact ? '' : label}
        aria-hidden={decorative || compact || undefined}
        width={full ? 1784 : 1254}
        height={full ? 882 : 1254}
        quality={90}
        sizes={full ? fullSizes[size] : iconSizes[size]}
        loading="eager"
      />
      {compact && (
        <span className="brand-logo-wordmark" aria-hidden="true">
          <span className="brand-logo-name">Yahoo! Security</span>
          <span className="brand-logo-subtitle">Messenger 2.0</span>
        </span>
      )}
    </span>
  );
}
