'use client';

import { useEffect, useRef, useState } from 'react';
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

export function AuthenticatedWorkspace() {
  const auth = useAuth();
  if (auth.status !== 'authenticated' || !auth.user) return null;
  if (auth.mode === 'demo' && auth.user.isDemo) return <DemoWorkspace key={auth.sessionVersion} user={auth.user} />;
  if (auth.mode !== 'api' || auth.user.isDemo) return null;
  return <RealMessengerWorkspace key={auth.sessionVersion} />;
}
