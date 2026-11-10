import { useCallback, useEffect, useRef, useState } from 'react';
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
    case 'delivered': return 'Delivered';
    case 'read': return 'Read';
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

  const pinnedMessages = messages.filter((m) => m.isPinned && !m.isDeleted);

  const closePopovers = useCallback(() => {
    setPickerOpenId(null);
    setPickerExpanded(false);
    setMenuOpenId(null);
  }, []);

  // Close popovers on outside click or Escape.
  useEffect(() => {
    if (!pickerOpenId && !menuOpenId) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-popover]')) closePopovers();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePopovers();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [pickerOpenId, menuOpenId, closePopovers]);

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
    closePopovers();
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
                        <Button size="sm" variant="primary" onClick={() => { onEditMessage?.(message.id, editDraft); setEditingId(null); }}>
                          <Check size={14} />
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>
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
                                  aria-haspopup="true"
                                  aria-expanded={isPickerOpen}
                                  onClick={() => {
                                    setMenuOpenId(null);
                                    setPickerExpanded(false);
                                    setPickerOpenId(isPickerOpen ? null : message.id);
                                  }}
                                >
                                  <SmilePlus size={16} aria-hidden="true" />
                                </button>

                                {isPickerOpen && (
                                  <div className={`rx-popover ${pickerExpanded ? 'rx-grid-panel' : 'rx-bar'}`} role="menu" aria-label="Choose a reaction">
                                    {pickerExpanded ? (
                                      <div className="rx-grid">
                                        {[...QUICK_EMOJIS, ...MORE_EMOJIS].map((emoji) => (
                                          <button
                                            key={emoji}
                                            type="button"
                                            className="rx-emoji-btn"
                                            aria-pressed={myReactions.has(emoji)}
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
                                            aria-pressed={myReactions.has(emoji)}
                                            onClick={() => react(message.id, emoji)}
                                            title={`React ${emoji}`}
                                          >
                                            {emoji}
                                          </button>
                                        ))}
                                        <button
                                          type="button"
                                          className="rx-more-btn"
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
                                  onClick={() => {
                                    setPickerOpenId(null);
                                    setPickerExpanded(false);
                                    setMenuOpenId(isMenuOpen ? null : message.id);
                                  }}
                                >
                                  <MoreHorizontal size={16} aria-hidden="true" />
                                </button>

                                {isMenuOpen && (
                                  <div className="rx-popover msg-menu" role="menu">
                                    {onTogglePin && (
                                      <button type="button" role="menuitem" className="msg-menu-item" onClick={() => { onTogglePin(message.id); closePopovers(); }}>
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
                                      <button type="button" role="menuitem" className="msg-menu-item msg-menu-item--danger" onClick={() => { onDeleteMessage(message.id); closePopovers(); }}>
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
                      <Button size="sm" variant="outline" onClick={() => onRetryMessage(message.id)}>
                        Retry
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
