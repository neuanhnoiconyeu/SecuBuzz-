import { useEffect, useState } from 'react';
import type { MessageAttachment } from '@/messaging/messageModel';
import { localAttachmentStore } from '@/messaging/localAttachmentStore';
import { createSafeSvgPreview, readAttachmentBytes } from '@/messaging/attachmentFiles';
import { matchesAttachmentSignature } from '../../../shared/attachmentSignatures';
import { createAttachmentUrl, releaseAttachmentUrl } from '@/messaging/attachmentUrls';
import { getAttachmentRule, parseUploadedAttachment } from '../../../shared/attachmentPolicy';
import { readRemoteAttachment } from '@/messaging/attachmentDownload';

interface Source { downloadUrl: string; previewUrl: string; loading: boolean; error: string }
export interface AttachmentSourceOptions { ownerId?: string | undefined; conversationId?: string | undefined; previewUrl?: string | undefined; previewPdf?: boolean }

export function useAttachmentSource(attachment: MessageAttachment, options: AttachmentSourceOptions = {}): Source {
  const svg = getAttachmentRule(attachment.name)?.mimeTypes[0] === 'image/svg+xml';
  const pdf = getAttachmentRule(attachment.name)?.mimeTypes[0] === 'application/pdf';
  const remote = attachment.storage !== 'indexeddb' ? parseUploadedAttachment(attachment) : null;
  const download = remote?.url ?? attachment.url;
  const direct = attachment.storage !== 'indexeddb' && (attachment.url.startsWith('blob:') || Boolean(remote));
  const remotePreview = Boolean(remote && (attachment.type !== 'file' || pdf && options.previewPdf));
  const needsPreviewProcessing = remotePreview || (svg && !options.previewUrl) || Boolean(pdf && options.previewPdf);
  const key = JSON.stringify([attachment.id, attachment.name, attachment.type, attachment.mimeType, attachment.sizeBytes, attachment.storage, attachment.url, options.ownerId,
    options.conversationId, options.previewUrl, options.previewPdf]);
  const initial: Source = { downloadUrl: direct ? download : '',
    previewUrl: direct && !needsPreviewProcessing ? options.previewUrl ?? download : '',
    loading: !direct || needsPreviewProcessing, error: '' };
  const [source, setSource] = useState<Source & { key: string }>(() => ({ ...initial, key }));

  useEffect(() => {
    let active = true;
    const urls: string[] = [];
    const controller = new AbortController();
    const create = (blob: Blob) => { const url = createAttachmentUrl(blob); urls.push(url); return url; };
    const load = async () => {
      if (!direct && attachment.storage !== 'indexeddb') throw new Error('Attachment unavailable.');
      let blob: Blob | undefined;
      let downloadUrl = direct ? download : '';
      if (attachment.storage === 'indexeddb') {
        if (!options.ownerId || !options.conversationId) throw new Error('This local file is unavailable in this conversation.');
        blob = await localAttachmentStore.getFile(options.ownerId, options.conversationId, attachment.id);
        if (!active) return;
        downloadUrl = create(blob);
      }
      if (remotePreview) {
        blob = await readRemoteAttachment(attachment, controller.signal);
        if (!active) return;
      }
      let previewUrl = options.previewUrl ?? downloadUrl;
      if (remotePreview && blob && !svg && !pdf) previewUrl = create(blob);
      if ((svg && !options.previewUrl) || (pdf && options.previewPdf)) {
        if (!blob) {
          const response = await fetch(downloadUrl, { credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error('The file preview could not be loaded.');
          blob = await response.blob();
        }
        if (svg) blob = await createSafeSvgPreview(blob);
        if (pdf) {
          if (!matchesAttachmentSignature(attachment.name, new Uint8Array(await readAttachmentBytes(blob.slice(0, 4096))))) {
            throw new Error('This file is not a readable PDF. Download the original to inspect it.');
          }
          blob = new Blob([blob], { type: 'application/pdf' });
        }
        if (!active) return;
        previewUrl = create(blob);
      }
      if (active) setSource({ downloadUrl, previewUrl, loading: false, error: '', key });
    };
    setSource({ downloadUrl: direct ? download : '', previewUrl: direct && !needsPreviewProcessing ? options.previewUrl ?? download : '',
      loading: !direct || needsPreviewProcessing, error: '', key });
    void load().catch((failure) => {
      if (active) setSource({ downloadUrl: '', previewUrl: '', loading: false, key,
        error: failure instanceof Error ? failure.message : 'The file could not be loaded.' });
    });
    return () => { active = false; controller.abort(); urls.forEach(releaseAttachmentUrl); };
  }, [attachment, download, remotePreview, direct, svg, pdf, key, needsPreviewProcessing,
    options.ownerId, options.conversationId, options.previewUrl, options.previewPdf]);
  return source.key === key ? source : initial;
}
