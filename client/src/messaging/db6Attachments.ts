import { getAttachmentRule, parseUploadedAttachment, type AttachmentMetadata } from '../../../shared/attachmentPolicy';

/** IDs supplied by the owning conversation API, never inferred from a conversation label. */
export type Db6AttachmentTarget =
  | { readonly type: 'group'; readonly groupId: string }
  | { readonly type: 'direct'; readonly recipientUserId: string };

const identifier = (value: unknown): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= 256 && !/[\s\u0000-\u001f\u007f]/u.test(value);

export function db6UploadPath(target: Db6AttachmentTarget): string | null {
  if (target?.type === 'group' && identifier(target.groupId)) return `/api/attachments?group_id=${encodeURIComponent(target.groupId)}`;
  if (target?.type === 'direct' && identifier(target.recipientUserId)) return `/api/attachments?recipient_user_id=${encodeURIComponent(target.recipientUserId)}`;
  return null;
}

/** DB6 accepts generic binary uploads for formats outside its short plaintext MIME allowlist. */
export function db6UploadMime(name: string): string | null {
  const mime = getAttachmentRule(name)?.mimeTypes[0];
  if (!mime) return null;
  return ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'text/plain', 'application/zip'].includes(mime)
    ? mime : 'application/octet-stream';
}

/** ASCII wire value, decoded once by the API transport when X-File-Name-Encoding is percent-utf8. */
export const db6UploadName = (name: string): string => encodeURIComponent(name);

/** Map the flat DB6 upload row, binding its scope/name/size to the submitted file. */
export function mapDb6Upload(value: unknown, target: Db6AttachmentTarget, file: { name: string; size: number }): AttachmentMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const rule = getAttachmentRule(file.name);
  if (!rule || row.original_name !== file.name || row.size_bytes !== file.size ||
      row.mime_type !== db6UploadMime(file.name) || row.encryption_algorithm !== null || row.deleted_at !== null ||
      (row.expires_at !== null && (typeof row.expires_at !== 'string' || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.now())) ||
      (target.type === 'group' ? row.group_id !== target.groupId || row.recipient_user_id !== null
        : row.recipient_user_id !== target.recipientUserId || row.group_id !== null)) return null;
  return parseUploadedAttachment({ id: row.attachment_id, name: file.name, sizeBytes: file.size, type: rule.kind,
    mimeType: rule.mimeTypes[0], url: `/api/attachments/${String(row.attachment_id)}/download` });
}
