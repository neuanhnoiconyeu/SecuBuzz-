import { useContext,useEffect, useRef, useState, type ReactNode } from 'react';
import {EncryptedAttachmentContext} from '@/messaging/EncryptedAttachmentContext';
import type { MessageAttachment } from '@/messaging/messageModel';
import { readRemoteAttachment } from '@/messaging/attachmentDownload';
import { createAttachmentUrl, releaseAttachmentUrl } from '@/messaging/attachmentUrls';
import { parseUploadedAttachment } from '../../../../shared/attachmentPolicy';

/** DB6 is checked again at click time; a Blob download preserves the original Unicode filename. */
export function AttachmentDownloadLink({ attachment, url, label, children }: {
  attachment: MessageAttachment; url: string; label?: string; children: ReactNode;
}) {
  const readEncrypted=useContext(EncryptedAttachmentContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const operation = useRef<AbortController | null>(null);
  const temporary = useRef<{ url: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => () => {
    operation.current?.abort();
    if (temporary.current) { clearTimeout(temporary.current.timer); releaseAttachmentUrl(temporary.current.url); }
  }, []);
  return <>
    <a className="attachment-action" href={url} download={attachment.name} aria-label={label} aria-busy={busy}
      onClick={(event) => {
        if (attachment.storage === 'indexeddb' || !attachment.encrypted&&!parseUploadedAttachment(attachment)) return;
        event.preventDefault();
        if (operation.current) return;
        const controller = new AbortController(); operation.current = controller;
        setBusy(true); setError('');
        const load=attachment.encrypted ? readEncrypted?readEncrypted(attachment,controller.signal):Promise.reject(new Error('Encrypted attachment unavailable.')) : readRemoteAttachment(attachment,controller.signal);
        void load.then((blob) => {
          if (controller.signal.aborted) return;
          if (temporary.current) { clearTimeout(temporary.current.timer); releaseAttachmentUrl(temporary.current.url); }
          const objectUrl = createAttachmentUrl(blob);
          const anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = attachment.name;
          document.body.appendChild(anchor); anchor.click(); anchor.remove();
          temporary.current = { url: objectUrl, timer: setTimeout(() => { releaseAttachmentUrl(objectUrl); temporary.current = null; }, 1000) };
        }).catch((failure: unknown) => {
          if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'The file could not be downloaded.');
        }).finally(() => { operation.current = null; if (!controller.signal.aborted) setBusy(false); });
      }}>{children}</a>
    {error && <span className="attachment-state" role="status">{error}</span>}
  </>;
}
