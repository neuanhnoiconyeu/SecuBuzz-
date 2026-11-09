import type { AuthUser } from './authModel';
import type { Conversation } from '@/conversations/conversationModel';
import { createDemoConversations } from '@/conversations/demoConversations';
import { LocalDemoFriendsService } from '@/friends/friendsService';
import { createLocalDemoTransport } from '@/messaging/localDemoTransport';
import type { MessagingTransport } from '@/messaging/transport';
import { createDemoProfile } from '@/profiles/profileModel';
import { LocalDemoProfileService, type ProfileService } from '@/profiles/profileService';
import {
  BrowserConversationCryptoService,
  type ConversationCryptoService,
} from '@/security/conversationCryptoService';
import { InMemoryDemoKeyManager, type ConversationKeyContext } from '@/security/keyManagement';

export interface DemoMessengerSession {
  user: AuthUser;
  profileService: ProfileService;
  friendsService: LocalDemoFriendsService;
  conversations: Conversation[];
  cryptoService: ConversationCryptoService;
  transport: MessagingTransport;
  dispose(): void;
}

export class DemoMessengerSessionError extends Error {
  constructor(public readonly code: 'demo_unavailable' | 'session_ended' | 'identity_mismatch') {
    super(code === 'demo_unavailable' ? 'The local messenger demo is unavailable for this session.' :
      code === 'identity_mismatch' ? 'This operation does not belong to the current demo identity.' :
        'This local demo session has ended.');
    this.name = 'DemoMessengerSessionError';
  }
}

/**
 * A development-only presentation bundle. It grants no API authorization and
 * never supplies fictional data to a real authenticated user. Mount a fresh
 * bundle for each auth session; do not retain it across logout or identity replacement.
 */
export function createDemoMessengerSession(user: AuthUser): DemoMessengerSession {
  if (process.env.NODE_ENV === 'production' || user.isDemo !== true) {
    throw new DemoMessengerSessionError('demo_unavailable');
  }
  const identity = Object.freeze({ ...user });
  const profileService = new LocalDemoProfileService({ ...createDemoProfile(), ...identity });
  const friendsService = new LocalDemoFriendsService(identity);
  const conversations = createDemoConversations(Date.now(), identity);
  const transport = createLocalDemoTransport();
  let delegate: ConversationCryptoService | null =
    new BrowserConversationCryptoService(new InMemoryDemoKeyManager());

  const activeDelegate = (context: ConversationKeyContext): ConversationCryptoService => {
    if (!delegate) throw new DemoMessengerSessionError('session_ended');
    if (context.localUserId !== identity.id) throw new DemoMessengerSessionError('identity_mismatch');
    return delegate;
  };
  const guarded = async <T,>(context: ConversationKeyContext, operation: (active: ConversationCryptoService) => Promise<T>): Promise<T> => {
    const active = activeDelegate(context);
    const result = await operation(active);
    // An outstanding operation may finish after logout. Discard its result so
    // old plaintext/ciphertext cannot enter a later session's UI or transport.
    if (delegate !== active) throw new DemoMessengerSessionError('session_ended');
    return result;
  };
  const cryptoService: ConversationCryptoService = {
    prepareConversation: (context) => guarded(context, (active) => active.prepareConversation(context)),
    encrypt: (context, plaintext, message) => guarded(context, (active) => active.encrypt(context, plaintext, message)),
    decrypt: (context, payload, message) => guarded(context, (active) => active.decrypt(context, payload, message)),
  };

  return {
    user: identity,
    profileService,
    friendsService,
    conversations,
    cryptoService,
    transport,
    dispose() {
      // Release this bundle's only long-lived key-manager reference. Pending
      // Web Crypto promises finish privately and fail the guard above.
      delegate = null;
      transport.dispose();
    },
  };
}
