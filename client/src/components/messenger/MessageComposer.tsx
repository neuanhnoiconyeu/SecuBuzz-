import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { BellRing, Check, Mic, Paperclip, Send, Smile, Sparkles, Square, X } from 'lucide-react';
import { EmojiPicker } from './EmojiPicker';
import { useAnchoredMessagePopover } from '@/hooks/useAnchoredMessagePopover';
import { Button } from '@/components/ui';
import type { MessageAttachment, VoiceMessageMetadata } from '@/messaging/messageModel';
import { AttachmentUploadError, type AttachmentUploader } from '@/messaging/attachmentUpload';
import { ATTACHMENT_ACCEPT, ATTACHMENT_HINT } from '../../../../shared/attachmentPolicy';
import { useAttachmentDrafts } from '@/hooks/useAttachmentDrafts';
import { useVoiceRecording } from '@/hooks/useVoiceRecording';
import { MessageAttachmentView } from './MessageAttachmentView';
import { validAIInput } from '@/ai/aiModel';

function sizeToDraft(input: HTMLTextAreaElement | null) {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(Math.max(input.scrollHeight, 44), 112)}px`;
  input.style.overflowY = input.scrollHeight > 112 ? 'auto' : 'hidden';
}

export interface MessageComposerSendExtras {
  attachments?: MessageAttachment[];
  voice?: VoiceMessageMetadata;
}

export interface MessageComposerProps {
  conversationName: string;
  messageCount: number;
  disabled?: boolean;
  isSending: boolean;
  buzzBusy: boolean;
  setupError?: string;
  draftValue?: string;
  onDraftChange?: (draft: string) => void;
  demoNotice?: string;
  uploadAttachment?: AttachmentUploader;
  discardAttachment?: (attachment: MessageAttachment) => Promise<void>;
  attachmentActionLabel?: string;
  droppedFiles?: readonly File[];
  attachmentUnavailableReason?: string;
  onSend(content: string, extras?: MessageComposerSendExtras): Promise<boolean>;
  onBuzz?(): void;
  textOnly?: boolean;
  active?: boolean;
  onTypingActivity?(): void;
  onTypingStop?(): void;
  onRewriteDraft?(draft: string): void;
}

export function MessageComposer({
  buzzBusy,
  conversationName,
  disabled = false,
  isSending,
  messageCount,
  onBuzz,
  onSend,
  draftValue,
  onDraftChange,
  demoNotice = 'Local demo only. Messages are not delivered to other users.',
  setupError,
  onTypingActivity,
  onTypingStop,
  uploadAttachment,
  attachmentUnavailableReason,
  discardAttachment,
  attachmentActionLabel = 'Uploading',
  droppedFiles,
  onRewriteDraft,
  textOnly = false,
  active = true,
}: MessageComposerProps) {
  const [internalValue, setInternalValue] = useState('');
  const value = draftValue ?? internalValue;
  const setValue = onDraftChange ?? setInternalValue;
  const [sendError, setSendError] = useState('');
  const [sendFeedback, setSendFeedback] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const attachmentDrafts = useAttachmentDrafts({ disabled: disabled || isSending || isSubmitting || Boolean(attachmentUnavailableReason), uploadAttachment, discardAttachment });
  const attachments = attachmentDrafts.drafts.map((draft) => draft.attachment);
  const uploadProgress = attachmentDrafts.progress;
  const processingAttachments = attachmentDrafts.processing;
  const addAttachmentFiles = attachmentDrafts.addFiles;
  const mounted = useRef(true);
  const previousDrop = useRef<readonly File[] | undefined>();
  const voice = useVoiceRecording(active, disabled || isSending || textOnly);
  const { draft: voiceDraft, recording: isRecording, requesting: requestingMicrophone, seconds: recordingSeconds } = voice;
  const displayedError = setupError || sendError || voice.error || attachmentDrafts.error;
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiPanel = useRef<HTMLDivElement>(null), emojiTrigger = useRef<HTMLButtonElement>(null);
  const emojiId = useId();
  const selection = useRef<{ start: number; end: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submitLock = useRef(false);
  const latestValue = useRef(value);
  latestValue.current = value;
  const hasContent = Boolean(value.trim()) || attachments.length > 0 || Boolean(voiceDraft);
  const isUploading = uploadProgress !== null;
  const canSend = hasContent && !disabled && !isSending && !isRecording && !requestingMicrophone && !isUploading && !processingAttachments && !isSubmitting;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (textOnly && draftValue === '') setSendError(''); }, [textOnly, draftValue]);
  useEffect(() => {
    if (!droppedFiles || previousDrop.current === droppedFiles) return;
    previousDrop.current = droppedFiles;
    setSendFeedback(false);
    void addAttachmentFiles(droppedFiles);
  }, [droppedFiles, addAttachmentFiles]);

  useEffect(() => {
    sizeToDraft(inputRef.current);
  }, [value]);

  useEffect(() => {
    const resizeInput = () => sizeToDraft(inputRef.current);
    window.addEventListener('resize', resizeInput);
    return () => window.removeEventListener('resize', resizeInput);
  }, []);

  const closeEmoji = useCallback((restoreFocus = false) => {
    setEmojiOpen(false);
    if (restoreFocus) inputRef.current?.focus();
  }, []);
  useAnchoredMessagePopover(emojiPanel, emojiTrigger, emojiOpen ? 'composer-emoji' : null, closeEmoji, true);
  useEffect(() => {
    if (emojiOpen) emojiPanel.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
  }, [emojiOpen]);
  useEffect(() => { if (!active || disabled || isSending || isSubmitting) closeEmoji(); }, [active, disabled, isSending, isSubmitting, closeEmoji]);

  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (files.length === 0 || disabled || isSending || submitLock.current || attachmentUnavailableReason) return;
    setSendFeedback(false);
    setSendError('');
    void attachmentDrafts.addFiles(files);
  };

  const startRecording = () => {
    if (disabled || isSending || submitLock.current) return;
    setSendError('');
    void voice.start();
  };

  const insertEmoji = (emoji: string) => {
    const input = inputRef.current;
    const text = latestValue.current;
    const start = Math.min(selection.current?.start ?? input?.selectionStart ?? text.length, text.length);
    const end = Math.min(selection.current?.end ?? input?.selectionEnd ?? text.length, text.length);
    const next = text.slice(0, start) + emoji + text.slice(end);
    setValue(next);
    setEmojiOpen(false);
    setSendFeedback(false);
    onTypingActivity?.();
    const caret = start + emoji.length;
    window.requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(caret, caret);
    });
  };

  const submit = async () => {
    const content = value.trim();
    const hasExtras = attachments.length > 0 || Boolean(voiceDraft);
    if ((!content && !hasExtras) || disabled || isSending || isRecording || requestingMicrophone || processingAttachments || submitLock.current) return;
    submitLock.current = true;
    setIsSubmitting(true);
    setSendError('');
    setSendFeedback(false);
    onTypingStop?.();
    try {
      const sentAttachments = attachments.length ? await attachmentDrafts.prepareForSend() : [];
      if (!mounted.current) return;
      const extras: MessageComposerSendExtras = {
        ...(sentAttachments.length > 0 ? { attachments: sentAttachments } : {}),
        ...(voiceDraft ? { voice: voiceDraft } : {}),
      };
      const accepted = hasExtras ? await onSend(content, extras) : await onSend(content);
      if (!mounted.current) return;
      if (accepted) {
        attachmentDrafts.clearAccepted();
        if (latestValue.current === value) setValue('');
        voice.clearDraft();
        setSendFeedback(true);
      } else setSendError(textOnly ? 'Your message was not confirmed. Your draft is still here.' : 'The message was not accepted. Your draft is still here.');
    } catch (failure) {
      if (mounted.current) setSendError(failure instanceof AttachmentUploadError
        ? failure.message : 'The message was not accepted. Your draft is still here.');
    } finally {
      submitLock.current = false;
      if (mounted.current) setIsSubmitting(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="message-composer"
      aria-label={`Message composer for ${conversationName}`}
      aria-busy={isSending || isSubmitting || processingAttachments}
      data-submit-feedback={sendFeedback}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {(attachments.length > 0 || voiceDraft || isRecording || requestingMicrophone) && (
        <div
          className="composer-attachments-preview"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            padding: '8px 12px',
            marginBottom: '6px',
            borderRadius: '8px',
            background: 'rgba(139, 92, 246, 0.08)',
            border: '1px solid rgba(139, 92, 246, 0.25)',
            alignItems: 'center',
          }}
        >
          {attachmentDrafts.drafts.map((draft) => (
            <div key={draft.attachment.id} className="composer-attachment-item">
              <MessageAttachmentView attachment={draft.attachment} previewUrl={draft.previewUrl} compact />
              <button type="button" className="composer-attachment-remove" onClick={() => {
                if (!submitLock.current) { attachmentDrafts.remove(draft.attachment.id); setSendError(''); }
              }} disabled={isSending || isSubmitting || processingAttachments} aria-label={`Remove ${draft.attachment.name}`}>
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ))}

          {(isRecording || requestingMicrophone) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#dc2626', fontSize: '0.82rem', fontWeight: 600 }}>
              <span>{requestingMicrophone ? 'Waiting for microphone permission…' : `● Recording voice... ${recordingSeconds}s`}</span>
              <button
                type="button"
                onClick={requestingMicrophone ? voice.cancel : voice.stop}
                style={{
                  padding: '2px 8px',
                  borderRadius: '4px',
                  border: '1px solid #dc2626',
                  background: '#fee2e2',
                  color: '#dc2626',
                  cursor: 'pointer',
                  fontSize: '0.75rem',
                }}
              >
                {requestingMicrophone ? 'Cancel' : 'Stop'}
              </button>
              {isRecording && <Button size="sm" variant="ghost" aria-label="Cancel voice recording" onClick={voice.cancel}>Cancel</Button>}
            </div>
          )}

          {voiceDraft && !isRecording && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '4px 8px',
                borderRadius: '6px',
                background: 'var(--color-surface)',
                border: '1px solid rgba(139, 92, 246, 0.3)',
                fontSize: '0.78rem',
                color: 'var(--color-text)',
              }}
            >
              <span>🎤 Voice ({voiceDraft.durationSeconds}s)</span>
              <audio
                src={voiceDraft.audioUrl}
                controls
                preload="metadata"
                aria-label="Recorded voice preview"
                style={{ height: '28px', maxWidth: '180px' }}
                onError={(e) => setSendError(`Audio failed to load (error code ${e.currentTarget.error?.code ?? 'unknown'}).`)}
              />
              <button
                type="button"
                disabled={disabled || isSending || isSubmitting}
                onClick={() => { voice.clearDraft(); setSendError(''); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', display: 'flex' }}
                aria-label="Remove recorded voice"
              >
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      )}

      {onRewriteDraft && <div className="composer-ai-entry"><Button size="sm" variant="ghost" leadingIcon={<Sparkles size={14} aria-hidden="true" />}
        disabled={disabled || isSending || isSubmitting || isRecording || processingAttachments || !validAIInput(value)} onClick={() => { onTypingStop?.(); onRewriteDraft(value); }}>Rewrite draft with @Secu</Button></div>}
      <label className="sr-only" htmlFor="message-input">Message to {conversationName}</label>
      <div className="composer-dock">
        {!textOnly && onBuzz && <Button
          id="buzz-button"
          className="composer-buzz"
          type="button"
          variant="ghost"
          loading={buzzBusy}
          disabled={buzzBusy}
          data-buzz-active={buzzBusy}
          onClick={onBuzz}
          aria-label="Send BUZZ alert"
          leadingIcon={<BellRing size={16} aria-hidden="true" />}
        >
          BUZZ!
        </Button>}

        {!textOnly && <><input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          aria-label="Select attachments"
          aria-describedby="message-attachment-limits"
          disabled={disabled || isSending || isSubmitting || processingAttachments || Boolean(attachmentUnavailableReason)}
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
        <Button
          type="button"
          variant="ghost"
          className="composer-icon-button composer-attach"
          disabled={disabled || isSending || isSubmitting || processingAttachments || Boolean(attachmentUnavailableReason)}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach files or images"
          title={attachmentUnavailableReason ?? ATTACHMENT_HINT}
          leadingIcon={<Paperclip size={18} aria-hidden="true" />}
        />

        <Button
          type="button"
          variant="ghost"
          className="composer-icon-button composer-voice"
          data-recording={isRecording}
          disabled={disabled || isSending || isSubmitting || isUploading || requestingMicrophone}
          onClick={isRecording ? voice.stop : startRecording}
          aria-label={isRecording ? 'Stop voice recording' : 'Record voice message'}
          title={isRecording ? 'Stop recording' : 'Record voice message'}
          leadingIcon={isRecording ? <Square size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
        />
        </>}
                <div className="composer-emoji-wrap">
          <Button
            ref={emojiTrigger}
            type="button"
            variant="ghost"
            className="composer-icon-button"
            disabled={disabled || isSending || isSubmitting || isUploading}
            onClick={() => {
              const input = inputRef.current;
              selection.current = input ? { start: input.selectionStart, end: input.selectionEnd } : null;
              setEmojiOpen(open => !open);
            }}
            aria-label="Insert emoji"
            aria-haspopup="dialog"
            aria-expanded={emojiOpen}
            aria-controls={emojiOpen ? emojiId : undefined}
            title="Insert emoji"
            leadingIcon={<Smile size={18} aria-hidden="true" />}
          />

          {emojiOpen && (
            <div ref={emojiPanel} id={emojiId} className="composer-emoji-popover emoji-picker-panel" role="dialog" aria-label="Emoji picker">
              <EmojiPicker onSelect={insertEmoji} onClose={() => closeEmoji(true)} />
            </div>
          )}
        </div>
        
        <textarea
          ref={inputRef}
          id="message-input"
          className="composer-input"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (event.target.value.trim()) onTypingActivity?.();
            else onTypingStop?.();
            setSendFeedback(false);
            if (sendError) setSendError('');
          }}
          onKeyDown={handleKeyDown}
          onBlur={onTypingStop}
          placeholder={`Message ${conversationName}…`}
          rows={1}
          disabled={disabled || isSending}
          aria-invalid={Boolean(displayedError)}
          aria-describedby={`message-input-hint message-input-demo${displayedError ? ' message-input-error' : ''}`}
        />
        <Button
          className="composer-send"
          type="submit"
          disabled={!canSend}
          loading={isSending || isSubmitting}
          leadingIcon={sendFeedback
            ? <Check size={16} className="composer-submit-mark" aria-hidden="true" />
            : <Send size={16} aria-hidden="true" />}
          >
          {isUploading ? `${attachmentActionLabel} ${uploadProgress}/${attachments.length}` : 'Send'}
        </Button>
      </div>

      {displayedError && (
        <p className="composer-error" id="message-input-error" role="alert">{displayedError}</p>
      )}

      <div className="composer-caption">
        <span className="sr-only" id="message-attachment-limits">{ATTACHMENT_HINT}</span>
        <p className="composer-demo-notice" id="message-input-demo">{demoNotice}</p>
        <p className="composer-hint" id="message-input-hint">Enter sends · Shift+Enter for a new line</p>
        <span className="sr-only">{messageCount} {messageCount === 1 ? 'message' : 'messages'} in this conversation.</span>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{processingAttachments ? 'Checking attachments…' : sendFeedback ? 'Message submitted.' : ''}</span>
      </div>
    </form>
  );
}
