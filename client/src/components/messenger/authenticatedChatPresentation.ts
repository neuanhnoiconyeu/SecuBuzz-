import type { ConversationSidebarItem } from './ConversationSidebar';
import type { ChatMessage, ConnectionStatus } from '@/messaging/messageModel';
import type { DirectConversation } from '@/security/e2ee/model';
import type { DecryptedRow } from '@/security/e2ee/session';
import type { SecureLiveState } from '@/realtime/SecureRealtimeWorkspace';
import type { LiveConnection } from '@/realtime/AuthenticatedSocketIoClient';
import type { Receipt } from '@/realtime/authenticatedProtocol';
import { decodeAuthenticatedContent } from '@/messaging/authenticatedContent';
import {getAttachmentRule} from '../../../../shared/attachmentPolicy';

/** Presentation only. These projections never create transport payloads or key material. */
export function conversationName(conversation: DirectConversation, actorId: string): string {
  return conversation.participants.find(p => p.id !== actorId)?.displayName ?? 'Contact';
}
export function presentConversations(conversations: readonly DirectConversation[], actorId: string,
  state: SecureLiveState, selectedId: string | null, localRows: readonly DecryptedRow[],
  isHidden?: (conversationId: string, messageId: string) => boolean): ConversationSidebarItem[] {
  return conversations.map(c => {
    const rows = state.rows[c.id] ?? (c.id === selectedId ? localRows.filter(row => row.message.conversationId === c.id) : []);
    const last = rows.filter(row => !isHidden?.(row.message.conversationId, row.message.id)).sort((a, b) => a.message.sequence - b.message.sequence).at(-1);
    const peer = c.participants.find(p => p.id !== actorId);
    const presence = peer ? state.presence[peer.id]?.status : undefined;
    const latest=last?.text?decodeAuthenticatedContent(last.text):null;
    return { id: c.id, type: 'direct', displayName: conversationName(c, actorId),
      lastMessagePreview: last ? last.message.state === 'deleted' ? 'Message deleted' : last.error || last.text === null ? 'Message unavailable on this device' : latest?latest.text||(latest.voice?'Voice message':latest.attachments?'Attachment':''):'Message unavailable on this device' : 'Open conversation',
      lastActivityAt: last?.message.timestamp ?? c.updatedAt, unreadCount: state.unread[c.id] ?? 0,
      ...(presence && presence !== 'unknown' ? { presence } : {}) };
  });
}
export function presentMessages(rows: readonly DecryptedRow[], receiptFor?: (cid: string, id: string) => Receipt | undefined,
  isHidden?: (conversationId: string, messageId: string) => boolean): {
  messages: ChatMessage[]; verifiedIds: ReadonlySet<string>;
} {
  const verifiedIds = new Set<string>();
  const visible = rows.filter(row => !isHidden?.(row.message.conversationId, row.message.id));
  const decoded = new Map(visible.map(row => [row, row.text === null || row.error ? null : decodeAuthenticatedContent(row.text)]));
  const messages = [...visible].sort((a, b) => a.message.sequence - b.message.sequence).map(row => {
    let content = decoded.get(row);
    const m = row.message, deleted = m.state === 'deleted';
    if(content?.attachments?.some(a=>a.conversationId!==m.conversationId||a.messageId!==m.id||a.senderId!==m.senderId))content=null;
    const unreadable = !deleted && (m.encryption?.version !== 2 || row.error !== null || !content);
    const verified = !deleted && !unreadable && m.encryption?.version === 2;
    if (verified) verifiedIds.add(m.id);
    const receipt = receiptFor?.(m.conversationId, m.id);
    const deliveryStatus = receipt?.conversationId === m.conversationId && receipt.messageId === m.id ? receipt.status : 'sent';
    const message: ChatMessage = { id: m.id, conversationId: m.conversationId, senderId: m.senderId,
      senderName: m.senderName, timestamp: m.timestamp, type: unreadable ? 'security_alert' : 'text',
      content: deleted ? 'Message deleted' : unreadable ? row.error ?? 'Message unavailable on this device.' : content?.text ?? '',
      deliveryStatus, ...(deleted ? { isDeleted: true } : {}) };
    if (!unreadable && !deleted && content?.forwarded) message.isForwarded = true;
    if(!unreadable&&!deleted&&m.edit?.proofs.length){message.isEdited=true;message.editedAt=m.edit.proofs.at(-1)!.proof.editedAt;}
    if(verified&&content?.attachments)message.attachments=content.attachments.map(a=>({id:a.id,name:a.name,mimeType:a.mimeType,sizeBytes:a.size,
      type:getAttachmentRule(a.name)!.kind,url:'',encrypted:a}));
    if(verified&&content?.voice){
      const voice=content.voice,file=message.attachments!.find(file=>file.id===voice.attachmentId)!;
      message.type='voice';message.voice={audioUrl:'',durationSeconds:voice.durationSeconds,attachment:file};
      message.attachments=message.attachments!.filter(file=>file.id!==voice.attachmentId);
    }
    if (!unreadable && !deleted && content?.reply) {
      const ref = content.reply;
      const original = visible.find(candidate => candidate.message.conversationId === m.conversationId && candidate.message.id === ref.messageId);
      // A reference is not proof of someone else's words. Quote only a loaded,
      // verified original, and never retain snippets of locally hidden rows.
      if (!original || original.message.senderId === ref.senderId) {
        const available = original && original.message.state === 'active' && original.message.encryption?.version === 2 && !original.error && decoded.get(original);
        message.replyTo = { messageId: ref.messageId, senderName: available ? original.message.senderName : 'a message', contentSnippet: available ? available.text.slice(0, 60)||(available.voice?'Voice message':available.attachments?'Attachment':'') : 'Original message unavailable.' };
      }
    }
    return message;
  });
  return { messages, verifiedIds };
}
export function presentConnection(connection?: LiveConnection): ConnectionStatus {
  return connection === 'offline' || !connection ? 'disconnected' : connection === 'auth_failed' ? 'error' : connection;
}
export function presentSendState(state: string): string {
  if (state === 'Persisted — delivery pending') return 'Message sent';
  if (state === 'Encrypting') return 'Encrypting message…';
  if (state === 'Sending' || state === 'Awaiting persistence acknowledgment') return 'Sending encrypted message…';
  return state;
}
