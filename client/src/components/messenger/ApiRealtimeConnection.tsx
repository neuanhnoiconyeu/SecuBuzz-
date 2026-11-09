'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import type { AuthUser } from '@/auth/authModel';
import { createSessionRealtimeClient } from '@/realtime/createRealtimeClient';
import type { RealtimeClient, RealtimeConnectionStatus } from '@/realtime/realtimeModel';
import { RealtimeStatus } from './RealtimeStatus';

/** Real connections require a configured cookie-session contract, not a demo identity. */
export function ApiRealtimeConnection({ user }: { user: AuthUser }) {
  const { restoreSession } = useAuth();
  const revalidate = useRef(restoreSession);
  revalidate.current = restoreSession;
  const initialUser = useRef(user).current;
  const [status, setStatus] = useState<RealtimeConnectionStatus>('disconnected');
  useEffect(() => {
    let active = true;
    let client: RealtimeClient;
    try { client = createSessionRealtimeClient(initialUser, 'api', []); }
    catch { setStatus('error'); return; }
    const unsubscribe = client.subscribe((event) => {
      if (!active) return;
      if (event.type === 'connection') setStatus(event.status);
      if (event.type === 'error' && event.code === 'authentication_rejected') void revalidate.current();
    });
    void client.connect().catch(() => { if (active) setStatus(client.getStatus()); });
    return () => { active = false; unsubscribe(); client.dispose(); };
  }, [initialUser]);
  return <RealtimeStatus status={status} />;
}
