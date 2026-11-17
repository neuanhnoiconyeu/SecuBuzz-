import type { ConversationSidebarItem } from './ConversationSidebar';
import type { ChatMessage, ConnectionStatus } from '@/messaging/messageModel';
import type { DirectConversation } from '@/security/e2ee/model';
import type { DecryptedRow } from '@/security/e2ee/session';
import type { SecureLiveState } from '@/realtime/SecureRealtimeWorkspace';
import type { LiveConnection } from '@/realtime/AuthenticatedSocketIoClient';
import type { Receipt } from '@/realtime/authenticatedProtocol';

/** Presentation only. These projections never create transport payloads or key material. */
export function conversationName(conversation: DirectConversation, actorId: string): string {
  return conversation.participants.find(p => p.id !== actorId)?.displayName ?? 'Contact';
}
export function presentConversations(conversations: readonly DirectConversation[], actorId: string,
  state: SecureLiveState, selectedId: string | null, localRows: readonly DecryptedRow[]): ConversationSidebarItem[] {
  return conversations.map(c => {
    const rows = state.rows[c.id] ?? (c.id === selectedId ? localRows.filter(row => row.message.conversationId === c.id) : []);
    const last = [...rows].sort((a, b) => a.message.sequence - b.message.sequence).at(-1);
    const peer = c.participants.find(p => p.id !== actorId);
    const presence = peer ? state.presence[peer.id]?.status : undefined;
    return { id: c.id, type: 'direct', displayName: conversationName(c, actorId),
      lastMessagePreview: last ? last.message.state === 'deleted' ? 'Message deleted' : last.error ? 'Message unavailable on this device' : last.text ?? 'Message unavailable on this device' : 'Open conversation',
      lastActivityAt: last?.message.timestamp ?? c.updatedAt, unreadCount: state.unread[c.id] ?? 0,
      ...(presence && presence !== 'unknown' ? { presence } : {}) };
  });
}
export function presentMessages(rows: readonly DecryptedRow[], receiptFor?: (cid: string, id: string) => Receipt | undefined): {
  messages: ChatMessage[]; verifiedIds: ReadonlySet<string>;
} {
  const verifiedIds = new Set<string>();
  const messages = [...rows].sort((a, b) => a.message.sequence - b.message.sequence).map(row => {
    const m = row.message, deleted = m.state === 'deleted', unreadable = !deleted && (m.encryption?.version !== 2 || row.error !== null || row.text === null);
    const verified = !deleted && !unreadable && m.encryption?.version === 2;
    if (verified) verifiedIds.add(m.id);
    const receipt = receiptFor?.(m.conversationId, m.id);
    const deliveryStatus = receipt?.conversationId === m.conversationId && receipt.messageId === m.id ? receipt.status : 'sent';
    const message: ChatMessage = { id: m.id, conversationId: m.conversationId, senderId: m.senderId,
      senderName: m.senderName, timestamp: m.timestamp, type: unreadable ? 'security_alert' : 'text',
      content: deleted ? 'Message deleted' : unreadable ? row.error ?? 'Message unavailable on this device.' : row.text ?? '',
      deliveryStatus, ...(deleted ? { isDeleted: true } : {}) };
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
