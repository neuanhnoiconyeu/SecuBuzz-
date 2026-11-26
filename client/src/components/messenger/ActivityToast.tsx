import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BellRing, MessageCircle, X } from 'lucide-react';
import { Button } from '@/components/ui';

/** Transient, generic in-app feedback. No system notifications, audio or permission prompts. */
export function ActivityToast({ id, text, kind, onDismiss, onOpen }: {
  id: string; text: string; kind: 'message' | 'buzz'; onDismiss(): void; onOpen?(): void;
}) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const toast = useRef<HTMLElement>(null);
  const dismiss = useRef(onDismiss); dismiss.current = onDismiss;
  useEffect(() => { setFocused(Boolean(toast.current?.contains(document.activeElement))); }, [id]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!document.hidden && !hovered && !focused) timer = setTimeout(() => dismiss.current(), 5000);
    };
    schedule(); document.addEventListener('visibilitychange', schedule);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', schedule); };
  }, [id, hovered, focused]);
  if (typeof document === 'undefined') return null;
  const Icon = kind === 'buzz' ? BellRing : MessageCircle;
  return createPortal(<aside ref={toast} className={`activity-toast activity-toast--${kind}`} aria-label="Incoming activity"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <Icon size={20} aria-hidden="true" />
    <div className="activity-toast-copy"><p role="status" aria-atomic="true" aria-label={kind === 'buzz' ? 'Buzz notification' : 'Message notification'}>{text}</p>
      {onOpen && <Button size="sm" variant="ghost" onClick={() => { onOpen(); onDismiss(); }}>View conversation</Button>}
    </div>
    <Button size="sm" variant="ghost" aria-label="Dismiss notification" onClick={onDismiss}><X size={18} aria-hidden="true" /></Button>
  </aside>, document.body);
}
