import { Cat, Rocket, Smile, Star } from 'lucide-react';
import { Avatar } from '@/components/ui';
import type { AvatarSize } from '@/components/ui';
import { PROFILE_AVATARS } from '@/profiles/profileModel';
import type { ProfileAvatarId } from '@/profiles/profileModel';

export interface ProfileAvatarProps {
  displayName: string;
  avatar: ProfileAvatarId;
  avatarUrl?: string | null | undefined;
  size?: AvatarSize;
  className?: string;
}

const presetIcons = { smile: Smile, star: Star, rocket: Rocket, cat: Cat };

/** Approved local presets or authenticated account avatar images; never fetches external URLs. */
export function ProfileAvatar({ avatar, avatarUrl, className = '', displayName, size = 'md' }: ProfileAvatarProps) {
  const classes = `profile-avatar profile-avatar--${avatar} ${className}`.trim();
  if (avatarUrl) return <Avatar name={displayName} src={avatarUrl} size={size} className={classes} />;
  if (avatar === 'initials') return <Avatar name={displayName} size={size} className={classes} />;

  const Icon = presetIcons[avatar];
  const presetLabel = PROFILE_AVATARS.find((preset) => preset.id === avatar)?.label ?? 'Preset';
  return (
    <span
      className={`ui-avatar ui-avatar--${size} ${classes}`}
      role="img"
      aria-label={`${displayName}, ${presetLabel} avatar`}
    >
      <Icon size={size === 'lg' ? 32 : size === 'sm' ? 18 : 24} aria-hidden="true" />
    </span>
  );
}
