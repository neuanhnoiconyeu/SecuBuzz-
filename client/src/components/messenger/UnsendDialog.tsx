import { useEffect, useRef, useState } from 'react';
import { Button, Dialog } from '@/components/ui';
import type { ChatMessage } from '@/messaging/messageModel';

export type UnsendScope = 'everyone' | 'me';

interface UnsendDialogProps {
  message: ChatMessage | null;
  canUnsendEveryone: boolean;
  canDeleteForMe: boolean;
  localOnly?: boolean;
  onClose(): void;
  onConfirm(scope: UnsendScope): Promise<boolean>;
}

export function UnsendDialog({ message, canUnsendEveryone, canDeleteForMe, localOnly = false, onClose, onConfirm }: UnsendDialogProps) {
  const [scope, setScope] = useState<UnsendScope>('everyone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitLock = useRef(false);

  useEffect(() => {
    if (message) {
      setScope(canUnsendEveryone ? 'everyone' : 'me');
      setError('');
    }
  }, [message, canUnsendEveryone]);

  const confirm = async () => {
    if (submitLock.current || !message || (scope === 'everyone' ? !canUnsendEveryone : !canDeleteForMe)) return;
    submitLock.current = true; setBusy(true); setError('');
    try {
      if (await onConfirm(scope)) onClose();
      else setError(scope === 'everyone' ? 'Could not unsend this message. Your message is unchanged. Try again.' : 'Could not delete this message for you. Your message is unchanged. Try again.');
    } catch {
      setError(scope === 'everyone' ? 'Could not unsend this message. Your message is unchanged. Try again.' : 'Could not delete this message for you. Your message is unchanged. Try again.');
    } finally {
      submitLock.current = false; setBusy(false);
    }
  };

  const options: Array<{ value: UnsendScope; title: string; text: string }> = [
    ...(canUnsendEveryone ? [{
      value: 'everyone' as const,
      title: 'Delete for everyone',
      text: 'This message will be unsent for everyone in the chat. Others may have already seen or forwarded it.',
    }] : []),
    ...(canDeleteForMe ? [{
      value: 'me' as const,
      title: 'Delete for you',
      text: 'This message will be removed from your device, but it will still be visible to other chat members.',
    }] : []),
  ];

  return (
    <Dialog open={Boolean(message)} title="Delete message?" className="unsend-dialog" dismissible={!busy}
      onOpenChange={open => { if (!open && !submitLock.current) onClose(); }}
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button variant="danger" loading={busy} disabled={!message || (scope === 'everyone' ? !canUnsendEveryone : !canDeleteForMe)} onClick={() => void confirm()}>Delete</Button>
      </>}>
      {localOnly && <p className="ui-dialog-description">Local demo only. These changes are not sent to other users.</p>}
      <div className="unsend-options" role="radiogroup" aria-label="Who do you want to delete this message for?">
        {options.map((option) => (
          <label key={option.value} className={`unsend-option ${scope === option.value ? 'is-selected' : ''}`}>
            <input
              type="radio"
              name="unsend-scope"
              value={option.value}
              checked={scope === option.value}
              disabled={busy}
              onChange={() => { setScope(option.value); setError(''); }}
            />
            <span className="unsend-option-copy">
              <strong>{option.title}</strong>
              <span>{option.text}</span>
            </span>
          </label>
        ))}
      </div>
      {error && <p className="composer-error" role="alert">{error}</p>}
    </Dialog>
  );
}
