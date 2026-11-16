import { ATTACHMENT_LIMITS, parseUploadedAttachment } from '../../../shared/attachmentPolicy';
import type { MessageAttachment } from './messageModel';

const prefix = '\u001eSecuBuzz:attachments:1\n';

/** File references travel inside the authenticated ciphertext, never as plaintext socket fields. */
export function encodeAttachmentContent(content: string, attachments: readonly MessageAttachment[] = []): string {
  if (!attachments.length && !content.startsWith(prefix)) return content;
  const parsed = attachments.map(parseUploadedAttachment);
  if (attachments.length > ATTACHMENT_LIMITS.maxCount || parsed.some((item) => !item) ||
      attachments.reduce((total, item) => total + item.sizeBytes, 0) > ATTACHMENT_LIMITS.maxTotalSizeMb * 1024 * 1024) {
    throw new Error('Invalid remote attachments.');
  }
  return prefix + JSON.stringify({ content, attachments: parsed });
}

export function decodeAttachmentContent(input: string): { content: string; attachments?: MessageAttachment[] } {
  if (!input.startsWith(prefix)) return { content: input };
  try {
    const body: unknown = JSON.parse(input.slice(prefix.length));
    if (!body || typeof body !== 'object') throw new Error();
    const { content, attachments } = body as Record<string, unknown>;
    if (typeof content !== 'string' || !Array.isArray(attachments) || attachments.length > ATTACHMENT_LIMITS.maxCount) throw new Error();
    const parsed = attachments.map(parseUploadedAttachment);
    if (parsed.some((item) => !item) || parsed.reduce((total, item) => total + (item?.sizeBytes ?? 0), 0) > ATTACHMENT_LIMITS.maxTotalSizeMb * 1024 * 1024) throw new Error();
    return { content, attachments: parsed as MessageAttachment[] };
  } catch {
    return { content: 'This attachment message could not be read.' };
  }
}
