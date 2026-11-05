import React from 'react';
import Image from 'next/image';
import { cx } from './utils';
import type { BadgeStatus } from './Badge';

export type AvatarSize = 'sm' | 'md' | 'lg';

export interface AvatarProps {
  name: string;
  src?: string;
  status?: Extract<BadgeStatus, 'online' | 'offline' | 'busy' | 'away'>;
  size?: AvatarSize;
  className?: string;
}

function getInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0] ?? '')
    .join('')
    .toUpperCase();
}

export function Avatar({ className, name, size = 'md', src, status }: AvatarProps) {
  return (
    <span
      className={cx('ui-avatar', `ui-avatar--${size}`, className)}
      role="img"
      aria-label={status ? `${name}, ${status}` : name}
    >
      {src ? <Image src={src} alt="" width={64} height={64} unoptimized className="ui-avatar-image" /> : getInitials(name)}
      {status ? <span aria-hidden="true" className={cx('ui-avatar-presence', `ui-avatar-presence--${status}`)} /> : null}
    </span>
  );
}

export default Avatar;
