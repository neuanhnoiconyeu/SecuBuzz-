'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Minus, Square, Terminal, X } from 'lucide-react';
import { BrandIcon, BrandLogo } from '@/components/branding';
import YahooChatWindow from '@/components/YahooChatWindow';
import { ConversationSidebar } from '@/components/messenger/ConversationSidebar';
import { MainNavigation } from '@/components/messenger/MainNavigation';
import { ProfileDialog } from '@/components/profile/ProfileDialog';
import { FriendsPage } from '@/components/friends/FriendsPage';
import type { MessengerSection } from '@/components/messenger/MainNavigation';
import { Button, Surface } from '@/components/ui';
import { useMessengerConversations } from '@/hooks/useMessengerConversations';
import { useCurrentProfile } from '@/hooks/useCurrentProfile';
import { useFriends } from '@/hooks/useFriends';
import { relationshipForUser, type FriendUser } from '@/friends/friendsModel';
import { existingDirectConversationAdapter } from '@/friends/conversationAdapter';
import type { DemoMessengerSession } from '@/auth/messengerSession';
import type { ConversationMessageActivity } from '@/conversations/conversationModel';
import type { ConversationSecurityStatus } from '@/security/keyManagement';

export interface MessengerAppProps {
  session: DemoMessengerSession;
  onLogout?: () => Promise<boolean>;
  isLoggingOut?: boolean;
  logoutError?: string | null;
}

/** Existing Messenger UI, mounted inside its authenticated session boundary. */
export function MessengerApp({ session, onLogout, isLoggingOut = false, logoutError = null }: MessengerAppProps) {
  const { profile, isLoading: profileLoading, isSaving: profileSaving, error: profileError, fieldErrors,
    loadProfile, updateProfile } = useCurrentProfile(session.profileService);
  const [profileOpen, setProfileOpen] = useState(false);
  const friendsService = session.friendsService;
  const friends = useFriends(friendsService);
  const friendIdentity = useMemo<FriendUser | null>(() => profile ? {
    id: profile.id, username: profile.username, displayName: profile.displayName, avatar: profile.avatar,
  } : null, [profile]);
  useEffect(() => {
    if (friendIdentity) friendsService.updateCurrentUser(friendIdentity);
  }, [friendIdentity, friendsService]);
  const {
    activeConversation,
    activeConversationId,
    conversations,
    drafts,
    isEmpty,
    recordMessageActivity,
    selectConversation,
    setDraft,
  } = useMessengerConversations(session.conversations);
  const [activeSection, setActiveSection] = useState<MessengerSection>('chats');
  useEffect(() => {
    const syncSection = () => {
      if (window.location.hash === '#friends') setActiveSection('friends');
      else if (window.location.hash === '#security') setActiveSection('security');
      else if (window.location.hash === '#chats') setActiveSection('chats');
    };
    syncSection();
    window.addEventListener('hashchange', syncSection);
    return () => window.removeEventListener('hashchange', syncSection);
  }, []);
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const previousMobileListOpen = useRef(false);
  const friendChatFocusPending = useRef(false);
  const [securityStatus, setSecurityStatus] = useState<ConversationSecurityStatus | null>(null);
  const [lastBuzz, setLastBuzz] = useState<string>('');
  const [messageLog, setMessageLog] = useState<string[]>([]);
  const conversationIds = useMemo(() => conversations.map((conversation) => conversation.id), [conversations]);
  const directAdapter = useMemo(() => existingDirectConversationAdapter(conversations, session.user.id), [conversations, session.user.id]);
  const directContact = activeConversation?.type === 'direct'
    ? activeConversation.participants.find((person) => person.id !== session.user.id) : undefined;
  const directRelationship = directContact ? relationshipForUser(friends.snapshot, directContact.id, session.user.id).relationship : null;
  const directBlocked = directRelationship === 'blocked';
  const directControlsDisabled = Boolean(directContact) && (directBlocked || friends.isStale || friends.isLoading);

  const openFriendConversation = async (user: FriendUser) => {
    if (friends.isStale || friends.isPending || relationshipForUser(friends.snapshot, user.id, session.user.id).relationship !== 'friend') {
      throw new Error('Relationship unavailable. Refresh Friends first.');
    }
    const id = await directAdapter.openDirectConversation(user.id);
    if (!selectConversation(id)) throw new Error('Conversation unavailable.');
    friendChatFocusPending.current = true;
    setMobileListOpen(false);
    setActiveSection('chats');
  };

  useEffect(() => {
    if (!friendChatFocusPending.current || activeSection !== 'chats') return;
    // Wait for the selected heading and visible chat section to commit before moving focus.
    const frame = window.requestAnimationFrame(() => {
      friendChatFocusPending.current = false;
      document.querySelector<HTMLHeadingElement>('.chat-title-heading')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeConversationId, activeSection]);

  useEffect(() => {
    if (window.innerWidth <= 680) {
      if (mobileListOpen) {
        const sidebar = document.querySelector('.conversation-sidebar');
        const focusTarget = sidebar?.querySelector<HTMLElement>('.conversation-list-item[aria-current="page"]')
          ?? sidebar?.querySelector<HTMLElement>('.conversation-list-item')
          ?? sidebar?.querySelector<HTMLElement>('.conversation-search-input');
        focusTarget?.focus();
      } else if (previousMobileListOpen.current) {
        document.querySelector<HTMLHeadingElement>('.chat-title-heading')?.focus();
      }
    }
    previousMobileListOpen.current = mobileListOpen;
  }, [mobileListOpen]);

  useEffect(() => {
    if (!mobileListOpen) return;
    const closeMobileListOnDesktop = () => {
      if (window.innerWidth > 680) setMobileListOpen(false);
    };
    window.addEventListener('resize', closeMobileListOnDesktop);
    return () => window.removeEventListener('resize', closeMobileListOnDesktop);
  }, [mobileListOpen]);

  const handleBuzz = useCallback(() => {
    setLastBuzz(`BUZZ triggered at ${new Date().toLocaleTimeString()}`);
  }, []);

  const handleSendMessage = useCallback(() => {
    setMessageLog((previous) => [
      ...previous,
      `[${new Date().toLocaleTimeString()}] Encrypted message accepted by local demo`,
    ]);
  }, []);

  const handleActivity = useCallback((activity: ConversationMessageActivity) => {
    recordMessageActivity(activity);
  }, [recordMessageActivity]);

  const handleSecurityStatusChange = useCallback((status: ConversationSecurityStatus | null) => {
    setSecurityStatus(status);
  }, []);

  const handleSelectConversation = (conversationId: string) => {
    setActiveSection('chats');
    selectConversation(conversationId);
    setMobileListOpen(false);
  };

  const showConversationsOnMobile = () => setMobileListOpen(true);

  return (
    <main className="app-shell">
      <div className="messenger-app">
        <div className="messenger-window-chrome">
          <BrandLogo variant="compact" size="sm" decorative />
          <span className="messenger-window-controls" aria-hidden="true">
            <Minus size={12} /><Square size={10} /><X size={12} />
          </span>
        </div>
        <MainNavigation
          activeSection={activeSection}
          onSelect={setActiveSection}
          profile={profile}
          profileLoading={profileLoading}
          onOpenProfile={() => setProfileOpen(true)}
          pendingRequestCount={friends.isStale ? 0 : friends.snapshot.incomingRequests.length}
        />

        <section id="chats" className="messenger-chat-section" hidden={activeSection !== 'chats'} aria-label="Chats">
          <ConversationSidebar
            conversations={conversations}
            activeConversationId={activeConversationId}
            mobileListOpen={mobileListOpen}
            onSelect={handleSelectConversation}
          />

          <div className={`messenger-main-column ${directContact ? 'has-friend-context' : ''}`}>
            {directContact && <div className="friends-chat-notice">
              <p role="status">{friends.isStale ? 'Friend status unavailable. Messaging is paused until it refreshes.' : directBlocked ? 'Blocked in this local demo' : directRelationship === 'friend' ? 'Friends · local demo' : 'Not friends · local demo'}
                {directBlocked && <span> Chat controls are disabled here. History is preserved; this is not server-enforced blocking.</span>}
              </p>
              <div className="friends-chat-actions">
              {directControlsDisabled && <Button className="friends-chat-browse" variant="outline" size="sm" onClick={() => setMobileListOpen(true)}>Browse chats</Button>}
              <Button variant="ghost" size="sm" onClick={() => setActiveSection('friends')}>Manage friends</Button>
              </div>
            </div>}
            {isEmpty ? (
              <section className="messenger-empty-state" role="status">
                <BrandIcon size="lg" decorative />
                <h1 className="display-heading display-heading--empty">No conversations available</h1>
                <p>Local demo conversations will appear here when available.</p>
              </section>
            ) : activeConversation ? (
              <>
                <fieldset className="friends-chat-scope" disabled={directControlsDisabled} aria-label="Conversation controls">
                <YahooChatWindow
                  conversationId={activeConversation.id}
                  contactName={activeConversation.displayName}
                  conversationType={activeConversation.type}
                  currentUserId={session.user.id}
                  currentUserName={profile?.displayName ?? 'You'}
                  identityReady={Boolean(profile)}
                  cryptoService={session.cryptoService}
                  transport={session.transport}
                  presentationActive={activeSection === 'chats' && !mobileListOpen}
                  {...(activeConversation.avatarUrl ? { avatarUrl: activeConversation.avatarUrl } : {})}
                  {...(activeConversation.presence ? { presenceStatus: activeConversation.presence } : {})}
                  showPresence={Boolean(activeConversation.presence)}
                  conversationIds={conversationIds}
                  draftValue={drafts[activeConversation.id] ?? ''}
                  onDraftChange={(draft) => setDraft(activeConversation.id, draft)}
                  onMessageActivity={handleActivity}
                  onSecurityStatusChange={handleSecurityStatusChange}
                  onBackToConversations={showConversationsOnMobile}
                  onBuzz={handleBuzz}
                  onSendMessage={handleSendMessage}
                />
                </fieldset>

                <details className="debug-console">
                  <summary className="debug-summary">
                    <Terminal size={15} aria-hidden="true" />
                    <span>System log</span>
                    <span className="debug-mode">Local demo</span>
                    <ChevronDown size={14} className="debug-chevron" aria-hidden="true" />
                  </summary>
                  <div className="debug-log" role="region" aria-label="System log" aria-live="polite">
                    <div>&gt; LOCAL DEMO TRANSPORT READY</div>
                    {lastBuzz && <div className="debug-alert">&gt; {lastBuzz}</div>}
                    {messageLog.slice(-3).map((log, index) => (
                      <div key={`${log}-${index}`} className="debug-entry">&gt; {log}</div>
                    ))}
                  </div>
                </details>
              </>
            ) : (
              <section className="messenger-empty-state" role="status">
                <BrandIcon size="lg" decorative />
                <h1 className="display-heading display-heading--empty">Choose a conversation</h1>
                <p>Select one of the local demo conversations to open its chat.</p>
              </section>
            )}
          </div>
        </section>

        <section id="friends" className="messenger-friends-section" hidden={activeSection !== 'friends'} aria-labelledby="friends-page-title">
          <FriendsPage controller={friends} currentUser={friendIdentity}
            onMessage={openFriendConversation} canMessage={directAdapter.canOpenDirectConversation} />
        </section>

        <section className="messenger-security-section" hidden={activeSection !== 'security'} aria-labelledby="security-page-title">
          <div className="security-page-heading">
            <p className="conversation-sidebar-eyebrow">LOCAL CLIENT STATUS</p>
            <h1 id="security-page-title" className="display-heading display-heading--page">Security</h1>
            <p>Security details for the current browser demo.</p>
          </div>
          <Surface className="security-status-panel">
            <h2 className="display-heading display-heading--section">{activeConversation?.displayName ?? 'No active conversation'}</h2>
            <dl>
              <div><dt>Browser cryptography</dt><dd>{securityStatus?.browserCryptoAvailable ? 'Available' : securityStatus ? 'Unavailable' : 'Preparing'}</dd></div>
              <div><dt>Local conversation encryption</dt><dd>{securityStatus?.localEncryptionAvailable ? 'Available' : securityStatus ? 'Unavailable' : 'Preparing'}</dd></div>
              <div><dt>Recipient key</dt><dd>{securityStatus?.recipientKeyAvailable ? 'Available' : 'Unavailable'}</dd></div>
              <div><dt>Authenticated key exchange</dt><dd>{securityStatus?.authenticatedKeyExchangeEstablished ? 'Established' : 'Not established'}</dd></div>
              <div><dt>Multi-user E2EE</dt><dd>Not established</dd></div>
            </dl>
            <p className="security-demo-limitation">
              Demo conversations are local UI examples. Their keys are held in this page&apos;s memory and are not shared with another user.
            </p>
          </Surface>
        </section>
      </div>
      <ProfileDialog
        open={profileOpen}
        onOpenChange={setProfileOpen}
        profile={profile}
        isLoading={profileLoading}
        isSaving={profileSaving}
        error={profileError}
        fieldErrors={fieldErrors}
        onRetry={() => void loadProfile()}
        onSave={updateProfile}
        {...(onLogout ? { onLogout } : {})}
        isLoggingOut={isLoggingOut}
        logoutError={logoutError}
      />
    </main>
  );
}
