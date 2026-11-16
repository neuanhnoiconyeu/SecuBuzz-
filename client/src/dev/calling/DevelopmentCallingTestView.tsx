'use client';

import type { AuthUser } from '@/auth/authModel';
import { useAuth } from '@/auth/AuthProvider';
import { ApiRealtimeConnection } from '@/components/messenger/ApiRealtimeConnection';
import { developmentCallingEnabled } from './developmentCalling';
import { DevelopmentCallingWorkspace } from './DevelopmentCallingWorkspace';

/** This boundary owns one authenticated socket/runtime; no demo session enters the real call view. */
export function DevelopmentCallingTestView({ user }: { user: AuthUser }) {
  const auth = useAuth();
  if (!developmentCallingEnabled() || auth.mode !== 'api' || auth.status !== 'authenticated' ||
      user.isDemo !== false || auth.user?.id !== user.id) return null;
  return <ApiRealtimeConnection key={auth.sessionVersion} user={user}><DevelopmentCallingWorkspace user={user} /></ApiRealtimeConnection>;
}
