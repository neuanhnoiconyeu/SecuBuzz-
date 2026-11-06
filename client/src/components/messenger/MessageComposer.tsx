import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { BellRing, Check, Send } from 'lucide-react';
import { Button } from '@/components/ui';

function sizeToDraft(input: HTMLTextAreaElement | null) {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(Math.max(input.scrollHeight, 44), 112)}px`;
  input.style.overflowY = input.scrollHeight > 112 ? 'auto' : 'hidden';
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
  onSend(content: string): Promise<boolean>;
  onBuzz(): void;
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
}: MessageComposerProps) {
  const [internalValue, setInternalValue] = useState('');
  const value = draftValue ?? internalValue;
  const setValue = onDraftChange ?? setInternalValue;
  const [sendError, setSendError] = useState('');
  const [sendFeedback, setSendFeedback] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const submitLock = useRef(false);
  const canSend = Boolean(value.trim()) && !disabled && !isSending;

  useEffect(() => {
    sizeToDraft(inputRef.current);
  }, [value]);

  useEffect(() => {
    const resizeInput = () => sizeToDraft(inputRef.current);
    window.addEventListener('resize', resizeInput);
    return () => window.removeEventListener('resize', resizeInput);
  }, []);

  const submit = async () => {
    const content = value.trim();
    if (!content || disabled || isSending || submitLock.current) return;
    submitLock.current = true;
    setSendError('');
    setSendFeedback(false);
    try {
      const accepted = await onSend(content);
      if (accepted) {
        setValue('');
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
        <textarea
          ref={inputRef}
          id="message-input"
          className="composer-input"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setSendFeedback(false);
            if (sendError) setSendError('');
          }}
          onKeyDown={handleKeyDown}
          placeholder={`Message ${conversationName}…`}
          rows={1}
          disabled={disabled || isSending}
          aria-invalid={Boolean(setupError || sendError)}
          aria-describedby={`message-input-hint message-input-demo${setupError || sendError ? ' message-input-error' : ''}`}
        />
        <Button className="composer-send" type="submit" disabled={!canSend} loading={isSending}
          leadingIcon={sendFeedback
            ? <Check size={16} className="composer-submit-mark" aria-hidden="true" />
            : <Send size={16} aria-hidden="true" />}>
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
