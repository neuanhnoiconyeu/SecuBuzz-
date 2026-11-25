import { MessageCircle, ShieldCheck, Sparkles, UserRound, UsersRound } from 'lucide-react';
import { BrandLogo } from '@/components/branding';
import { ProfileAvatar } from '@/components/profile/ProfileAvatar';
import { PRESENCE_OPTIONS } from '@/profiles/profileModel';
import type { UserProfile } from '@/profiles/profileModel';
import type { ReactNode } from 'react';

export type MessengerSection = 'chats' | 'friends' | 'security' | 'ai';

export interface MainNavigationProps {
  activeSection: MessengerSection;
  onSelect(section: MessengerSection): void;
  profile?: UserProfile | null;
  profileLoading?: boolean;
  onOpenProfile?: () => void;
  pendingRequestCount?: number;
  mode?: 'remote' | 'local-demo';
  profileActions?: ReactNode;
}

export function MainNavigation({ activeSection, onSelect, profile, profileLoading = false, onOpenProfile, pendingRequestCount = 0, mode, profileActions }: MainNavigationProps) {
  const presenceLabel = PRESENCE_OPTIONS.find((option) => option.value === profile?.presencePreference)?.label;
  const remote = mode === 'remote' || profile?.isDemo === false;
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
        <button type="button" className={`messenger-navigation-item ${activeSection === 'ai' ? 'is-active' : ''}`}
          aria-label="AI Hub" aria-current={activeSection === 'ai' ? 'page' : undefined} onClick={() => onSelect('ai')}>
          <Sparkles size={19} aria-hidden="true" /><span>AI Hub</span>
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
            aria-label={profile ? `Open profile for ${profile.displayName}; ${presenceLabel} ${remote ? 'saved' : 'local'} preference` : 'Open your profile'}
            aria-haspopup="dialog"
            aria-busy={profileLoading}
            title={remote ? 'Your account profile and saved preferences' : profile ? `${profile.displayName} — ${presenceLabel} (local preference)${profile.statusMessage ? ` · ${profile.statusMessage}` : ''}` : 'Your local demo profile'}
            onClick={onOpenProfile}
          >
            <span className="navigation-profile-avatar">
              {profile ? <ProfileAvatar displayName={profile.displayName} avatar={profile.avatar} avatarUrl={profile.avatarUrl} /> : <UserRound size={24} aria-hidden="true" />}
              {profile && !remote && <span className={`navigation-profile-dot navigation-profile-dot--${profile.presencePreference}`} aria-hidden="true" />}
            </span>
            <span className="navigation-profile-copy">
              <span className="navigation-profile-name">{profile?.displayName ?? 'Profile'}</span>
              <span className="navigation-profile-presence">
                {profileLoading ? 'Loading' : remote ? 'Account profile' : presenceLabel ?? 'Open profile'}
                {!remote && <span className="navigation-profile-local-inline"> · local</span>}
              </span>
              <span className="navigation-profile-local">{remote ? 'Presence unavailable' : 'Local preference'}</span>
            </span>
          </button>
          {profileActions}
        </div>
      ) : <span className="messenger-navigation-caption">Local demo</span>}
    </nav>
  );
}
