import type { MessageAttachment } from './messageModel';
import { validateAttachmentFile } from '../../../shared/attachmentPolicy';
import { db6UploadMime, db6UploadName, db6UploadPath, mapDb6Upload, type Db6AttachmentTarget } from './db6Attachments';

export type AttachmentUploader = (file: File, signal: AbortSignal) => Promise<MessageAttachment>;

export class AttachmentUploadError extends Error {
  constructor(message: string) { super(message); this.name = 'AttachmentUploadError'; }
}

export function createAttachmentUploader(target: Db6AttachmentTarget): AttachmentUploader {
  return async (file, signal) => {
    if (signal.aborted) throw new AttachmentUploadError('The upload was cancelled. Your draft is still here.');
    const invalid = validateAttachmentFile(file);
    if (invalid) throw new AttachmentUploadError(invalid);
    const path = db6UploadPath(target);
    if (!path) throw new AttachmentUploadError('This conversation has no verified file upload target.');
    const name = db6UploadName(file.name);
    if (file.name.length > 180) throw new AttachmentUploadError('Shorten this filename before uploading it to the server. Your draft is still here.');
    const token = document.querySelector<HTMLMetaElement>('meta[name="secubuzz-csrf-token"]')?.content;
    if (!token?.trim() || /[\r\n]/.test(token)) throw new AttachmentUploadError('Your session could not be verified. Sign in again before uploading.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    const timeout = setTimeout(abort, 120_000);
    try {
      const response = await fetch(path, {
        method: 'POST', body: file, signal: controller.signal, credentials: 'same-origin', mode: 'same-origin',
        redirect: 'error', cache: 'no-store', headers: {
          Accept: 'application/json', 'Content-Type': db6UploadMime(file.name)!,
          'X-CSRF-Token': token, 'X-File-Name': name, 'X-File-Name-Encoding': 'percent-utf8',
        },
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new AttachmentUploadError('You no longer have access to upload here. Sign in again or check this conversation.');
        if (response.status === 400 || response.status === 413 || response.status === 415) throw new AttachmentUploadError(`${file.name} was rejected. Check its file type and the server's upload size limit.`);
        if (response.status === 404) throw new AttachmentUploadError('The file recipient or group is no longer available. Your draft is still here.');
        if (response.status === 429) throw new AttachmentUploadError('File storage is busy or full. Try again later.');
        throw new AttachmentUploadError('File uploads are unavailable. Your draft is still here.');
      }
      const body: unknown = await response.json();
      const attachment = mapDb6Upload(body, target, file);
      if (!attachment) {
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
