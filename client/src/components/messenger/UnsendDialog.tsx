import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui';
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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [scope, setScope] = useState<UnsendScope>('everyone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitLock = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (message && !dialog.open) {
      setScope(canUnsendEveryone ? 'everyone' : 'me');
      setError('');
      dialog.showModal();
    } else if (!message && dialog.open) {
      dialog.close();
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
      title: 'Unsend for everyone',
      text: 'This message will be unsent for everyone in the chat. Others may have already seen or forwarded it.',
    }] : []),
    ...(canDeleteForMe ? [{
      value: 'me' as const,
      title: 'Delete for me',
      text: 'This message will be removed from your device, but it will still be visible to other chat members.',
    }] : []),
  ];

  return (
    <dialog ref={dialogRef} className="ui-dialog unsend-dialog" onClose={onClose}
      onCancel={event => { if (submitLock.current) event.preventDefault(); }} aria-labelledby="unsend-title" aria-busy={busy}>
      <div className="ui-dialog-panel">
        <div className="ui-dialog-header">
          <h2 className="ui-dialog-title" id="unsend-title">Who do you want to remove this message for?</h2>
          <Button variant="ghost" size="sm" className="ui-dialog-close" disabled={busy} onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </Button>
        </div>

        <div className="ui-dialog-body">
          {localOnly && <p className="ui-dialog-description">Local demo only. These changes are not sent to other users.</p>}
          <div className="unsend-options" role="radiogroup" aria-labelledby="unsend-title">
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
        </div>

        <div className="ui-dialog-footer unsend-footer">
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={() => void confirm()}>Remove</Button>
        </div>
      </div>
    </dialog>
  );
}
