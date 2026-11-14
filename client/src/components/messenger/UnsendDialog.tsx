import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui';
import type { ChatMessage } from '@/messaging/messageModel';

export type UnsendScope = 'everyone' | 'me';

interface UnsendDialogProps {
  message: ChatMessage | null;
  canUnsendEveryone: boolean;
  onClose(): void;
  onConfirm(scope: UnsendScope): void;
}

export function UnsendDialog({ message, canUnsendEveryone, onClose, onConfirm }: UnsendDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [scope, setScope] = useState<UnsendScope>('everyone');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (message && !dialog.open) {
      setScope(canUnsendEveryone ? 'everyone' : 'me');
      dialog.showModal();
    } else if (!message && dialog.open) {
      dialog.close();
    }
  }, [message, canUnsendEveryone]);

  const options: Array<{ value: UnsendScope; title: string; text: string }> = [
    ...(canUnsendEveryone ? [{
      value: 'everyone' as const,
      title: 'Unsend for everyone',
      text: 'This message will be unsent for everyone in the chat. Others may have already seen or forwarded it.',
    }] : []),
    {
      value: 'me' as const,
      title: 'Unsend for you',
      text: 'This message will be removed from your device, but it will still be visible to other chat members.',
    },
  ];

  return (
    <dialog ref={dialogRef} className="ui-dialog unsend-dialog" onClose={onClose} aria-labelledby="unsend-title">
      <div className="ui-dialog-panel">
        <div className="ui-dialog-header">
          <h2 className="ui-dialog-title" id="unsend-title">Who do you want to unsend this message for?</h2>
          <Button variant="ghost" size="sm" className="ui-dialog-close" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </Button>
        </div>

        <div className="ui-dialog-body">
          <div className="unsend-options" role="radiogroup" aria-labelledby="unsend-title">
            {options.map((option) => (
              <label key={option.value} className={`unsend-option ${scope === option.value ? 'is-selected' : ''}`}>
                <input
                  type="radio"
                  name="unsend-scope"
                  value={option.value}
                  checked={scope === option.value}
                  onChange={() => setScope(option.value)}
                />
                <span className="unsend-option-copy">
                  <strong>{option.title}</strong>
                  <span>{option.text}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="ui-dialog-footer unsend-footer">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => onConfirm(scope)}>Remove</Button>
        </div>
      </div>
    </dialog>
  );
}