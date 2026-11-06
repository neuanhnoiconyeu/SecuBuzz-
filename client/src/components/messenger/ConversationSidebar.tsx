import { useEffect, useId, useRef, useState } from 'react';
import { Bot, Search, Users, UserRound, X } from 'lucide-react';
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
  const [searchQuery, setSearchQuery] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchId = useId();
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleConversations = conversations.filter((conversation) =>
    conversation.displayName.toLowerCase().includes(normalizedQuery)
    || conversation.type.includes(normalizedQuery)
  );
  const clearSearch = () => {
    setSearchQuery('');
    searchInputRef.current?.focus();
  };

  useEffect(() => {
    // Demo timestamps and locale formatting differ between server and browser.
    // Keep the first render stable; the actual activity remains client-visible.
    setHydrated(true);
  }, []);

  return (
    <aside
      className={`conversation-sidebar ${mobileListOpen ? 'is-mobile-open' : 'is-mobile-hidden'}`}
      aria-label="Conversations"
    >
      <div className="conversation-browse-header">
        <div className="conversation-sidebar-heading">
          <div>
            <p className="conversation-sidebar-eyebrow">Your conversations</p>
            <h2 className="display-heading">Messages</h2>
          </div>
          <Badge status="info">Demo</Badge>
        </div>

        <div className="conversation-search">
          <label className="sr-only" htmlFor={searchId}>Search conversations</label>
          <Search className="conversation-search-icon" size={16} aria-hidden="true" />
          <input
            ref={searchInputRef}
            id={searchId}
            className="ui-input conversation-search-input"
            type="search"
            placeholder="Search conversations"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && searchQuery) {
                event.preventDefault();
                clearSearch();
              }
            }}
            autoComplete="off"
            spellCheck={false}
          />
          {searchQuery && (
            <button type="button" className="conversation-search-clear" aria-label="Clear conversation search" onClick={clearSearch}>
              <X size={15} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="conversation-list-heading">
        <span>{normalizedQuery ? 'Search results' : 'Recent chats'}</span>
        <span className="conversation-result-count" aria-live="polite" aria-atomic="true">
          {visibleConversations.length} {normalizedQuery
            ? visibleConversations.length === 1 ? 'result' : 'results'
            : visibleConversations.length === 1 ? 'conversation' : 'conversations'}
        </span>
      </div>

      {conversations.length === 0 ? (
        <div className="conversation-list-empty" role="status">
          <strong>No conversations yet</strong>
          <span>Demo conversations will appear here when available.</span>
        </div>
      ) : visibleConversations.length === 0 ? (
        <div className="conversation-list-empty" role="status">
          <Search size={24} aria-hidden="true" />
          <strong>No matching conversations</strong>
          <span>Try another name or conversation type.</span>
          <button type="button" className="conversation-search-reset" onClick={clearSearch}>Clear search</button>
        </div>
      ) : (
        <ul className="conversation-list" aria-label="Your conversations">
          {visibleConversations.map((conversation) => {
            const active = conversation.id === activeConversationId;
            const typeLabel = conversation.type === 'bot' ? 'Bot' : conversation.type === 'group' ? 'Group' : 'Direct';
            const unreadLabel = conversation.unreadCount > 99 ? '99+' : String(conversation.unreadCount);
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
                  <span className="conversation-list-avatar">
                    <Avatar name={conversation.displayName} {...(conversation.avatarUrl ? { src: conversation.avatarUrl } : {})} size="md" />
                    <span className={`conversation-avatar-type conversation-avatar-type--${conversation.type}`} title={typeLabel}>
                      <ConversationTypeIcon type={conversation.type} />
                    </span>
                  </span>
                  <span className="conversation-list-copy">
                    <span className="conversation-list-name" title={conversation.displayName}>{conversation.displayName}</span>
                    <span className="conversation-list-preview">{conversation.lastMessagePreview}</span>
                  </span>
                  <span className="conversation-list-trailing">
                    <time
                      className="conversation-activity-time"
                      {...(hydrated ? {
                        dateTime: conversation.lastActivityAt,
                        title: new Date(conversation.lastActivityAt).toLocaleString(),
                      } : {})}
                    >
                      {hydrated ? formatActivity(conversation.lastActivityAt) : '—'}
                    </time>
                    {conversation.unreadCount > 0 && (
                      <span className="conversation-unread" aria-label={`${conversation.unreadCount} unread messages`}>
                        <span className="conversation-unread-value" key={unreadLabel} aria-hidden="true">{unreadLabel}</span>
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="conversation-demo-note">Local examples only. No other users are connected.</p>
    </aside>
  );
}
