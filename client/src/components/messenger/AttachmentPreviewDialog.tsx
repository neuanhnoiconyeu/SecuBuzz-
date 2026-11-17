/* eslint-disable @next/next/no-img-element -- User-selected files have blob URLs and unknown dimensions. */
import { useState } from 'react';
import { Dialog } from '@/components/ui';
import type { MessageAttachment } from '@/messaging/messageModel';
import { useAttachmentSource, type AttachmentSourceOptions } from '@/hooks/useAttachmentSource';
import { formatAttachmentSize, getAttachmentRule } from '../../../../shared/attachmentPolicy';
import { AttachmentDownloadLink } from './AttachmentDownloadLink';

export function AttachmentPreviewDialog({ attachment, onClose, ...options }: AttachmentSourceOptions & {
  attachment: MessageAttachment; onClose(): void;
}) {
  const source = useAttachmentSource(attachment, { ...options, previewPdf: true });
  const [mediaError, setMediaError] = useState(false);
  const pdf = getAttachmentRule(attachment.name)?.mimeTypes[0] === 'application/pdf';
  return (
    <Dialog open title={attachment.name} onOpenChange={(open) => { if (!open) onClose(); }}
      closeLabel="Close attachment preview" className="attachment-preview-dialog"
      description={`${formatAttachmentSize(attachment.sizeBytes)}${attachment.storage === 'indexeddb' ? ' · Saved on this device only' : ''}`}
      footer={source.downloadUrl ? <>
        {pdf && <a className="attachment-action" href={source.previewUrl} target="_blank" rel="noopener noreferrer">Open PDF</a>}
        <AttachmentDownloadLink attachment={attachment} url={source.downloadUrl}>Download original</AttachmentDownloadLink>
      </> : undefined}>
      {source.loading ? <p role="status">Loading preview…</p> : source.error ? <p role="alert">{source.error}</p> : <>
        {mediaError && <p role="status">This browser cannot preview this file. You can download the original.</p>}
        {attachment.type === 'image' && !mediaError && <img className="attachment-preview-image" src={source.previewUrl} alt={attachment.name} onError={() => setMediaError(true)} />}
        {attachment.type === 'video' && <video className="attachment-preview-video" controls playsInline preload="metadata" src={source.previewUrl} aria-label={`Video preview: ${attachment.name}`} onError={() => setMediaError(true)} />}
        {attachment.type === 'audio' && <audio controls preload="metadata" src={source.previewUrl} aria-label={`Audio preview: ${attachment.name}`} onError={() => setMediaError(true)} />}
        {pdf && <>
          <iframe className="attachment-preview-pdf" referrerPolicy="no-referrer" src={source.previewUrl} title={`PDF preview: ${attachment.name}`} />
          <p className="attachment-preview-hint">If your browser cannot display the PDF here, choose Open PDF or Download original.</p>
        </>}
      </>}
    </Dialog>
  );
}
