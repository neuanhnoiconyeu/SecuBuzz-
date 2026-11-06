import { BrandLogo } from './BrandLogo';
import type { BrandLogoProps } from './BrandLogo';

export type BrandIconProps = Omit<BrandLogoProps, 'variant'>;

export function BrandIcon(props: BrandIconProps) {
  return <BrandLogo {...props} variant="icon" />;
}
