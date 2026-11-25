import { act, renderHook } from '@testing-library/react';
import { useRealtimeNotifications } from '../useRealtimeNotifications';
import type { SecureLiveState, SecureRealtimeWorkspace } from '@/realtime/SecureRealtimeWorkspace';
import { conversation } from '@/realtime/testing/authenticatedFixtures';

const incoming = (id = 'message') => ({ id, conversationId: conversation.id, senderId: 'bob', senderName: 'Bob' });
function fixture() {
  let state: SecureLiveState = { connection: 'connected', conversations: [conversation], rows: {}, cursors: {}, unread: {}, typing: {}, presence: {}, receipts: {}, keyVersions: {}, errors: {}, synchronized: 1 };
  const listeners = new Set<() => void>();
  const live = { getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; } } as unknown as SecureRealtimeWorkspace;
  const publish = (patch: Partial<SecureLiveState>) => act(() => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); });
  return { live, publish, listeners };
}

test('only new incoming metadata produces an inactive-chat notice; replay and opening the chat do not duplicate it', () => {
  const f = fixture();
  const { result, rerender, unmount } = renderHook(({ cid, active }) => useRealtimeNotifications(f.live, 'alice', cid, active),
    { initialProps: { cid: null as string | null, active: true } });
  f.publish({ incomingMessage: incoming('one') });
  expect(result.current.message).toEqual(incoming('one'));
  act(() => result.current.dismissMessage());
  f.publish({ incomingMessage: { ...incoming('one') } }); expect(result.current.message).toBeNull();
  f.publish({ incomingMessage: incoming('two') });
  rerender({ cid: conversation.id, active: true }); expect(result.current.message).toBeNull();
  f.publish({ incomingMessage: incoming('three') }); expect(result.current.message).toBeNull();
  rerender({ cid: null, active: true }); expect(result.current.message).toBeNull();
  unmount(); expect(f.listeners.size).toBe(0);
});

test('inactive sections receive notices and own/unauthorized messages cannot notify', () => {
  const f = fixture(); const { result } = renderHook(() => useRealtimeNotifications(f.live, 'alice', conversation.id, false));
  f.publish({ incomingMessage: { ...incoming('own'), senderId: 'alice' } }); expect(result.current.message).toBeNull();
  f.publish({ incomingMessage: { ...incoming('wrong'), conversationId: 'not-authorized' } }); expect(result.current.message).toBeNull();
  f.publish({ incomingMessage: incoming('peer') }); expect(result.current.message?.id).toBe('peer');
  f.publish({ conversations: [{ ...conversation, interactionAllowed: false }] }); expect(result.current.message).toBeNull();
});

test('cached metadata and history/unread reconciliation cannot fabricate a new-message notice', () => {
  const f = fixture(); f.publish({ incomingMessage: incoming('cached') });
  const { result, rerender } = renderHook(({ actor }) => useRealtimeNotifications(f.live, actor, null, false), { initialProps: { actor: 'alice' } });
  expect(result.current.message).toBeNull();
  f.publish({ unread: { [conversation.id]: 7 }, synchronized: 2 }); expect(result.current.message).toBeNull();
  f.publish({ incomingMessage: incoming('new') }); expect(result.current.message?.id).toBe('new');
  rerender({ actor: 'another-account' }); expect(result.current.message).toBeNull();
});

test('a background-tab notice is suppressed when that same chat becomes visible again', () => {
  const descriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
  try {
    const f = fixture(); const { result } = renderHook(() => useRealtimeNotifications(f.live, 'alice', conversation.id, true));
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    f.publish({ incomingMessage: incoming('background') }); expect(result.current.message?.id).toBe('background');
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    act(() => document.dispatchEvent(new Event('visibilitychange'))); expect(result.current.message).toBeNull();
  } finally { if (descriptor) Object.defineProperty(document, 'hidden', descriptor); else Reflect.deleteProperty(document, 'hidden'); }
});

test('sound callback receives only new authorized peer events, including the open chat, without history/replay catch-up', () => {
  const f = fixture(), notify = jest.fn(); f.publish({ incomingMessage: incoming('cached') });
  const { result, rerender } = renderHook(({ active }) => useRealtimeNotifications(f.live, 'alice', conversation.id, active, notify), { initialProps: { active: true } });
  f.publish({ synchronized: 2, unread: { [conversation.id]: 3 } }); expect(notify).not.toHaveBeenCalled();
  f.publish({ incomingMessage: incoming('open') }); expect(notify).toHaveBeenCalledTimes(1); expect(result.current.message).toBeNull();
  rerender({ active: false }); f.publish({ incomingMessage: { ...incoming('open') } }); expect(notify).toHaveBeenCalledTimes(1);
  f.publish({ incomingMessage: { ...incoming('own'), senderId: 'alice' } });
  f.publish({ incomingMessage: { ...incoming('invalid'), conversationId: 'not-authorized' } });
  expect(notify).toHaveBeenCalledTimes(1);
  f.publish({ incomingMessage: incoming('inactive') }); expect(notify).toHaveBeenLastCalledWith(incoming('inactive')); expect(notify).toHaveBeenCalledTimes(2);
});
