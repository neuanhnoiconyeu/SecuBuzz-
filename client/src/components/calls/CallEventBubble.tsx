import { Phone, Video } from 'lucide-react';
import { useId } from 'react';
import { directCallSummaryLabel, type DirectCallSummary } from '@/calls/directCallHistory';

/** A session-only timeline event, never an encrypted message or a new call controller. */
export function CallEventBubble({ call }: { call: DirectCallSummary }) {
  const Icon = call.kind === 'video' ? Video : Phone;
  const timestamp = new Date(call.endedAt);
  const descriptionId = useId();
  return <article className="message-system message-call-event" role="note" data-call-id={call.id}
    aria-label={directCallSummaryLabel(call)}
    aria-describedby={descriptionId}
    title="Call observed in this session; not saved after reload or sign-out.">
    <Icon size={16} aria-hidden="true" />
    <strong>{directCallSummaryLabel(call)}</strong>
    <span id={descriptionId} hidden>Call observed in this session; not saved after reload or sign-out.</span>
    {!call.confirmed && <span>End not confirmed</span>}
    <time dateTime={timestamp.toISOString()} title={timestamp.toLocaleString()}>
      {timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </time>
  </article>;
}
