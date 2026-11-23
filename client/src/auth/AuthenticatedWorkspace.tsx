'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiRealtimeConnection } from '@/components/messenger/ApiRealtimeConnection';
import { VoiceRoomsWorkspace } from '@/components/voice/VoiceRoomsWorkspace';
import { developmentCallingEnabled } from '@/dev/calling/developmentCalling';
import { DevelopmentCallingTestView } from '@/dev/calling/DevelopmentCallingTestView';
import { AuthLoading } from '@/components/auth/AuthShell';
import { MessengerApp } from '@/components/messenger/MessengerApp';
import { RealMessengerWorkspace } from '@/components/messenger/RealMessengerWorkspace';
import { useAuth } from './AuthProvider';
import { createDemoMessengerSession, type DemoMessengerSession } from './messengerSession';
import type { AuthUser } from './authModel';

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
  // Keep the DATA session and drafts mounted while browsing the separate media workspace.
  // The legacy calling socket must not replace DATA's authenticated v2 messaging transport.
  return <>
    <RealMessengerWorkspace active={!voiceOpen} onOpenVoiceRooms={() => setVoiceOpen(true)} />
    {voiceOpen && <ApiRealtimeConnection user={user} enableDirectCalls={false}><VoiceRoomsWorkspace user={user}
      onClose={() => setVoiceOpen(false)} onLogout={auth.logout}
      isLoggingOut={auth.pending === 'logout'} logoutError={auth.error?.message ?? null} /></ApiRealtimeConnection>}
  </>;
}

export function AuthenticatedWorkspace() {
  const auth = useAuth();
  if (auth.status !== 'authenticated' || !auth.user) return null;
  if (auth.mode === 'demo' && auth.user.isDemo) return <DemoWorkspace key={auth.sessionVersion} user={auth.user} />;
  if (auth.mode !== 'api' || auth.user.isDemo) return null;
  return <ApiWorkspace key={auth.sessionVersion} user={auth.user} />;
}
