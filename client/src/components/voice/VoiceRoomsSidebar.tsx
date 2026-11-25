import { Headphones, LogOut, Volume2 } from 'lucide-react';
import { VOICE_ROOMS, type VoiceRoom } from '@/voice/voiceRooms';
import type { LiveVoiceRoomController } from '@/voice/useLiveVoiceRoom';

interface VoiceRoomsSidebarProps {
  selectedRoomId: string | null;
  joinedRoomId: string | null;
  onSelect(roomId: string): void;
  onLeave(): void;
  live?: LiveVoiceRoomController;
  rooms?: readonly VoiceRoom[];
  onCreate?: (() => void) | undefined;
}

export function VoiceRoomsSidebar({ selectedRoomId, joinedRoomId, onSelect, onLeave, live, rooms = VOICE_ROOMS, onCreate }: VoiceRoomsSidebarProps) {
  const joined = rooms.find((room) => room.id === (live?.targetRoomId ?? joinedRoomId));
  return <section className="voice-sidebar" aria-labelledby="voice-rooms-title">
    <div className="voice-sidebar-heading">
      <h2 id="voice-rooms-title"><Headphones size={15} aria-hidden="true" />Voice Rooms</h2>
      <span>{live ? 'Drop in anytime' : 'Local preview'}</span>
    </div>
    {onCreate && <button type="button" className="voice-room-create" onClick={onCreate}>Create room</button>}
    <ul className="voice-room-list" aria-label="Available voice rooms">
      {rooms.map((room) => {
        const count = live ? live.joinedRoomId === room.id && live.status === 'connected' ? live.participants.length : null : joinedRoomId === room.id ? 1 : 0;
        return <li key={room.id}><button type="button"
          className={`voice-room-row ${selectedRoomId === room.id ? 'is-selected' : ''}`}
          aria-current={selectedRoomId === room.id ? 'page' : undefined}
          aria-label={count === null ? `${room.name}, participant count unavailable` : `${room.name}, ${count} ${live ? '' : 'local '}${count === 1 ? 'participant' : 'participants'}`}
          onClick={() => onSelect(room.id)}>
          <Volume2 size={17} aria-hidden="true" />
          <span>{room.name}{joinedRoomId === room.id && <small>{live ? live.status === 'reconnecting' ? 'Reconnecting' : 'Joined' : 'Joined locally'}</small>}</span>
          <span className="voice-room-count" aria-hidden="true">{count ?? '—'}</span>
        </button></li>;
      })}
    </ul>
    <p className="voice-sidebar-note">{live ? 'Counts update in your joined room. Empty rooms stay available.' : 'Counts are local. Live voice is unavailable.'}</p>
    {joined && <div className="voice-sidebar-session">
      <button type="button" className="voice-session-open" onClick={() => onSelect(joined.id)}>
        <Headphones size={17} aria-hidden="true" /><span>{live ? live.status === 'connected' ? live.participants.length === 1 ? 'Waiting alone' : 'Voice connected' : live.status === 'reconnecting' ? 'Reconnecting' : live.status === 'leaving' ? 'Leaving' : 'Connecting' : 'Waiting alone'}
          <small>{joined.name}{!live && ' · Local preview'}</small></span>
      </button>
      <button type="button" className="voice-session-leave" aria-label={`Leave ${joined.name}`} title="Leave room" onClick={onLeave}>
        <LogOut size={17} aria-hidden="true" />
      </button>
    </div>}
  </section>;
}
