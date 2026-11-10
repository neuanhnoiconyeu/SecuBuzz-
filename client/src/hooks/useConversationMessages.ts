import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appendMessage, createClientMessageId, deleteMessageById, editMessageContent, toggleMessagePin, toggleMessageReaction, updateMessageDeliveryStatus, } from '@/messaging/messageState';
import type {
  ChatMessage,
  ConnectionStatus,
  EncryptedIncomingMessage,
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

export const MAX_CONCURRENT_DECRYPTS = 64;
export const MAX_QUEUED_DECRYPTS = 256;
export const MAX_QUEUED_DECRYPT_BYTES = 16 * 1024 * 1024;

export interface UseConversationMessagesOptions {
  conversationId: string;
  currentUserId: string;
  currentUserName: string;
  initialPresence?: PresenceStatus;
  transport?: MessagingTransport;
  cryptoService?: ConversationCryptoService;
  conversationIds?: string[];
  onMessageActivity?: (activity: ConversationMessageActivity) => void;
  presentationActive?: boolean;
}

export interface UseConversationMessagesResult {
  messages: ChatMessage[];
  presence: PresenceStatus | undefined;
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
  typingUsers: Array<{ userId: string; displayName: string }>;
  notifyTypingActivity(): void;
  stopTyping(): void;
  canRetryMessage(messageId: string): boolean;
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
    ['sending', 'sent', 'delivered', 'failed', 'read'].includes(String(message.deliveryStatus));
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
  presentationActive = true,
}: UseConversationMessagesOptions): UseConversationMessagesResult {
  const [messagesByConversation, setMessagesByConversation] = useState<Record<string, ChatMessage[]>>({});
  const [presence, setPresence] = useState<PresenceStatus | undefined>(initialPresence);
  const initialPresenceRef = useRef(initialPresence);
  initialPresenceRef.current = initialPresence;
  useEffect(() => { setPresence(initialPresence); }, [initialPresence]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const connectionStatuses = useRef(new Map<string, ConnectionStatus>());
  const [securityStatus, setSecurityStatus] = useState<ConversationSecurityStatus | null>(null);
  const [pendingCounts, setPendingCounts] = useState<Record<string, number>>({});
  const sendLocks = useRef(new Set<string>());
  const [typingUsers, setTypingUsers] = useState<Array<{ userId: string; displayName: string }>>([]);
  const incomingTypers = useRef(new Map<string, { displayName: string; timestamp: number; expiresAt: number; isTyping: boolean }>());
  const outgoingTyping = useRef({ active: false, sentAt: 0, timer: null as ReturnType<typeof setTimeout> | null });
  const readRequested = useRef(new Set<string>());
  const seenIncoming = useRef(new Set<string>());
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const presentation = useRef({ conversationId, presentationActive, pageVisible, onMessageActivity });
  presentation.current = { conversationId, presentationActive, pageVisible, onMessageActivity };
  const messages = useMemo(() => messagesByConversation[conversationId] ?? [], [conversationId, messagesByConversation]);
  const trackedConversationIdsKey = JSON.stringify(Array.from(new Set([conversationId, ...conversationIds])).sort());
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
    while (observedActivityIds.current.size > 2_000) observedActivityIds.current.delete(observedActivityIds.current.values().next().value!);
    const current = presentation.current;
    current.onMessageActivity?.({
      conversationId: message.conversationId,
      messageId: message.id,
      direction,
      preview: message.content,
      timestamp: message.timestamp,
      isViewed: current.presentationActive && current.pageVisible && message.conversationId === current.conversationId,
    });
  }, []);

  const stopTyping = useCallback(() => {
    if (outgoingTyping.current.timer !== null) clearTimeout(outgoingTyping.current.timer);
    outgoingTyping.current.timer = null;
    if (!outgoingTyping.current.active) return;
    outgoingTyping.current.active = false;
    try { transport.sendTyping?.(conversationId, false); } catch { /* Ephemeral signals have no retry queue. */ }
  }, [conversationId, transport]);
  const stopTypingRef = useRef(stopTyping);
  stopTypingRef.current = stopTyping;

  const notifyTypingActivity = useCallback(() => {
    if (!presentationActive || !pageVisible || connectionStatus !== 'connected' || !transport.sendTyping) return;
    const now = Date.now();
    if (!outgoingTyping.current.active || now - outgoingTyping.current.sentAt >= 2_000) {
      try { transport.sendTyping(conversationId, true); } catch { return; }
      outgoingTyping.current.active = true;
      outgoingTyping.current.sentAt = now;
    }
    if (outgoingTyping.current.timer !== null) clearTimeout(outgoingTyping.current.timer);
    outgoingTyping.current.timer = setTimeout(stopTyping, 1_500);
  }, [connectionStatus, conversationId, pageVisible, presentationActive, stopTyping, transport]);

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      let changed = false;
      for (const [id, value] of incomingTypers.current) {
        if (value.expiresAt <= Date.now()) { incomingTypers.current.delete(id); changed = true; }
      }
      if (changed) setTypingUsers(Array.from(incomingTypers.current).filter(([, value]) => value.isTyping)
        .map(([userId, value]) => ({ userId, displayName: value.displayName })));
    }, 500);
    return () => { window.clearInterval(timer); stopTyping(); };
  }, [stopTyping]);

  useEffect(() => {
    incomingTypers.current.clear();
    setTypingUsers([]);
    if (!presentationActive || !pageVisible) stopTyping();
    return stopTyping;
  }, [conversationId, pageVisible, presentationActive, stopTyping]);

  useEffect(() => {
    setPresence(initialPresenceRef.current);
    setConnectionStatus(transport.getConnectionStatus?.() ?? connectionStatuses.current.get(conversationId) ?? 'connecting');
  }, [conversationId, transport]);

  useEffect(() => {
    let active = true;
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
    return () => { active = false; };
  }, [cryptoService, keyContext]);

  useEffect(() => {
    let active = true;
    let decrypting = 0;
    let queuedBytes = 0;
    let overflowReported = false;
    type DecryptWork = { message: EncryptedIncomingMessage; keyContext: ConversationKeyContext; bytes: number };
    const decryptQueue: DecryptWork[] = [];

    const reportOverflow = (id: string) => {
      if (!active || overflowReported) return;
      overflowReported = true;
      const alert: ChatMessage = {
        id: `security-processing-limit-${createClientMessageId()}`, conversationId: id, senderId: 'security', senderName: 'Security notice',
        content: 'Some encrypted messages exceeded the local processing limit and were discarded. No unverified message content was displayed.',
        timestamp: new Date().toISOString(), type: 'security_alert', deliveryStatus: 'delivered',
      };
      setMessagesByConversation((state) => appendMessage(state, alert));
      notifyActivity(alert, 'incoming');
    };

    function drainDecryptQueue() {
      while (active && decrypting < MAX_CONCURRENT_DECRYPTS && decryptQueue.length) {
        const work = decryptQueue.shift()!;
        queuedBytes -= work.bytes;
        decrypt(work);
      }
    }

    function decrypt(work: DecryptWork) {
      if (!active) return;
      decrypting += 1;
      const incoming = work.message;
      let operation: Promise<string>;
      try { operation = cryptoService.decrypt(work.keyContext, incoming.encryption, cryptoContext(incoming)); }
      catch { operation = Promise.reject(new Error('Authentication unavailable')); }
      void operation.then(
        (content) => {
          if (!active) return;
          const message: ChatMessage = {
            id: incoming.id, conversationId: incoming.conversationId, senderId: incoming.senderId, senderName: incoming.senderName,
            content, timestamp: incoming.timestamp, type: 'text', deliveryStatus: incoming.deliveryStatus,
            encryption: { ...incoming.encryption, scope: 'browser-demo' },
          };
          setMessagesByConversation((state) => appendMessage(state, message));
          notifyActivity(message, 'incoming');
        },
        () => {
          if (!active) return;
          const alert: ChatMessage = {
            id: `security-auth-failed-${incoming.id}`, conversationId: incoming.conversationId, senderId: 'security', senderName: 'Security notice',
            content: 'An encrypted message failed authentication and was discarded.', timestamp: new Date().toISOString(),
            type: 'security_alert', deliveryStatus: 'delivered',
          };
          setMessagesByConversation((state) => appendMessage(state, alert));
          notifyActivity(alert, 'incoming');
        },
      ).finally(() => { decrypting -= 1; drainDecryptQueue(); });
    }

    const cleanups: Array<() => void> = [];
    for (const subscribedConversationId of trackedConversationIds) {
      const subscribedKeyContext = { conversationId: subscribedConversationId, localUserId: currentUserId };
      const unsubscribe = transport.subscribeToConversation(subscribedConversationId, {
        onMessage: (incoming) => {
          if (!active || !isIncomingMessage(incoming) || incoming.conversationId !== subscribedConversationId) return;
          const incomingId = JSON.stringify([incoming.conversationId, incoming.id]);
          if (seenIncoming.current.has(incomingId)) return;
          if ('demoOnly' in incoming) {
            if (transport.mode !== 'local-demo') return;
            seenIncoming.current.add(incomingId);
            while (seenIncoming.current.size > 2_000) seenIncoming.current.delete(seenIncoming.current.values().next().value!);
            setMessagesByConversation((state) => appendMessage(state, incoming));
            notifyActivity(incoming, 'incoming');
            return;
          }

          // Retain only ciphertext and authenticated routing metadata while a
          // native crypto slot is busy. No unverified plaintext enters a store.
          const source = incoming.encryption as unknown;
          const payload = source && typeof source === 'object' ? source as Record<string, unknown> : {};
          const copiedPayload = {
            version: typeof payload.version === 'number' ? payload.version : 0,
            algorithm: typeof payload.algorithm === 'string' ? payload.algorithm : '',
            encoding: typeof payload.encoding === 'string' ? payload.encoding : '',
            iv: typeof payload.iv === 'string' ? payload.iv : '',
            ciphertext: typeof payload.ciphertext === 'string' ? payload.ciphertext : '',
          } as EncryptedIncomingMessage['encryption'];
          const message: EncryptedIncomingMessage = {
            id: incoming.id, conversationId: incoming.conversationId, senderId: incoming.senderId, senderName: incoming.senderName,
            timestamp: incoming.timestamp, type: 'text', deliveryStatus: incoming.deliveryStatus, encryption: copiedPayload,
          };
          const bytes = 256 + 2 * (message.id.length + message.conversationId.length + message.senderId.length +
            message.senderName.length + message.timestamp.length + copiedPayload.algorithm.length + copiedPayload.encoding.length +
            copiedPayload.iv.length + copiedPayload.ciphertext.length);
          if (bytes > MAX_QUEUED_DECRYPT_BYTES || (decrypting >= MAX_CONCURRENT_DECRYPTS &&
            (decryptQueue.length >= MAX_QUEUED_DECRYPTS || queuedBytes + bytes > MAX_QUEUED_DECRYPT_BYTES))) {
            reportOverflow(subscribedConversationId);
            return;
          }
          seenIncoming.current.add(incomingId);
          while (seenIncoming.current.size > 2_000) seenIncoming.current.delete(seenIncoming.current.values().next().value!);
          const work = { message, keyContext: subscribedKeyContext, bytes };
          if (decrypting < MAX_CONCURRENT_DECRYPTS) decrypt(work);
          else { decryptQueue.push(work); queuedBytes += bytes; }
        },
        onDeliveryStatus: ({ messageId, status }) => {
          if (active) {
            setMessagesByConversation((state) =>
              updateMessageDeliveryStatus(state, subscribedConversationId, messageId, status)
            );
          }
        },
        onPresenceUpdate: (status) => {
          if (active && subscribedConversationId === presentation.current.conversationId) setPresence(status);
        },
        onSecurityAlert: (message) => {
          if (active && message.conversationId === subscribedConversationId && message.type === 'security_alert') {
            setMessagesByConversation((state) => appendMessage(state, message));
            notifyActivity({ ...message, content: 'Security alert' }, 'incoming');
          }
        },
        onConnectionChange: (status) => {
          connectionStatuses.current.set(subscribedConversationId, status);
          if (active && subscribedConversationId === presentation.current.conversationId) {
            setConnectionStatus(status);
            if (status !== 'connected') {
              incomingTypers.current.clear();
              setTypingUsers([]);
              stopTypingRef.current();
              setPresence(undefined);
            }
          }
        },
        onTypingUpdate: (update) => {
          const current = presentation.current;
          if (!active || !current.presentationActive || !current.pageVisible || subscribedConversationId !== current.conversationId || update.userId === currentUserId) return;
          const timestamp = Date.parse(update.timestamp);
          if (!Number.isFinite(timestamp) || timestamp > Date.now() + 60_000 || timestamp < Date.now() - 5_000) return;
          const previous = incomingTypers.current.get(update.userId);
          if (previous && (timestamp < previous.timestamp || (timestamp === previous.timestamp && (!previous.isTyping || update.isTyping)))) return;
          incomingTypers.current.set(update.userId, { displayName: update.displayName, timestamp,
            expiresAt: Math.min(Date.now(), timestamp) + 5_000, isTyping: update.isTyping });
          while (incomingTypers.current.size > 40) incomingTypers.current.delete(incomingTypers.current.keys().next().value!);
          setTypingUsers(Array.from(incomingTypers.current).filter(([, value]) => value.isTyping)
            .map(([userId, value]) => ({ userId, displayName: value.displayName })));
        },
      });
      cleanups.push(() => {
        unsubscribe();
        void transport.disconnect(subscribedConversationId).catch(() => undefined);
      });

      void transport.connect(subscribedConversationId).then(
        () => {
          connectionStatuses.current.set(subscribedConversationId, transport.getConnectionStatus?.() ?? 'connected');
          if (active && subscribedConversationId === presentation.current.conversationId) setConnectionStatus(transport.getConnectionStatus?.() ?? 'connected');
        },
        () => {
          connectionStatuses.current.set(subscribedConversationId, transport.getConnectionStatus?.() ?? 'failed');
          if (active && subscribedConversationId === presentation.current.conversationId) setConnectionStatus(transport.getConnectionStatus?.() ?? 'failed');
        }
      );
    }

    return () => {
      active = false;
      decryptQueue.length = 0;
      queuedBytes = 0;
      stopTypingRef.current();
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [currentUserId, cryptoService, notifyActivity, trackedConversationIds, transport]);

  useEffect(() => {
    if (!presentationActive || !pageVisible || connectionStatus !== 'connected' || !transport.markRead) return;
    const latest = [...messages].reverse().find((message) => message.senderId !== currentUserId && message.type === 'text');
    if (!latest) return;
    const id = JSON.stringify([conversationId, latest.id]);
    if (readRequested.current.has(id)) return;
    readRequested.current.add(id);
    while (readRequested.current.size > 2_000) readRequested.current.delete(readRequested.current.values().next().value!);
    void transport.markRead(conversationId, latest.id).catch(() => { /* No speculative read claim or automatic retry. */ });
  }, [connectionStatus, conversationId, currentUserId, messages, pageVisible, presentationActive, transport]);

  const sendMessage = useCallback(async (
    content: string,
    options?: {
      replyTo?: MessageReplyReference;
      attachments?: MessageAttachment[];
      voice?: VoiceMessageMetadata;
    }
  ) => {
    const trimmedContent = content.trim();
    if (!trimmedContent || sendLocks.current.has(conversationId) || transport.canSendMessages === false) return false;
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
    if (!message?.encryption || message.deliveryStatus !== 'failed' || sendLocks.current.has(conversationId) ||
      transport.canSendMessages === false || (transport.canRetryMessage && !transport.canRetryMessage(conversationId, messageId))) return false;

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
    typingUsers,
    notifyTypingActivity,
    stopTyping,
    canRetryMessage: (messageId: string) => transport.canRetryMessage?.(conversationId, messageId) ?? true,
  };
}
