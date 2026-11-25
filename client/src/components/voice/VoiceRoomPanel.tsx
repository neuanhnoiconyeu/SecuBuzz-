import { useEffect, useRef } from 'react';
import { ChevronLeft, Headphones, LogOut, Mic, MicOff, Users, Video, VideoOff, Volume2, Wifi, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui';
import type { AuthUser } from '@/auth/authModel';
import type { VoiceRoom } from '@/voice/voiceRooms';
import type { VoiceRoomsController } from '@/voice/useVoiceRooms';
import type { LiveVoiceRoomController, VoiceParticipant } from '@/voice/useLiveVoiceRoom';
import { VoiceParticipantTile, VoiceParticipantAvatar } from './VoiceParticipantTile';
interface VoiceRoomPanelProps {
  room: VoiceRoom;
  controller: VoiceRoomsController | LiveVoiceRoomController;
  user: AuthUser;
  onBack(): void;
}

export function VoiceRoomPanel({ room, controller, user, onBack }: VoiceRoomPanelProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const live = controller.mode === 'live' ? controller : null;
  const local = controller.mode === 'local-preview' ? controller : null;
  const joined = controller.joinedRoomId === room.id;
  const thisAttempt = live?.targetRoomId === room.id;
  const connecting = thisAttempt && (live?.status === 'requesting-token' || live?.status === 'connecting');
  const reconnecting = thisAttempt && live?.status === 'reconnecting';
  const microphoneOn = joined && (live ? live.microphoneEnabled : Boolean(local?.streams.audio));
  const cameraOn = joined && (live ? live.cameraEnabled : Boolean(local?.streams.video));
  const participants: VoiceParticipant[] = !joined ? [] : live ? live.participants : [{ id: user.id, name: user.displayName,
    isLocal: true, microphoneEnabled: microphoneOn, cameraEnabled: cameraOn, speaking: false, video: null }];
  const connectionLabel = !live ? 'Voice unavailable' : live.status === 'disabled' ? 'Voice unavailable' : connecting ? 'Connecting'
    : reconnecting ? 'Reconnecting' : joined && live.status === 'connected' ? 'Connected' : live.status === 'leaving' ? 'Leaving' : 'Not connected';
  const waitingLabel = !live ? joined ? 'Waiting alone · Local preview' : 'Room available · Not joined'
    : live.status === 'leaving' ? 'Leaving voice…' : connecting ? 'Connecting to voice…' : reconnecting ? 'Reconnecting to voice…' : joined ? participants.length === 1 ? 'Connected · Waiting alone' : 'Connected · Voice room'
      : live.status === 'disabled' ? 'Live voice unavailable' : 'Room available · Not joined';
  useEffect(() => { heading.current?.focus(); }, [room.id]);

  return <section className="voice-room-panel" aria-labelledby="voice-room-name">
    <header className="voice-panel-header">
      <button type="button" className="mobile-chat-back" aria-label="Back to conversations and voice rooms" onClick={onBack}><ChevronLeft size={21} aria-hidden="true" /></button>
      <span className="voice-header-icon"><Volume2 size={23} aria-hidden="true" /></span>
      <div><p className="conversation-sidebar-eyebrow">VOICE ROOM</p><h1 id="voice-room-name" className="display-heading" ref={heading} tabIndex={-1}>{room.name}</h1></div>
      <span className={`voice-connection-state ${live && joined && live.status === 'connected' ? 'is-connected' : ''}`}>
        {live && joined && live.status === 'connected' ? <Wifi size={14} aria-hidden="true" /> : <WifiOff size={14} aria-hidden="true" />}{connectionLabel}
      </span>
    </header>
    <div className="voice-panel-body">
      <div className="voice-room-intro">
        <span className="voice-local-label">{live ? 'Drop in anytime' : 'Local preview'}</span>
        <h2>{joined ? participants.length > 1 ? 'You’re in good company.' : 'A little room to yourself.' : 'Drop in. Make yourself at home.'}</h2>
        <p>{room.description}</p>
      </div>
      <div className={`voice-stage ${participants.length > 1 ? 'has-participants' : ''}`} data-participant-count={participants.length}>
        {joined ? participants.map((person) => <VoiceParticipantTile key={person.id} person={person} user={user}
          preview={Boolean(local)} previewStream={person.isLocal && cameraOn ? local?.streams.video ?? null : null} />) : <div className="voice-empty-stage">
          <span className="voice-empty-icon"><Headphones size={38} strokeWidth={1.4} aria-hidden="true" /></span>
          <h3>This room has a place for you.</h3><p>Join even when the room is empty.</p>
          <Button disabled={Boolean(live && (!live.canJoin || connecting))} loading={Boolean(connecting)} leadingIcon={<Headphones size={17} aria-hidden="true" />}
            onClick={() => void controller.join(room.id)}>{connecting ? 'Connecting' : controller.joinedRoomId || (live?.targetRoomId && !thisAttempt) ? 'Switch to this room' : 'Join room'}</Button>
        </div>}
      </div>
      <div className="voice-waiting" role="status"><span className="voice-waiting-dot" aria-hidden="true" /><div><strong>{waitingLabel}</strong>
        <p>{!live ? `Live voice is unavailable. ${joined ? 'Your devices preview only on this device.' : 'You can join locally and preview your devices.'}`
          : live.status === 'disabled' ? live.connectionError
            : reconnecting ? 'Restoring the voice connection. You can leave at any time.'
              : joined ? 'Anyone with access can join at any time. No host approval is needed.' : 'Join directly and wait for others. No host approval is needed.'}</p>
      </div></div>
      {live && joined && live.needsPlayback && <Button variant="outline" onClick={() => void live.enablePlayback()} leadingIcon={<Volume2 size={17} aria-hidden="true" />}>Enable sound</Button>}
      <section className="voice-participants" aria-labelledby="voice-participants-title">
        <h2 id="voice-participants-title"><Users size={16} aria-hidden="true" />Participants<span>{joined ? participants.length : live ? '—' : 0}{!live && ' local'}</span></h2>
        {joined ? <ul aria-label="Room participants">{participants.map((person) => <li key={person.id} className={person.speaking ? 'is-speaking' : ''}>
          <VoiceParticipantAvatar person={person} user={user} size="sm" /><span>{person.name}<small>{person.speaking ? 'Speaking' : person.isLocal ? live ? 'You' : 'You · Local preview' : 'Participant'}</small></span>
          {person.microphoneEnabled ? <Mic size={15} aria-label={live ? 'Microphone on' : 'Local microphone on'} /> : <MicOff size={15} aria-label="Microphone muted" />}
        </li>)}</ul> : <p>{live ? 'Participant counts are available after joining.' : 'No local participants. Live participant counts are unavailable.'}</p>}
      </section>
    </div>
    <footer className="voice-controls">
      <div className="voice-control-buttons">
        <Button variant={microphoneOn ? 'secondary' : 'outline'} disabled={!joined || Boolean(reconnecting && !microphoneOn)} loading={joined && controller.pending.audio}
          aria-label={microphoneOn ? 'Mute microphone' : 'Unmute microphone'} aria-pressed={microphoneOn}
          leadingIcon={microphoneOn ? <Mic size={19} aria-hidden="true" /> : <MicOff size={19} aria-hidden="true" />} onClick={() => void controller.toggleDevice('audio')}>
          {joined && controller.pending.audio ? microphoneOn ? 'Muting' : 'Requesting microphone' : microphoneOn ? 'Mute' : 'Unmute'}</Button>
        <Button variant={cameraOn ? 'secondary' : 'outline'} disabled={!joined || Boolean(reconnecting && !cameraOn)} loading={joined && controller.pending.video}
          aria-label={cameraOn ? 'Turn camera off' : 'Turn camera on'} aria-pressed={cameraOn}
          leadingIcon={cameraOn ? <Video size={19} aria-hidden="true" /> : <VideoOff size={19} aria-hidden="true" />} onClick={() => void controller.toggleDevice('video')}>
          {joined && controller.pending.video ? 'Updating camera' : cameraOn ? 'Camera on' : 'Camera off'}</Button>
        <Button variant="danger" disabled={!joined && !connecting} leadingIcon={<LogOut size={19} aria-hidden="true" />} onClick={() => void controller.leave()}>
          {connecting ? 'Cancel join' : 'Leave room'}</Button>
      </div>
      {joined && Object.entries(controller.errors).map(([device, message]) => message && <p key={device} className="voice-device-error" role="alert">{message}</p>)}
      {live?.connectionError && live.status !== 'disabled' && <p className="voice-device-error" role="alert">{live.connectionError}</p>}
      <p className="voice-controls-note">{!live ? 'Microphone and camera start off. Nothing is transmitted.' : joined ? microphoneOn ? 'Microphone on. Use Mute to stop transmitting audio.' : 'Your microphone is muted. You can still listen.' : 'Joining turns on your microphone. Camera starts off.'}</p>
      {live && <p className="voice-controls-note">LiveKit transport encryption is used. End-to-end media encryption is not enabled.</p>}
    </footer>
  </section>;
}
