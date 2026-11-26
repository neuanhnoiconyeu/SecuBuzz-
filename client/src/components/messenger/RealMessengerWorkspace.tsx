'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { LogOut, Minus, Square, X } from 'lucide-react';
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
import {DirectCallsRuntime, useDirectCalls} from '@/components/calls/DirectCallsRuntime';
import {REAL_ACCOUNT_MESSAGING_CAPABILITIES} from '@/messaging/messagingCapabilities';
import { useRealtimeNotifications } from '@/hooks/useRealtimeNotifications';
import { useConversationBuzz } from '@/hooks/useConversationBuzz';
import { ActivityToast } from './ActivityToast';
import { NotificationSoundProvider, NotificationSoundToggle, useNotificationAudio } from '@/notifications/NotificationSoundProvider';
import { useBrowserTabNotifications } from '@/notifications/useBrowserTabNotifications';

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
  if(!resources)return <p role="status">Opening your workspace…</p>;
  // Hide the conversation workspace, while the single call layer stays visible over Voice Rooms.
  const content=<div hidden={!active}><ConnectedMessenger key={resources.version} resources={resources} active={active} {...(onOpenVoiceRooms ? { onOpenVoiceRooms } : {})}/></div>;
  return <NotificationSoundProvider key={resources.version} accountId={actor?.id ?? resources.api.actor.id}>
    {resources.live&&actor?<DirectCallsRuntime key={resources.version} client={resources.live.transport} user={actor} sessionApi={resources.api} enabled={REAL_ACCOUNT_MESSAGING_CAPABILITIES.directCalls}>{content}</DirectCallsRuntime>:content}
  </NotificationSoundProvider>;
}

function ConnectedMessenger({ resources, onOpenVoiceRooms, active }: { resources: Resources; onOpenVoiceRooms?: () => void; active: boolean }) {
  const auth = useAuth();
  const profile = useCurrentProfile(resources.profiles);
  const friends = useFriends(resources.friends);
  useEffect(() => { void resources.live?.refresh().catch(() => {}); }, [resources.live, friends.snapshot]);
  const [section, setSection] = useState<MessengerSection>('chats');
  const [profileOpen, setProfileOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const audio = useNotificationAudio();
  const onIncomingMessage = useCallback((event: NonNullable<ReturnType<SecureRealtimeWorkspace['getSnapshot']>['incomingMessage']>) => audio?.notify('message', JSON.stringify([event.conversationId, event.id])), [audio]);
  const onIncomingBuzz = useCallback((event: { id: string }) => audio?.notify('buzz', event.id), [audio]);
  const { snapshot, message, dismissMessage } = useRealtimeNotifications(resources.live, resources.api.actor.id, conversationId, active && section === 'chats', onIncomingMessage);
  const calls = useDirectCalls();
  const incomingCall = calls?.signalStatus === 'connected' && !calls.busy && calls.state.phase === 'ringing' &&
    calls.state.call.direction === 'incoming' && calls.state.call.source === 'transport' ? calls.state.call.kind : null;
  useBrowserTabNotifications(snapshot.unread, incomingCall);
  const sendBuzz = useCallback((cid: string) => resources.live!.buzz(cid), [resources.live]);
  const buzz = useConversationBuzz(snapshot.buzz, active && section === 'chats', resources.live ? sendBuzz : undefined, true, onIncomingBuzz);
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
  const accountLabel = account ? `${account.displayName} · @${account.username}` : '';
  return <main className="app-shell real-workspace-shell">
    <div className="messenger-app real-messenger" data-buzz-active={Boolean(buzz.effectConversation)}>
      <div className="messenger-window-chrome">
        <BrandLogo variant="compact" size="sm" decorative />
        <span className="messenger-window-controls" aria-hidden="true"><Minus size={12} /><Square size={10} /><X size={12} /></span>
      </div>
      <MainNavigation activeSection={section} onSelect={selectSection} mode="remote"
        profile={profile.profile} profileLoading={profile.isLoading} onOpenProfile={() => setProfileOpen(true)}
        pendingRequestCount={friends.snapshot.incomingRequests.length} profileActions={<NotificationSoundToggle />} />
      <section id="chats" className="messenger-chat-section real-chat-section" hidden={section !== 'chats'} aria-labelledby="real-chats-title">
        <SecureConversationPanel session={resources.secure} live={resources.live} active={active && section === 'chats'} selectedId={conversationId} onSelect={setConversationId} displayName={account?.displayName ?? ''}
          onOpenVoiceRooms={onOpenVoiceRooms} onOpenFriends={() => selectSection('friends')} buzzController={buzz} />
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
        <span className="real-account-identity" title={accountLabel}>{accountLabel}</span>
        {auth.error && <p role="alert">{auth.error.message}</p>}
        <Button size="sm" variant="ghost" className="real-account-signout" aria-label="Sign out" title="Sign out"
          leadingIcon={<LogOut size={18} aria-hidden="true" />} loading={auth.pending === 'logout'} disabled={Boolean(auth.pending)} onClick={() => void auth.logout()} />
      </footer>
    </div>
    {buzz.notice ? <ActivityToast id={buzz.notice} text={buzz.notice} kind="buzz" onDismiss={buzz.dismiss} />
      : message && <ActivityToast id={JSON.stringify([message.conversationId, message.id])} text={`New message from ${message.senderName}`} kind="message" onDismiss={dismissMessage}
        {...(active ? { onOpen: () => { setConversationId(message.conversationId); selectSection('chats'); } } : {})} />}
    <ProfileDialog mode="remote" open={profileOpen} onOpenChange={setProfileOpen} profile={profile.profile}
      isLoading={profile.isLoading} isSaving={profile.isSaving} error={profile.error} fieldErrors={profile.fieldErrors}
      onRetry={() => void profile.loadProfile()} onSave={profile.updateProfile}
      onUploadAvatar={profile.uploadAvatar} onRemoveAvatar={profile.removeAvatar} onLogout={auth.logout}
      isLoggingOut={auth.pending === 'logout'} logoutError={auth.error?.message ?? null} />
  </main>;
}
