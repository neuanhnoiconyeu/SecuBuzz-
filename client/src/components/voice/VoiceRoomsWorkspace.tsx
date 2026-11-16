import { useState } from 'react';
import type { AuthUser } from '@/auth/authModel';
import { BrandLogo } from '@/components/branding';
import { Button } from '@/components/ui';
import { ConversationSidebar } from '@/components/messenger/ConversationSidebar';
import { useLiveKitConnection } from '@/voice/useLiveKitConnection';
import { useLiveVoiceRoom } from '@/voice/useLiveVoiceRoom';
import { VOICE_ROOMS } from '@/voice/voiceRooms';
import { VoiceRoomPanel } from './VoiceRoomPanel';
import { VoiceRoomsSidebar } from './VoiceRoomsSidebar';
import { VoiceRoomAudio } from './VoiceMedia';

interface VoiceRoomsWorkspaceProps {
  user: AuthUser;
  onClose(): void;
  onLogout(): Promise<boolean>;
  isLoggingOut: boolean;
  logoutError: string | null;
}

/** Real accounts can use voice without fictional chat/friend data or a messenger crypto adapter. */
export function VoiceRoomsWorkspace({ user, onClose, onLogout, isLoggingOut, logoutError }: VoiceRoomsWorkspaceProps) {
  const { service } = useLiveKitConnection();
  const voice = useLiveVoiceRoom(service, user);
  const [selected, setSelected] = useState(VOICE_ROOMS[0]!.id);
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const room = VOICE_ROOMS.find((entry) => entry.id === selected)!;
  return <main className="app-shell"><div className="messenger-app voice-workspace">
    <div className="messenger-window-chrome">SecuBuzz · Voice Rooms</div>
    <nav className="messenger-navigation voice-workspace-nav" aria-label="Voice room navigation">
      <BrandLogo variant="compact" size="sm" decorative />
      <span className="voice-workspace-user" title={user.displayName}>{user.displayName}</span>
      <Button variant="ghost" size="sm" onClick={onClose}>Back to account</Button>
      <Button variant="outline" size="sm" disabled={isLoggingOut} loading={isLoggingOut} onClick={() => void onLogout()}>Sign Out</Button>
    </nav>
    <section className="messenger-chat-section" aria-label="Voice rooms">
      <ConversationSidebar conversations={[]} activeConversationId={null} mobileListOpen={mobileListOpen} onSelect={() => {}}
        showConversations={false} voiceRooms={<VoiceRoomsSidebar selectedRoomId={selected} joinedRoomId={voice.joinedRoomId} live={voice}
          onSelect={(roomId) => { setSelected(roomId); setMobileListOpen(false); }} onLeave={() => void voice.leave()} />} />
      <div className="messenger-main-column voice-main-column">
        {logoutError && <p className="voice-workspace-error" role="alert">{logoutError}</p>}
        <VoiceRoomPanel room={room} controller={voice} user={user} onBack={() => setMobileListOpen(true)} />
      </div>
    </section>
    <VoiceRoomAudio controller={voice} />
  </div></main>;
}
