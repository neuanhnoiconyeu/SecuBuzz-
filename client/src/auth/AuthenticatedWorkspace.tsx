'use client';

import { useEffect, useRef, useState } from 'react';
import { AuthShell, AuthLoading } from '@/components/auth/AuthShell';
import { MessengerApp } from '@/components/messenger/MessengerApp';
import { ProfileAvatar } from '@/components/profile/ProfileAvatar';
import { Button } from '@/components/ui';
import { ApiRealtimeConnection } from '@/components/messenger/ApiRealtimeConnection';
import { VoiceRoomsWorkspace } from '@/components/voice/VoiceRoomsWorkspace';
import { useAuth } from './AuthProvider';
import { createDemoMessengerSession, type DemoMessengerSession } from './messengerSession';
import type { AuthUser } from './authModel';
import { developmentCallingEnabled } from '@/dev/calling/developmentCalling';
import { DevelopmentCallingTestView } from '@/dev/calling/DevelopmentCallingTestView';

function DemoWorkspace({ user }: { user: AuthUser }) {
  const auth = useAuth();
  const initialUser = useRef(user).current;
  const [session, setSession] = useState<DemoMessengerSession | null>(null);
  useEffect(() => {
    const resources = createDemoMessengerSession(initialUser);
    setSession(resources);
    return () => resources.dispose();
  }, [initialUser]);
  if (!session) return <AuthLoading message="Opening your demo workspace…" />;
  return <MessengerApp session={session} onLogout={auth.logout} isLoggingOut={auth.pending === 'logout'}
    logoutError={auth.error?.message ?? null} />;
}

function ApiWorkspace({ user }: { user: AuthUser }) {
  const auth = useAuth();
  const [voiceOpen, setVoiceOpen] = useState(false);
  if (developmentCallingEnabled()) return <DevelopmentCallingTestView user={user} />;
  return <ApiRealtimeConnection key={auth.sessionVersion} user={user}>{voiceOpen ? <VoiceRoomsWorkspace user={user} onClose={() => setVoiceOpen(false)} onLogout={auth.logout}
    isLoggingOut={auth.pending === 'logout'} logoutError={auth.error?.message ?? null} /> : <ApiAccountCard user={user} onVoice={() => setVoiceOpen(true)} />}</ApiRealtimeConnection>;
}
function ApiAccountCard({ user, onVoice }: { user: AuthUser; onVoice(): void }) {
  const auth = useAuth();
  // A real account must never be silently connected to fictional users or conversations.
  return <AuthShell><section className="auth-card" aria-labelledby="connected-workspace-title">
    <ProfileAvatar displayName={user.displayName} avatar={user.avatar} size="lg" />
    <h1 id="connected-workspace-title" className="auth-heading display-heading">You&apos;re signed in.</h1>
    <p className="auth-description">{user.displayName} · @{user.username}</p>
    <p className="auth-feedback">Messenger services are not connected yet. Your account is signed in; profile, friends,
      and conversation APIs must be integrated before your real data can appear.</p>
    {auth.error && <p className="auth-feedback auth-feedback--error" role="alert">{auth.error.message}</p>}
    <Button variant="primary" onClick={onVoice}>Open Voice Rooms</Button>
    <Button loading={auth.pending === 'logout'} disabled={Boolean(auth.pending)} onClick={() => void auth.logout()}>Sign Out</Button>
  </section></AuthShell>;
}

export function AuthenticatedWorkspace() {
  const auth = useAuth();
  if (auth.status !== 'authenticated' || !auth.user) return null;
  if (auth.mode === 'demo' && auth.user.isDemo) return <DemoWorkspace key={auth.sessionVersion} user={auth.user} />;
  return <ApiWorkspace key={auth.sessionVersion} user={auth.user} />;
}
