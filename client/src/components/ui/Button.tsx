import React, { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './utils';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'retro';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  retro?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    className,
    disabled,
    leadingIcon,
    loading = false,
    retro = false,
    size = 'md',
    trailingIcon,
    type = 'button',
    variant = 'primary',
    ...props
  },
  ref
) {
  const useRetroStyle = retro || variant === 'retro';
  const retroTone = variant === 'danger' ? 'is-error' : 'is-primary';
  const classes = useRetroStyle
    ? cx('nes-btn', retroTone, 'ui-button-retro', `ui-button-size-${size}`, className)
    : cx('ui-button', `ui-button--${variant}`, `ui-button--${size}`, className);

  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="ui-button-spinner" aria-hidden="true" /> : leadingIcon}
      <span>{children}</span>
      {!loading && trailingIcon}
    </button>
  );
});

Button.displayName = 'Button';

export default Button;
