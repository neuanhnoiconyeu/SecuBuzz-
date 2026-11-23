import type { SecureMessagingSession } from '@/security/e2ee/session';
import type { SecureRealtimeWorkspace } from '@/realtime/SecureRealtimeWorkspace';
import type { ChatMessage } from './messageModel';
import { decodeAuthenticatedContent, encodeAuthenticatedContent, type ForwardOperationReference } from './authenticatedContent';

interface Operation { source: string; note: string }
export class AuthenticatedForwarding {
  private operations = new Map<string, Operation>();
  private locks = new Set<string>();
  private accepted = new Set<string>();
  constructor(private session: SecureMessagingSession, private live?: SecureRealtimeWorkspace) {}

  private async permitted(cid: string): Promise<void> {
    const c = await this.session.api.getConversation(cid), actor = this.session.api.session.actor.id;
    if (c.id !== cid || c.type !== 'direct' || !c.interactionAllowed || c.participants.length !== 2 || !c.participants.some(p => p.id === actor)) throw new Error('Conversation unavailable.');
  }
  private async deliver(cid: string, text: string, operation: ForwardOperationReference, name: string, mode: 'live' | 'rest') {
    await this.permitted(cid);
    const step = JSON.stringify([cid, operation.id, operation.part]);
    if (this.accepted.has(step)) return;
    // Reconcile by encrypted operation identity, even if an earlier send committed and
    // clearing its pending envelope succeeded before a later history refresh failed.
    let cursor: string | undefined;
    for (let page = 0; page < 200; page++) {
      const history = await this.session.history(cid, cursor);
      for (const row of history.items) {
        if (row.message.conversationId !== cid || row.message.senderId !== this.session.api.session.actor.id || row.error || row.text === null) continue;
        const content = decodeAuthenticatedContent(row.text);
        if (content?.operation?.id !== operation.id || content.operation.part !== operation.part) continue;
        if (row.text !== text || row.message.state !== 'active') throw new Error('Forward operation conflict.');
        const outstanding = await this.session.pending(cid);
        if (outstanding?.id === row.message.id) {
          if (this.live) await this.live.retry(cid, mode, () => {});
          else await this.session.retryPending(cid);
        }
        this.accepted.add(step);
        return;
      }
      if (!history.nextCursor) break;
      if (page === 199) throw new Error('History reconciliation incomplete.');
      cursor = history.nextCursor;
    }
    const pending = await this.session.pending(cid);
    if (pending) {
      // Never consume another composer draft or operation's pending message.
      if (pending.senderId !== this.session.api.session.actor.id || pending.conversationId !== cid || await this.session.decryptIncoming(pending) !== text) throw new Error('Another message is awaiting confirmation.');
      const result = this.live ? await this.live.retry(cid, mode, () => {}) : await this.session.retryPending(cid);
      if (!result) throw new Error('Message confirmation is still unavailable.');
    } else if (this.live) await this.live.send(cid, name, text, mode, () => {});
    else await this.session.send(cid, name, text);
    this.accepted.add(step);
  }

  async forward(source: ChatMessage, targetIds: string[], note: string, operationId: string, name: string, mode: 'live' | 'rest') {
    const targets = [...new Set(targetIds)], failed: string[] = [], noteFailed: string[] = [];
    if (!operationId || operationId.length > 256 || !targets.length || targets.length > 5 || source.type !== 'text' || source.isDeleted || source.attachments?.length || source.voice || ['sending', 'failed'].includes(source.deliveryStatus)) return { failed: targets, noteFailed };
    const fingerprint = JSON.stringify([source.conversationId, source.id, source.content]);
    const previous = this.operations.get(operationId);
    if (previous && (previous.source !== fingerprint || previous.note !== note.trim())) return { failed: targets, noteFailed };
    this.operations.set(operationId, { source: fingerprint, note: note.trim() });
    let messageText: string, noteText: string | undefined;
    try {
      messageText = encodeAuthenticatedContent({ text: source.content, forwarded: true, operation: { id: operationId, part: 'message' } });
      if (note.trim()) noteText = encodeAuthenticatedContent({ text: note.trim(), operation: { id: operationId, part: 'note' } });
      await this.permitted(source.conversationId);
    } catch { return { failed: targets, noteFailed }; }
    for (const cid of targets) {
      if (this.locks.has(cid)) { failed.push(cid); continue; }
      this.locks.add(cid);
      let forwarded = false;
      try {
        const operation: ForwardOperationReference = { id: operationId, part: 'message' };
        await this.deliver(cid, messageText, operation, name, mode);
        forwarded = true;
        if (noteText) {
          const noteOperation: ForwardOperationReference = { id: operationId, part: 'note' };
          await this.deliver(cid, noteText, noteOperation, name, mode);
        }
      } catch { failed.push(cid); if (forwarded && note.trim()) noteFailed.push(cid); }
      finally { this.locks.delete(cid); }
    }
    return { failed, noteFailed };
  }
}
