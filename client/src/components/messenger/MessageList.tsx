import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, Check, Edit2, FileText, LockKeyhole, Mic, Pin, Reply, Trash2, X } from 'lucide-react';
import { BrandLogo } from '@/components/branding';
import { Badge, Button, Surface } from '@/components/ui';
import type { ChatMessage, TransportMode } from '@/messaging/messageModel';
import { useMessageEntryMotion } from './useMessageEntryMotion';

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

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢'];

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
  const pinnedMessages = messages.filter((m) => m.isPinned && !m.isDeleted);

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
                    )}

                    {isOutgoing && message.deliveryStatus === 'failed' && (
                      <Button size="sm" variant="outline" disabled={canRetryMessage ? !canRetryMessage(message.id) : false} onClick={() => onRetryMessage(message.id)}>
                        {canRetryMessage && !canRetryMessage(message.id) ? 'Retry unavailable' : 'Retry'}
                      </Button>
                    )}
                  </div>

                  {!message.isDeleted && message.reactions && message.reactions.length > 0 && (
                    <div className="message-reactions-list" style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}>
                      {message.reactions.map((reaction) => {
                        const reactedByMe = reaction.userIds.includes(currentUserId);
                        return (
                          <button
                            key={reaction.emoji}
                            type="button"
                            onClick={() => onToggleReaction?.(message.id, reaction.emoji)}
                            style={{
                              padding: '2px 6px',
                              borderRadius: '12px',
                              fontSize: '0.75rem',
                              border: reactedByMe ? '1px solid #8b5cf6' : '1px solid rgba(255,255,255,0.15)',
                              background: reactedByMe ? 'rgba(139, 92, 246, 0.25)' : 'rgba(255,255,255,0.05)',
                              color: 'inherit',
                              cursor: 'pointer',
                            }}
                          >
                            {reaction.emoji} {reaction.userIds.length}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {!message.isDeleted && editingId !== message.id && (
                    <div className="message-actions-bar" style={{ display: 'flex', gap: '4px', alignItems: 'center', marginTop: '4px', opacity: 0.75, fontSize: '0.75rem', flexWrap: 'wrap' }}>
                      {onToggleReaction && QUICK_EMOJIS.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          onClick={() => onToggleReaction(message.id, emoji)}
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 4px', fontSize: '0.85rem' }}
                          title={`React ${emoji}`}
                        >
                          {emoji}
                        </button>
                      ))}
                      {onReplyMessage && (
                        <button type="button" onClick={() => onReplyMessage(message)} style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '2px', padding: '2px 4px' }} title="Reply">
                          <Reply size={12} /> Reply
                        </button>
                      )}
                      {onTogglePin && (
                        <button type="button" onClick={() => onTogglePin(message.id)} style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '2px', padding: '2px 4px' }} title="Pin/Unpin">
                          <Pin size={12} /> {message.isPinned ? 'Unpin' : 'Pin'}
                        </button>
                      )}
                      {isOutgoing && onEditMessage && (
                        <button
                          type="button"
                          onClick={() => { setEditingId(message.id); setEditDraft(message.content); }}
                          style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '2px', padding: '2px 4px' }}
                          title="Edit"
                        >
                          <Edit2 size={12} /> Edit
                        </button>
                      )}
                      {isOutgoing && onDeleteMessage && (
                        <button type="button" onClick={() => onDeleteMessage(message.id)} style={{ background: 'transparent', border: 'none', color: '#f87171', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '2px', padding: '2px 4px' }} title="Delete">
                          <Trash2 size={12} /> Delete
                        </button>
                      )}
                    </div>
                  )}

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
