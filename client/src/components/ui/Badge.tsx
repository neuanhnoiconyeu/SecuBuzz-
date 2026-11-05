import React from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './utils';

export type BadgeStatus = 'online' | 'offline' | 'busy' | 'away' | 'new' | 'info' | 'success' | 'warning' | 'error';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  status?: BadgeStatus;
  announce?: boolean;
  children: ReactNode;
}

export function Badge({ announce = false, children, className, status = 'info', ...props }: BadgeProps) {
  return (
    <span
      {...props}
      className={cx('ui-badge', `ui-badge--${status}`, className)}
      role={announce ? 'status' : undefined}
      aria-live={announce ? 'polite' : undefined}
    >
      {children}
    </span>
  );
}

export default Badge;
