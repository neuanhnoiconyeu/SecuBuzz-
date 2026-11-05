import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { BellRing, Send } from 'lucide-react';
import { Button, TextArea } from '@/components/ui';

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
  const submitLock = useRef(false);
  const canSend = Boolean(value.trim()) && !disabled && !isSending;

  const submit = async () => {
    const content = value.trim();
    if (!content || disabled || isSending || submitLock.current) return;
    submitLock.current = true;
    setSendError('');
    try {
      const accepted = await onSend(content);
      if (accepted) setValue('');
      else setSendError('The message was not accepted. Your draft is still here.');
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
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <TextArea
        id="message-input"
        label={`Message to ${conversationName}`}
        hint="Enter sends. Shift+Enter adds a new line. This demo does not deliver messages to other users."
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          if (sendError) setSendError('');
        }}
        onKeyDown={handleKeyDown}
        placeholder="Write a message..."
        rows={3}
        disabled={disabled || isSending}
      />

      {(setupError || sendError) && (
        <p className="composer-error" role="alert">{setupError || sendError}</p>
      )}

      <div className="composer-controls">
        <Button type="submit" disabled={!canSend} loading={isSending} leadingIcon={<Send size={16} aria-hidden="true" />}>
          Send
        </Button>
        <Button
          id="buzz-button"
          type="button"
          variant="danger"
          retro
          loading={buzzBusy}
          disabled={buzzBusy}
          data-buzz-active={buzzBusy}
          onClick={onBuzz}
          aria-label="Send BUZZ alert"
          leadingIcon={<BellRing size={16} aria-hidden="true" />}
        >
          BUZZ!
        </Button>
      </div>

      <p className="composer-demo-notice">{demoNotice}</p>
      <p className="composer-hint">
        Local demo transport · {messageCount} {messageCount === 1 ? 'message' : 'messages'} in this conversation
      </p>
    </form>
  );
}
