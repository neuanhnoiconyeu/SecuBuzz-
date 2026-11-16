import { useEffect, useState } from 'react';
import { Clock, Loader2, Phone, PhoneOff } from 'lucide-react';
import { formatCallDuration, type ActiveDirectCall } from '@/calls/directCallMachine';

export function DirectCallStatus({ state }: { state: ActiveDirectCall }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (state.phase !== 'connected' && state.phase !== 'reconnecting') return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state.phase, state.connectedAt]);
  const labels = { ringing: state.call.direction === 'incoming' ? 'Incoming call' : 'Ringing', connecting: 'Connecting', connected: 'Connected', reconnecting: 'Reconnecting',
    declined: 'Declined', missed: 'Missed', ended: 'Ended' };
  const Icon = state.phase === 'connecting' ? Loader2 : state.phase === 'connected' ? Phone : state.phase === 'ringing' ? Phone : PhoneOff;
  return <div className="direct-call-status" data-state={state.phase}>
    <p role="status" aria-live="polite"><Icon size={16} aria-hidden="true" /><span>{labels[state.phase]}{state.call.source === 'preview' ? ' · UI preview' : ''}</span></p>
    {state.connectedAt !== null && <span className="direct-call-duration"><Clock size={14} aria-hidden="true" />
      <output aria-label="Call duration" aria-live="off">{formatCallDuration((state.endedAt ?? Math.max(now, state.connectedAt)) - state.connectedAt)}</output>
    </span>}
  </div>;
}
