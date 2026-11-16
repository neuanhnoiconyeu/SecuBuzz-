import type { MessageAttachment } from './messageModel';
import { parseUploadedAttachment, validateAttachmentFile } from '../../../shared/attachmentPolicy';

export type AttachmentUploader = (file: File, signal: AbortSignal) => Promise<MessageAttachment>;

export class AttachmentUploadError extends Error {
  constructor(message: string) { super(message); this.name = 'AttachmentUploadError'; }
}

export function createAttachmentUploader(conversationId: string): AttachmentUploader {
  return async (file, signal) => {
    const invalid = validateAttachmentFile(file);
    if (invalid) throw new AttachmentUploadError(invalid);
    const token = document.querySelector<HTMLMetaElement>('meta[name="secubuzz-csrf-token"]')?.content;
    if (!token?.trim() || /[\r\n]/.test(token)) throw new AttachmentUploadError('Your session could not be verified. Sign in again before uploading.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    const timeout = setTimeout(abort, 120_000);
    try {
      const response = await fetch('/api/attachments', {
        method: 'POST', body: file, signal: controller.signal, credentials: 'same-origin', mode: 'same-origin',
        redirect: 'error', cache: 'no-store', headers: {
          Accept: 'application/json', 'Content-Type': file.type || 'application/octet-stream',
          'X-CSRF-Token': token, 'X-Conversation-Id': conversationId, 'X-Attachment-Name': encodeURIComponent(file.name),
        },
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new AttachmentUploadError('You no longer have access to upload here. Sign in again or check this conversation.');
        if (response.status === 400 || response.status === 413) throw new AttachmentUploadError(`${file.name} was rejected. Check its file type, contents, and size.`);
        if (response.status === 429) throw new AttachmentUploadError('File storage is busy or full. Try again later.');
        throw new AttachmentUploadError('File uploads are unavailable. Your draft is still here.');
      }
      const body: unknown = await response.json();
      const attachment = parseUploadedAttachment(body && typeof body === 'object' ? (body as Record<string, unknown>).attachment : null);
      if (!attachment || attachment.name !== file.name || attachment.sizeBytes !== file.size) {
        throw new AttachmentUploadError('The upload response could not be verified. Your draft is still here.');
      }
      if (controller.signal.aborted) throw new AttachmentUploadError('The upload was cancelled or timed out. Try again.');
      return attachment;
    } catch (failure) {
      if (failure instanceof AttachmentUploadError) throw failure;
      throw new AttachmentUploadError('The upload failed or timed out. Check your connection and try again.');
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
  };
}
