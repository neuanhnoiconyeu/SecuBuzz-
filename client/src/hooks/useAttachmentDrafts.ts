import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageAttachment } from '@/messaging/messageModel';
import type { AttachmentUploader } from '@/messaging/attachmentUpload';
import { createAttachmentUrl, releaseAttachmentUrl } from '@/messaging/attachmentUrls';
import { prepareAttachmentFile } from '@/messaging/attachmentFiles';
import { ATTACHMENT_LIMITS, getAttachmentRule, validateAttachmentFile, sanitizeAttachmentName } from '../../../shared/attachmentPolicy';

export interface AttachmentDraft { attachment: MessageAttachment; previewUrl: string; file: File }
interface Options {
  disabled: boolean;
  uploadAttachment?: AttachmentUploader | undefined;
  discardAttachment?: ((attachment: MessageAttachment) => Promise<void>) | undefined;
}

export function useAttachmentDrafts({ disabled, uploadAttachment, discardAttachment }: Options) {
  const [drafts, setDrafts] = useState<AttachmentDraft[]>([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const entries = useRef(drafts);
  const busy = useRef(false);
  const alive = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const uploaded = useRef(new Map<string, MessageAttachment>());
  const discard = useRef(discardAttachment); discard.current = discardAttachment;
  const release = useCallback((draft: AttachmentDraft) => {
    releaseAttachmentUrl(draft.attachment.url);
    if (draft.previewUrl !== draft.attachment.url) releaseAttachmentUrl(draft.previewUrl);
  }, []);

  useEffect(() => {
    alive.current = true;
    const savedFiles = uploaded.current;
    return () => {
      alive.current = false; controller.current?.abort();
      entries.current.forEach(release);
      savedFiles.forEach((file) => { void discard.current?.(file).catch(() => undefined); });
    };
  }, [release]);

  const addFiles = useCallback(async (input: readonly File[]) => {
    if (disabled || busy.current || !input.length) return;
    if (entries.current.length + input.length > ATTACHMENT_LIMITS.maxCount) {
      setError(`You can attach up to ${ATTACHMENT_LIMITS.maxCount} files per message.`); return;
    }
    for (const file of input) {
      const invalid = validateAttachmentFile({ name: sanitizeAttachmentName(file.name), type: file.type, size: file.size });
      if (invalid) { setError(invalid); return; }
    }
    if (entries.current.reduce((sum, draft) => sum + draft.file.size, 0) + input.reduce((sum, file) => sum + file.size, 0)
      > ATTACHMENT_LIMITS.maxTotalSizeMb * 1024 * 1024) {
      setError(`Attachments must total ${ATTACHMENT_LIMITS.maxTotalSizeMb} MB or less per message.`); return;
    }
    busy.current = true; setProcessing(true); setError('');
    const staged: AttachmentDraft[] = [];
    try {
      for (const inputFile of input) {
        const { file, svgPreview } = await prepareAttachmentFile(inputFile);
        if (!alive.current) { staged.forEach(release); return; }
        const url = createAttachmentUrl(file);
        let previewUrl = url;
        try { if (svgPreview) previewUrl = createAttachmentUrl(svgPreview); }
        catch (failure) { releaseAttachmentUrl(url); throw failure; }
        const rule = getAttachmentRule(file.name)!;
        staged.push({ file, previewUrl, attachment: { id: crypto.randomUUID(), name: file.name,
          type: rule.kind, mimeType: rule.mimeTypes[0]!, url, sizeBytes: file.size } });
      }
      entries.current = [...entries.current, ...staged];
      setDrafts(entries.current);
    } catch (failure) {
      staged.forEach(release);
      if (alive.current) setError(failure instanceof Error ? failure.message : 'These files could not be read. Select them again.');
    } finally {
      busy.current = false;
      if (alive.current) setProcessing(false);
    }
  }, [disabled, release]);

  const remove = useCallback((id: string) => {
    if (busy.current || disabled) return;
    const draft = entries.current.find((item) => item.attachment.id === id);
    if (draft) release(draft);
    const saved = uploaded.current.get(id);
    if (saved) void discard.current?.(saved).catch(() => undefined);
    uploaded.current.delete(id);
    entries.current = entries.current.filter((item) => item.attachment.id !== id);
    setDrafts(entries.current); setError('');
  }, [disabled, release]);

  const prepareForSend = useCallback(async (): Promise<MessageAttachment[]> => {
    if (busy.current) throw new Error('Wait for the selected files to finish processing.');
    busy.current = true;
    const operation = new AbortController(); controller.current = operation;
    try {
      const result: MessageAttachment[] = [];
      for (const draft of entries.current) {
        if (!uploadAttachment) { result.push(draft.attachment); continue; }
        if (alive.current) setProgress(result.length + 1);
        let saved = uploaded.current.get(draft.attachment.id);
        if (!saved) {
          saved = await uploadAttachment(draft.file, operation.signal);
          if (operation.signal.aborted) { void discard.current?.(saved).catch(() => undefined); throw new Error('Saving was cancelled.'); }
          uploaded.current.set(draft.attachment.id, saved);
        }
        result.push(saved);
      }
      return result;
    } finally {
      busy.current = false; controller.current = null;
      if (alive.current) setProgress(null);
    }
  }, [uploadAttachment]);

  const clearAccepted = useCallback(() => {
    entries.current.forEach(release); entries.current = []; uploaded.current.clear();
    if (alive.current) { setDrafts([]); setError(''); }
  }, [release]);
  return { drafts, processing, progress, error, clearError: () => setError(''), addFiles, remove, prepareForSend, clearAccepted };
}
