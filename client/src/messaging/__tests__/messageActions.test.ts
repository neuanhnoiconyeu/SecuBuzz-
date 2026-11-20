import { deleteMessageById, removeMessageById, toggleMessagePin, toggleMessageReaction } from '../messageState';
import type { ChatMessage } from '../messageModel';

const message: ChatMessage = { id: 'm', conversationId: 'chat', senderId: 'self', senderName: 'You', content: 'Keep this',
  timestamp: '2026-11-21T00:00:00.000Z', type: 'text', deliveryStatus: 'sent' };

test('each user has one reaction; replacing and removing a choice preserve other users and counts', () => {
  let state = { chat: [{ ...message, reactions: [{ emoji: '👍', userIds: ['peer', 'self'] }, { emoji: '❤️', userIds: ['other'] }] }] };
  state = toggleMessageReaction(state, 'chat', 'm', '❤️', 'self') as typeof state;
  expect(state.chat[0]!.reactions).toEqual([{ emoji: '👍', userIds: ['peer'] }, { emoji: '❤️', userIds: ['other', 'self'] }]);
  state = toggleMessageReaction(state, 'chat', 'm', '❤️', 'self') as typeof state;
  expect(state.chat[0]!.reactions).toEqual([{ emoji: '👍', userIds: ['peer'] }, { emoji: '❤️', userIds: ['other'] }]);
  state = toggleMessageReaction(state, 'chat', 'm', '👍', 'peer') as typeof state;
  expect(state.chat[0]!.reactions).toEqual([{ emoji: '❤️', userIds: ['other'] }]);
});

test('replacement repairs older local snapshots with multiple choices and duplicate user IDs', () => {
  const state = { chat: [{ ...message, reactions: [{ emoji: '👍', userIds: ['self', 'peer', 'peer'] }, { emoji: '❤️', userIds: ['self'] }] }] };
  const updated = toggleMessageReaction(state, 'chat', 'm', '😂', 'self');
  expect(updated.chat![0]!.reactions).toEqual([{ emoji: '👍', userIds: ['peer'] }, { emoji: '😂', userIds: ['self'] }]);
  expect(state.chat[0]!.reactions[0]!.userIds).toEqual(['self', 'peer', 'peer']);
});

test('pin and unpin change only the target; unsending clears pins, reactions and media', () => {
  const peer = { ...message, id: 'other' };
  const pinned = toggleMessagePin({ chat: [message, peer] }, 'chat', 'm');
  expect(pinned.chat![0]!.isPinned).toBe(true); expect(pinned.chat![1]).toBe(peer);
  expect(toggleMessagePin(pinned, 'chat', 'm').chat![0]!.isPinned).toBe(false);
  const deleted = deleteMessageById({ chat: [{ ...pinned.chat![0]!, voice: { audioUrl: 'blob:voice', durationSeconds: 3 }, reactions: [{ emoji: '👍', userIds: ['self'] }] }] }, 'chat', 'm');
  expect(deleted.chat![0]).toMatchObject({ isDeleted: true, isPinned: false, reactions: [], attachments: [] });
  expect(deleted.chat![0]!.voice).toBeUndefined();
  expect(toggleMessagePin(deleted, 'chat', 'm').chat![0]!.isPinned).toBe(false);
  expect(toggleMessageReaction(deleted, 'chat', 'm', '👍', 'self').chat![0]!.reactions).toEqual([]);
  expect(removeMessageById(deleted, 'chat', 'm').chat).toEqual([]);
});

test('a restored failed message can still have its old local pin removed', () => {
  const state = { chat: [{ ...message, isPinned: true, deliveryStatus: 'failed' as const }] };
  expect(toggleMessagePin(state, 'chat', 'm').chat![0]!.isPinned).toBe(false);
});

test.each([{ deliveryStatus: 'sending' }, { deliveryStatus: 'failed' }, { type: 'system' }, { type: 'security_alert' }, { isDeleted: true }] as Partial<ChatMessage>[])(
  'ineligible messages cannot gain pins or reactions: %o', override => {
    const original = { ...message, ...override }, state = { chat: [original] };
    expect(toggleMessagePin(state, 'chat', 'm').chat![0]).toBe(original);
    expect(toggleMessageReaction(state, 'chat', 'm', '👍', 'self').chat![0]).toBe(original);
  });
