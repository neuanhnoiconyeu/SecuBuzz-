import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { createSessionLiveKitConnection, type LiveKitSnapshot } from './livekitConnection';
import type {SessionApi} from '@/api/sessionApi';

/** Explicit-connect boundary for the future real workspace. No connection is opened on mount. */
export function useLiveKitConnection(purpose: 'voice-room' | 'direct-call' = 'voice-room', getConnectionId?: () => string | null,api?:SessionApi,enabled=true) {
  const { user, mode, sessionVersion, restoreSession } = useAuth();
  const restore = useRef(restoreSession);
  restore.current = restoreSession;
  const connectionId = useRef(getConnectionId); connectionId.current = getConnectionId;
  const [snapshot, setSnapshot] = useState<LiveKitSnapshot>({ status: 'disabled', roomId: null, error: 'disabled' });
  const [service, setService] = useState<ReturnType<typeof createSessionLiveKitConnection> | null>(null);
  const userId = user?.id;
  const initialIdentity = useRef(user);
  initialIdentity.current = user;
  useEffect(() => {
    const revalidate = () => { void restore.current(); };
    const connection = purpose === 'voice-room' ? api ? createSessionLiveKitConnection(initialIdentity.current, mode, revalidate, purpose, undefined, {api,enabled}) : createSessionLiveKitConnection(initialIdentity.current, mode, revalidate)
      : api?createSessionLiveKitConnection(initialIdentity.current, mode, revalidate, purpose, () => connectionId.current?.() ?? null,{api,enabled})
      : createSessionLiveKitConnection(initialIdentity.current, mode, revalidate, purpose, () => connectionId.current?.() ?? null);
    setService(connection); setSnapshot(connection.getSnapshot());
    const unsubscribe = connection.subscribe(setSnapshot);
    return () => { unsubscribe(); void connection.dispose(); };
  }, [mode, userId, sessionVersion, purpose,api,enabled]);
  return { service, snapshot };
}
