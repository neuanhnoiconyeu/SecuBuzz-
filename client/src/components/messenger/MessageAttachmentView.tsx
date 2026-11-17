/* eslint-disable @next/next/no-img-element -- User-selected files have blob URLs and unknown dimensions. */
import { useState } from 'react';
import { Download, Eye } from 'lucide-react';
import type { MessageAttachment } from '@/messaging/messageModel';
import { formatAttachmentSize, getAttachmentRule } from '../../../../shared/attachmentPolicy';
import { useAttachmentSource, type AttachmentSourceOptions } from '@/hooks/useAttachmentSource';
import { AttachmentIcon } from './AttachmentIcon';
import { AttachmentPreviewDialog } from './AttachmentPreviewDialog';
import { AttachmentDownloadLink } from './AttachmentDownloadLink';
import './attachments.css';

export function MessageAttachmentView({ attachment, compact = false, ...options }: AttachmentSourceOptions & { attachment: MessageAttachment; compact?: boolean }) {
  const source = useAttachmentSource(attachment, options);
  const [preview, setPreview] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const canPreview = attachment.type !== 'file' || getAttachmentRule(attachment.name)?.mimeTypes[0] === 'application/pdf';
  return (
    <div className={`message-attachment${compact ? ' message-attachment--compact' : ''}`}>
      {source.loading && <span className="attachment-state" role="status">Loading {attachment.name}…</span>}
      {source.error && <span className="attachment-state" role="status">{source.error}</span>}
      {mediaError && <span className="attachment-state" role="status">Preview unavailable. Download the original file.</span>}
      {!source.loading && source.previewUrl && !mediaError && attachment.type === 'image' && (
        <button type="button" className="attachment-thumbnail-button" onClick={() => setPreview(true)} aria-label={`Preview ${attachment.name}`}>
          <img className="message-attachment-image" src={source.previewUrl} alt={attachment.name} loading="lazy" onError={() => setMediaError(true)} />
        </button>
      )}
      {!source.loading && source.previewUrl && attachment.type === 'video' && (
        <video className="message-attachment-video" controls playsInline preload="metadata" src={source.previewUrl}
          aria-label={`Video: ${attachment.name}`} onError={() => setMediaError(true)} />
      )}
      {!source.loading && source.previewUrl && attachment.type === 'audio' && (
        <audio className="message-attachment-audio" controls preload="metadata" src={source.previewUrl}
          aria-label={`Audio: ${attachment.name}`} onError={() => setMediaError(true)} />
      )}
      <div className="message-attachment-summary">
        <AttachmentIcon attachment={attachment} />
        <span className="message-attachment-details">
          <span className="message-attachment-name" title={attachment.name}>{attachment.name}</span>
          <span className="message-attachment-size">{formatAttachmentSize(attachment.sizeBytes)}</span>
          {!compact && <span className="attachment-storage-label">{attachment.storage === 'indexeddb' ? 'Saved on this device' : attachment.url.startsWith('blob:') ? 'Local preview' : 'Server file'}</span>}
        </span>
        {source.downloadUrl && <div className="attachment-actions">
          {canPreview && attachment.type !== 'image' && <button type="button" className="attachment-action" onClick={() => setPreview(true)} aria-label={`Preview ${attachment.name}`}><Eye size={16} aria-hidden="true" /></button>}
          <AttachmentDownloadLink attachment={attachment} url={source.downloadUrl} label={`Download ${attachment.name}`}><Download size={16} aria-hidden="true" /></AttachmentDownloadLink>
        </div>}
      </div>
      {preview && <AttachmentPreviewDialog attachment={attachment} {...options} onClose={() => setPreview(false)} />}
    </div>
  );
}
