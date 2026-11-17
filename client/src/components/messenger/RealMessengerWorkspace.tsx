'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Minus, Square, X } from 'lucide-react';
import { BrandLogo } from '@/components/branding';
import { Button } from '@/components/ui';
import { FriendsPage } from '@/components/friends/FriendsPage';
import { ProfileDialog } from '@/components/profile/ProfileDialog';
import { useAuth } from '@/auth/AuthProvider';
import { ApiError, type SessionApi } from '@/api/sessionApi';
import { RemoteProfileService } from '@/profiles/remoteProfileService';
import { RemoteFriendsService } from '@/friends/remoteFriendsService';
import { useCurrentProfile } from '@/hooks/useCurrentProfile';
import { useFriends } from '@/hooks/useFriends';
import { MainNavigation, type MessengerSection } from './MainNavigation';
import { SecureMessagingSession } from '@/security/e2ee/session';
import { SecureConversationPanel } from './SecureConversationPanel';
import { SecureRealtimeWorkspace } from '@/realtime/SecureRealtimeWorkspace';

interface Resources { version: number; api: SessionApi; profiles: RemoteProfileService; friends: RemoteFriendsService; secure: SecureMessagingSession; live?: SecureRealtimeWorkspace }
function sectionFromHash(): MessengerSection {
  const hash = window.location.hash;
  return hash === '#friends' ? 'friends' : hash === '#security' ? 'security' : hash === '#ai-hub' ? 'ai' : 'chats';
}

/** Real sessions have no demo transport, conversations, AI provider or inferred presence. */
export function RealMessengerWorkspace({ onOpenVoiceRooms, active = true }: { onOpenVoiceRooms?: () => void; active?: boolean } = {}) {
  const auth = useAuth();
  const createApi = auth.createSessionApi;
  const actor = useRef(auth.user).current;
  const [resources, setResources] = useState<Resources | null>(null);
  const resourceVersion = useRef(0);
  useEffect(() => {
    if (!actor) return;
    const api = createApi?.() ?? { actor, request: async () => { throw new ApiError('unavailable'); }, dispose() {} };
    const secure = new SecureMessagingSession(api);
    const live = api.realtimeAuth ? new SecureRealtimeWorkspace(secure, window.location.origin) : undefined;
    live?.start();
    setResources({ version: ++resourceVersion.current, api, profiles: new RemoteProfileService(api), friends: new RemoteFriendsService(api), secure, ...(live ? { live } : {}) });
    return () => { live?.dispose(); secure.dispose(); api.dispose(); };
  }, [actor, createApi]);
  return resources ? <ConnectedMessenger key={resources.version} resources={resources} active={active} {...(onOpenVoiceRooms ? { onOpenVoiceRooms } : {})} /> : <p role="status">Opening your workspace…</p>;
}

function ConnectedMessenger({ resources, onOpenVoiceRooms, active }: { resources: Resources; onOpenVoiceRooms?: () => void; active: boolean }) {
  const auth = useAuth();
  const profile = useCurrentProfile(resources.profiles);
  const friends = useFriends(resources.friends);
  const [section, setSection] = useState<MessengerSection>('chats');
  const [profileOpen, setProfileOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setSection(sectionFromHash());
    update(); window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const selectSection = (value: MessengerSection) => {
    setSection(value);
    window.history.replaceState(null, '', value === 'ai' ? '#ai-hub' : `#${value}`);
  };
  const loadPublicProfile = useCallback((id: string, signal: AbortSignal) => resources.friends.getPublicProfile(id, signal), [resources.friends]);
  const account = profile.profile ?? auth.user;
  return <main className="app-shell real-workspace-shell">
    <div className="messenger-app real-messenger">
      <div className="messenger-window-chrome">
        <BrandLogo variant="compact" size="sm" decorative />
        <span className="messenger-window-controls" aria-hidden="true"><Minus size={12} /><Square size={10} /><X size={12} /></span>
      </div>
      <MainNavigation activeSection={section} onSelect={selectSection} mode="remote"
        profile={profile.profile} profileLoading={profile.isLoading} onOpenProfile={() => setProfileOpen(true)}
        pendingRequestCount={friends.snapshot.incomingRequests.length} />
      <section id="chats" className="messenger-chat-section real-chat-section" hidden={section !== 'chats'} aria-labelledby="real-chats-title">
        <SecureConversationPanel session={resources.secure} live={resources.live} active={active && section === 'chats'} selectedId={conversationId} onSelect={setConversationId} displayName={account?.displayName ?? ''}
          onOpenVoiceRooms={onOpenVoiceRooms} onOpenFriends={() => selectSection('friends')} />
      </section>
      <section id="friends" className="messenger-friends-section" hidden={section !== 'friends'} aria-labelledby="friends-page-title">
        <FriendsPage controller={friends} currentUser={account} canMessage={() => true}
          onMessage={async user => { const conversation = await resources.secure.api.createDirect(user.id); setConversationId(conversation.id); selectSection('chats'); }} loadPublicProfile={loadPublicProfile} />
      </section>
      <section id="ai-hub" className="messenger-security-section" hidden={section !== 'ai'} aria-labelledby="real-ai-title">
        <div className="security-page-heading"><h1 id="real-ai-title" className="display-heading display-heading--page">AI Hub</h1>
          <p>AI tools are not connected for this account.</p></div>
      </section>
      <section id="security" className="messenger-security-section" hidden={section !== 'security'} aria-labelledby="real-security-title">
        <div className="security-page-heading"><h1 id="real-security-title" className="display-heading display-heading--page">Security</h1>
          <p>Your account uses server-verified sessions. Profile and friendship changes require a security check.</p>
          <p>Secure device keys persist in this browser. Messages use verified key epochs, authenticated live delivery and encrypted REST history. Server-authenticated keys use trust on first use.</p></div>
      </section>
      <footer className="real-account-footer">
        <span>{account ? `${account.displayName} · @${account.username}` : ''}</span>
        {auth.error && <p role="alert">{auth.error.message}</p>}
        <Button size="sm" variant="outline" loading={auth.pending === 'logout'} disabled={Boolean(auth.pending)} onClick={() => void auth.logout()}>Sign Out</Button>
      </footer>
    </div>
    <ProfileDialog mode="remote" open={profileOpen} onOpenChange={setProfileOpen} profile={profile.profile}
      isLoading={profile.isLoading} isSaving={profile.isSaving} error={profile.error} fieldErrors={profile.fieldErrors}
      onRetry={() => void profile.loadProfile()} onSave={profile.updateProfile} onLogout={auth.logout}
      isLoggingOut={auth.pending === 'logout'} logoutError={auth.error?.message ?? null} />
  </main>;
}
