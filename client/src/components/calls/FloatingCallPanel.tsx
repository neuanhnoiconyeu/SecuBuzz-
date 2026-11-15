import { useState } from 'react';
import { Maximize2, Minimize2, MonitorUp, MonitorOff } from 'lucide-react';
import type { LiveDirectCallsController } from '@/calls/useLiveDirectCalls';
import { isCallFinished } from '@/calls/directCallMachine';
import { Avatar, Button } from '@/components/ui';
import { DirectCallStatus } from './DirectCallStatus';
import { DirectCallControls } from './DirectCallControls';

/** Presentation only: minimizing changes no connection, publication, or call state. */
export function FloatingCallPanel({ calls, children }: { calls: LiveDirectCallsController; children: React.ReactNode }) {
  const [minimized, setMinimized] = useState(false);
  if (calls.state.phase === 'idle') return null;
  const { state, media } = calls, finished = isCallFinished(state);
  const enabled = calls.ownedId === state.call.id && (state.phase === 'connected' || state.phase === 'reconnecting');
  return <aside className={`floating-call-panel ${minimized ? 'is-minimized' : ''}`} aria-label={`Call with ${state.call.peer.name}`}>
    <header className="floating-call-header">
      <Avatar name={state.call.peer.name} {...(state.call.peer.avatarUrl ? { src: state.call.peer.avatarUrl } : {})} />
      <div><h2>{state.call.peer.name}</h2><DirectCallStatus state={state} /></div>
      <button type="button" className="floating-call-toggle" aria-expanded={!minimized} aria-label={minimized ? 'Expand call' : 'Minimize call'} onClick={() => setMinimized(value => !value)}>
        {minimized ? <Maximize2 size={18} aria-hidden="true" /> : <Minimize2 size={18} aria-hidden="true" />}
      </button>
    </header>
    {!finished && <p className="floating-call-participants" aria-label="Active call participants">{media.participants.length ? media.participants.map(person => `${person.name}${person.isLocal ? ' (you)' : ''}`).join(' · ') : 'Waiting for media connection'}</p>}
    {!minimized && !finished && <div className="floating-call-body">{children}</div>}
    {media.screenShareEnabled && <p role="status" className="direct-call-note">You are sharing your screen.</p>}
    {calls.error && <p role="alert" className="voice-device-error">{calls.error}</p>}
    {!finished ? <>
      <DirectCallControls enabled={enabled} media={{ microphoneEnabled: media.microphoneEnabled, cameraEnabled: media.cameraEnabled,
        pending: media.pending.audio || media.pending.video, onToggleMicrophone: () => void media.toggleDevice('audio'), onToggleCamera: () => void media.toggleDevice('video') }} onHangUp={() => calls.hangUp(state.call.id)} />
      <Button className="call-screen-share" variant="outline" disabled={!media.screenShareEnabled && (!enabled || media.status !== 'connected') || media.pending.screen}
        aria-label={media.screenShareEnabled ? 'Stop sharing screen' : 'Share screen'} aria-pressed={media.screenShareEnabled}
        leadingIcon={media.screenShareEnabled ? <MonitorOff size={18} aria-hidden="true" /> : <MonitorUp size={18} aria-hidden="true" />}
        onClick={() => void media.toggleDevice('screen')}>{media.screenShareEnabled ? 'Stop sharing' : 'Share screen'}</Button>
      {Object.entries(media.errors).map(([device, message]) => message && <p key={device} role="alert" className="voice-device-error">{message}</p>)}
      {media.needsPlayback && minimized && <Button onClick={() => void media.enablePlayback()}>Enable call sound</Button>}
    </> : <Button variant="outline" onClick={() => calls.dismiss(state.call.id)}>Close call</Button>}
  </aside>;
}
