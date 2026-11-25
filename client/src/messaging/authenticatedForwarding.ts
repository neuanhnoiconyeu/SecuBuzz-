import type { SecureMessagingSession } from '@/security/e2ee/session';
import type { SecureRealtimeWorkspace } from '@/realtime/SecureRealtimeWorkspace';
import type { ChatMessage, MessageAttachment } from './messageModel';
import { decodeAuthenticatedContent, encodeAuthenticatedContent, type AuthenticatedContent, type ForwardOperationReference } from './authenticatedContent';
import { AuthenticatedAttachments } from './authenticatedAttachments';
import { verifyVoicePlayback } from './voiceAudio';
import { validAttachmentSet } from '../../../shared/encryptedAttachments';
import { parseEncryptedVoice } from '../../../shared/encryptedVoice';
import { getAttachmentRule } from '../../../shared/attachmentPolicy';

const mediaItems = (source: ChatMessage) => [...source.attachments ?? [], ...(source.voice?.attachment ? [source.voice.attachment] : [])];
export function canForwardAuthenticatedMessage(source: ChatMessage): boolean {
  if (source.demoOnly || source.isDeleted || !['text', 'voice'].includes(source.type) || ['sending', 'failed'].includes(source.deliveryStatus)) return false;
  const items = mediaItems(source);
  if (!items.length) return source.type === 'text' && !source.voice;
  const manifests = items.map(item => item.encrypted);
  return validAttachmentSet(manifests) && items.every((item, index) => {
    const m = manifests[index]!;
    return m.conversationId === source.conversationId && m.messageId === source.id && m.senderId === source.senderId &&
      item.id === m.id && item.name === m.name && item.sizeBytes === m.size && item.mimeType === m.mimeType && item.type === getAttachmentRule(m.name)?.kind;
  }) && (source.voice ? source.type === 'voice' && Boolean(parseEncryptedVoice({ v: 1, attachmentId: source.voice.attachment?.id, durationSeconds: source.voice.durationSeconds }, manifests)) : source.type === 'text');
}
const manifestIdentity = (items: readonly MessageAttachment[]) => items.map(item => {
  const m = item.encrypted!; return [m.id, m.conversationId, m.messageId, m.senderId, m.name, m.mimeType, m.size, m.key, m.iv, m.sha256];
}).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
class MediaForwardError extends Error {}
interface MediaJob { uploader: AuthenticatedAttachments; uploaded: MessageAttachment[]; text?: string; messageId?: string }
interface Operation { source: string; note: string; controller: AbortController; files?: File[]; jobs: Map<string, MediaJob> }
interface MediaPayload { build(): Promise<{ text: string; messageId: string }>; matches(text: string, messageId: string): boolean; signal: AbortSignal }
export class AuthenticatedForwarding {
  private operations = new Map<string, Operation>();
  private locks = new Set<string>();
  private accepted = new Set<string>();
  constructor(private session: SecureMessagingSession, private live?: SecureRealtimeWorkspace) {}

  release = (id: string) => {
    const operation = this.operations.get(id); if (!operation) return;
    operation.controller.abort(); delete operation.files;
    // Existing DATA discard is a no-op for sealed/committed batches, so cleanup cannot erase a confirmed or uncertain send.
    for (const job of operation.jobs.values()) for (const item of job.uploaded) void job.uploader.discard(item).catch(() => {});
    operation.jobs.clear(); this.operations.delete(id);
  };
  dispose = () => { for (const id of this.operations.keys()) this.release(id); };

  private async permitted(cid: string): Promise<void> {
    const c = await this.session.api.getConversation(cid), actor = this.session.api.session.actor.id;
    if (c.id !== cid || c.type !== 'direct' || !c.interactionAllowed || c.participants.length !== 2 || !c.participants.some(p => p.id === actor)) throw new Error('Conversation unavailable.');
  }
  private async deliver(cid: string, payload: string | MediaPayload, operation: ForwardOperationReference, name: string, mode: 'live' | 'rest') {
    await this.permitted(cid);
    const assertActive = () => { if (typeof payload !== 'string' && payload.signal.aborted) throw new MediaForwardError('Forwarding was cancelled.'); };
    const matches = (text: string, id: string) => typeof payload === 'string' ? text === payload : payload.matches(text, id);
    assertActive();
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
        if (!matches(row.text, row.message.id) || row.message.state !== 'active') throw new Error('Forward operation conflict.');
        assertActive();
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
      if (pending.senderId !== this.session.api.session.actor.id || pending.conversationId !== cid || !matches(await this.session.decryptIncoming(pending), pending.id)) throw new Error('Another message is awaiting confirmation.');
      assertActive();
      const result = this.live ? await this.live.retry(cid, mode, () => {}) : await this.session.retryPending(cid);
      if (!result) throw new Error('Message confirmation is still unavailable.');
    } else {
      const prepared = typeof payload === 'string' ? { text: payload, messageId: undefined } : await payload.build();
      assertActive(); await this.permitted(cid); assertActive();
      if (this.live) await this.live.send(cid, name, prepared.text, mode, () => {}, prepared.messageId);
      else if (prepared.messageId) await this.session.send(cid, name, prepared.text, undefined, () => {}, prepared.messageId);
      else await this.session.send(cid, name, prepared.text);
    }
    this.accepted.add(step);
  }

  private async verifySource(source: ChatMessage) {
    let cursor: string | undefined;
    for (let page = 0; page < 200; page++) {
      const history = await this.session.history(source.conversationId, cursor);
      const row = history.items.find(row => row.message.id === source.id && row.message.conversationId === source.conversationId);
      if (row) {
        const content = row.text !== null && !row.error && row.message.state === 'active' && row.message.encryption?.version === 2 && decodeAuthenticatedContent(row.text);
        const items = content && content.attachments?.map(m => ({ encrypted: m } as MessageAttachment));
        if (!content || !items || row.message.senderId !== source.senderId || content.text !== source.content ||
          JSON.stringify(manifestIdentity(items)) !== JSON.stringify(manifestIdentity(mediaItems(source))) ||
          content.voice?.durationSeconds !== source.voice?.durationSeconds || content.voice?.attachmentId !== source.voice?.attachment?.id) break;
        return;
      }
      if (!history.nextCursor) break; cursor = history.nextCursor;
    }
    throw new MediaForwardError('The original media message is unavailable or changed. Refresh the conversation before forwarding.');
  }

  private mediaPayload(source: ChatMessage, cid: string, reference: ForwardOperationReference, operation: Operation): MediaPayload {
    const items = mediaItems(source), signal = operation.controller.signal;
    const matches = (text: string, messageId: string) => {
      const content = decodeAuthenticatedContent(text), manifests = content?.attachments;
      if (!content?.forwarded || content.text !== source.content || content.operation?.id !== reference.id || content.operation.part !== 'message' ||
          !manifests || manifests.length !== items.length || Boolean(content.voice) !== Boolean(source.voice)) return false;
      return manifests.every((m, index) => m.conversationId === cid && m.messageId === messageId && m.senderId === this.session.api.session.actor.id &&
        m.name === items[index]!.name && m.mimeType === items[index]!.mimeType && m.size === items[index]!.sizeBytes &&
        !items.some(item => item.encrypted!.id === m.id || item.encrypted!.key === m.key)) &&
        (!source.voice || content.voice?.attachmentId === manifests.at(-1)!.id && content.voice.durationSeconds === source.voice.durationSeconds);
    };
    return { matches, signal, build: async () => {
      let job = operation.jobs.get(cid);
      if (!job) { job = { uploader: new AuthenticatedAttachments(this.session.api.session, cid), uploaded: [] }; operation.jobs.set(cid, job); }
      if (job.text && job.messageId) return { text: job.text, messageId: job.messageId };
      if (!operation.files) {
        const reader = new AuthenticatedAttachments(this.session.api.session, source.conversationId), files: File[] = [];
        try {
          for (const item of items) {
            const blob = await reader.read(item, signal);
            if (source.voice?.attachment?.id === item.id) await verifyVoicePlayback(blob, source.voice.durationSeconds, signal);
            files.push(new File([blob], item.name, { type: item.mimeType! }));
          }
        } catch { throw new MediaForwardError('Source media is unavailable or could not be decrypted. Check access, keys and connection, then retry.'); }
        operation.files = files;
      }
      try {
        while (job.uploaded.length < operation.files.length) job.uploaded.push(await job.uploader.upload(operation.files[job.uploaded.length]!, signal));
        const batch = await job.uploader.seal(job.uploaded);
        const content: AuthenticatedContent = { text: source.content, forwarded: true, operation: reference, attachments: batch.manifests,
          ...(source.voice ? { voice: { v: 1 as const, attachmentId: batch.manifests.at(-1)!.id, durationSeconds: source.voice.durationSeconds } } : {}) };
        job.text = encodeAuthenticatedContent(content); job.messageId = batch.messageId;
        return { text: job.text, messageId: batch.messageId };
      } catch { throw new MediaForwardError('Encrypted upload could not be confirmed. Check the supported file type, size limit and connection, then retry.'); }
    } };
  }

  async forward(source: ChatMessage, targetIds: string[], note: string, operationId: string, name: string, mode: 'live' | 'rest') {
    const targets = [...new Set(targetIds)], failed: string[] = [], noteFailed: string[] = [];
    const media = mediaItems(source).length > 0, errors: Record<string, string> = {};
    if (!operationId || operationId.length > 256 || !targets.length || targets.length > 5 || !canForwardAuthenticatedMessage(source)) return { failed: targets, noteFailed };
    const fingerprint = JSON.stringify([source.conversationId, source.id, source.content, media ? manifestIdentity(mediaItems(source)) : null, source.voice?.durationSeconds]);
    const previous = this.operations.get(operationId);
    if (previous && (previous.source !== fingerprint || previous.note !== note.trim())) return { failed: targets, noteFailed };
    const operationState = previous ?? { source: fingerprint, note: note.trim(), controller: new AbortController(), jobs: new Map<string, MediaJob>() };
    this.operations.set(operationId, operationState);
    let messageText: string, noteText: string | undefined;
    try {
      messageText = media ? '' : encodeAuthenticatedContent({ text: source.content, forwarded: true, operation: { id: operationId, part: 'message' } });
      if (note.trim()) noteText = encodeAuthenticatedContent({ text: note.trim(), operation: { id: operationId, part: 'note' } });
      await this.permitted(source.conversationId);
      if (media) await this.verifySource(source);
    } catch { return { failed: targets, noteFailed, ...(media ? { errors: Object.fromEntries(targets.map(id => [id, 'The original media message is unavailable or cannot be verified. Refresh and check your access and device keys.'])) } : {}) }; }
    for (const cid of targets) {
      if (this.locks.has(cid)) { failed.push(cid); continue; }
      this.locks.add(cid);
      let forwarded = false;
      try {
        const operation: ForwardOperationReference = { id: operationId, part: 'message' };
        await this.deliver(cid, media ? this.mediaPayload(source, cid, operation, operationState) : messageText, operation, name, mode);
        forwarded = true;
        operationState.jobs.delete(cid);
        if (noteText) {
          const noteOperation: ForwardOperationReference = { id: operationId, part: 'note' };
          await this.deliver(cid, noteText, noteOperation, name, mode);
        }
      } catch (error) { failed.push(cid); if (forwarded && note.trim()) noteFailed.push(cid);
        if (media) errors[cid] = error instanceof MediaForwardError ? error.message : 'Destination or message confirmation unavailable. Check access and connection, then retry.';
      }
      finally { this.locks.delete(cid); }
    }
    if (targets.every(cid => this.accepted.has(JSON.stringify([cid, operationId, 'message'])))) { delete operationState.files; operationState.jobs.clear(); }
    return { failed, noteFailed, ...(Object.keys(errors).length ? { errors } : {}) };
  }
}
