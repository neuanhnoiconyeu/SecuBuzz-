import type { ChatMessage } from './messageModel';
import type { MessagingTransport, MessagingTransportHandlers } from './transport';
import { SECUREBOT_CONVERSATION_ID } from '@/conversations/demoConversations';

export interface LocalDemoMessagingTransport extends MessagingTransport {
  dispose(): void;
}

export class DemoTransportDisposedError extends Error {
  constructor() {
    super('This local demo session has ended.');
    this.name = 'DemoTransportDisposedError';
  }
}

/**
 * Local-only transport boundary. It resolves locally to exercise message
 * state transitions; it contacts no service and persists no data.
 */
export function createLocalDemoTransport(): LocalDemoMessagingTransport {
  const conversationListeners = new Map<string, Set<MessagingTransportHandlers>>();
  let mockMessageSequence = 0;
  let disposed = false;
  const assertActive = () => { if (disposed) throw new DemoTransportDisposedError(); };

  return {
    mode: 'local-demo',
    async connect() {
      assertActive();
      // There is no remote connection in the local demo.
    },
    async sendMessage(outbound) {
      assertActive();
      if (outbound.conversationId !== SECUREBOT_CONVERSATION_ID) return;
      // Emit a fixed, explicitly labeled mock response. No content is decrypted or sent to an AI service.
      const listeners = conversationListeners.get(outbound.conversationId);
      if (!listeners?.size) return;

      mockMessageSequence += 1;
      const reply: ChatMessage & { demoOnly: true } = {
        id: `securebot-demo-reply-${mockMessageSequence}`,
        conversationId: outbound.conversationId,
        senderId: 'securebot-demo',
        senderName: 'SecureBot',
        content: 'Demo reply: your message was received locally. No AI service is connected.',
        timestamp: new Date().toISOString(),
        type: 'text',
        deliveryStatus: 'delivered',
        demoOnly: true,
      };

      for (const handlers of Array.from(listeners)) {
        if (disposed) break;
        if (listeners.has(handlers)) handlers.onMessage({ ...reply });
      }
      assertActive();
    },
    subscribeToConversation(conversationId, handlers) {
      if (disposed) return () => undefined;
      const listeners = conversationListeners.get(conversationId) ?? new Set<MessagingTransportHandlers>();
      listeners.add(handlers);
      conversationListeners.set(conversationId, listeners);

      return () => {
        listeners.delete(handlers);
        if (listeners.size === 0) conversationListeners.delete(conversationId);
      };
    },
    async disconnect() {
      // There is no remote connection to close in the local demo.
    },
    dispose() {
      disposed = true;
      conversationListeners.clear();
    },
  };
}

/** Legacy standalone consumers retain the same default behavior. Auth sessions use the factory. */
export const localDemoTransport: MessagingTransport = createLocalDemoTransport();
