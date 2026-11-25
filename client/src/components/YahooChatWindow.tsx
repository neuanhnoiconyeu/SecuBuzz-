'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConversationHeader } from '@/components/messenger/ConversationHeader';
import { MessageComposer } from '@/components/messenger/MessageComposer';
import { MessageList } from '@/components/messenger/MessageList';
import { useConversationMessages } from '@/hooks/useConversationMessages';
import { ForwardDialog } from '@/components/messenger/ForwardDialog';
import { ReplyPreview } from '@/components/messenger/ReplyPreview';
import type { ChatMessage, MessageAttachment, PresenceStatus, VoiceMessageMetadata } from '@/messaging/messageModel';
import type { MessagingTransport } from '@/messaging/transport';
import { createAttachmentUploader } from '@/messaging/attachmentUpload';
import type { Db6AttachmentTarget } from '@/messaging/db6Attachments';
import { createLocalAttachmentUploader, localAttachmentStore } from '@/messaging/localAttachmentStore';
import { useChatFileDrop } from '@/hooks/useChatFileDrop';
import type { ConversationMessageActivity, ConversationType } from '@/conversations/conversationModel';
import type { ConversationSecurityStatus } from '@/security/keyManagement';
import type { ConversationCryptoService } from '@/security/conversationCryptoService';
import { validAIInput, type AIMessageAction, type AISelection } from '@/ai/aiModel';
import type { ForwardTarget } from '@/components/messenger/ForwardDialog';
import type { DirectCallKind } from '@/calls/directCallMachine';

export interface YahooChatWindowProps {
  forwardTargets?: ForwardTarget[];
  conversationId?: string;
  contactName?: string;
  conversationType?: ConversationType;
  /** Authoritative DB6 group/recipient ID; required for remote uploads. */
  attachmentTarget?: Db6AttachmentTarget;
  presenceStatus?: PresenceStatus;
  currentUserId?: string;
  currentUserName?: string;
  identityReady?: boolean;
  /** Presentation visibility only; hidden chats consume arrivals without entrance motion. */
  presentationActive?: boolean;
  avatarUrl?: string;
  transport?: MessagingTransport;
  cryptoService?: ConversationCryptoService;
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
  onRequestAI?(selection: AISelection): void;
  onStartCall?(kind: DirectCallKind): void;
  callDisabled?: boolean;
  callPeerId?: string;
}

export function YahooChatWindow({
  forwardTargets,
  avatarUrl,
  contactName = 'SecureBot',
  conversationId = 'securebot-demo',
  conversationType = 'bot',
  attachmentTarget,
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
  cryptoService,
  onRequestAI,
  onStartCall,
  callDisabled,
  callPeerId,
}: YahooChatWindowProps) {
  const [buzzBusy, setBuzzBusy] = useState(false);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [forwardingMessage, setForwardingMessage] = useState<ChatMessage | null>(null);
  const chatHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousConversationId = useRef(conversationId);
  const buzzLock = useRef(false);
  const buzzTimeout = useRef<number | null>(null);
  const {
    connectionStatus, 
    removeMessage,
    unsendMessage,
    canUnsend,
    forwardMessage,
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
    typingUsers,
    notifyTypingActivity,
    stopTyping,
    canRetryMessage,
    canEdit,
    attachmentHistoryLoading,
    attachmentStorageError,
  } = useConversationMessages({
    conversationId,
    currentUserId,
    currentUserName,
    initialPresence: presenceStatus,
    ...(transport ? { transport } : {}),
    ...(cryptoService ? { cryptoService } : {}),
    ...(conversationIds ? { conversationIds } : {}),
    ...(onMessageActivity ? { onMessageActivity } : {}),
    presentationActive,
  });

  useEffect(() => () => {
    if (buzzTimeout.current !== null) window.clearTimeout(buzzTimeout.current);
  }, []);

  const uploadAttachment = useMemo(() => transportMode === 'local-demo'
    ? createLocalAttachmentUploader(currentUserId, conversationId)
    : process.env.NEXT_PUBLIC_ATTACHMENT_API_READY === 'true' && attachmentTarget ? createAttachmentUploader(attachmentTarget) : undefined,
  [conversationId, currentUserId, transportMode, attachmentTarget]);
  const discardAttachment = useCallback((attachment: MessageAttachment) =>
    localAttachmentStore.discardUnusedFile(currentUserId, conversationId, attachment), [currentUserId, conversationId]);
  const attachmentUnavailableReason = transportMode === 'realtime' && !uploadAttachment
    ? 'File uploads are not available yet.' : attachmentHistoryLoading ? 'Restoring saved attachments…' : undefined;
  const drop = useChatFileDrop(conversationId, identityReady && Boolean(securityStatus?.localEncryptionAvailable) &&
    !isSending && !attachmentUnavailableReason && transport?.canSendMessages !== false);

  useEffect(() => {
    onSecurityStatusChange?.(securityStatus);
  }, [onSecurityStatusChange, securityStatus]);

  useEffect(() => {
    if (previousConversationId.current !== conversationId && window.innerWidth <= 680) {
      chatHeadingRef.current?.focus();
    }
    previousConversationId.current = conversationId;
    setReplyingTo(null);
    setForwardingMessage(null);
  }, [conversationId]);

const handleSendMessage = useCallback(async (
  content: string,
  extras?: {attachments?: MessageAttachment[]; voice?: VoiceMessageMetadata }
) => {
  const options = {
    ...(replyingTo
    ? {
        replyTo: {
          messageId: replyingTo.id,
          senderName: replyingTo.senderName,
          contentSnippet: replyingTo.content.slice(0, 60),
        },
      }
    : {}),
      ...(extras?.attachments ? { attachments: extras.attachments } : {}),
      ...(extras?.voice ? { voice: extras.voice } : {}),
    };
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

  const handleForwardConfirm = useCallback(
  (targetIds: string[], note: string, operationId: string) =>
    forwardingMessage
      ? forwardMessage(forwardingMessage, targetIds, note, operationId)
      : Promise.resolve({ succeeded: [] as string[], failed: targetIds }),
  [forwardMessage, forwardingMessage],
  );

  const setupError = securityStatus && !securityStatus.localEncryptionAvailable
    ? 'Browser encryption could not be initialized. Messaging is unavailable in this demo.'
    : undefined;

  return (
    <section className="chat-window chat-attachment-drop-target" aria-label={`${contactName} conversation`} data-buzz-active={buzzBusy} {...drop.bind}>
      {drop.dragging && <div className="chat-attachment-drop-overlay" aria-hidden="true">Drop files to attach</div>}
      <ConversationHeader
        active={presentationActive}
        name={contactName}
        transitionKey={conversationId}
        headingRef={chatHeadingRef}
        {...(onBackToConversations ? { onBackToConversations } : {})}
        {...(avatarUrl ? { avatarUrl } : {})}
        type={conversationType}
        {...(showPresence && presence ? { presence } : {})}
        securityStatus={securityStatus}
        connectionStatus={connectionStatus}
        transportMode={transportMode}
        {...(onStartCall ? { onStartCall } : {})}
        {...(callDisabled !== undefined ? { callDisabled } : {})}
        {...(callPeerId ? { callTarget: { conversationId, peer: { id: callPeerId, name: contactName } } } : {})}
      />

      <MessageList
        key={`messages:${conversationId}`}
        messages={messages}
        currentUserId={currentUserId}
        currentUserName={currentUserName}
        active={presentationActive}
        transportMode={transportMode}
        {...(onRequestAI ? { onAIMessage: (task: AIMessageAction, messageId: string) => {
          const selected = messages.find(message => message.id === messageId && message.conversationId === conversationId && message.type === 'text' && !message.isDeleted);
          if (selected && validAIInput(selected.content)) onRequestAI({ task, input: selected.content, conversationId, messageId: selected.id, kind: 'message' });
        } } : {})}
        onRetryMessage={(messageId) => void retryMessage(messageId)}
        canRetryMessage={canRetryMessage}
        onReplyMessage={(message) => setReplyingTo(message)}
        onEditMessage={editMessage}
        canEditMessage={canEdit}
        {...(transportMode === 'local-demo' ? { onDeleteMessage: removeMessage, onTogglePin: togglePin, onToggleReaction: toggleReaction } : {})}
        {...(canUnsend ? { onUnsendMessage: unsendMessage } : {})}
        {...((forwardTargets?.length ?? 0) > 0 ? { onForwardMessage: setForwardingMessage } : {})}
      />

      <p className="chat-typing-status" role="status" aria-live="polite" aria-atomic="true">
        {typingUsers.length > 0 && `${typingUsers.map((user) => user.displayName).slice(0, 3).join(', ')}${typingUsers.length > 3 ? ' and others' : ''} ${typingUsers.length === 1 ? 'is' : 'are'} typing…${transportMode === 'local-demo' ? ' · simulated' : ''}`}
      </p>
      {replyingTo && <ReplyPreview message={replyingTo} onCancel={() => setReplyingTo(null)} />}

      <MessageComposer
        key={`composer:${conversationId}`}
        active={presentationActive}
        conversationName={contactName}
        messageCount={messages.length}
        disabled={!identityReady || !securityStatus?.localEncryptionAvailable || transport?.canSendMessages === false}
        isSending={isSending}
        buzzBusy={buzzBusy}
        {...(uploadAttachment ? { uploadAttachment } : {})}
        {...(transportMode === 'local-demo' ? { discardAttachment, attachmentActionLabel: 'Saving' } : {})}
        {...(drop.files ? { droppedFiles: drop.files } : {})}
        {...(attachmentUnavailableReason ? { attachmentUnavailableReason } : {})}
        {...(draftValue !== undefined ? { draftValue } : {})}
        {...(onDraftChange ? { onDraftChange } : {})}
        demoNotice={transportMode === 'local-demo' ? 'Local demo · Attachments are saved on this device only; other users cannot access them.' : conversationType === 'bot'
          ? 'SecureBot replies are scripted local demo text; no AI service is connected.'
          : 'Local conversation preview only. No other users receive these messages.'}
        {...(setupError ? { setupError } : {})}
        onSend={handleSendMessage}
        onBuzz={() => void handleBuzz()}
        onTypingActivity={notifyTypingActivity}
        onTypingStop={stopTyping}
        {...(onRequestAI ? { onRewriteDraft: (draft: string) => {
          if (validAIInput(draft)) onRequestAI({ task: 'rewrite', input: draft, conversationId, kind: 'draft' });
        } } : {})}
      />
      {attachmentStorageError && <p className="composer-error" role="status">{attachmentStorageError}</p>}
      <ForwardDialog
        message={forwardingMessage}
        conversations={forwardTargets ?? []}
        onClose={() => setForwardingMessage(null)}
        onConfirm={handleForwardConfirm}
      />
    </section>
  );
}

export default YahooChatWindow;
