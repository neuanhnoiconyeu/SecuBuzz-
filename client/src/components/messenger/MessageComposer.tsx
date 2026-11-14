import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { BellRing, Check, Mic, Paperclip, Send, Smile, Sparkles, Square, X } from 'lucide-react';
import { EMOJI_CATEGORIES } from './emojiData';
import { Button } from '@/components/ui';
import type { MessageAttachment, VoiceMessageMetadata } from '@/messaging/messageModel';
import { AttachmentUploadError, type AttachmentUploader } from '@/messaging/attachmentUpload';
import { ATTACHMENT_ACCEPT, ATTACHMENT_HINT } from '../../../../shared/attachmentPolicy';
import { useAttachmentDrafts } from '@/hooks/useAttachmentDrafts';
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
  onBuzz(): void;
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
  const displayedError = setupError || sendError || attachmentDrafts.error;
  const addAttachmentFiles = attachmentDrafts.addFiles;
  const mounted = useRef(true);
  const previousDrop = useRef<readonly File[] | undefined>();
  const [voiceDraft, setVoiceDraft] = useState<VoiceMessageMetadata | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiCategory, setEmojiCategory] = useState(0);
  const emojiWrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<number | null>(null);
  const recordingStartRef = useRef<number>(0);
  const submitLock = useRef(false);
  const latestValue = useRef(value);
  latestValue.current = value;
  const hasContent = Boolean(value.trim()) || attachments.length > 0 || Boolean(voiceDraft);
  const isUploading = uploadProgress !== null;
  const canSend = hasContent && !disabled && !isSending && !isRecording && !isUploading && !processingAttachments && !isSubmitting;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
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

  useEffect(() => {
    if (!emojiOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!emojiWrapRef.current?.contains(event.target as Node)) setEmojiOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setEmojiOpen(false);
        inputRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [emojiOpen]);

  useEffect(() => {
      return () => {
        if (recordingTimerRef.current !== null) window.clearInterval(recordingTimerRef.current);
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
      };
    }, []);

  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (files.length === 0 || disabled || isSending || submitLock.current || attachmentUnavailableReason) return;
    setSendFeedback(false);
    setSendError('');
    void attachmentDrafts.addFiles(files);
  };

  const startRecording = async () => {
    if (disabled || isSending || submitLock.current) return;
    setSendError('');
    setVoiceDraft(null);

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setSendError('This browser cannot record audio. Open the app in Chrome or Edge.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
        .find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const duration = Math.max(1, Math.round((Date.now() - recordingStartRef.current) / 1000));
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size === 0) {
          setSendError('No audio was captured. Check your microphone.');
          return;
        }
        setVoiceDraft({ audioUrl: URL.createObjectURL(blob), durationSeconds: duration });
      };
      mediaRecorderRef.current = recorder;
      recordingStartRef.current = Date.now();
      setRecordingSeconds(0);
      recordingTimerRef.current = window.setInterval(() => {
        setRecordingSeconds(Math.max(1, Math.round((Date.now() - recordingStartRef.current) / 1000)));
      }, 500);
      recorder.start();
      setIsRecording(true);
    } catch {
      setSendError('Microphone access was blocked. Allow the microphone and try again.');
    }
  };

  const stopRecording = () => {
    if (recordingTimerRef.current !== null) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  };

  const insertEmoji = (emoji: string) => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + emoji + value.slice(end);
    setValue(next);
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
    if ((!content && !hasExtras) || disabled || isSending || isRecording || processingAttachments || submitLock.current) return;
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
        setVoiceDraft(null);
        setSendFeedback(true);
      } else setSendError('The message was not accepted. Your draft is still here.');
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
      {(attachments.length > 0 || voiceDraft || isRecording) && (
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

          {isRecording && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#dc2626', fontSize: '0.82rem', fontWeight: 600 }}>
              <span>● Recording voice... {recordingSeconds}s</span>
              <button
                type="button"
                onClick={stopRecording}
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
                Stop
              </button>
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
                background: 'rgba(255, 255, 255, 0.9)',
                border: '1px solid rgba(139, 92, 246, 0.3)',
                fontSize: '0.78rem',
                color: '#1f2937',
              }}
            >
              <span>🎤 Voice ({voiceDraft.durationSeconds}s)</span>
              <audio
                src={voiceDraft.audioUrl}
                controls
                style={{ height: '28px', maxWidth: '180px' }}
                onError={(e) => setSendError(`Audio failed to load (error code ${e.currentTarget.error?.code ?? 'unknown'}).`)}
              />
              <button
                type="button"
                onClick={() => setVoiceDraft(null)}
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
        <Button
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
        </Button>

        <input
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
          disabled={disabled || isSending || isSubmitting || isUploading}
          onClick={isRecording ? stopRecording : () => void startRecording()}
          aria-label={isRecording ? 'Stop voice recording' : 'Record voice message'}
          title={isRecording ? 'Stop recording' : 'Record voice message'}
          leadingIcon={isRecording ? <Square size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
        />
                <div className="composer-emoji-wrap" ref={emojiWrapRef}>
          <Button
            type="button"
            variant="ghost"
            className="composer-icon-button"
            disabled={disabled || isSending || isSubmitting || isUploading}
            onClick={() => setEmojiOpen((open) => !open)}
            aria-label="Insert emoji"
            aria-haspopup="true"
            aria-expanded={emojiOpen}
            title="Insert emoji"
            leadingIcon={<Smile size={18} aria-hidden="true" />}
          />

          {emojiOpen && (
            <div className="composer-emoji-popover" role="dialog" aria-label="Emoji picker">
              <div className="rx-tabs" role="tablist" aria-label="Emoji categories">
                {EMOJI_CATEGORIES.map((category, index) => (
                  <button
                    key={category.id}
                    type="button"
                    role="tab"
                    className="rx-tab"
                    aria-selected={index === emojiCategory}
                    aria-label={category.label}
                    title={category.label}
                    onClick={() => setEmojiCategory(index)}
                  >
                    {category.icon}
                  </button>
                ))}
              </div>
              <div className="composer-emoji-grid">
                {EMOJI_CATEGORIES[emojiCategory]!.emojis.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="composer-emoji-btn"
                    onClick={() => insertEmoji(emoji)}
                    title={emoji}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
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
