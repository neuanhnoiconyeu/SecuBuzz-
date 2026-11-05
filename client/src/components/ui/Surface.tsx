import React, { forwardRef } from 'react';
import type { HTMLAttributes } from 'react';
import { cx } from './utils';

export type SurfaceVariant = 'default' | 'elevated' | 'retro';

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  variant?: SurfaceVariant;
}

export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  { className, variant = 'default', ...props },
  ref
) {
  const retroClass = variant === 'retro' ? 'nes-container is-rounded' : '';
  return (
    <div
      {...props}
      ref={ref}
      className={cx('ui-surface', `ui-surface--${variant}`, retroClass, className)}
    />
  );
});

Surface.displayName = 'Surface';

export default Surface;
