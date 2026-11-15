import { createContext, useContext, type ReactNode } from 'react';
import type { AuthUser } from '@/auth/authModel';
import type { RealtimeClient } from '@/realtime/realtimeModel';
import { useLiveKitConnection } from '@/voice/useLiveKitConnection';
import { useLiveDirectCalls, type LiveDirectCallsController } from '@/calls/useLiveDirectCalls';
import { VoiceRoomAudio } from '@/components/voice/VoiceMedia';
import { VoiceVideo } from '@/components/voice/VoiceMedia';
import { VoiceParticipantTile } from '@/components/voice/VoiceParticipantTile';
import { Button } from '@/components/ui';
import { DirectCallLayer } from './DirectCallLayer';
import { FloatingCallPanel } from './FloatingCallPanel';

const DirectCallsContext = createContext<LiveDirectCallsController | null>(null);
export const useDirectCalls = () => useContext(DirectCallsContext);

export function DirectCallMediaStage({ calls, user }: { calls: LiveDirectCallsController; user: AuthUser }) {
  const { media } = calls;
  return <div className="direct-call-media-content">
    {media.participants.filter(person => person.screen).map(person => <section className="call-screen-stage" key={person.id} aria-label={`${person.name}'s screen share`}>
      <p>{person.name}{person.isLocal ? ' (you)' : ''} · Screen share</p><VoiceVideo track={person.screen!} local={false} label={`${person.name}'s shared screen`} />
    </section>)}
    <div className={`voice-stage ${media.participants.length > 1 ? 'has-participants' : ''}`} data-participant-count={media.participants.length}>
      {media.participants.map(person => <VoiceParticipantTile key={person.id} person={person} user={user} />)}
    </div>
    {calls.state.phase === 'connecting' && <p className="direct-call-note" role="status">{calls.ownedId ? 'Connecting media · Waiting for the other participant.' : 'Media is not active on this device.'}</p>}
    {media.needsPlayback && <Button variant="outline" onClick={() => void media.enablePlayback()}>Enable call sound</Button>}
  </div>;
}
export function LiveDirectCallLayer({ calls, user }: { calls: LiveDirectCallsController; user: AuthUser }) {
  const incoming = calls.state.phase === 'ringing' && calls.state.call.direction === 'incoming';
  return <>
    {incoming ? <DirectCallLayer state={calls.state} actions={calls} busy={calls.busy} canAccept={calls.available} error={calls.error}
      media={{ microphoneEnabled: calls.media.microphoneEnabled, cameraEnabled: calls.media.cameraEnabled,
        pending: calls.media.pending.audio || calls.media.pending.video,
        onToggleMicrophone: () => void calls.media.toggleDevice('audio'), onToggleCamera: () => void calls.media.toggleDevice('video') }}
      mediaContent={calls.state.phase !== 'idle' && calls.state.phase !== 'ringing' && <DirectCallMediaStage calls={calls} user={user} />} />
      : <FloatingCallPanel key={calls.state.phase === 'idle' ? 'idle' : calls.state.call.id} calls={calls}><DirectCallMediaStage calls={calls} user={user} /></FloatingCallPanel>}
    <VoiceRoomAudio controller={calls.media} />
    {calls.state.phase === 'idle' && calls.error && <p role="alert" className="voice-device-error">{calls.error}</p>}
  </>;
}
/** Mount once at the real authenticated workspace boundary; it uses that workspace's existing socket. */
export function DirectCallsRuntime({ client, user, children }: { client: RealtimeClient; user: AuthUser; children?: ReactNode }) {
  const { service } = useLiveKitConnection('direct-call', () => client.calls?.getConnectionId() ?? null);
  const calls = useLiveDirectCalls(client, service, user);
  return <DirectCallsContext.Provider value={calls}>{children}<LiveDirectCallLayer calls={calls} user={user} /></DirectCallsContext.Provider>;
}
