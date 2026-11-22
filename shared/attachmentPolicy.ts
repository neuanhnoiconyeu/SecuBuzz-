/** Client attachment formats and limits. DB6 also enforces its own server-side upload cap. */
import type {EncryptedAttachmentManifest} from './encryptedAttachments.ts';
export const ATTACHMENT_LIMITS = {
  maxCount: 5,
  maxTotalSizeMb: 100,
  imageSizeMb: 5,
  documentSizeMb: 10,
  audioSizeMb: 20,
  archiveSizeMb: 25,
  videoSizeMb: 50,
} as const;

export type AttachmentKind = 'image' | 'file' | 'video' | 'audio';

export interface AttachmentMetadata {
  id: string;
  name: string;
  type: AttachmentKind;
  url: string;
  sizeBytes: number;
  mimeType?: string;
  /** An IndexedDB reference is scoped by the current demo user and conversation. */
  storage?: 'indexeddb';
  /** Present only after a verified authenticated V2 message is decrypted. */
  encrypted?: EncryptedAttachmentManifest;
}

interface FileRule {
  extensions: readonly string[];
  mimeTypes: readonly string[];
  kind: AttachmentKind;
  label: string;
  maxSizeMb: number;
}

const { imageSizeMb, documentSizeMb, audioSizeMb, archiveSizeMb, videoSizeMb } = ATTACHMENT_LIMITS;

const rules: readonly FileRule[] = [
  { extensions: ['jpg', 'jpeg'], mimeTypes: ['image/jpeg', 'image/pjpeg'], kind: 'image', label: 'image', maxSizeMb: imageSizeMb },
  ...['png', 'gif', 'webp', 'avif', 'bmp'].map((extension): FileRule => ({
    extensions: [extension], mimeTypes: [`image/${extension}`], kind: 'image', label: 'image', maxSizeMb: imageSizeMb,
  })),
  { extensions: ['pdf'], mimeTypes: ['application/pdf'], kind: 'file', label: 'PDF', maxSizeMb: documentSizeMb },
  { extensions: ['svg'], mimeTypes: ['image/svg+xml'], kind: 'image', label: 'image', maxSizeMb: imageSizeMb },
  { extensions: ['rtf'], mimeTypes: ['application/rtf', 'text/rtf'], kind: 'file', label: 'document', maxSizeMb: documentSizeMb },
  { extensions: ['doc'], mimeTypes: ['application/msword'], kind: 'file', label: 'document', maxSizeMb: documentSizeMb },
  { extensions: ['docx'], mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], kind: 'file', label: 'document', maxSizeMb: documentSizeMb },
  { extensions: ['xls'], mimeTypes: ['application/vnd.ms-excel'], kind: 'file', label: 'document', maxSizeMb: documentSizeMb },
  { extensions: ['xlsx'], mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], kind: 'file', label: 'document', maxSizeMb: documentSizeMb },
  { extensions: ['ppt'], mimeTypes: ['application/vnd.ms-powerpoint'], kind: 'file', label: 'document', maxSizeMb: documentSizeMb },
  { extensions: ['pptx'], mimeTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'], kind: 'file', label: 'document', maxSizeMb: documentSizeMb },
  { extensions: ['txt'], mimeTypes: ['text/plain'], kind: 'file', label: 'document', maxSizeMb: documentSizeMb },
  { extensions: ['csv'], mimeTypes: ['text/csv', 'application/vnd.ms-excel', 'text/plain'], kind: 'file', label: 'document', maxSizeMb: documentSizeMb },
  { extensions: ['zip'], mimeTypes: ['application/zip', 'application/x-zip-compressed'], kind: 'file', label: 'archive', maxSizeMb: archiveSizeMb },
  { extensions: ['rar'], mimeTypes: ['application/vnd.rar', 'application/x-rar-compressed', 'application/x-rar'], kind: 'file', label: 'archive', maxSizeMb: archiveSizeMb },
  { extensions: ['7z'], mimeTypes: ['application/x-7z-compressed'], kind: 'file', label: 'archive', maxSizeMb: archiveSizeMb },
  { extensions: ['mp4', 'm4v'], mimeTypes: ['video/mp4', 'video/x-m4v'], kind: 'video', label: 'video', maxSizeMb: videoSizeMb },
  { extensions: ['webm'], mimeTypes: ['video/webm'], kind: 'video', label: 'video', maxSizeMb: videoSizeMb },
  { extensions: ['mov'], mimeTypes: ['video/quicktime'], kind: 'video', label: 'video', maxSizeMb: videoSizeMb },
  { extensions: ['mp3'], mimeTypes: ['audio/mpeg', 'audio/mp3'], kind: 'audio', label: 'audio', maxSizeMb: audioSizeMb },
  { extensions: ['weba'], mimeTypes: ['audio/webm'], kind: 'audio', label: 'audio', maxSizeMb: audioSizeMb },
  { extensions: ['wav'], mimeTypes: ['audio/wav', 'audio/x-wav', 'audio/wave'], kind: 'audio', label: 'audio', maxSizeMb: audioSizeMb },
  { extensions: ['ogg'], mimeTypes: ['audio/ogg', 'application/ogg'], kind: 'audio', label: 'audio', maxSizeMb: audioSizeMb },
  { extensions: ['m4a'], mimeTypes: ['audio/mp4', 'audio/x-m4a'], kind: 'audio', label: 'audio', maxSizeMb: audioSizeMb },
];

export const ATTACHMENT_ACCEPT = rules.flatMap((rule) => rule.extensions.map((extension) => `.${extension}`)).join(',');
export const ATTACHMENT_HINT = `Up to ${ATTACHMENT_LIMITS.maxCount} files: images ${imageSizeMb} MB, documents ${documentSizeMb} MB, audio ${audioSizeMb} MB, archives ${archiveSizeMb} MB, videos ${videoSizeMb} MB. Maximum ${ATTACHMENT_LIMITS.maxTotalSizeMb} MB per message.`;

export function sanitizeAttachmentName(name: string): string {
  const safe = name.normalize('NFC').replace(/[\/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '_').trim();
  if (safe.length <= 200) return safe;
  const dot = safe.lastIndexOf('.');
  const extension = dot > 0 ? safe.slice(dot).slice(-20) : '';
  return safe.slice(0, 200 - extension.length) + extension;
}

export function getAttachmentRule(name: string): FileRule | undefined {
  const extension = name.split('.').pop()?.toLowerCase();
  return rules.find((rule) => rule.extensions.includes(extension ?? ''));
}

export function validateAttachmentFile(file: { name: string; type: string; size: number }): string | null {
  if (!file.name || file.name.length > 200 || /[\/\\\u0000-\u001f\u007f]/u.test(file.name)) {
    return 'Choose a file with a valid name of up to 200 characters.';
  }
  const rule = getAttachmentRule(file.name);
  const mime = file.type.toLowerCase().split(';')[0]?.trim() ?? '';
  if (!rule || (mime !== '' && mime !== 'application/octet-stream' && !rule.mimeTypes.includes(mime))) {
    return 'Supported files: PDF, Word, Excel, PowerPoint, images, videos, audio, TXT, RTF, CSV, ZIP, RAR, and 7Z.';
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return `${file.name} is empty or has an invalid size.`;
  if (file.size > rule.maxSizeMb * 1024 * 1024) return `${file.name} exceeds the ${rule.maxSizeMb} MB ${rule.label} limit.`;
  return null;
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Remote messages may reference only this application's authenticated file endpoint. */
export function parseUploadedAttachment(value: unknown): AttachmentMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if('encrypted' in item)return null; // Never feed ciphertext references into the legacy plaintext loader.
  if (typeof item.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.id) ||
      typeof item.name !== 'string' || typeof item.mimeType !== 'string' || typeof item.sizeBytes !== 'number' ||
      (item.url !== `/api/attachments/${item.id}/download` && item.url !== `/api/attachments/${item.id}`)) return null;
  const rule = getAttachmentRule(item.name);
  if (!rule || item.type !== rule.kind || item.mimeType !== rule.mimeTypes[0] ||
      validateAttachmentFile({ name: item.name, type: item.mimeType, size: item.sizeBytes })) return null;
  // Normalize older message references so metadata routes are never used as file bytes.
  return { id: item.id, name: item.name, type: rule.kind, mimeType: item.mimeType, sizeBytes: item.sizeBytes, url: `/api/attachments/${item.id}/download` };
}
