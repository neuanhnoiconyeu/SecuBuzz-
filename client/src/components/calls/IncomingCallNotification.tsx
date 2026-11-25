import { useId } from 'react';
import { Phone, PhoneOff, Video } from 'lucide-react';
import { Avatar, Button } from '@/components/ui';
import type { ActiveDirectCall } from '@/calls/directCallMachine';
import { DirectCallStatus } from './DirectCallStatus';
import { NotificationSoundToggle } from '@/notifications/NotificationSoundProvider';

export function IncomingCallNotification({ state, onAccept, onDecline, busy = false, canAccept = true, error, attention = true }: {
  state: ActiveDirectCall; onAccept(): void; onDecline(): void; busy?: boolean; canAccept?: boolean; error?: string | null; attention?: boolean;
}) {
  const titleId = useId(), descriptionId = useId();
  if (state.phase !== 'ringing' || state.call.direction !== 'incoming') return null;
  const { peer, kind, source } = state.call;
  return <aside className="incoming-call-notification" data-call-attention={attention ? 'true' : undefined} role="dialog" aria-modal="false" aria-labelledby={titleId} aria-describedby={descriptionId}>
    <div className="incoming-call-identity"><Avatar name={peer.name} {...(peer.avatarUrl ? { src: peer.avatarUrl } : {})} size="lg" />
      <div><p className="direct-call-eyebrow">{kind === 'video' ? 'Video call' : 'Voice call'}</p><h2 id={titleId}>{peer.name}</h2><DirectCallStatus state={state} /></div>
    </div>
    <p id={descriptionId} role="status" aria-label="Incoming call" aria-atomic="true" className="direct-call-note">{source === 'preview' ? 'Incoming call preview. Nobody is calling you; no audio or video is transmitted.' : `${peer.name} is calling. Incoming ${kind} call. Answer to connect.`}</p>
    {error && <p className="voice-device-error" role="alert">{error}</p>}
    {!canAccept && <p className="direct-call-note">Live media is unavailable on this device. You can decline this call.</p>}
    <div className="incoming-call-actions">
      <Button variant="outline" disabled={busy} onClick={onDecline} leadingIcon={<PhoneOff size={18} aria-hidden="true" />}>Decline</Button>
      <Button disabled={busy || !canAccept} onClick={onAccept} leadingIcon={kind === 'video' ? <Video size={18} aria-hidden="true" /> : <Phone size={18} aria-hidden="true" />}>Answer</Button>
    </div>
    {source === 'transport' && <div className="incoming-call-audio"><NotificationSoundToggle inlineHelp /></div>}
  </aside>;
}
