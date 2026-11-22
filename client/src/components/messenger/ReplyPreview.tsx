import type { ChatMessage } from '@/messaging/messageModel';

export function ReplyPreview({ message, onCancel }: { message: Pick<ChatMessage, 'senderName' | 'content'>; onCancel(): void }) {
  return <div className="reply-preview-banner" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', background: 'rgba(139, 92, 246, 0.12)', borderTop: '1px solid rgba(139, 92, 246, 0.3)', fontSize: '0.8rem' }}>
    <div style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
      <strong>Replying to {message.senderName}: </strong><span>{message.content}</span>
    </div>
    <button type="button" onClick={onCancel} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit', fontWeight: 'bold', padding: '0 6px' }} aria-label="Cancel reply">✕</button>
  </div>;
}
