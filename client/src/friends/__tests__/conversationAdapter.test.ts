import { createDemoConversations } from '@/conversations/demoConversations';
import { DirectConversationUnavailableError, existingDirectConversationAdapter } from '../conversationAdapter';

describe('friends conversation adapter', () => {
  test('reuses the existing Ava DM id on every open without creating or mutating threads', async () => {
    const conversations = createDemoConversations();
    const before = JSON.stringify(conversations);
    const adapter = existingDirectConversationAdapter(conversations, 'local-user');
    expect(adapter.canOpenDirectConversation('demo-ava')).toBe(true);
    expect(await adapter.openDirectConversation('demo-ava')).toBe('demo-direct-ava');
    expect(await adapter.openDirectConversation('demo-ava')).toBe('demo-direct-ava');
    expect(JSON.stringify(conversations)).toBe(before);
  });

  test('does not substitute a group, bot, unrelated actor or self for a one-to-one conversation', async () => {
    const conversations = createDemoConversations();
    const adapter = existingDirectConversationAdapter(conversations, 'local-user');
    for (const id of ['demo-jules', 'securebot-demo', 'local-user', 'unknown']) {
      expect(adapter.canOpenDirectConversation(id)).toBe(false);
      await expect(adapter.openDirectConversation(id)).rejects.toBeInstanceOf(DirectConversationUnavailableError);
    }
    expect(existingDirectConversationAdapter(conversations, 'another-actor').canOpenDirectConversation('demo-ava')).toBe(false);
  });
});
