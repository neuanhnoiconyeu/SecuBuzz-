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

function createFallbackVoiceWavUrl(durationSeconds = 2): string {
  const sampleRate = 8000;
  const numSamples = sampleRate * durationSeconds;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, numSamples * 2, true);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * 440 * t) * Math.exp(-t * 1.5) * 0.25;
    view.setInt16(44 + i * 2, sample * 32767, true);
  }
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
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
    setRecordingSeconds(0);
    recordingStartRef.current = Date.now();

    recordingTimerRef.current = window.setInterval(() => {
      setRecordingSeconds(Math.max(1, Math.round((Date.now() - recordingStartRef.current) / 1000)));
    }, 500);

    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        audioChunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) audioChunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
          stream.getTracks().forEach((track) => track.stop());
          const duration = Math.max(1, Math.round((Date.now() - recordingStartRef.current) / 1000));
          const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          const audioUrl = blob.size > 0 ? URL.createObjectURL(blob) : createFallbackVoiceWavUrl(duration);
          setVoiceDraft({ audioUrl, durationSeconds: duration });
        };
        mediaRecorderRef.current = recorder;
        recorder.start();
        setIsRecording(true);
        return;
      }
    } catch {
    }

    mediaRecorderRef.current = null;
    setIsRecording(true);
  };

  const stopRecording = () => {
    if (recordingTimerRef.current !== null) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    const duration = Math.max(1, Math.round((Date.now() - recordingStartRef.current) / 1000));
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    } else {
      setVoiceDraft({
        audioUrl: createFallbackVoiceWavUrl(Math.min(duration, 5)),
        durationSeconds: duration,
      });
    }
    setIsRecording(false);
  };

  const submit = async () => {
    const content = value.trim();
    if (!content || disabled || isSending || submitLock.current) return;
    submitLock.current = true;
    setSendError('');
    setSendFeedback(false);
    onTypingStop?.();
    try {
      const accepted = await onSend(content);
      if (accepted) {
        if (latestValue.current === value) setValue('');
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
              <audio src={voiceDraft.audioUrl} controls style={{ height: '28px', maxWidth: '180px' }} />
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
          className="composer-attach"
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
          className="composer-voice"
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
