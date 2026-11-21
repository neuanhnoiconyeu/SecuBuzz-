import { UnsendDialog, type UnsendScope } from './UnsendDialog';
import { QUICK_EMOJIS, emojiName, emojiOnlyCount } from './emojiData';
import { EmojiPicker } from './EmojiPicker';
import { rememberEmoji } from './recentEmojis';
import { useAnchoredMessagePopover } from '@/hooks/useAnchoredMessagePopover';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  AlertTriangle, ArrowDown, Check, Edit2, Forward, LockKeyhole, Mic, MoreHorizontal,
  Pin, Plus, Reply, Undo2, SmilePlus, Sparkles, Trash2, X,
} from 'lucide-react';
import { BrandLogo } from '@/components/branding';
import { Badge, Button, Surface } from '@/components/ui';
import type { ChatMessage, TransportMode } from '@/messaging/messageModel';
import { AI_MAX_INPUT, type AIMessageAction } from '@/ai/aiModel';
import { useMessageEntryMotion } from './useMessageEntryMotion';
import { MessageAttachmentView } from './MessageAttachmentView';
import './message-reactions.css';

export interface MessageListProps {
  messages: ChatMessage[];
  currentUserId: string;
  /** Current display label only; stored authenticated sender metadata stays unchanged. */
  currentUserName?: string;
  /** Suppresses entry motion while this conversation's UI is hidden. */
  active?: boolean;
  transportMode?: TransportMode;
  onRetryMessage(messageId: string): void;
  canRetryMessage?(messageId: string): boolean;
  onReplyMessage?: (message: ChatMessage) => void;
  onEditMessage?: (messageId: string, newContent: string) => Promise<boolean> | boolean | void;
  canEditMessage?: boolean;
  onDeleteMessage?: (messageId: string) => Promise<boolean | void> | boolean | void;
  onUnsendMessage?: (messageId: string) => Promise<boolean> | boolean;
  onTogglePin?: (messageId: string) => void;
  onToggleReaction?: (messageId: string, emoji: string) => void;
  onAIMessage?: (task: AIMessageAction, messageId: string) => void;
  onForwardMessage?: (message: ChatMessage) => void;
  verifiedMessageIds?: ReadonlySet<string>;
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'Time unavailable';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isGroupedWithPrevious(message: ChatMessage, previous?: ChatMessage): boolean {
  if (!previous || message.type !== 'text' || previous.type !== 'text') return false;
  if (message.senderId !== previous.senderId || message.conversationId !== previous.conversationId) return false;
  const timeGap = new Date(message.timestamp).getTime() - new Date(previous.timestamp).getTime();
  return timeGap >= 0 && timeGap <= 5 * 60 * 1000;
}

function deliveryLabel(status: ChatMessage['deliveryStatus'], transportMode: TransportMode): string {
  switch (status) {
    case 'sending': return 'Sending';
    case 'sent': return transportMode === 'local-demo' ? 'Accepted by local demo' : 'Sent';
    case 'delivered': return transportMode === 'local-demo' ? 'Delivered · simulated' : 'Delivered';
    case 'read': return transportMode === 'local-demo' ? 'Read · simulated' : 'Read';
    case 'failed': return 'Not sent';
  }
}

function isAcceptedMessage(message: ChatMessage): boolean {
  return !message.isDeleted && ['text', 'voice'].includes(message.type) && message.deliveryStatus !== 'sending' && message.deliveryStatus !== 'failed';
}

export function MessageList({
  messages,
  currentUserId,
  currentUserName = 'You',
  active = true,
  canEditMessage = true,
  onRetryMessage,
  canRetryMessage,
  onReplyMessage,
  onEditMessage,
  onDeleteMessage,
  onUnsendMessage,
  onTogglePin,
  onToggleReaction,
  onAIMessage,
  onForwardMessage,
  transportMode = 'local-demo',
  verifiedMessageIds,
}: MessageListProps) {
  const historyRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);
  const previousLength = useRef(messages.length);
  const previousPage = useRef({ first: messages[0]?.id, last: messages.at(-1)?.id, height: 0 });
  const initialScrollHandled = useRef(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const { enteringIds, finishEntry } = useMessageEntryMotion(messages, active);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editError, setEditError] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const editLock = useRef(false);
  const saveEdit = async (messageId: string) => {
    if (!editDraft.trim() || editLock.current || !canEditMessage || !onEditMessage) return;
    editLock.current = true;
    setSavingEdit(true);
    setEditError('');
    try {
      if (await onEditMessage(messageId, editDraft) === false) {
        setEditError('Could not edit this message. Your original message is unchanged.');
        return;
      }
      setEditingId(null);
    } catch {
      setEditError('Could not edit this message. Your original message is unchanged.');
    } finally {
      editLock.current = false;
      setSavingEdit(false);
    }
  };
  const [unsendingMessage, setUnsendingMessage] = useState<ChatMessage | null>(null);
  const [removing, setRemoving] = useState(false);
  const removalLock = useRef(false);
  const [actionFeedback, setActionFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const remove = async (messageId: string, scope: UnsendScope): Promise<boolean> => {
    const message = messages.find(candidate => candidate.id === messageId);
    const handler = scope === 'everyone' ? onUnsendMessage : onDeleteMessage;
    if (removalLock.current || !message || !handler || (scope === 'everyone' && (message.senderId !== currentUserId || !isAcceptedMessage(message)))) return false;
    removalLock.current = true; setRemoving(true); setActionFeedback(null);
    try {
      if (await handler(messageId) === false) return false;
      setActionFeedback({ error: false, text: scope === 'me' ? 'Message deleted for you on this device.'
        : transportMode === 'local-demo' ? 'Message unsent in this local demo only.' : 'Message unsent for everyone.' });
      return true;
    } catch {
      return false;
    } finally {
      removalLock.current = false; setRemoving(false);
    }
  };
  const deleteIncoming = async (messageId: string) => {
    if (!await remove(messageId, 'me')) setActionFeedback({ error: true, text: 'Could not delete this message for you. Your message is unchanged. Try again.' });
  };
  const [pinsOpen, setPinsOpen] = useState(false);
  const pinsButton = useRef<HTMLButtonElement>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [replyNotice, setReplyNotice] = useState('');
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (highlightTimer.current !== null) clearTimeout(highlightTimer.current);
  }, []);
  const navigateToMessage = (messageId: string, conversationId: string, kind = 'original') => {
    const original = messages.find(candidate => candidate.id === messageId && candidate.conversationId === conversationId);
    const row = Array.from(historyRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])
      .find(element => element.dataset.messageId === original?.id);
    if (!original || original.isDeleted || !row) {
      setHighlightedId(null);
      setReplyNotice(original?.isDeleted ? `The ${kind} message was deleted.` : `The ${kind} message is unavailable in the loaded history.`);
      return;
    }
    setReplyNotice('');
    row.scrollIntoView?.({ block: 'center', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    row.focus({ preventScroll: true });
    setHighlightedId(original.id);
    if (highlightTimer.current !== null) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightedId(null), 2000);
  };

  // Reaction picker (quick bar -> expanded grid) and "more" menu: only one open at a time.
  const [pickerOpenId, setPickerOpenId] = useState<string | null>(null);
  const [pickerExpanded, setPickerExpanded] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restorePopoverFocus = useRef(false);
  const popoverId = useId();

  const pinnedMessages = messages.filter((m) => m.isPinned && !m.isDeleted);
  useEffect(() => {
    if (!active || pinnedMessages.length === 0) {
      setPinsOpen(false);
      if (active && pinsOpen) historyRef.current?.focus({ preventScroll: true });
    }
  }, [active, pinnedMessages.length, pinsOpen]);

  const closePopovers = useCallback((restoreFocus = false) => {
    restorePopoverFocus.current = restoreFocus;
    setPickerOpenId(null);
    setPickerExpanded(false);
    setMenuOpenId(null);
  }, []);

  const openPopover = pickerOpenId ? `reaction:${pickerOpenId}:${pickerExpanded}` : menuOpenId ? `menu:${menuOpenId}` : null;
  useAnchoredMessagePopover(popoverRef, popoverTriggerRef, openPopover, closePopovers, pickerExpanded, historyRef);

  useEffect(() => {
    if (!pickerOpenId && !menuOpenId) {
      if (restorePopoverFocus.current) {
        restorePopoverFocus.current = false;
        (popoverTriggerRef.current?.isConnected ? popoverTriggerRef.current : historyRef.current)?.focus({ preventScroll: true });
      }
      return;
    }
    if (!active) { closePopovers(); return; }
    const panel = popoverRef.current;
    panel?.querySelector<HTMLElement>('input[type="search"], button:not(:disabled)')?.focus({ preventScroll: true });
  }, [active, pickerOpenId, menuOpenId, pickerExpanded, closePopovers]);

  useEffect(() => {
    const id = pickerOpenId ?? menuOpenId;
    if (id && !messages.some((message) => message.id === id && !message.isDeleted)) closePopovers(true);
  }, [messages, pickerOpenId, menuOpenId, closePopovers]);

  const handlePopoverKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.closest('.emoji-picker')) return;
    const panel = event.currentTarget;
    if (event.key === 'Tab') {
      event.preventDefault();
      const trigger = popoverTriggerRef.current;
      const controls = Array.from(document.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex]'))
        .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[hidden], [inert]') &&
          !panel.contains(element) && element.getClientRects().length > 0);
      const next = controls[controls.indexOf(trigger!) + (event.shiftKey ? -1 : 1)];
      closePopovers();
      (next ?? trigger ?? historyRef.current)?.focus({ preventScroll: true });
      return;
    }
    const items = Array.from(panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = pickerExpanded && (event.key === 'ArrowDown' || event.key === 'ArrowUp') ? 6 : 1;
    let next: number | undefined;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + step) % items.length;
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - step + items.length) % items.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = items.length - 1;
    if (next !== undefined && items.length) { event.preventDefault(); items[next]?.focus({ preventScroll: true }); }
  };

  useEffect(() => {
    const history = historyRef.current;
    if (!initialScrollHandled.current) {
      initialScrollHandled.current = true;
      previousLength.current = messages.length;
      previousPage.current = { first: messages[0]?.id, last: messages.at(-1)?.id, height: history?.scrollHeight ?? 0 };
      if (messages.length > 0 && history) {
        history.scrollTop = history.scrollHeight;
        isNearBottom.current = true;
      }
      return;
    }

    const addedCount = messages.length - previousLength.current;
    const prepended = addedCount > 0 && previousPage.current.first && messages[0]?.id !== previousPage.current.first && messages.at(-1)?.id === previousPage.current.last;
    if (prepended && history) {
      history.scrollTop += Math.max(0, history.scrollHeight - previousPage.current.height);
    } else if (addedCount > 0) {
      if (isNearBottom.current) {
        if (history) history.scrollTop = history.scrollHeight;
        setNewMessageCount(0);
      } else {
        setNewMessageCount((count) => count + addedCount);
      }
    }
    previousLength.current = messages.length;
    previousPage.current = { first: messages[0]?.id, last: messages.at(-1)?.id, height: history?.scrollHeight ?? 0 };
  }, [messages]);

  const updateViewportPosition = () => {
    closePopovers();
    const history = historyRef.current;
    if (!history) return;
    isNearBottom.current = history.scrollHeight - history.scrollTop - history.clientHeight <= 72;
    if (isNearBottom.current) setNewMessageCount(0);
  };

  const jumpToLatest = () => {
    const history = historyRef.current;
    if (history) history.scrollTop = history.scrollHeight;
    isNearBottom.current = true;
    setNewMessageCount(0);
  };

  const react = (messageId: string, emoji: string, remember = true) => {
    if (remember) rememberEmoji(emoji);
    onToggleReaction?.(messageId, emoji);
    closePopovers(true);
  };

  return (
    <div className="chat-history-wrap">
      {pinnedMessages.length > 0 && (
        <div className="pinned-messages-bar" style={{ padding: '6px 12px', background: 'rgba(139, 92, 246, 0.12)', borderBottom: '1px solid rgba(139, 92, 246, 0.25)', fontSize: '0.82rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <div className="pinned-message-summary">
            <Pin size={14} aria-hidden="true" />
            <strong>Pinned ({pinnedMessages.length}):</strong>
            <button type="button" className="pinned-message-preview" aria-label="Go to latest pinned message"
              onClick={() => { const message = pinnedMessages[pinnedMessages.length - 1]!; navigateToMessage(message.id, message.conversationId, 'pinned'); }}>
              {pinnedMessages[pinnedMessages.length - 1]?.content}
            </button>
          </div>
          <Button ref={pinsButton} size="sm" variant="ghost" aria-expanded={pinsOpen} aria-controls={`${popoverId}-pins`} onClick={() => setPinsOpen(open => !open)}>
            View pinned messages
          </Button>
          {onTogglePin && (
            <Button size="sm" variant="outline" onClick={() => {
              onTogglePin(pinnedMessages[pinnedMessages.length - 1]!.id);
              if (pinnedMessages.length === 1) historyRef.current?.focus({ preventScroll: true });
            }}>
              Unpin
            </Button>
          )}
        </div>
      )}
      {pinsOpen && pinnedMessages.length > 0 && <section id={`${popoverId}-pins`} className="pinned-messages-panel" aria-label="Pinned messages"
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setPinsOpen(false); pinsButton.current?.focus(); } }}>
        {transportMode === 'local-demo' && <p className="pinned-messages-notice">Pins apply only to this local demo.</p>}
        <ul className="pinned-messages-list">
          {pinnedMessages.map(message => <li key={message.id}>
            <button type="button" className="pinned-message-link" onClick={() => { setPinsOpen(false); navigateToMessage(message.id, message.conversationId, 'pinned'); }}>
              <strong>{message.senderId === currentUserId ? currentUserName : message.senderName}</strong>
              <span>{message.content}</span>
            </button>
            {onTogglePin && <Button size="sm" variant="outline" aria-label={`Unpin message: ${message.content.slice(0, 60)}`} onClick={() => onTogglePin(message.id)}>Unpin</Button>}
          </li>)}
        </ul>
      </section>}
      <Surface
        ref={historyRef}
        variant="default"
        className="chat-history"
        role="log"
        aria-label="Chat messages"
        aria-live="polite"
        onScroll={updateViewportPosition}
        tabIndex={0}
      >
        {messages.length === 0 ? (
          <div className="chat-empty-state">
            <div className="chat-empty-atmosphere" aria-hidden="true" />
            <div className="chat-empty-brand-stage">
              <BrandLogo variant="full" size="lg" className="chat-empty-logo" />
            </div>
            <h2 className="display-heading display-heading--empty">No messages yet</h2>
            <p>{transportMode === 'local-demo'
              ? 'A little hello starts a conversation. Try it in this local demo.'
              : 'Write a message to start this conversation.'}</p>
          </div>
        ) : (
          <div className="message-list">
            {messages.map((message, index) => {
              const previous = messages[index - 1];
              const grouped = isGroupedWithPrevious(message, previous);
              const isOutgoing = message.senderId === currentUserId;

              if (message.type === 'system') {
                return (
                  <article className="message-system" key={message.id} role="note" data-message-id={message.id}>
                    <span>{message.content}</span>
                    <time dateTime={message.timestamp} title={new Date(message.timestamp).toLocaleString()}>
                      {formatTime(message.timestamp)}
                    </time>
                  </article>
                );
              }

              if (message.type === 'security_alert') {
                return (
                  <article className="message-security-alert" key={message.id} role="alert" data-message-id={message.id}>
                    <AlertTriangle size={18} aria-hidden="true" />
                    <div className="message-security-copy">
                      <strong>{message.senderName}</strong>
                      <p>{message.content}</p>
                      <time dateTime={message.timestamp} title={new Date(message.timestamp).toLocaleString()}>
                        {formatTime(message.timestamp)}
                      </time>
                    </div>
                  </article>
                );
              }

              const hasReactions = !message.isDeleted && !!message.reactions && message.reactions.length > 0;
              const isPickerOpen = pickerOpenId === message.id;
              const isMenuOpen = menuOpenId === message.id;
              const myReactions = new Set(
                (message.reactions ?? []).filter((r) => r.userIds.includes(currentUserId)).map((r) => r.emoji),
              );
              const canShareWithAI = Boolean(onAIMessage && message.type === 'text' && !message.isDeleted && message.content.trim() && message.content.length <= AI_MAX_INPUT);
              const emojiCount = message.type === 'text' && !message.isDeleted && !message.attachments?.length && !message.voice ? emojiOnlyCount(message.content) : 0;
              const accepted = isAcceptedMessage(message);
              const canEdit = Boolean(isOutgoing && onEditMessage && canEditMessage && message.type === 'text' && accepted);
              const canUnsend = Boolean(isOutgoing && onUnsendMessage && accepted);
              const canDelete = Boolean(onDeleteMessage && !message.isDeleted);
              const canForward = Boolean(onForwardMessage && accepted);
              const canPin = Boolean(onTogglePin && (accepted || message.isPinned));
              const canReact = Boolean(onToggleReaction && accepted);
              const canShowMenu = !!(canShareWithAI || canForward || canPin || canEdit || canDelete || canUnsend);
              const originalReply = message.replyTo && messages.find(candidate => candidate.id === message.replyTo?.messageId && candidate.conversationId === message.conversationId);

              return (
                <article
                  className={`message-row ${isOutgoing ? 'message-row-outgoing' : ''} ${grouped ? 'message-row-grouped' : ''}`}
                  key={message.id}
                  data-message-id={message.id}
                  data-message-highlighted={highlightedId === message.id && !message.isDeleted ? 'true' : undefined}
                  tabIndex={-1}
                  data-message-enter={active && enteringIds.has(message.id) ? 'true' : undefined}
                  onAnimationEnd={(event) => {
                    if (event.target === event.currentTarget) finishEntry(message.id);
                  }}
                >
                  <div className="message-meta">
                    {!grouped && <strong>{isOutgoing ? currentUserName === 'You' ? 'You' : `${currentUserName} (You)` : message.senderName}</strong>}
                    <time dateTime={message.timestamp} title={new Date(message.timestamp).toLocaleString()}>
                      {formatTime(message.timestamp)}
                    </time>
                    {message.isEdited && !message.isDeleted && <span style={{ fontSize: '0.72rem', opacity: 0.7 }}>(edited)</span>}
                    {message.isPinned && !message.isDeleted && <Pin size={12} aria-label="Pinned message" />}
                  </div>

                  {message.replyTo && !message.isDeleted && (
                    <button type="button" className="message-reply-quote" onClick={() => navigateToMessage(message.replyTo!.messageId, message.conversationId)}
                      aria-label={`Go to original message from ${message.replyTo.senderName}`}>
                      <strong>Replying to {message.replyTo.senderName}: </strong>
                      <span>{originalReply?.isDeleted ? 'Original message deleted.' : !originalReply ? 'Original message unavailable.' : message.replyTo.contentSnippet}</span>
                    </button>
                  )}

                  <div className="message-content-row">
                    {editingId === message.id && canEdit ? (
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', width: '100%' }}>
                        <textarea
                          aria-label="Edit message"
                          rows={3}
                          value={editDraft}
                          disabled={savingEdit}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
                              e.preventDefault(); void saveEdit(message.id);
                            } else if (e.key === 'Escape' && !editLock.current) { setEditingId(null); setEditError(''); }
                          }}
                          style={{ flex: 1, minWidth: 0, maxHeight: '14rem', resize: 'vertical', padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(139,92,246,0.5)', background: 'rgba(0,0,0,0.25)', color: 'inherit', font: 'inherit' }}
                          autoFocus
                        />
                        <Button size="sm" variant="primary" aria-label="Save edit" loading={savingEdit} disabled={!editDraft.trim()} onClick={() => void saveEdit(message.id)}>
                          <Check size={14} />
                        </Button>
                        <Button size="sm" variant="outline" aria-label="Cancel edit" disabled={savingEdit} onClick={() => { setEditingId(null); setEditError(''); }}>
                          <X size={14} />
                        </Button>
                        {editError && <span role="alert" style={{ color: 'var(--color-error)', fontSize: '0.75rem' }}>{editError}</span>}
                      </div>
                    ) : (
                      <div className={`msg-bubble-wrap ${hasReactions ? 'msg-bubble-wrap--has-reactions' : ''}`}>
                        <div className="message-bubble" style={message.isDeleted ? { fontStyle: 'italic', opacity: 0.6 } : undefined}>
                          {message.forwardedFrom && (
                            <span className="message-forwarded-label">
                              <Forward size={12} aria-hidden="true" /> Forwarded from {message.forwardedFrom}
                            </span>
                          )}
                          <span className={emojiCount ? 'message-text message-text--emoji' : 'message-text'} data-emoji-count={emojiCount || undefined}>{message.content}</span>

                          {!message.isDeleted && message.attachments && message.attachments.length > 0 && (
                            <div className="message-attachments">
                              {message.attachments.map((attachment) => <MessageAttachmentView key={attachment.id} attachment={attachment} ownerId={currentUserId} conversationId={message.conversationId} />)}
                            </div>
                          )}

                          {!message.isDeleted && message.voice && (
                            <div style={{ marginTop: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <Mic size={14} style={{ flexShrink: 0 }} />
                              <audio controls preload="metadata" aria-label={`Voice message from ${isOutgoing ? currentUserName : message.senderName}`} src={message.voice.audioUrl} style={{ height: '28px', maxWidth: '200px', minWidth: 0 }} />
                              <span style={{ fontSize: '0.75rem', whiteSpace: 'nowrap', flexShrink: 0 }}>{message.voice.durationSeconds}s</span>
                            </div>
                          )}
                        </div>

                        {hasReactions && (
                          <div className="rx-summary">
                            {message.reactions!.map((reaction) => {
                              const reactedByMe = reaction.userIds.includes(currentUserId);
                              return (
                                <button
                                  key={reaction.emoji}
                                  type="button"
                                  className="rx-pill"
                                  aria-pressed={reactedByMe}
                                  aria-label={`${reaction.emoji} ${reaction.userIds.length}`}
                                  aria-describedby={`${popoverId}-${message.id}-${encodeURIComponent(reaction.emoji)}-description`}
                                  disabled={!canReact}
                                  onClick={() => { rememberEmoji(reaction.emoji); onToggleReaction?.(message.id, reaction.emoji); }}
                                >
                                  <span>{reaction.emoji}</span>
                                  <span className="sr-only" id={`${popoverId}-${message.id}-${encodeURIComponent(reaction.emoji)}-description`}>
                                    {emojiName(reaction.emoji)}. {reactedByMe ? 'Your reaction; activate to remove it.' : 'Activate to use this reaction.'}
                                  </span>
                                  {reaction.userIds.length > 1 && (
                                    <span className="rx-pill-count">{reaction.userIds.length}</span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        )}

                        {!message.isDeleted && (
                          <div className="msg-toolbar" data-popover data-open={isPickerOpen || isMenuOpen}>
                            {canReact && (
                              <div style={{ position: 'relative' }}>
                                <button
                                  type="button"
                                  className="msg-icon-btn"
                                  title="React"
                                  aria-label="React to message"
                                  aria-haspopup={isPickerOpen && pickerExpanded ? 'dialog' : 'menu'}
                                  aria-expanded={isPickerOpen}
                                  aria-controls={isPickerOpen ? `${popoverId}-${message.id}-reactions` : undefined}
                                  onClick={(event) => {
                                    popoverTriggerRef.current = event.currentTarget;
                                    setMenuOpenId(null);
                                    setPickerExpanded(false);
                                    setPickerOpenId(isPickerOpen ? null : message.id);
                                  }}
                                >
                                  <SmilePlus size={16} aria-hidden="true" />
                                </button>

                                {isPickerOpen && (
                                  <div id={`${popoverId}-${message.id}-reactions`} ref={popoverRef} onKeyDown={handlePopoverKeyDown} className={`rx-popover ${pickerExpanded ? 'emoji-picker-panel' : 'rx-bar'}`} role={pickerExpanded ? 'dialog' : 'menu'} aria-label="Choose a reaction">
                                    {pickerExpanded ? (
                                      <EmojiPicker reaction selected={myReactions} onSelect={emoji => react(message.id, emoji, false)} onClose={() => closePopovers(true)} />
                                    ) : (
                                      <>
                                        {QUICK_EMOJIS.map((emoji) => (
                                          <button
                                            key={emoji}
                                            type="button"
                                            className="rx-emoji-btn"
                                            role="menuitemcheckbox"
                                            aria-checked={myReactions.has(emoji)}
                                            aria-label={`React ${emoji}`}
                                            onClick={() => react(message.id, emoji)}
                                            title={`React with ${emojiName(emoji)} ${emoji}`}
                                          >
                                            {emoji}
                                          </button>
                                        ))}
                                        <button
                                          type="button"
                                          className="rx-more-btn"
                                          role="menuitem"
                                          title="More reactions"
                                          aria-label="More reactions"
                                          onClick={() => setPickerExpanded(true)}
                                        >
                                          <Plus size={16} aria-hidden="true" />
                                        </button>
                                      </>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}

                            {onReplyMessage && accepted && (
                              <button type="button" className="msg-icon-btn" title="Reply" aria-label="Reply" onClick={() => onReplyMessage(message)}>
                                <Reply size={16} aria-hidden="true" />
                              </button>
                            )}

                            {canShowMenu && (
                              <div style={{ position: 'relative' }}>
                                <button
                                  type="button"
                                  className="msg-icon-btn"
                                  title="More"
                                  aria-label="More actions"
                                  aria-haspopup="menu"
                                  aria-expanded={isMenuOpen}
                                  aria-controls={isMenuOpen ? `${popoverId}-${message.id}-actions` : undefined}
                                  onClick={(event) => {
                                    popoverTriggerRef.current = event.currentTarget;
                                    setPickerOpenId(null);
                                    setPickerExpanded(false);
                                    setMenuOpenId(isMenuOpen ? null : message.id);
                                  }}
                                >
                                  <MoreHorizontal size={16} aria-hidden="true" />
                                </button>

                                {isMenuOpen && (
                                  <div id={`${popoverId}-${message.id}-actions`} ref={popoverRef} onKeyDown={handlePopoverKeyDown} className="rx-popover msg-menu" role="menu" aria-label="Message actions">
                                    {canShareWithAI && (['chat', 'summarize', 'translate', 'explain'] as const).map(task => (
                                      <button key={task} type="button" role="menuitem" className="msg-menu-item" onClick={() => { onAIMessage?.(task, message.id); closePopovers(); }}>
                                        <Sparkles size={14} aria-hidden="true" />{task === 'chat' ? 'Ask @Secu' : `${task === 'summarize' ? 'Summarize' : task === 'translate' ? 'Translate' : 'Explain'} selected message`}
                                      </button>
                                    ))}
                                    {canForward && (
                                      <button type="button" role="menuitem" className="msg-menu-item" onClick={() => { onForwardMessage?.(message); closePopovers(true); }}>
                                        <Forward size={14} aria-hidden="true" /> Forward
                                      </button>
                                    )}
                                    {canPin && (
                                      <button type="button" role="menuitem" className="msg-menu-item" onClick={() => { onTogglePin?.(message.id); closePopovers(true); }}>
                                        <Pin size={14} aria-hidden="true" /> {message.isPinned ? 'Unpin' : 'Pin'}
                                      </button>
                                    )}
                                    {canEdit && (
                                      <button
                                        type="button"
                                        role="menuitem"
                                        className="msg-menu-item"
                                        disabled={savingEdit}
                                        onClick={() => { setEditingId(message.id); setEditDraft(message.content); setEditError(''); closePopovers(); }}
                                      >
                                        <Edit2 size={14} aria-hidden="true" /> Edit
                                      </button>
                                    )}
                                    {canDelete && (!isOutgoing || !canUnsend) && (
                                      <button type="button" role="menuitem" className="msg-menu-item" disabled={removing} onClick={() => {
                                        closePopovers(true);
                                        if (isOutgoing) setUnsendingMessage(message); else void deleteIncoming(message.id);
                                      }}>
                                        <Trash2 size={14} aria-hidden="true" /> Delete for me
                                      </button>
                                    )}
                                    {canUnsend && (
                                      <button
                                        type="button"
                                        role="menuitem"
                                        className="msg-menu-item msg-menu-item--danger"
                                        disabled={removing}
                                        onClick={() => { closePopovers(); setUnsendingMessage(message); }}
                                      >
                                        <Undo2 size={14} aria-hidden="true" /> Unsend
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {isOutgoing && message.deliveryStatus === 'failed' && (
                      <Button size="sm" variant="outline" disabled={canRetryMessage ? !canRetryMessage(message.id) : false} onClick={() => onRetryMessage(message.id)}>
                        {canRetryMessage && !canRetryMessage(message.id) ? 'Retry unavailable' : 'Retry'}
                      </Button>
                    )}
                  </div>

                  {(message.encryption || verifiedMessageIds?.has(message.id) || message.demoOnly || isOutgoing) && (
                    <div className="message-status-line">
                      {message.encryption && (
                        <Badge status="success" aria-label="Encrypted in this browser demo">
                          <LockKeyhole size={12} aria-hidden="true" />
                          Encrypted locally
                        </Badge>
                      )}
                      {verifiedMessageIds?.has(message.id) && <Badge status="success" aria-label="End-to-end encrypted message"><LockKeyhole size={12} aria-hidden="true" />Encrypted</Badge>}
                      {message.demoOnly && <Badge status="info">Demo reply</Badge>}
                      {isOutgoing && <span className={`message-delivery message-delivery--${message.deliveryStatus}`}>
                        {deliveryLabel(message.deliveryStatus, transportMode)}
                      </span>}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </Surface>
      {actionFeedback && <p className={actionFeedback.error ? 'composer-error' : 'message-action-feedback'} role={actionFeedback.error ? 'alert' : 'status'}>{actionFeedback.text}</p>}
      {replyNotice && <p className="composer-error" role="status">{replyNotice}</p>}
      {newMessageCount > 0 && (
        <div className="chat-scroll-notice">
          <Button size="sm" variant="secondary" onClick={jumpToLatest} trailingIcon={<ArrowDown size={14} aria-hidden="true" />}>
            {newMessageCount} new {newMessageCount === 1 ? 'message' : 'messages'} — latest
          </Button>
        </div>
      )}
        <UnsendDialog
          message={unsendingMessage}
          canUnsendEveryone={Boolean(onUnsendMessage && unsendingMessage && unsendingMessage.senderId === currentUserId && isAcceptedMessage(unsendingMessage))}
          canDeleteForMe={Boolean(onDeleteMessage)}
          localOnly={transportMode === 'local-demo'}
          onClose={() => setUnsendingMessage(null)}
          onConfirm={scope => unsendingMessage ? remove(unsendingMessage.id, scope) : Promise.resolve(false)}
      />
    </div>
  );
}
