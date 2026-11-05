import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, LockKeyhole } from 'lucide-react';
import { Badge, Button, Surface } from '@/components/ui';
import type { ChatMessage, TransportMode } from '@/messaging/messageModel';

export interface MessageListProps {
  messages: ChatMessage[];
  currentUserId: string;
  transportMode?: TransportMode;
  onRetryMessage(messageId: string): void;
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
    case 'failed': return 'Not sent';
  }
}

export function MessageList({
  messages,
  currentUserId,
  onRetryMessage,
  transportMode = 'local-demo',
}: MessageListProps) {
  const historyRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);
  const previousLength = useRef(messages.length);
  const initialScrollHandled = useRef(false);
  const [newMessageCount, setNewMessageCount] = useState(0);

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
            <span className="chat-empty-mark" aria-hidden="true">Y!</span>
            <h2>No messages yet</h2>
            <p>Write a message to start this local demo conversation.</p>
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
                >
                  <div className="message-meta">
                    {!grouped && <strong>{isOutgoing ? 'You' : message.senderName}</strong>}
                    <time dateTime={message.timestamp} title={new Date(message.timestamp).toLocaleString()}>
                      {formatTime(message.timestamp)}
                    </time>
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
                  <div className="message-content-row">
                    <div className="message-bubble">{message.content}</div>
                    {isOutgoing && message.deliveryStatus === 'failed' && (
                      <Button size="sm" variant="outline" onClick={() => onRetryMessage(message.id)}>
                        Retry
                      </Button>
                    )}
                  </div>
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
