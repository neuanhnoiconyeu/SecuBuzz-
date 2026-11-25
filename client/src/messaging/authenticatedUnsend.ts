import type { SecureMessagingSession } from '@/security/e2ee/session';
import type { StoredMessage } from '@/security/e2ee/model';

/** REST Unsend integration. Storage IDs never replace the UI/crypto wire identity. */
export class AuthenticatedUnsend {
  private inFlight = new Map<string, Promise<StoredMessage>>();
  constructor(private session: SecureMessagingSession) {}

  private confirmed(original: StoredMessage, result: StoredMessage): boolean {
    return result.storageId === original.storageId && result.id === original.id && result.conversationId === original.conversationId &&
      result.senderId === original.senderId && result.senderName === original.senderName && result.timestamp === original.timestamp && result.storedAt === original.storedAt &&
      result.sequence === original.sequence && result.revision > original.revision && result.state === 'deleted' && result.encryption === null && result.deletedAt !== null;
  }
  remove(original: StoredMessage): Promise<StoredMessage> {
    if (original.senderId !== this.session.api.session.actor.id || original.state !== 'active' || original.encryption?.version !== 2) return Promise.reject(new Error('This message cannot be unsent.'));
    const key = JSON.stringify([original.conversationId, original.id, original.storageId]);
    const pending = this.inFlight.get(key); if (pending) return pending;
    const operation = this.perform(original).finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, operation); return operation;
  }
  private async perform(original: StoredMessage): Promise<StoredMessage> {
    try {
      const result = await this.session.api.remove(original.storageId);
      if (!this.confirmed(original, result)) throw new Error('The server did not confirm this Unsend.');
      return result;
    } catch (error) {
      // A lost response is not proof of failure. Reconcile without another DELETE,
      // without consuming a pending send, and without exposing/decrypting message content.
      let cursor: string | undefined;
      try {
        for (let page = 0; page < 200; page++) {
          const history = await this.session.api.history(original.conversationId, cursor);
          const result = history.items.find(message => message.id === original.id);
          if (result) { if (this.confirmed(original, result)) return result; break; }
          if (!history.nextCursor) break; cursor = history.nextCursor;
        }
      } catch { /* Keep the original failure and visible message until confirmation is possible. */ }
      throw error;
    }
  }
}
