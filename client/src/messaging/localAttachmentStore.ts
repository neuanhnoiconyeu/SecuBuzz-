import type { ChatMessage, MessageAttachment } from './messageModel';
import { AttachmentUploadError, type AttachmentUploader } from './attachmentUpload';
import { getAttachmentRule, validateAttachmentFile } from '../../../shared/attachmentPolicy';

type Scope = readonly [ownerId: string, conversationId: string];
interface StoredMessage { key: string[]; scope: string[]; message: ChatMessage }
interface StoredFile { key: string[]; scope: string[]; attachment: MessageAttachment; blob: Blob }
const storageFailure = () => new Error('Local file storage is full or unavailable. Free browser storage or enable site storage, then try again.');
const localFiles = (message: ChatMessage) => (message.attachments ?? []).filter((file) => file.storage === 'indexeddb');

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(storageFailure());
  });
}

/** Local demo data only. Scope is a browser partition, not authenticated server authorization. */
export class LocalAttachmentStore {
  constructor(private readonly factory?: IDBFactory, private readonly databaseName = 'secubuzz-local-attachments-v1') {}

  private open(): Promise<IDBDatabase> {
    const factory = this.factory ?? globalThis.indexedDB;
    if (!factory) return Promise.reject(storageFailure());
    return new Promise((resolve, reject) => {
      const request = factory.open(this.databaseName, 1);
      let settled = false;
      const timeout = setTimeout(() => { settled = true; reject(storageFailure()); }, 5000);
      request.onupgradeneeded = () => {
        for (const name of ['files', 'messages']) {
          const store = request.result.createObjectStore(name, { keyPath: 'key' });
          store.createIndex('scope', 'scope');
        }
      };
      request.onsuccess = () => {
        clearTimeout(timeout);
        if (settled) { request.result.close(); return; }
        settled = true; resolve(request.result);
      };
      request.onerror = request.onblocked = () => { clearTimeout(timeout); settled = true; reject(storageFailure()); };
    });
  }

  async putFile(ownerId: string, conversationId: string, file: File): Promise<MessageAttachment> {
    const error = validateAttachmentFile(file);
    if (error) throw new Error(error);
    const rule = getAttachmentRule(file.name)!;
    const attachment: MessageAttachment = { id: crypto.randomUUID(), name: file.name, type: rule.kind,
      sizeBytes: file.size, mimeType: rule.mimeTypes[0]!, storage: 'indexeddb', url: '' };
    const database = await this.open();
    try {
      const transaction = database.transaction('files', 'readwrite');
      const done = completed(transaction);
      transaction.objectStore('files').put({ key: [ownerId, conversationId, attachment.id], scope: [ownerId, conversationId], attachment, blob: file } satisfies StoredFile);
      await done;
      return attachment;
    } catch { throw storageFailure(); } finally { database.close(); }
  }

  async getFile(ownerId: string, conversationId: string, id: string): Promise<Blob> {
    const database = await this.open();
    try {
      const transaction = database.transaction('files', 'readonly');
      const done = completed(transaction);
      const request = transaction.objectStore('files').get([ownerId, conversationId, id]);
      await done;
      const stored = request.result as StoredFile | undefined;
      if (!stored?.blob || typeof stored.blob.slice !== 'function') throw new Error('This local file is missing. Attach the original file again.');
      return stored.blob;
    } finally { database.close(); }
  }

  async saveMessage(ownerId: string, message: ChatMessage): Promise<void> {
    const database = await this.open();
    try {
      const transaction = database.transaction(['files', 'messages'], 'readwrite');
      const done = completed(transaction);
      const messages = transaction.objectStore('messages');
      const files = transaction.objectStore('files');
      const scope = [ownerId, message.conversationId];
      const request = messages.index('scope').getAll(scope);
      // Keys and browser-demo ciphertext cannot be reused after reload. Persist the explicitly
      // local plaintext snapshot, with durable file references and no temporary object URLs.
      const { encryption: _encryption, voice: _voice, ...snapshot } = message;
      const saved: ChatMessage = { ...snapshot, type: 'text', attachments: localFiles(message).map((file) => ({ ...file, url: '' })) };
      request.onsuccess = () => {
        const previous = request.result as StoredMessage[];
        const others = previous.filter((record) => record.message.id !== message.id);
        const referenced = new Set([...others.flatMap((record) => localFiles(record.message)), ...localFiles(saved)].map((file) => file.id));
        const commit = () => {
          messages.put({ key: [...scope, message.id], scope, message: saved } satisfies StoredMessage);
          for (const file of previous.find((record) => record.message.id === message.id)?.message.attachments ?? []) {
            if (file.storage === 'indexeddb' && !referenced.has(file.id)) files.delete([...scope, file.id]);
          }
        };
        const required = localFiles(saved);
        if (!required.length) { commit(); return; }
        let pending = required.length;
        for (const file of required) {
          const check = files.get([...scope, file.id]);
          check.onsuccess = () => {
            const stored = check.result as StoredFile | undefined;
            if (!stored || stored.attachment.name !== file.name || stored.attachment.sizeBytes !== file.sizeBytes) { transaction.abort(); return; }
            if (--pending === 0) commit();
          };
        }
      };
      await done;
    } finally { database.close(); }
  }

  async loadMessages(ownerId: string, conversationIds: readonly string[]): Promise<ChatMessage[]> {
    const database = await this.open();
    try {
      const transaction = database.transaction('messages', 'readonly');
      const done = completed(transaction);
      const requests = conversationIds.map((id) => transaction.objectStore('messages').index('scope').getAll([ownerId, id]));
      await done;
      return requests.flatMap((request) => (request.result as StoredMessage[]).map(({ message }) => message))
        .filter((message) => typeof message.id === 'string' && typeof message.content === 'string' &&
          conversationIds.includes(message.conversationId) && Number.isFinite(Date.parse(message.timestamp)))
        .map((message) => message.deliveryStatus === 'sending' ? { ...message, deliveryStatus: 'failed' as const } : message)
        .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
    } finally { database.close(); }
  }

  async removeMessage(ownerId: string, conversationId: string, messageId: string): Promise<void> {
    const database = await this.open();
    try {
      const transaction = database.transaction(['files', 'messages'], 'readwrite');
      const done = completed(transaction);
      const messages = transaction.objectStore('messages');
      const request = messages.index('scope').getAll([ownerId, conversationId]);
      request.onsuccess = () => {
        const records = request.result as StoredMessage[];
        const removed = records.find((record) => record.message.id === messageId);
        const referenced = new Set(records.filter((record) => record !== removed).flatMap((record) => localFiles(record.message).map((file) => file.id)));
        messages.delete([ownerId, conversationId, messageId]);
        for (const file of removed ? localFiles(removed.message) : []) {
          if (!referenced.has(file.id)) transaction.objectStore('files').delete([ownerId, conversationId, file.id]);
        }
      };
      await done;
    } finally { database.close(); }
  }

  async discardUnusedFile(ownerId: string, conversationId: string, attachment: MessageAttachment): Promise<void> {
    const database = await this.open();
    try {
      const transaction = database.transaction(['files', 'messages'], 'readwrite');
      const done = completed(transaction);
      const request = transaction.objectStore('messages').index('scope').getAll([ownerId, conversationId]);
      request.onsuccess = () => {
        if (!(request.result as StoredMessage[]).some((record) => localFiles(record.message).some((file) => file.id === attachment.id))) {
          transaction.objectStore('files').delete([ownerId, conversationId, attachment.id]);
        }
      };
      await done;
    } finally { database.close(); }
  }

  async copyAttachments(ownerId: string, sourceId: string, targetId: string, attachments: readonly MessageAttachment[]): Promise<MessageAttachment[]> {
    return Promise.all(attachments.map(async (attachment) => {
      if (attachment.storage !== 'indexeddb' || sourceId === targetId) return attachment;
      const blob = await this.getFile(ownerId, sourceId, attachment.id);
      return this.putFile(ownerId, targetId, new File([blob], attachment.name, { type: attachment.mimeType ?? 'application/octet-stream' }));
    }));
  }
}

export const localAttachmentStore = new LocalAttachmentStore();
export const createLocalAttachmentUploader = (ownerId: string, conversationId: string): AttachmentUploader =>
  async (file, signal) => {
    if (signal.aborted) throw new Error('Saving was cancelled.');
    let attachment: MessageAttachment;
    try { attachment = await localAttachmentStore.putFile(ownerId, conversationId, file); }
    catch { throw new AttachmentUploadError(storageFailure().message); }
    if (signal.aborted) {
      await localAttachmentStore.discardUnusedFile(ownerId, conversationId, attachment);
      throw new Error('Saving was cancelled.');
    }
    return attachment;
  };

export type AttachmentScope = Scope;
