import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Search, X } from 'lucide-react';
import { Button } from '@/components/ui';
import type { ChatMessage } from '@/messaging/messageModel';
import { createClientMessageId } from '@/messaging/messageState';

const MAX_RECIPIENTS = 5;

export interface ForwardTarget {
  id: string;
  displayName: string;
}

interface ForwardDialogProps {
  message: ChatMessage | null;
  conversations: ForwardTarget[];
  onClose(): void;
  onConfirm(conversationIds: string[], note: string, operationId: string): Promise<{ failed: string[]; noteFailed?: string[] }>;
}

export function ForwardDialog({ message, conversations, onClose, onConfirm }: ForwardDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState<string[]>([]);
  const [attempted, setAttempted] = useState(false);
  const operationId = useRef('');
  const submitLock = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (message && !dialog.open) {
      setQuery(''); setSelected([]); setNote(''); setError('');
      setCompleted([]); setAttempted(false);
      operationId.current = createClientMessageId();
      dialog.showModal();
    } else if (!message && dialog.open) {
      dialog.close();
    }
  }, [message]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? conversations.filter((c) => c.displayName.toLowerCase().includes(q)) : conversations;
  }, [conversations, query]);

  const toggle = (id: string) => {
    setError('');
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < MAX_RECIPIENTS ? [...prev, id] : prev,
    );
  };

  const submit = async () => {
    if (!selected.length || submitLock.current) return;
    submitLock.current = true;
    setBusy(true);
    setAttempted(true);
    setError('');
    try {
      const { failed, noteFailed = [] } = await onConfirm(selected, note.trim(), operationId.current);
      setCompleted(previous => [...new Set([...previous, ...selected.filter(id => !failed.includes(id))])]);
      if (failed.length === 0) {
        onClose();
      } else {
        const names = (ids: string[]) => conversations.filter(c => ids.includes(c.id)).map(c => c.displayName).join(', ');
        const forwardFailed = failed.filter(id => !noteFailed.includes(id));
        setSelected(failed);
        setError([
          forwardFailed.length ? `Could not forward to: ${names(forwardFailed)}.` : '',
          noteFailed.length ? `The message was forwarded to ${names(noteFailed)}, but the optional note was not sent.` : '',
          'Retry resumes unfinished sends without forwarding completed messages again.',
        ].filter(Boolean).join(' '));
      }
    } catch {
      setError('Forwarding could not be completed. Retry to resume unfinished sends.');
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialogRef} className="ui-dialog forward-dialog" onClose={onClose}
      onCancel={event => { if (submitLock.current) event.preventDefault(); }} aria-labelledby="forward-title">
      <div className="ui-dialog-panel">
        <div className="ui-dialog-header">
          <div>
            <h2 className="ui-dialog-title" id="forward-title">Forward to</h2>
            <p className="ui-dialog-description">Choose up to {MAX_RECIPIENTS} conversations.</p>
          </div>
          <Button variant="ghost" size="sm" className="ui-dialog-close" disabled={busy} onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </Button>
        </div>

        <div className="ui-dialog-body">
          <blockquote className="forward-preview">{message?.content}</blockquote>

          <div className="conversation-search">
            <Search size={16} className="conversation-search-icon" aria-hidden="true" />
            <input
              type="search"
              className="ui-input conversation-search-input"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search conversations"
            />
          </div>

          <ul className="forward-list">
            {filtered.length === 0 && <li className="forward-empty">No conversations found.</li>}
            {filtered.map((c) => {
              const isSelected = selected.includes(c.id);
              const initials = c.displayName.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    disabled={busy || completed.includes(c.id)}
                    className={`forward-target ${isSelected ? 'is-selected' : ''}`}
                    aria-pressed={isSelected}
                    onClick={() => toggle(c.id)}
                  >
                    <span className="ui-avatar ui-avatar--sm" aria-hidden="true">{initials}</span>
                    <span className="forward-target-name">{c.displayName}</span>
                    {completed.includes(c.id) && <span className="forward-count">Sent</span>}
                    <span className="forward-check" aria-hidden="true">{isSelected && <Check size={12} />}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          <input
            type="text"
            className="ui-input"
            placeholder="Add a message (optional)…"
            value={note}
            disabled={busy || attempted}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Optional message"
          />
          {error && <p className="composer-error" role="alert">{error}</p>}
        </div>

        <div className="ui-dialog-footer forward-footer">
          <span className="forward-count">{selected.length} selected</span>
          <Button variant="primary" disabled={!selected.length} loading={busy} onClick={() => void submit()}>
            Send{selected.length > 1 ? ` (${selected.length})` : ''}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
