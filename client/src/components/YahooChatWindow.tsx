'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConversationHeader } from '@/components/messenger/ConversationHeader';
import { MessageComposer } from '@/components/messenger/MessageComposer';
import { MessageList } from '@/components/messenger/MessageList';
import { useConversationMessages } from '@/hooks/useConversationMessages';
import type { ChatMessage, PresenceStatus } from '@/messaging/messageModel';
import type { MessagingTransport } from '@/messaging/transport';
import type { ConversationMessageActivity, ConversationType } from '@/conversations/conversationModel';
import type { ConversationSecurityStatus } from '@/security/keyManagement';

export interface YahooChatWindowProps {
  conversationId?: string;
  contactName?: string;
  conversationType?: ConversationType;
  presenceStatus?: PresenceStatus;
  currentUserId?: string;
  currentUserName?: string;
  identityReady?: boolean;
  /** Presentation visibility only; hidden chats consume arrivals without entrance motion. */
  presentationActive?: boolean;
  avatarUrl?: string;
  transport?: MessagingTransport;
  onBuzz?: () => void | Promise<void>;
  /** Called after the configured transport accepts the encrypted message payload. */
  onSendMessage?: () => void;
  conversationIds?: string[];
  draftValue?: string;
  onDraftChange?: (draft: string) => void;
  onMessageActivity?: (activity: ConversationMessageActivity) => void;
  onSecurityStatusChange?: (status: ConversationSecurityStatus | null) => void;
  onBackToConversations?: () => void;
  showPresence?: boolean;
}

export function YahooChatWindow({
  avatarUrl,
  contactName = 'SecureBot',
  conversationId = 'securebot-demo',
  conversationType = 'bot',
  currentUserId = 'local-user',
  currentUserName = 'You',
  identityReady = true,
  presentationActive = true,
  onBuzz,
  onSendMessage,
  conversationIds,
  draftValue,
  onDraftChange,
  onMessageActivity,
  onSecurityStatusChange,
  onBackToConversations,
  showPresence = false,
  presenceStatus = 'offline',
  transport,
}: YahooChatWindowProps) {
  const [buzzBusy, setBuzzBusy] = useState(false);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const chatHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousConversationId = useRef(conversationId);
  const buzzLock = useRef(false);
  const buzzTimeout = useRef<number | null>(null);
  const {
    connectionStatus,
    deleteMessage, 
    editMessage,
    isSending,
    messages,
    presence,
    retryMessage,
    securityStatus,
    sendMessage,
    togglePin,
    toggleReaction,
    transportMode,
  } = useConversationMessages({
    conversationId,
    currentUserId,
    currentUserName,
    initialPresence: presenceStatus,
    ...(transport ? { transport } : {}),
    ...(conversationIds ? { conversationIds } : {}),
    ...(onMessageActivity ? { onMessageActivity } : {}),
  });

  useEffect(() => () => {
    if (buzzTimeout.current !== null) window.clearTimeout(buzzTimeout.current);
  }, []);

  useEffect(() => {
    onSecurityStatusChange?.(securityStatus);
  }, [onSecurityStatusChange, securityStatus]);

  useEffect(() => {
    if (previousConversationId.current !== conversationId && window.innerWidth <= 680) {
      chatHeadingRef.current?.focus();
    }
    previousConversationId.current = conversationId;
    setReplyingTo(null);
  }, [conversationId]);

const handleSendMessage = useCallback(async (content: string) => {
  const options = replyingTo
    ? {
        replyTo: {
          messageId: replyingTo.id,
          senderName: replyingTo.senderName,
          contentSnippet: replyingTo.content.slice(0, 60),
        },
      }
    : undefined;
  const accepted = await sendMessage(content, options);
  if (accepted) {
    setReplyingTo(null);
    onSendMessage?.();
  }
  return accepted;
}, [onSendMessage, replyingTo, sendMessage]);

  const playBuzzSound = useCallback(() => {
    try {
      const audioGlobals = globalThis as typeof globalThis & {
        webkitAudioContext?: typeof AudioContext;
      };
      const AudioContextConstructor = globalThis.AudioContext || audioGlobals.webkitAudioContext;
      if (!AudioContextConstructor) return;

      const audioContext = new AudioContextConstructor();
      const playTone = (frequency: number, startAt: number) => {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.frequency.value = frequency;
        oscillator.type = 'sine';
        gain.gain.setValueAtTime(0.3, startAt);
        gain.gain.exponentialRampToValueAtTime(0.01, startAt + 0.1);
        oscillator.start(startAt);
        oscillator.stop(startAt + 0.1);
      };

      playTone(440, audioContext.currentTime);
      playTone(400, audioContext.currentTime + 0.12);
      window.setTimeout(() => void audioContext.close(), 350);
    } catch (error) {
      console.debug('Audio context not available:', error);
    }
  }, []);

  const handleBuzz = useCallback(async () => {
    if (buzzLock.current) return;
    buzzLock.current = true;
    setBuzzBusy(true);
    playBuzzSound();
    try {
      await onBuzz?.();
    } catch (error) {
      console.error('BUZZ action failed:', error);
    } finally {
      buzzTimeout.current = window.setTimeout(() => {
        buzzLock.current = false;
        setBuzzBusy(false);
        buzzTimeout.current = null;
      }, 500);
    }
  }, [onBuzz, playBuzzSound]);

  const setupError = securityStatus && !securityStatus.localEncryptionAvailable
    ? 'Browser encryption could not be initialized. Messaging is unavailable in this demo.'
    : undefined;

  return (
    <section className="chat-window" aria-label={`${contactName} conversation`} data-buzz-active={buzzBusy}>
      <ConversationHeader
        name={contactName}
        transitionKey={conversationId}
        headingRef={chatHeadingRef}
        {...(onBackToConversations ? { onBackToConversations } : {})}
        {...(avatarUrl ? { avatarUrl } : {})}
        type={conversationType}
        {...(showPresence ? { presence } : {})}
        securityStatus={securityStatus}
        connectionStatus={connectionStatus}
        transportMode={transportMode}
      />

      <MessageList
        key={`messages:${conversationId}`}
        messages={messages}
        currentUserId={currentUserId}
        currentUserName={currentUserName}
        active={presentationActive}
        transportMode={transportMode}
        onRetryMessage={(messageId) => void retryMessage(messageId)}
        onReplyMessage={(message) => setReplyingTo(message)}
        onEditMessage={editMessage}
        onDeleteMessage={deleteMessage}
        onTogglePin={togglePin}
        onToggleReaction={toggleReaction}
      />

      {replyingTo && (
        <div
          className="reply-preview-banner"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '6px 12px',
            background: 'rgba(139, 92, 246, 0.12)',
            borderTop: '1px solid rgba(139, 92, 246, 0.3)',
            fontSize: '0.8rem',
          }}
        >
          <div style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            <strong>Replying to {replyingTo.senderName}: </strong>
            <span>{replyingTo.content}</span>
          </div>
          <button
            type="button"
            onClick={() => setReplyingTo(null)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
              fontWeight: 'bold',
              padding: '0 6px',
            }}
            aria-label="Cancel reply"
          >
            ✕
          </button>
        </div>
      )}

      <MessageComposer
        key={`composer:${conversationId}`}
        conversationName={contactName}
        messageCount={messages.length}
        disabled={!identityReady || !securityStatus?.localEncryptionAvailable}
        isSending={isSending}
        buzzBusy={buzzBusy}
        {...(draftValue !== undefined ? { draftValue } : {})}
        {...(onDraftChange ? { onDraftChange } : {})}
        demoNotice={conversationType === 'bot'
          ? 'SecureBot replies are scripted local demo text; no AI service is connected.'
          : 'Local conversation preview only. No other users receive these messages.'}
        {...(setupError ? { setupError } : {})}
        onSend={handleSendMessage}
        onBuzz={() => void handleBuzz()}
      />
    </section>
  );
}

export default YahooChatWindow;
