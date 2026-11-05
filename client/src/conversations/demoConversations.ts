import type { Conversation } from './conversationModel';

export const SECUREBOT_CONVERSATION_ID = 'securebot-demo';

/** Data is local UI scaffolding; none of these entries represents a connected user. */
export function createDemoConversations(now = Date.now()): Conversation[] {
  return [
    {
      id: SECUREBOT_CONVERSATION_ID,
      displayName: 'SecureBot',
      type: 'bot',
      participants: [
        { id: 'local-user', displayName: 'You', kind: 'person' },
        { id: 'securebot-demo', displayName: 'SecureBot', kind: 'bot' },
      ],
      lastMessagePreview: 'Start a local demo conversation.',
      lastActivityAt: new Date(now - 2 * 60_000).toISOString(),
      unreadCount: 0,
      securityState: 'local-demo',
      isDemo: true,
    },
    {
      id: 'demo-direct-ava',
      displayName: 'Ava Morgan',
      type: 'direct',
      participants: [
        { id: 'local-user', displayName: 'You', kind: 'person' },
        { id: 'demo-ava', displayName: 'Ava Morgan', kind: 'person' },
      ],
      lastMessagePreview: 'Direct message UI preview only.',
      lastActivityAt: new Date(now - 38 * 60_000).toISOString(),
      unreadCount: 0,
      securityState: 'recipient-key-unavailable',
      isDemo: true,
    },
    {
      id: 'demo-group-security',
      displayName: 'Security Study Group',
      type: 'group',
      participants: [
        { id: 'local-user', displayName: 'You', kind: 'person' },
        { id: 'demo-ava', displayName: 'Ava Morgan', kind: 'person' },
        { id: 'demo-jules', displayName: 'Jules Park', kind: 'person' },
      ],
      lastMessagePreview: 'Group conversation UI preview only.',
      lastActivityAt: new Date(now - 3 * 60 * 60_000).toISOString(),
      unreadCount: 0,
      securityState: 'recipient-key-unavailable',
      isDemo: true,
    },
  ];
}

export function uniqueConversations(conversations: Conversation[]): Conversation[] {
  const seen = new Set<string>();
  return conversations.filter((conversation) => {
    if (!conversation.id || seen.has(conversation.id)) return false;
    seen.add(conversation.id);
    return true;
  });
}
