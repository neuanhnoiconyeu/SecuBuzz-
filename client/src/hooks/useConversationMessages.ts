import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appendMessage, createClientMessageId, deleteMessageById, editMessageContent, toggleMessagePin, toggleMessageReaction, updateMessageDeliveryStatus, } from '@/messaging/messageState';
import type {
  ChatMessage,
  ConnectionStatus,
  IncomingMessage,
  MessageAttachment,
  MessageReplyReference,
  MessageEncryptionMetadata,
  PresenceStatus,
  TransportMode,
  VoiceMessageMetadata,
} from '@/messaging/messageModel';
import type { ConversationMessageActivity } from '@/conversations/conversationModel';
import type { ConversationKeyContext, ConversationSecurityStatus } from '@/security/keyManagement';
import { demoConversationCryptoService } from '@/security/conversationCryptoService';
import type { ConversationCryptoService } from '@/security/conversationCryptoService';
import { localDemoTransport } from '@/messaging/localDemoTransport';
import type { MessagingTransport } from '@/messaging/transport';

export interface UseConversationMessagesOptions {
  conversationId: string;
  currentUserId: string;
  currentUserName: string;
  initialPresence?: PresenceStatus;
  transport?: MessagingTransport;
  cryptoService?: ConversationCryptoService;
  conversationIds?: string[];
  onMessageActivity?: (activity: ConversationMessageActivity) => void;
}

export interface UseConversationMessagesResult {
  messages: ChatMessage[];
  presence: PresenceStatus;
  connectionStatus: ConnectionStatus;
  transportMode: TransportMode;
  securityStatus: ConversationSecurityStatus | null;
  isSending: boolean;
  sendMessage(
    content: string,
    option?: {
      replyTo?: MessageReplyReference;
      attachements?: MessageAttachment[];
      voice?: VoiceMessageMetadata;
    }
  ): Promise<boolean>;
  retryMessage(messageId: string): Promise<boolean>;
  editMessage(messageId: string, newConten: string): void;
  deleteMessage(messageId: string): void;
  togglePin(messageId: string): void;
  toggleReaction(messageId: string, emoji: string): void;
}

function cryptoContext(message: Pick<ChatMessage, 'conversationId' | 'id' | 'senderId' | 'senderName' | 'timestamp'>) {
  return {
    conversationId: message.conversationId,
    messageId: message.id,
    senderId: message.senderId,
    senderName: message.senderName,
    timestamp: message.timestamp,
  };
}

function isIncomingMessage(value: unknown): value is IncomingMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  const commonFieldsAreValid =
    typeof message.id === 'string' && message.id.length > 0 &&
    typeof message.conversationId === 'string' && message.conversationId.length > 0 &&
    typeof message.senderId === 'string' && message.senderId.length > 0 &&
    typeof message.senderName === 'string' && message.senderName.length > 0 &&
    typeof message.timestamp === 'string' && Number.isFinite(Date.parse(message.timestamp)) &&
    message.type === 'text' &&
    ['sending', 'sent', 'delivered', 'failed'].includes(String(message.deliveryStatus));
  if (!commonFieldsAreValid) return false;
  if (message.demoOnly === true) return typeof message.content === 'string';
  if ('demoOnly' in message) return false;
  return Object.prototype.hasOwnProperty.call(message, 'encryption');
}

export function useConversationMessages({
  conversationId,
  currentUserId,
  currentUserName,
  initialPresence = 'offline',
  transport = localDemoTransport,
  cryptoService = demoConversationCryptoService,
  conversationIds = [conversationId],
  onMessageActivity,
}: UseConversationMessagesOptions): UseConversationMessagesResult {
  const [messagesByConversation, setMessagesByConversation] = useState<Record<string, ChatMessage[]>>({});
  const [presence, setPresence] = useState<PresenceStatus>(initialPresence);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [securityStatus, setSecurityStatus] = useState<ConversationSecurityStatus | null>(null);
  const [pendingCounts, setPendingCounts] = useState<Record<string, number>>({});
  const sendLocks = useRef(new Set<string>());
  const messages = messagesByConversation[conversationId] ?? [];
  const trackedConversationIdsKey = JSON.stringify(Array.from(new Set([conversationId, ...conversationIds])));
  const trackedConversationIds = useMemo<string[]>(
    () => JSON.parse(trackedConversationIdsKey) as string[],
    [trackedConversationIdsKey]
  );
  const observedActivityIds = useRef(new Set<string>());
  const keyContext = useMemo<ConversationKeyContext>(
    () => ({ conversationId, localUserId: currentUserId }),
    [conversationId, currentUserId]
  );

  const notifyActivity = useCallback((message: ChatMessage, direction: 'incoming' | 'outgoing') => {
    const id = JSON.stringify([message.conversationId, message.id]);
    if (observedActivityIds.current.has(id)) return;
    observedActivityIds.current.add(id);
    onMessageActivity?.({
      conversationId: message.conversationId,
      messageId: message.id,
      direction,
      preview: message.content,
      timestamp: message.timestamp,
    });
  }, [onMessageActivity]);

  useEffect(() => {
    let active = true;
    setPresence(initialPresence);
    setConnectionStatus('connecting');
    setSecurityStatus(null);

    void cryptoService.prepareConversation(keyContext).then(
      (status) => { if (active) setSecurityStatus(status); },
      () => { if (active) setSecurityStatus({
        browserCryptoAvailable: false,
        localEncryptionAvailable: false,
        recipientKeyAvailable: false,
        authenticatedKeyExchangeEstablished: false,
      }); }
    );

    const cleanups: Array<() => void> = [];
    for (const subscribedConversationId of trackedConversationIds) {
      const subscribedKeyContext = { conversationId: subscribedConversationId, localUserId: currentUserId };
      const unsubscribe = transport.subscribeToConversation(subscribedConversationId, {
        onMessage: (incoming) => {
          if (!active || !isIncomingMessage(incoming) || incoming.conversationId !== subscribedConversationId) return;
          if ('demoOnly' in incoming) {
            if (transport.mode !== 'local-demo') return;
            setMessagesByConversation((state) => appendMessage(state, incoming));
            notifyActivity(incoming, 'incoming');
            return;
          }

          const context = {
            conversationId: incoming.conversationId,
            messageId: incoming.id,
            senderId: incoming.senderId,
            senderName: incoming.senderName,
            timestamp: incoming.timestamp,
          };
          void cryptoService.decrypt(subscribedKeyContext, incoming.encryption, context).then(
            (content) => {
              if (!active) return;
              const message: ChatMessage = {
                id: incoming.id,
                conversationId: incoming.conversationId,
                senderId: incoming.senderId,
                senderName: incoming.senderName,
                content,
                timestamp: incoming.timestamp,
                type: 'text',
                deliveryStatus: incoming.deliveryStatus,
                encryption: { ...incoming.encryption, scope: 'browser-demo' },
              };
              setMessagesByConversation((state) => appendMessage(state, message));
              notifyActivity(message, 'incoming');
            },
            () => {
              if (!active) return;
              const alert: ChatMessage = {
                id: `security-auth-failed-${incoming.id}`,
                conversationId: subscribedConversationId,
                senderId: 'security',
                senderName: 'Security notice',
                content: 'An encrypted message failed authentication and was discarded.',
                timestamp: new Date().toISOString(),
                type: 'security_alert',
                deliveryStatus: 'delivered',
              };
              setMessagesByConversation((state) => appendMessage(state, alert));
              notifyActivity(alert, 'incoming');
            }
          );
        },
        onDeliveryStatus: ({ messageId, status }) => {
          if (active) {
            setMessagesByConversation((state) =>
              updateMessageDeliveryStatus(state, subscribedConversationId, messageId, status)
            );
          }
        },
        onPresenceUpdate: (status) => {
          if (active && subscribedConversationId === conversationId) setPresence(status);
        },
        onSecurityAlert: (message) => {
          if (active && message.conversationId === subscribedConversationId && message.type === 'security_alert') {
            setMessagesByConversation((state) => appendMessage(state, message));
            notifyActivity({ ...message, content: 'Security alert' }, 'incoming');
          }
        },
        onConnectionChange: (status) => {
          if (active && subscribedConversationId === conversationId) setConnectionStatus(status);
        },
      });
      cleanups.push(() => {
        unsubscribe();
        void transport.disconnect(subscribedConversationId).catch(() => undefined);
      });

      void transport.connect(subscribedConversationId).then(
        () => {
          if (active && subscribedConversationId === conversationId) setConnectionStatus('connected');
        },
        () => {
          if (active && subscribedConversationId === conversationId) setConnectionStatus('failed');
        }
      );
    }

    return () => {
      active = false;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [conversationId, currentUserId, cryptoService, initialPresence, keyContext, notifyActivity, trackedConversationIds, transport]);

  const sendMessage = useCallback(async (
    content: string,
    options?: {
      replyTo?: MessageReplyReference;
      attachments?: MessageAttachment[];
      voice?: VoiceMessageMetadata;
    }
  ) => {
    const trimmedContent = content.trim();
    if (!trimmedContent || sendLocks.current.has(conversationId)) return false;
    sendLocks.current.add(conversationId);
    setPendingCounts((counts) => ({ ...counts, [conversationId]: (counts[conversationId] ?? 0) + 1 }));

    try {
      const message: ChatMessage = {
        id: createClientMessageId(),
        conversationId,
        senderId: currentUserId,
        senderName: currentUserName,
        content: trimmedContent,
        timestamp: new Date().toISOString(),
        type: 'text',
        deliveryStatus: 'sending',
        replyTo: options?.replyTo,
        attachments: options?.attachments,
        voice: options?.voice,
      };
      const encrypted = await cryptoService.encrypt(keyContext, trimmedContent, cryptoContext(message));
      const encryption: MessageEncryptionMetadata = { ...encrypted, scope: 'browser-demo' };
      const localMessage = { ...message, encryption };
      const outbound = {
        id: message.id,
        conversationId,
        senderId: currentUserId,
        senderName: currentUserName,
        timestamp: message.timestamp,
        type: 'text' as const,
        encryption,
      };

      setMessagesByConversation((state) => appendMessage(state, localMessage));
      notifyActivity(localMessage, 'outgoing');
      try {
        await transport.sendMessage(outbound);
        setMessagesByConversation((state) =>
          updateMessageDeliveryStatus(state, conversationId, message.id, 'sent')
        );
        return true;
      } catch {
        setMessagesByConversation((state) =>
          updateMessageDeliveryStatus(state, conversationId, message.id, 'failed')
        );
        return false;
      }
    } catch {
      // Encryption failure produces neither a plaintext local message nor a transport send.
      return false;
    } finally {
      sendLocks.current.delete(conversationId);
      setPendingCounts((counts) => ({
        ...counts,
        [conversationId]: Math.max(0, (counts[conversationId] ?? 1) - 1),
      }));
    }
  }, [conversationId, cryptoService, currentUserId, currentUserName, keyContext, notifyActivity, transport]);

  const retryMessage = useCallback(async (messageId: string) => {
    const message = (messagesByConversation[conversationId] ?? []).find((candidate) => candidate.id === messageId);
    if (!message?.encryption || message.deliveryStatus !== 'failed' || sendLocks.current.has(conversationId)) return false;

    sendLocks.current.add(conversationId);
    setPendingCounts((counts) => ({ ...counts, [conversationId]: (counts[conversationId] ?? 0) + 1 }));
    setMessagesByConversation((state) => updateMessageDeliveryStatus(state, conversationId, messageId, 'sending'));
    try {
      await transport.sendMessage({
        id: message.id,
        conversationId: message.conversationId,
        senderId: message.senderId,
        senderName: message.senderName,
        timestamp: message.timestamp,
        type: 'text',
        encryption: message.encryption,
      });
      setMessagesByConversation((state) => updateMessageDeliveryStatus(state, conversationId, messageId, 'sent'));
      return true;
    } catch {
      setMessagesByConversation((state) => updateMessageDeliveryStatus(state, conversationId, messageId, 'failed'));
      return false;
    } finally {
      sendLocks.current.delete(conversationId);
      setPendingCounts((counts) => ({ ...counts, [conversationId]: Math.max(0, (counts[conversationId] ?? 1) - 1) }));
    }
  }, [conversationId, messagesByConversation, transport]);

    const editMessage = useCallback((messageId: string, newContent: string) => {
      setMessagesByConversation((state) =>
        editMessageContent(state, conversationId, messageId, newContent)
      );
    }, [conversationId]);

    const deleteMessage = useCallback((messageId: string) => {
      setMessagesByConversation((state) =>
        deleteMessageById(state, conversationId, messageId)
      );
    }, [conversationId]);

    const togglePin = useCallback((messageId: string) => {
      setMessagesByConversation((state) =>
        toggleMessagePin(state, conversationId, messageId)
      );
    }, [conversationId]);

    const toggleReaction = useCallback((messageId: string, emoji: string) => {
      setMessagesByConversation((state) =>
        toggleMessageReaction(state, conversationId, messageId, emoji, currentUserId)
      );
    }, [conversationId, currentUserId]);

  return {
    messages,
    presence,
    connectionStatus,
    transportMode: transport.mode,
    securityStatus,
    isSending: (pendingCounts[conversationId] ?? 0) > 0,
    sendMessage,
    retryMessage,
    editMessage,
    deleteMessage,
    togglePin,
    toggleReaction,
  };
}
