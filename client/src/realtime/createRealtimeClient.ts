import type { AuthUser } from '@/auth/authModel';
import type { AuthService } from '@/auth/authService';
import type { Conversation } from '@/conversations/conversationModel';
import { MockRealtimeClient } from './MockRealtimeClient';
import { SocketIoRealtimeClient } from './SocketIoRealtimeClient';
import { RealtimeOperationError, type RealtimeClient } from './realtimeModel';

/** No fallback: a missing real contract cannot activate a demo connection. */
export function createSessionRealtimeClient(user: AuthUser, authMode: AuthService['mode'], conversations: readonly Conversation[]): RealtimeClient {
  if (authMode === 'demo' && user.isDemo && process.env.NODE_ENV !== 'production') {
    return new MockRealtimeClient({ user, conversations });
  }
  if (authMode !== 'api' || user.isDemo || process.env.NEXT_PUBLIC_REALTIME_CONTRACT_READY !== 'true' || !process.env.NEXT_PUBLIC_REALTIME_URL) {
    throw new RealtimeOperationError('unavailable');
  }
  const client = new SocketIoRealtimeClient({ user, authMode, contractReady: true, url: process.env.NEXT_PUBLIC_REALTIME_URL,
    ...(process.env.NEXT_PUBLIC_REALTIME_PATH ? { path: process.env.NEXT_PUBLIC_REALTIME_PATH } : {}) });
  client.watchConversations(conversations.map((conversation) => conversation.id));
  return client;
}
