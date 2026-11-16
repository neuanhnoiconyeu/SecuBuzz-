/** @jest-environment node */
import { IDBFactory } from 'fake-indexeddb';
import { LocalAttachmentStore } from '../localAttachmentStore';
import type { ChatMessage, MessageAttachment } from '../messageModel';
import { makeAttachmentFile } from '../../../test/attachmentFixtures';

const message = (attachment: MessageAttachment, id = 'message-1', conversationId = 'room-a'): ChatMessage => ({
  id, conversationId, senderId: 'demo-a', senderName: 'Demo', content: 'A saved document',
  timestamp: '2026-11-15T12:00:00Z', type: 'text', deliveryStatus: 'sent', attachments: [attachment],
});

test('restores actual file bytes and message associations using a new store instance', async () => {
  const factory = new IDBFactory();
  const store = new LocalAttachmentStore(factory, 'reload-test');
  const original = makeAttachmentFile('report.pdf', 'application/pdf');
  const attachment = await store.putFile('demo-a', 'room-a', original);
  await store.saveMessage('demo-a', message(attachment));
  const reloaded = new LocalAttachmentStore(factory, 'reload-test');
  expect(await reloaded.loadMessages('demo-a', ['room-a'])).toEqual([message(attachment)]);
  expect(await (await reloaded.getFile('demo-a', 'room-a', attachment.id)).arrayBuffer()).toEqual(await original.arrayBuffer());
  expect(attachment).toMatchObject({ storage: 'indexeddb', url: '' });
});

test('isolates demo identities and conversations, and copies forwarded files into the target scope', async () => {
  const store = new LocalAttachmentStore(new IDBFactory());
  const attachment = await store.putFile('demo-a', 'room-a', makeAttachmentFile('report.pdf', 'application/pdf'));
  await store.saveMessage('demo-a', message(attachment));
  expect(await store.loadMessages('demo-b', ['room-a'])).toEqual([]);
  expect(await store.loadMessages('demo-a', ['room-b'])).toEqual([]);
  await expect(store.getFile('demo-b', 'room-a', attachment.id)).rejects.toThrow('missing');
  await expect(store.getFile('demo-a', 'room-b', attachment.id)).rejects.toThrow('missing');
  const [copy] = await store.copyAttachments('demo-a', 'room-a', 'room-b', [attachment]);
  await store.saveMessage('demo-a', message(copy!, 'forward', 'room-b'));
  await store.removeMessage('demo-a', 'room-a', 'message-1');
  expect((await store.getFile('demo-a', 'room-b', copy!.id)).size).toBe(attachment.sizeBytes);
});

test('deleting a message releases its file only after the final message reference is removed', async () => {
  const store = new LocalAttachmentStore(new IDBFactory());
  const attachment = await store.putFile('demo-a', 'room-a', makeAttachmentFile('notes.txt', 'text/plain'));
  await store.saveMessage('demo-a', message(attachment));
  await store.saveMessage('demo-a', message(attachment, 'message-2'));
  await store.discardUnusedFile('demo-a', 'room-a', attachment);
  expect((await store.getFile('demo-a', 'room-a', attachment.id)).size).toBe(attachment.sizeBytes);
  await store.removeMessage('demo-a', 'room-a', 'message-1');
  expect((await store.getFile('demo-a', 'room-a', attachment.id)).size).toBe(attachment.sizeBytes);
  await store.removeMessage('demo-a', 'room-a', 'message-2');
  await expect(store.getFile('demo-a', 'room-a', attachment.id)).rejects.toThrow('missing');
});

test('removing a staged file prevents publishing a message with a missing file', async () => {
  const store = new LocalAttachmentStore(new IDBFactory());
  const attachment = await store.putFile('demo-a', 'room-a', makeAttachmentFile('notes.txt', 'text/plain'));
  await store.discardUnusedFile('demo-a', 'room-a', attachment);
  await expect(store.saveMessage('demo-a', message(attachment))).rejects.toThrow('storage');
  expect(await store.loadMessages('demo-a', ['room-a'])).toEqual([]);
});

test('persists edits and deletion while avoiding stale ciphertext and temporary URLs', async () => {
  const store = new LocalAttachmentStore(new IDBFactory());
  const attachment = await store.putFile('demo-a', 'room-a', makeAttachmentFile('notes.txt', 'text/plain'));
  await store.saveMessage('demo-a', { ...message(attachment), content: 'Edited caption', isEdited: true, deliveryStatus: 'sending' });
  expect(await store.loadMessages('demo-a', ['room-a'])).toMatchObject([{ content: 'Edited caption', isEdited: true, deliveryStatus: 'failed' }]);
  await store.saveMessage('demo-a', { ...message(attachment), content: 'Deleted', isDeleted: true, attachments: [] });
  await expect(store.getFile('demo-a', 'room-a', attachment.id)).rejects.toThrow('missing');
  expect(await store.loadMessages('demo-a', ['room-a'])).toMatchObject([{ isDeleted: true, attachments: [] }]);
});
