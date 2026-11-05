import { act, renderHook } from '@testing-library/react';
import { useMessengerConversations } from '../useMessengerConversations';
import { createDemoConversations } from '@/conversations/demoConversations';

describe('useMessengerConversations', () => {
  test('lists conversations once and selects only known conversations', () => {
    const demos = createDemoConversations(1_700_000_000_000);
    const duplicate = { ...demos[1]!, id: demos[0]!.id, displayName: 'Duplicate ID' };
    const { result } = renderHook(() => useMessengerConversations([...demos, duplicate]));

    expect(result.current.conversations).toHaveLength(3);
    expect(result.current.activeConversationId).toBe(demos[0]?.id);
    expect(result.current.selectConversation('missing')).toBe(false);
    act(() => { expect(result.current.selectConversation(demos[1]!.id)).toBe(true); });
    expect(result.current.activeConversation?.displayName).toBe('Ava Morgan');
  });

  test('keeps drafts isolated per conversation and clears them when emptied', () => {
    const demos = createDemoConversations(1_700_000_000_000);
    const { result } = renderHook(() => useMessengerConversations(demos));
    act(() => {
      result.current.setDraft(demos[0]!.id, 'Bot draft');
      result.current.setDraft(demos[1]!.id, 'Direct draft');
    });
    expect(result.current.drafts).toEqual({
      [demos[0]!.id]: 'Bot draft',
      [demos[1]!.id]: 'Direct draft',
    });
    act(() => { result.current.setDraft(demos[0]!.id, ''); });
    expect(result.current.drafts).toEqual({ [demos[1]!.id]: 'Direct draft' });
  });

  test('updates previews and counts each inactive incoming message once', () => {
    const demos = createDemoConversations(1_700_000_000_000);
    const { result } = renderHook(() => useMessengerConversations(demos));
    const inactiveId = demos[1]!.id;
    const activity = {
      conversationId: inactiveId,
      messageId: 'message-1',
      direction: 'incoming' as const,
      preview: 'An incoming note',
      timestamp: '2026-02-01T12:00:00.000Z',
    };

    act(() => {
      result.current.recordMessageActivity(activity);
      result.current.recordMessageActivity(activity);
    });
    expect(result.current.conversations.find((conversation) => conversation.id === inactiveId))
      .toMatchObject({ unreadCount: 1, lastMessagePreview: 'An incoming note', lastActivityAt: activity.timestamp });

    act(() => { result.current.selectConversation(inactiveId); });
    expect(result.current.conversations.find((conversation) => conversation.id === inactiveId)?.unreadCount).toBe(0);
    act(() => {
      result.current.recordMessageActivity({
        ...activity,
        messageId: 'message-2',
        direction: 'incoming',
        preview: 'While active',
        timestamp: '2026-02-01T12:01:00.000Z',
      });
    });
    expect(result.current.conversations.find((conversation) => conversation.id === inactiveId))
      .toMatchObject({ unreadCount: 0, lastMessagePreview: 'While active' });
  });

  test('represents an empty provider result without choosing an active conversation', () => {
    const { result } = renderHook(() => useMessengerConversations([]));
    expect(result.current.isEmpty).toBe(true);
    expect(result.current.activeConversationId).toBeNull();
    expect(result.current.activeConversation).toBeNull();
  });
});
