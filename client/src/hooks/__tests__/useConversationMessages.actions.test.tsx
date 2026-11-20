import { act, renderHook, waitFor } from '@testing-library/react';
import { useConversationMessages } from '../useConversationMessages';
import type { ChatMessage, OutboundMessage, TransportMode } from '@/messaging/messageModel';
import { BrowserConversationCryptoService } from '@/security/conversationCryptoService';
import { InMemoryDemoKeyManager } from '@/security/keyManagement';
import { localAttachmentStore } from '@/messaging/localAttachmentStore';
import { createAttachmentUrl, releaseAttachmentUrl } from '@/messaging/attachmentUrls';

const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL'), originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
const revoke = jest.fn(); let mediaSequence = 0;
beforeAll(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => `blob:message-media-${++mediaSequence}` });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
});
beforeEach(() => revoke.mockClear());
afterAll(() => {
  for (const [name, descriptor] of [['createObjectURL', originalCreate], ['revokeObjectURL', originalRevoke]] as const) {
    if (descriptor) Object.defineProperty(URL, name, descriptor); else Reflect.deleteProperty(URL, name);
  }
});

const source: ChatMessage = { id: 'source', conversationId: 'origin', senderId: 'peer', senderName: 'Peer',
  content: 'Forwarded\nmessage', timestamp: '2026-11-21T00:00:00.000Z', type: 'text', deliveryStatus: 'sent' };

async function setup(editSupported = true, mode: TransportMode = 'local-demo') {
  const cryptoService = new BrowserConversationCryptoService(new InMemoryDemoKeyManager());
  const edit = jest.fn(async () => {});
  const remove = jest.fn(async (_conversationId: string, _messageId: string) => {});
  const transport = { mode, connect: jest.fn(async () => {}), disconnect: jest.fn(async () => {}),
    sendMessage: jest.fn(async (_message: OutboundMessage) => {}), subscribeToConversation: () => () => {},
    deleteMessage: remove,
    ...(editSupported ? { editMessage: edit } : {}),
  };
  const hook = renderHook(({ cid }) => useConversationMessages({ conversationId: cid, conversationIds: ['origin', 'a', 'b'],
    currentUserId: 'self', currentUserName: 'You', transport, cryptoService }), { initialProps: { cid: 'origin' } });
  await waitFor(() => expect(hook.result.current.securityStatus?.localEncryptionAvailable).toBe(true));
  return { ...hook, transport, cryptoService, edit, remove };
}

afterEach(() => jest.restoreAllMocks());

test('note failure is a partial failure; retry sends only the same missing note and skips completed recipients', async () => {
  const h = await setup();
  h.transport.sendMessage.mockResolvedValueOnce().mockRejectedValueOnce(new Error('Note unavailable'));
  await act(async () => {
    expect(await h.result.current.forwardMessage(source, ['a', 'b'], 'Optional note', 'operation')).toEqual({ succeeded: ['b'], failed: ['a'], noteFailed: ['a'] });
  });
  const failedNote = h.transport.sendMessage.mock.calls[1]![0];
  expect(h.transport.sendMessage).toHaveBeenCalledTimes(4);
  await act(async () => {
    expect(await h.result.current.forwardMessage(source, ['a', 'b'], 'Optional note', 'operation')).toEqual({ succeeded: ['a', 'b'], failed: [], noteFailed: [] });
  });
  expect(h.transport.sendMessage).toHaveBeenCalledTimes(5);
  expect(h.transport.sendMessage.mock.calls[4]![0]).toEqual(failedNote);
  await act(async () => h.rerender({ cid: 'a' }));
  expect(h.result.current.messages).toHaveLength(2);
  expect(h.result.current.messages.filter(message => message.forwardedFrom)).toHaveLength(1);
  expect(h.result.current.messages.every(message => message.deliveryStatus === 'sent')).toBe(true);
});

test('uncertain forwarding failures retry the original ID and encrypted envelope without duplicating the local message', async () => {
  const h = await setup(); h.transport.sendMessage.mockRejectedValueOnce(new Error('Acknowledgment lost'));
  await act(async () => {
    expect(await h.result.current.forwardMessage(source, ['a', 'a'], '', 'operation')).toEqual({ succeeded: [], failed: ['a'], noteFailed: [] });
  });
  const first = h.transport.sendMessage.mock.calls[0]![0];
  await act(async () => { expect((await h.result.current.forwardMessage(source, ['a'], '', 'operation')).failed).toEqual([]); });
  expect(h.transport.sendMessage.mock.calls[1]![0]).toEqual(first);
  await act(async () => h.rerender({ cid: 'a' })); expect(h.result.current.messages).toHaveLength(1);
  expect(h.result.current.messages[0]).toMatchObject({ id: first.id, content: source.content, deliveryStatus: 'sent' });
  await act(async () => { await h.result.current.forwardMessage(source, ['a'], '', 'another-operation'); });
  expect(h.result.current.messages).toHaveLength(2); // A new dialog can intentionally forward again.
});

test('attachment forwarding retains copied attachments and does not copy them again when retrying a note', async () => {
  const h = await setup();
  const attachment = { id: 'original-file', name: 'report.pdf', sizeBytes: 20, type: 'file' as const, url: 'blob:original' };
  const copied = { ...attachment, id: 'copied-file', url: 'blob:copied' };
  const copy = jest.spyOn(localAttachmentStore, 'copyAttachments').mockResolvedValue([copied]);
  h.transport.sendMessage.mockResolvedValueOnce().mockRejectedValueOnce(new Error('Note failed'));
  const message = { ...source, attachments: [attachment] };
  await act(async () => { expect((await h.result.current.forwardMessage(message, ['a'], 'Note', 'operation')).noteFailed).toEqual(['a']); });
  await act(async () => { expect((await h.result.current.forwardMessage(message, ['a'], 'Note', 'operation')).failed).toEqual([]); });
  expect(copy).toHaveBeenCalledTimes(1); expect(copy).toHaveBeenCalledWith('self', 'origin', 'a', [attachment]);
  await act(async () => h.rerender({ cid: 'a' })); expect(h.result.current.messages.find(item => item.forwardedFrom)?.attachments).toEqual([copied]);
});

test('note encryption failure is reported and retry does not resend the accepted forward', async () => {
  const h = await setup(), encrypt = h.cryptoService.encrypt.bind(h.cryptoService);
  jest.spyOn(h.cryptoService, 'encrypt').mockImplementationOnce(encrypt).mockRejectedValueOnce(new Error('Cannot prepare note'));
  await act(async () => {
    expect(await h.result.current.forwardMessage(source, ['a'], 'Note', 'operation')).toEqual({ succeeded: [], failed: ['a'], noteFailed: ['a'] });
  });
  expect(h.transport.sendMessage).toHaveBeenCalledTimes(1);
  await act(async () => { expect((await h.result.current.forwardMessage(source, ['a'], 'Note', 'operation')).failed).toEqual([]); });
  expect(h.transport.sendMessage).toHaveBeenCalledTimes(2);
});

test('editing preserves every line break, message identity and edited metadata', async () => {
  const h = await setup();
  await act(async () => { expect(await h.result.current.sendMessage('First\nLast')).toBe(true); });
  const original = h.result.current.messages[0]!;
  const content = '\nFirst edited\n\nLast\n';
  await act(async () => { expect(await h.result.current.editMessage(original.id, content)).toBe(true); });
  const edited = h.result.current.messages[0]!;
  expect(h.result.current.messages).toHaveLength(1);
  expect(edited).toMatchObject({ id: original.id, timestamp: original.timestamp, conversationId: original.conversationId, content, isEdited: true });
  expect(edited.editedAt).toBeDefined(); expect(h.edit).toHaveBeenCalledTimes(1);
  const plaintext = await h.cryptoService.decrypt({ conversationId: original.conversationId, localUserId: 'self' }, edited.encryption,
    { messageId: original.id, conversationId: original.conversationId, senderId: original.senderId, senderName: original.senderName, timestamp: original.timestamp });
  expect(plaintext).toBe(content);
});

test('a transport without editing support retains its original message and exposes no editing capability', async () => {
  const h = await setup(false);
  await act(async () => { await h.result.current.sendMessage('Original'); });
  const original = h.result.current.messages[0]!;
  expect(h.result.current.canEdit).toBe(false);
  await act(async () => { expect(await h.result.current.editMessage(original.id, 'Changed\ntext')).toBe(false); });
  expect(h.result.current.messages[0]).toEqual(original); expect(h.edit).not.toHaveBeenCalled();
});

test('failed or pending Unsend preserves the message, pin and reactions; confirmed Unsend clears them', async () => {
  const h = await setup();
  await act(async () => { await h.result.current.sendMessage('Preserve me'); });
  const id = h.result.current.messages[0]!.id;
  act(() => { h.result.current.togglePin(id); h.result.current.toggleReaction(id, '👍'); });
  const original = h.result.current.messages[0]!;
  let finish!: () => void, pending!: Promise<boolean>;
  h.remove.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await act(async () => {
    pending = h.result.current.unsendMessage(id);
    expect(await h.result.current.unsendMessage(id)).toBe(false);
  });
  expect(h.remove).toHaveBeenCalledTimes(1); expect(h.result.current.messages[0]).toEqual(original);
  await act(async () => { finish(); expect(await pending).toBe(true); });
  expect(h.result.current.messages[0]).toMatchObject({ id, isDeleted: true, isPinned: false, reactions: [] });
});

test('rejected Unsend can be retried and Delete for Me uses no transport deletion', async () => {
  const h = await setup(); await act(async () => { await h.result.current.sendMessage('Keep until success'); });
  const original = h.result.current.messages[0]!;
  h.remove.mockRejectedValueOnce(new Error('Unavailable'));
  await act(async () => { expect(await h.result.current.unsendMessage(original.id)).toBe(false); });
  expect(h.result.current.messages[0]).toEqual(original);
  await act(async () => { expect(await h.result.current.unsendMessage(original.id)).toBe(true); });
  expect(h.remove).toHaveBeenCalledTimes(2);
  act(() => { expect(h.result.current.removeMessage(original.id)).toBe(true); });
  expect(h.result.current.messages).toEqual([]); expect(h.remove).toHaveBeenCalledTimes(2);
});

test('legacy realtime placeholders cannot enable local deletion, pinning, reactions, edits or Unsend', async () => {
  const h = await setup(true, 'realtime'); await act(async () => { await h.result.current.sendMessage('Server-backed text'); });
  const original = h.result.current.messages[0]!;
  expect(h.result.current.canUnsend).toBe(false); expect(h.result.current.canEdit).toBe(false);
  await act(async () => {
    expect(await h.result.current.unsendMessage(original.id)).toBe(false);
    expect(await h.result.current.editMessage(original.id, 'Changed')).toBe(false);
    expect(h.result.current.removeMessage(original.id)).toBe(false);
    h.result.current.togglePin(original.id); h.result.current.toggleReaction(original.id, '👍');
  });
  expect(h.result.current.messages[0]).toEqual(original); expect(h.remove).not.toHaveBeenCalled(); expect(h.edit).not.toHaveBeenCalled();
});

test('sent and forwarded voice URLs stay playable until their final message is removed', async () => {
  const h = await setup(), audioUrl = createAttachmentUrl(new Blob(['audio']));
  await act(async () => { expect(await h.result.current.sendMessage('', { voice: { audioUrl, durationSeconds: 3 } })).toBe(true); });
  releaseAttachmentUrl(audioUrl); // The accepted composer draft gives up its own reference.
  const original = h.result.current.messages[0]!;
  await act(async () => { expect((await h.result.current.forwardMessage(original, ['a'], '', 'voice-forward')).failed).toEqual([]); });
  act(() => { h.result.current.removeMessage(original.id); }); expect(revoke).not.toHaveBeenCalledWith(audioUrl);
  await act(async () => h.rerender({ cid: 'a' }));
  expect(h.result.current.messages[0]!.voice).toEqual({ audioUrl, durationSeconds: 3 });
  await act(async () => { expect(await h.result.current.unsendMessage(h.result.current.messages[0]!.id)).toBe(true); });
  expect(revoke).toHaveBeenCalledWith(audioUrl); expect(revoke.mock.calls.filter(call => call[0] === audioUrl)).toHaveLength(1);
});

test('failed file messages keep their media until removal and release it before hook unmount', async () => {
  const h = await setup(), url = createAttachmentUrl(new Blob(['%PDF-']));
  h.transport.sendMessage.mockRejectedValueOnce(new Error('Not accepted'));
  await act(async () => { expect(await h.result.current.sendMessage('File', { attachments: [{ id: 'preview', name: 'report.pdf', type: 'file', sizeBytes: 5, url }] })).toBe(false); });
  releaseAttachmentUrl(url); expect(revoke).not.toHaveBeenCalledWith(url);
  act(() => { h.result.current.removeMessage(h.result.current.messages[0]!.id); });
  expect(revoke).toHaveBeenCalledWith(url); h.unmount(); expect(revoke.mock.calls.filter(call => call[0] === url)).toHaveLength(1);
});

test('media held by pending encryption is released when both the composer and message hook have unmounted', async () => {
  const h = await setup(), audioUrl = createAttachmentUrl(new Blob(['audio']));
  const encrypt = h.cryptoService.encrypt.bind(h.cryptoService); let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  jest.spyOn(h.cryptoService, 'encrypt').mockImplementation(async (...args) => { await pending; return encrypt(...args); });
  let sending!: Promise<boolean>;
  act(() => { sending = h.result.current.sendMessage('', { voice: { audioUrl, durationSeconds: 1 } }); });
  h.unmount(); releaseAttachmentUrl(audioUrl); expect(revoke).not.toHaveBeenCalledWith(audioUrl);
  await act(async () => { finish(); await sending; }); expect(revoke).toHaveBeenCalledWith(audioUrl);
});
