import { Avatar, Button } from '@/components/ui';
import { useState } from 'react';
import { Minimize2, Maximize2, X } from 'lucide-react';
import { isCallFinished, type ActiveDirectCall } from '@/calls/directCallMachine';
import { DirectCallStatus } from './DirectCallStatus';
import { DirectCallControls, type DirectCallMediaControls } from './DirectCallControls';
import type { ReactNode } from 'react';

export function DirectCallWindow({ state, onHangUp, onDismiss, media, mediaContent, error }: {
  state: ActiveDirectCall; onHangUp(): void; onDismiss(): void; media?: DirectCallMediaControls; mediaContent?: ReactNode; error?: string | null;
}) {
  const { peer, kind, source } = state.call;
  const finished = isCallFinished(state);
  const [minimized, setMinimized] = useState(false);
  return <aside role="dialog" aria-modal="false" aria-label={`${kind === 'video' ? 'Video' : 'Voice'} call with ${peer.name}`} className={`floating-call-panel direct-call-preview-window ${minimized ? 'is-minimized' : ''}`}>
    <header className="floating-call-header"><div><h2>{peer.name}</h2><DirectCallStatus state={state} /></div>
      <button type="button" className="floating-call-toggle" aria-expanded={!minimized} aria-label={minimized ? 'Expand call' : 'Minimize call'} onClick={() => setMinimized(value => !value)}>
        {minimized ? <Maximize2 size={18} aria-hidden="true" /> : <Minimize2 size={18} aria-hidden="true" />}</button>
      <button type="button" className="floating-call-toggle" aria-label={finished ? 'Close call window' : 'End call'} onClick={finished ? onDismiss : onHangUp}><X size={18} aria-hidden="true" /></button>
    </header>
    <p className="direct-call-note">{source === 'preview' ? 'UI preview · Calling service unavailable' : `${state.call.direction === 'incoming' ? 'Incoming' : 'Outgoing'} ${kind} call`}</p>
    <div hidden={minimized}>
    <div className={`direct-call-stage ${mediaContent ? 'has-call-media' : ''} ${state.phase === 'ringing' ? 'is-ringing' : ''}`}>
      <Avatar name={peer.name} {...(peer.avatarUrl ? { src: peer.avatarUrl } : {})} size="lg" />
      <h3>{peer.name}</h3>
      {source === 'preview' && <p className="direct-call-note">{state.phase === 'connecting' ? 'This previews the connection screen. A calling service is needed to connect; no media is transmitted.'
        : finished ? 'Preview complete. No remote call was made and no media was transmitted.'
          : `${peer.name} has not been notified. This previews the outgoing call window without placing a call.`}</p>}
    </div>
    {!finished && mediaContent}
    </div>
    {error && <p className="voice-device-error" role="alert">{error}</p>}
    {finished ? <div className="direct-call-finished"><Button variant="outline" onClick={onDismiss}>Close call</Button></div>
      : <><DirectCallControls enabled={source === 'transport' && state.phase === 'connected'} {...(media ? { media } : {})} onHangUp={onHangUp} />
        {source === 'preview' && <p className="direct-call-note direct-call-device-note">Microphone and camera controls become available when a real call connects.</p>}</>}
  </aside>;
}
