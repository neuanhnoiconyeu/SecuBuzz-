import { MessageCircle, ShieldCheck, UserRound, UsersRound } from 'lucide-react';
import { BrandLogo } from '@/components/branding';
import { ProfileAvatar } from '@/components/profile/ProfileAvatar';
import { PRESENCE_OPTIONS } from '@/profiles/profileModel';
import type { UserProfile } from '@/profiles/profileModel';

export type MessengerSection = 'chats' | 'friends' | 'security';

export interface MainNavigationProps {
  activeSection: MessengerSection;
  onSelect(section: MessengerSection): void;
  profile?: UserProfile | null;
  profileLoading?: boolean;
  onOpenProfile?: () => void;
  pendingRequestCount?: number;
}

export function MainNavigation({ activeSection, onSelect, profile, profileLoading = false, onOpenProfile, pendingRequestCount = 0 }: MainNavigationProps) {
  const presenceLabel = PRESENCE_OPTIONS.find((option) => option.value === profile?.presencePreference)?.label;
  return (
    <nav className="messenger-navigation" aria-label="Main navigation">
      <a className="messenger-navigation-brand" href="#chats" aria-label="Yahoo Security Messenger home" onClick={() => onSelect('chats')}>
        <BrandLogo variant="compact" size="md" decorative />
      </a>
      <div className="messenger-navigation-tabs">
        <button
          type="button"
          className={`messenger-navigation-item ${activeSection === 'chats' ? 'is-active' : ''}`}
          aria-current={activeSection === 'chats' ? 'page' : undefined}
          onClick={() => onSelect('chats')}
        >
          <MessageCircle size={19} aria-hidden="true" />
          <span>Chats</span>
        </button>
        <button
          type="button"
          className={`messenger-navigation-item ${activeSection === 'friends' ? 'is-active' : ''}`}
          aria-current={activeSection === 'friends' ? 'page' : undefined}
          aria-label={pendingRequestCount > 0 ? `Friends, ${pendingRequestCount} incoming request${pendingRequestCount === 1 ? '' : 's'}` : 'Friends'}
          onClick={() => onSelect('friends')}
        >
          <UsersRound size={19} aria-hidden="true" />
          <span>Friends</span>
          {pendingRequestCount > 0 && <sup className="friends-navigation-count" aria-hidden="true">{pendingRequestCount}</sup>}
        </button>
        <button
          type="button"
          className={`messenger-navigation-item ${activeSection === 'security' ? 'is-active' : ''}`}
          aria-current={activeSection === 'security' ? 'page' : undefined}
          onClick={() => onSelect('security')}
        >
          <ShieldCheck size={19} aria-hidden="true" />
          <span>Security</span>
        </button>
      </div>
      {onOpenProfile ? (
        <div className="messenger-navigation-profile">
          <button
            type="button"
            className="navigation-profile-button"
            aria-label={profile ? `Open profile for ${profile.displayName}; ${presenceLabel} local preference` : 'Open your profile'}
            aria-haspopup="dialog"
            aria-busy={profileLoading}
            title={profile ? `${profile.displayName} — ${presenceLabel} (local preference)${profile.statusMessage ? ` · ${profile.statusMessage}` : ''}` : 'Your local demo profile'}
            onClick={onOpenProfile}
          >
            <span className="navigation-profile-avatar">
              {profile ? <ProfileAvatar displayName={profile.displayName} avatar={profile.avatar} /> : <UserRound size={24} aria-hidden="true" />}
              {profile && <span className={`navigation-profile-dot navigation-profile-dot--${profile.presencePreference}`} aria-hidden="true" />}
            </span>
            <span className="navigation-profile-copy">
              <span className="navigation-profile-name">{profile?.displayName ?? 'Profile'}</span>
              <span className="navigation-profile-presence">
                {profileLoading ? 'Loading' : presenceLabel ?? 'Open profile'}
                <span className="navigation-profile-local-inline"> · local</span>
              </span>
              <span className="navigation-profile-local">Local preference</span>
            </span>
          </button>
        </div>
      ) : <span className="messenger-navigation-caption">Local demo</span>}
    </nav>
  );
}
