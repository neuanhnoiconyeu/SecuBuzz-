import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { BellRing, Check, FileText, Mic, Paperclip, Send, Square, X } from 'lucide-react';
import { Button } from '@/components/ui';
import type { MessageAttachment, VoiceMessageMetadata } from '@/messaging/messageModel';

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
  onSend(content: string, extras?: MessageComposerSendExtras): Promise<boolean>;
  onBuzz(): void;
  onTypingActivity?(): void;
  onTypingStop?(): void;
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
}: MessageComposerProps) {
  const [internalValue, setInternalValue] = useState('');
  const value = draftValue ?? internalValue;
  const setValue = onDraftChange ?? setInternalValue;
  const [sendError, setSendError] = useState('');
  const [sendFeedback, setSendFeedback] = useState(false);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [voiceDraft, setVoiceDraft] = useState<VoiceMessageMetadata | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
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
  const canSend = hasContent && !disabled && !isSending && !isRecording;

  useEffect(() => {
    sizeToDraft(inputRef.current);
  }, [value]);

  useEffect(() => {
    const resizeInput = () => sizeToDraft(inputRef.current);
    window.addEventListener('resize', resizeInput);
    return () => window.removeEventListener('resize', resizeInput);
  }, []);

  useEffect(() => {
      return () => {
        if (recordingTimerRef.current !== null) window.clearInterval(recordingTimerRef.current);
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
      };
    }, []);

  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const selected: MessageAttachment[] = Array.from(files).map((file) => ({
      id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: file.name,
      type: file.type.startsWith('image/') ? 'image' : 'file',
      url: URL.createObjectURL(file),
      sizeBytes: file.size,
    }));

    setAttachments((prev) => [...prev, ...selected]);
    event.target.value = '';
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
  };

  const startRecording = async () => {
    if (disabled || isSending) return;
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

  const submit = async () => {
    const content = value.trim();
    const hasExtras = attachments.length > 0 || Boolean(voiceDraft);
    if ((!content && !hasExtras) || disabled || isSending || isRecording || submitLock.current) return;
    submitLock.current = true;
    setSendError('');
    setSendFeedback(false);
    onTypingStop?.();
    try {
      const extras: MessageComposerSendExtras = {
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(voiceDraft ? { voice: voiceDraft } : {}),
      };
      const accepted = await onSend(content, hasExtras ? extras : undefined);
      if (accepted) {
        if (latestValue.current === value) setValue('');
        setAttachments([]);
        setVoiceDraft(null);
        setSendFeedback(true);
      } else setSendError('The message was not accepted. Your draft is still here.');
    } catch {
      setSendError('The message was not accepted. Your draft is still here.');
    } finally {
      submitLock.current = false;
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
      aria-busy={isSending}
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
          {attachments.map((att) => (
            <div
              key={att.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 8px',
                borderRadius: '6px',
                background: 'rgba(255, 255, 255, 0.85)',
                border: '1px solid rgba(0, 0, 0, 0.1)',
                fontSize: '0.78rem',
                color: '#1f2937',
              }}
            >
              {att.type === 'image' ? (
                <img
                  src={att.url}
                  alt={att.name}
                  style={{ width: '28px', height: '28px', objectFit: 'cover', borderRadius: '4px' }}
                />
              ) : (
                <FileText size={16} />
              )}
              <span style={{ maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {att.name}
              </span>
              <span style={{ opacity: 0.6, fontSize: '0.7rem' }}>
                ({Math.max(1, Math.round(att.sizeBytes / 1024))} KB)
              </span>
              <button
                type="button"
                onClick={() => removeAttachment(att.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', display: 'flex' }}
                aria-label={`Remove ${att.name}`}
              >
                <X size={14} />
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
          accept="image/*,.pdf,.doc,.docx,.txt,.zip"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
        <Button
          type="button"
          variant="ghost"
          disabled={disabled || isSending}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach files or images"
          title="Attach image or file"
          leadingIcon={<Paperclip size={16} aria-hidden="true" />}
        >
          Attach
        </Button>

        <Button
          type="button"
          variant="ghost"
          disabled={disabled || isSending}
          onClick={isRecording ? stopRecording : () => void startRecording()}
          aria-label={isRecording ? 'Stop voice recording' : 'Record voice message'}
          title={isRecording ? 'Stop recording' : 'Record voice message'}
          leadingIcon={isRecording ? <Square size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
        >
          {isRecording ? `${recordingSeconds}s` : 'Voice'}
        </Button>

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
          aria-invalid={Boolean(setupError || sendError)}
          aria-describedby={`message-input-hint message-input-demo${setupError || sendError ? ' message-input-error' : ''}`}
        />
        <Button 
          className="composer-send" 
          type="submit" 
          disabled={!canSend} 
          loading={isSending}
          leadingIcon={sendFeedback
            ? <Check size={16} className="composer-submit-mark" aria-hidden="true" />
            : <Send size={16} aria-hidden="true" />}
          >
          Send
        </Button>
      </div>

      {(setupError || sendError) && (
        <p className="composer-error" id="message-input-error" role="alert">{setupError || sendError}</p>
      )}

      <div className="composer-caption">
        <p className="composer-demo-notice" id="message-input-demo">{demoNotice}</p>
        <p className="composer-hint" id="message-input-hint">Enter sends · Shift+Enter for a new line</p>
        <span className="sr-only">{messageCount} {messageCount === 1 ? 'message' : 'messages'} in this conversation.</span>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{sendFeedback ? 'Message submitted.' : ''}</span>
      </div>
    </form>
  );
}