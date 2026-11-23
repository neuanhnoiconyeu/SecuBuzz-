/** Application content inside the existing encrypted V2 text envelope. */
import {validAttachmentSet,type EncryptedAttachmentManifest} from '../../../shared/encryptedAttachments';
import {parseEncryptedVoice,type EncryptedVoiceReference} from '../../../shared/encryptedVoice';
export const AUTHENTICATED_CONTENT_PREFIX = '\u001eSecuBuzz:message:1\n';
const MAX_BYTES = 49136;
export interface EncryptedReplyReference { messageId: string; senderId: string }
export interface ForwardOperationReference { id: string; part: 'message' | 'note' }
export interface AuthenticatedContent {
  text: string;
  reply?: EncryptedReplyReference;
  forwarded?: true;
  operation?: ForwardOperationReference;
  attachments?: EncryptedAttachmentManifest[];
  voice?: EncryptedVoiceReference;
}
const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\s\u0000-\u001f\u007f-\u009f\p{Cs}]/u.test(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(key => allowed.includes(key));

export function decodeAuthenticatedContent(raw: string): AuthenticatedContent | null {
  if (!raw.startsWith(AUTHENTICATED_CONTENT_PREFIX)) return { text: raw };
  if (new TextEncoder().encode(raw).length > MAX_BYTES) return null;
  try {
    const value: unknown = JSON.parse(raw.slice(AUTHENTICATED_CONTENT_PREFIX.length));
    if (!record(value) || !keys(value, ['v', 'text', 'reply', 'forwarded', 'operation',...([2,3].includes(Number(value.v))?['attachments']:[]),...(value.v===3?['voice']:[])]) ||
        (value.v!==1&&value.v!==2&&value.v!==3) || typeof value.text !== 'string' ||
        (value.v!==1 ? !validAttachmentSet(value.attachments) : !value.text.trim())) return null;
    const result: AuthenticatedContent = { text: value.text };
    if(value.v===2||value.v===3){
      if(value.forwarded||value.operation)return null;
      result.attachments=value.attachments as EncryptedAttachmentManifest[];
      const first=result.attachments[0]!;
      if(result.attachments.some(m=>m.conversationId!==first.conversationId||m.messageId!==first.messageId||m.senderId!==first.senderId))return null;
      if(value.v===3){const voice=parseEncryptedVoice(value.voice,result.attachments);if(!voice)return null;result.voice=voice;}
    }
    if ('reply' in value) {
      if (!record(value.reply) || !keys(value.reply, ['messageId', 'senderId']) || !id(value.reply.messageId) || !id(value.reply.senderId)) return null;
      result.reply = { messageId: value.reply.messageId, senderId: value.reply.senderId };
    }
    if ('forwarded' in value) { if (value.forwarded !== true) return null; result.forwarded = true; }
    if ('operation' in value) {
      if (!record(value.operation) || !keys(value.operation, ['id', 'part']) || !id(value.operation.id) || !['message', 'note'].includes(String(value.operation.part))) return null;
      result.operation = { id: value.operation.id, part: value.operation.part as 'message' | 'note' };
      if ((result.operation.part === 'message') !== Boolean(result.forwarded)) return null;
    }
    if (result.reply && (result.forwarded || result.operation)) return null;
    if (result.forwarded && !result.operation) return null;
    return result;
  } catch { return null; }
}

export function encodeAuthenticatedContent(content: AuthenticatedContent): string {
  const encoded = !content.voice && !content.attachments && !content.reply && !content.forwarded && !content.operation && !content.text.startsWith(AUTHENTICATED_CONTENT_PREFIX)
    ? content.text : AUTHENTICATED_CONTENT_PREFIX + JSON.stringify({ v: content.voice?3:content.attachments?2:1, ...content });
  if ((!content.text.trim()&&!content.attachments?.length) || new TextEncoder().encode(encoded).length > MAX_BYTES || !decodeAuthenticatedContent(encoded)) throw new Error('Message content is invalid or too large.');
  return encoded;
}
