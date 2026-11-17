import type { MessageAttachment } from './messageModel';
import { parseUploadedAttachment } from '../../../shared/attachmentPolicy';
import { matchesAttachmentSignature } from '../../../shared/attachmentSignatures';
import { readAttachmentBytes } from './attachmentFiles';

/** Read through DB6 on every operation; never persist remote bytes in the demo store. */
export async function readRemoteAttachment(attachment: MessageAttachment, signal: AbortSignal): Promise<Blob> {
  const file = attachment.storage === 'indexeddb' ? null : parseUploadedAttachment(attachment);
  if (!file) throw new Error('This server file is unavailable.');
  const response = await fetch(file.url, { credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', signal });
  if (!response.ok) throw new Error(response.status === 404 || response.status === 410
    ? 'This file has expired, was removed, or is no longer available to you.' : 'The file could not be downloaded. Check your session and try again.');
  const blob = await response.blob();
  if (blob.size !== file.sizeBytes || !matchesAttachmentSignature(file.name, new Uint8Array(await readAttachmentBytes(blob.slice(0, 4096))))) {
    throw new Error('The downloaded file does not match its attachment details.');
  }
  // DB6 may store/serve these bytes as application/octet-stream with download disposition.
  return new Blob([blob], { type: file.mimeType ?? 'application/octet-stream' });
}
