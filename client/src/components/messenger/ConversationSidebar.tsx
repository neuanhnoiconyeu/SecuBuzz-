import { Bot, Users, UserRound } from 'lucide-react';
import { Avatar, Badge } from '@/components/ui';
import type { Conversation } from '@/conversations/conversationModel';

export interface ConversationSidebarProps {
  conversations: Conversation[];
  activeConversationId: string | null;
  mobileListOpen: boolean;
  onSelect(conversationId: string): void;
}

function formatActivity(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  const now = new Date();
  const difference = Math.max(0, now.getTime() - date.getTime());
  if (difference < 60_000) return 'now';
  if (difference < 60 * 60_000) return `${Math.floor(difference / 60_000)}m`;
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function ConversationTypeIcon({ type }: { type: Conversation['type'] }) {
  if (type === 'bot') return <Bot size={13} aria-hidden="true" />;
  if (type === 'group') return <Users size={13} aria-hidden="true" />;
  return <UserRound size={13} aria-hidden="true" />;
}

export function ConversationSidebar({
  activeConversationId,
  conversations,
  mobileListOpen,
  onSelect,
}: ConversationSidebarProps) {
  return (
    <aside
      className={`conversation-sidebar ${mobileListOpen ? 'is-mobile-open' : 'is-mobile-hidden'}`}
      aria-label="Conversations"
    >
      <div className="conversation-sidebar-heading">
        <div>
          <p className="conversation-sidebar-eyebrow">Yahoo! Messenger</p>
          <h2>Chats</h2>
        </div>
        <Badge status="info">Demo</Badge>
      </div>
      <p className="conversation-demo-note">Local examples only. No other users are connected.</p>

      {conversations.length === 0 ? (
        <div className="conversation-list-empty" role="status">
          <strong>No conversations yet</strong>
          <span>Demo conversations will appear here when available.</span>
        </div>
      ) : (
        <ul className="conversation-list" aria-label="Your conversations">
          {conversations.map((conversation) => {
            const active = conversation.id === activeConversationId;
            const typeLabel = conversation.type === 'bot' ? 'Bot' : conversation.type === 'group' ? 'Group' : 'Direct';
            const accessibleLabel = [
              conversation.displayName,
              typeLabel,
              conversation.unreadCount ? `${conversation.unreadCount} unread` : 'No unread messages',
              'Local demo',
            ].join(', ');
            return (
              <li key={conversation.id}>
                <button
                  type="button"
                  className={`conversation-list-item ${active ? 'is-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  aria-label={accessibleLabel}
                  onClick={() => onSelect(conversation.id)}
                >
                  <Avatar name={conversation.displayName} {...(conversation.avatarUrl ? { src: conversation.avatarUrl } : {})} size="md" />
                  <span className="conversation-list-copy">
                    <span className="conversation-list-topline">
                      <span className="conversation-list-name">{conversation.displayName}</span>
                      <time dateTime={conversation.lastActivityAt} title={new Date(conversation.lastActivityAt).toLocaleString()}>
                        {formatActivity(conversation.lastActivityAt)}
                      </time>
                    </span>
                    <span className="conversation-list-preview">{conversation.lastMessagePreview}</span>
                    <span className="conversation-list-bottomline">
                      <span className="conversation-type-tag"><ConversationTypeIcon type={conversation.type} />{typeLabel}</span>
                      {conversation.unreadCount > 0 && (
                        <span className="conversation-unread" aria-label={`${conversation.unreadCount} unread messages`}>
                          {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
