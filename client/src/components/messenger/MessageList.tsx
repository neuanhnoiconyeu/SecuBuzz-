import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  AlertTriangle, ArrowDown, Check, Edit2, FileText, LockKeyhole, Mic, MoreHorizontal,
  Pin, Plus, Reply, SmilePlus, Trash2, X,
} from 'lucide-react';
import { BrandLogo } from '@/components/branding';
import { Badge, Button, Surface } from '@/components/ui';
import type { ChatMessage, TransportMode } from '@/messaging/messageModel';
import { useMessageEntryMotion } from './useMessageEntryMotion';
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
  onEditMessage?: (messageId: string, newContent: string) => void;
  onDeleteMessage?: (messageId: string) => void;
  onTogglePin?: (messageId: string) => void;
  onToggleReaction?: (messageId: string, emoji: string) => void;
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

/** Same 6 quick reactions as Messenger. */
const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '😡'];
const MORE_EMOJIS = [
  '🔥', '🎉', '👏', '💯', '🙏', '👀',
  '🤔', '🥰', '😎', '🥳', '😭', '🤯',
  '🫡', '🤝', '🚀', '💜', '✨', '⚡',
  '💀', '🤡', '👻', '🎃', '🍀', '☕',
];

export function MessageList({
  messages,
  currentUserId,
  currentUserName = 'You',
  active = true,
  onRetryMessage,
  canRetryMessage,
  onReplyMessage,
  onEditMessage,
  onDeleteMessage,
  onTogglePin,
  onToggleReaction,
  transportMode = 'local-demo',
}: MessageListProps) {
  const historyRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);
  const previousLength = useRef(messages.length);
  const initialScrollHandled = useRef(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const { enteringIds, finishEntry } = useMessageEntryMotion(messages, active);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  // Reaction picker (quick bar -> expanded grid) and "more" menu: only one open at a time.
  const [pickerOpenId, setPickerOpenId] = useState<string | null>(null);
  const [pickerExpanded, setPickerExpanded] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restorePopoverFocus = useRef(false);
  const popoverId = useId();

  const pinnedMessages = messages.filter((m) => m.isPinned && !m.isDeleted);

  const closePopovers = useCallback((restoreFocus = false) => {
    restorePopoverFocus.current = restoreFocus;
    setPickerOpenId(null);
    setPickerExpanded(false);
    setMenuOpenId(null);
  }, []);

  // Keep the teammate's popovers inside the visible message scroller, including
  // the first/last message and narrow screens. They stay in the disabled fieldset.
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
    const trigger = popoverTriggerRef.current;
    const history = historyRef.current;
    if (!panel || !trigger || !history) return;
    const bounds = history.getBoundingClientRect();
    const anchor = trigger.getBoundingClientRect();
    const origin = panel.offsetParent?.getBoundingClientRect();
    if (origin && bounds.width && bounds.height) {
      panel.style.maxWidth = `${Math.max(1, bounds.width - 16)}px`;
      panel.style.maxHeight = `${Math.max(1, bounds.height - 16)}px`;
      const width = Math.min(panel.offsetWidth, bounds.width - 16);
      const height = Math.min(panel.offsetHeight, bounds.height - 16);
      const left = Math.max(bounds.left + 8, Math.min(anchor.left, bounds.right - width - 8));
      const preferredTop = anchor.top - height - 8 >= bounds.top + 8 ? anchor.top - height - 8 : anchor.bottom + 8;
      const top = Math.max(bounds.top + 8, Math.min(preferredTop, bounds.bottom - height - 8));
      Object.assign(panel.style, { left: `${left - origin.left}px`, top: `${top - origin.top}px`, right: 'auto', bottom: 'auto',
        maxWidth: `${Math.max(1, bounds.width - 16)}px`, maxHeight: `${Math.max(1, bounds.height - 16)}px`, overflowY: 'auto' });
    }
    panel.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [active, pickerOpenId, menuOpenId, pickerExpanded, closePopovers]);

  useEffect(() => {
    const id = pickerOpenId ?? menuOpenId;
    if (id && !messages.some((message) => message.id === id && !message.isDeleted)) closePopovers(true);
  }, [messages, pickerOpenId, menuOpenId, closePopovers]);

  // Pointer events cover mouse, touch and pen. Menus never outlive navigation.
  useEffect(() => {
    if (!pickerOpenId && !menuOpenId) return;
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !popoverRef.current?.contains(e.target) && !popoverTriggerRef.current?.contains(e.target)) closePopovers();
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closePopovers(true); }
    };
    const onResize = () => closePopovers();
    window.addEventListener('resize', onResize);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [pickerOpenId, menuOpenId, closePopovers]);

  const handlePopoverKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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
      if (messages.length > 0 && history) {
        history.scrollTop = history.scrollHeight;
        isNearBottom.current = true;
      }
      return;
    }

    const addedCount = messages.length - previousLength.current;
    if (addedCount > 0) {
      if (isNearBottom.current) {
        if (history) history.scrollTop = history.scrollHeight;
        setNewMessageCount(0);
      } else {
        setNewMessageCount((count) => count + addedCount);
      }
    }
    previousLength.current = messages.length;
  }, [messages.length]);

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

  const react = (messageId: string, emoji: string) => {
    onToggleReaction?.(messageId, emoji);
    closePopovers(true);
  };

  return (
    <div className="chat-history-wrap">
      {pinnedMessages.length > 0 && (
        <div className="pinned-messages-bar" style={{ padding: '6px 12px', background: 'rgba(139, 92, 246, 0.12)', borderBottom: '1px solid rgba(139, 92, 246, 0.25)', fontSize: '0.82rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            <Pin size={14} aria-hidden="true" />
            <strong>Pinned ({pinnedMessages.length}):</strong>
            <span>{pinnedMessages[pinnedMessages.length - 1]?.content}</span>
          </div>
          {onTogglePin && (
            <Button size="sm" variant="outline" onClick={() => onTogglePin(pinnedMessages[pinnedMessages.length - 1]!.id)}>
              Unpin
            </Button>
          )}
        </div>
      )}
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
              const canShowMenu = !!(onTogglePin || (isOutgoing && (onEditMessage || onDeleteMessage)));

              return (
                <article
                  className={`message-row ${isOutgoing ? 'message-row-outgoing' : ''} ${grouped ? 'message-row-grouped' : ''}`}
                  key={message.id}
                  data-message-id={message.id}
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
                    <div className="message-reply-quote" style={{ fontSize: '0.78rem', padding: '4px 8px', marginBottom: '4px', borderLeft: '3px solid #8b5cf6', background: 'rgba(255,255,255,0.04)', borderRadius: '4px', opacity: 0.85 }}>
                      <strong>Replying to {message.replyTo.senderName}: </strong>
                      <span>{message.replyTo.contentSnippet}</span>
                    </div>
                  )}

                  <div className="message-content-row">
                    {editingId === message.id ? (
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', width: '100%' }}>
                        <input
                          aria-label="Edit message"
                          type="text"
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && editDraft.trim()) {
                              onEditMessage?.(message.id, editDraft);
                              setEditingId(null);
                            } else if (e.key === 'Escape') {
                              setEditingId(null);
                            }
                          }}
                          style={{ flex: 1, padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(139,92,246,0.5)', background: 'rgba(0,0,0,0.25)', color: 'inherit' }}
                          autoFocus
                        />
                        <Button size="sm" variant="primary" aria-label="Save edit" onClick={() => { onEditMessage?.(message.id, editDraft); setEditingId(null); }}>
                          <Check size={14} />
                        </Button>
                        <Button size="sm" variant="outline" aria-label="Cancel edit" onClick={() => setEditingId(null)}>
                          <X size={14} />
                        </Button>
                      </div>
                    ) : (
                      <div className={`msg-bubble-wrap ${hasReactions ? 'msg-bubble-wrap--has-reactions' : ''}`}>
                        <div className="message-bubble" style={message.isDeleted ? { fontStyle: 'italic', opacity: 0.6 } : undefined}>
                          {message.content}

                          {!message.isDeleted && message.attachments && message.attachments.length > 0 && (
                            <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              {message.attachments.map((att) =>
                                att.type === 'image' ? (
                                  <img key={att.id} src={att.url} alt={att.name} style={{ maxWidth: '220px', borderRadius: '6px', marginTop: '4px' }} />
                                ) : (
                                  <a key={att.id} href={att.url} download={att.name} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem', textDecoration: 'underline' }}>
                                    <FileText size={14} /> {att.name} ({Math.round(att.sizeBytes / 1024)} KB)
                                  </a>
                                )
                              )}
                            </div>
                          )}

                          {!message.isDeleted && message.voice && (
                            <div style={{ marginTop: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <Mic size={14} />
                              <audio controls src={message.voice.audioUrl} style={{ height: '28px', maxWidth: '200px' }} />
                              <span style={{ fontSize: '0.75rem' }}>{message.voice.durationSeconds}s</span>
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
                                  disabled={!onToggleReaction}
                                  onClick={() => onToggleReaction?.(message.id, reaction.emoji)}
                                >
                                  <span>{reaction.emoji}</span>
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
                            {onToggleReaction && (
                              <div style={{ position: 'relative' }}>
                                <button
                                  type="button"
                                  className="msg-icon-btn"
                                  title="React"
                                  aria-label="React to message"
                                  aria-haspopup="menu"
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
                                  <div id={`${popoverId}-${message.id}-reactions`} ref={popoverRef} onKeyDown={handlePopoverKeyDown} className={`rx-popover ${pickerExpanded ? 'rx-grid-panel' : 'rx-bar'}`} role="menu" aria-label="Choose a reaction">
                                    {pickerExpanded ? (
                                      <div className="rx-grid">
                                        {[...QUICK_EMOJIS, ...MORE_EMOJIS].map((emoji) => (
                                          <button
                                            key={emoji}
                                            type="button"
                                            className="rx-emoji-btn"
                                            role="menuitemcheckbox"
                                            aria-checked={myReactions.has(emoji)}
                                            aria-label={`React ${emoji}`}
                                            onClick={() => react(message.id, emoji)}
                                            title={`React ${emoji}`}
                                          >
                                            {emoji}
                                          </button>
                                        ))}
                                      </div>
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
                                            title={`React ${emoji}`}
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

                            {onReplyMessage && (
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
                                    {onTogglePin && (
                                      <button type="button" role="menuitem" className="msg-menu-item" onClick={() => { onTogglePin(message.id); closePopovers(true); }}>
                                        <Pin size={14} aria-hidden="true" /> {message.isPinned ? 'Unpin' : 'Pin'}
                                      </button>
                                    )}
                                    {isOutgoing && onEditMessage && (
                                      <button
                                        type="button"
                                        role="menuitem"
                                        className="msg-menu-item"
                                        onClick={() => { setEditingId(message.id); setEditDraft(message.content); closePopovers(); }}
                                      >
                                        <Edit2 size={14} aria-hidden="true" /> Edit
                                      </button>
                                    )}
                                    {isOutgoing && onDeleteMessage && (
                                      <button type="button" role="menuitem" className="msg-menu-item msg-menu-item--danger" onClick={() => { onDeleteMessage(message.id); closePopovers(true); }}>
                                        <Trash2 size={14} aria-hidden="true" /> Delete
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

                  {(message.encryption || message.demoOnly || isOutgoing) && (
                    <div className="message-status-line">
                      {message.encryption && (
                        <Badge status="success" aria-label="Encrypted in this browser demo">
                          <LockKeyhole size={12} aria-hidden="true" />
                          Encrypted locally
                        </Badge>
                      )}
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
      {newMessageCount > 0 && (
        <div className="chat-scroll-notice">
          <Button size="sm" variant="secondary" onClick={jumpToLatest} trailingIcon={<ArrowDown size={14} aria-hidden="true" />}>
            {newMessageCount} new {newMessageCount === 1 ? 'message' : 'messages'} — latest
          </Button>
        </div>
      )}
    </div>
  );
}
