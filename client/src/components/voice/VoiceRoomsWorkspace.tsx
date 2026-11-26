import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import type { SessionApi } from '@/api/sessionApi';
import { useRoomCatalog, roomFailure } from '@/voice/useRoomCatalog';
import type { AuthUser } from '@/auth/authModel';
import { BrandLogo } from '@/components/branding';
import { Button, Dialog } from '@/components/ui';
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
  const auth = useAuth();
  const createApi = auth.createSessionApi;
  const [api, setApi] = useState<SessionApi | null>(null);
  useEffect(() => { const next = createApi?.() ?? null; setApi(next); return () => next?.dispose(); }, [createApi, auth.sessionVersion]);
  const catalog = useRoomCatalog(api);
  const { service } = useLiveKitConnection('voice-room', undefined, api ?? undefined);
  const voice = useLiveVoiceRoom(service, user, catalog.rooms);
  const [dialog, setDialog] = useState<'create' | 'rename' | 'delete' | null>(null);
  const [name, setName] = useState(''), [saving, setSaving] = useState(false), [failure, setFailure] = useState(''), [notice, setNotice] = useState('');
  const operation = useRef(false), request = useRef<{name:string;id:string} | null>(null), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [selected, setSelected] = useState(VOICE_ROOMS[0]!.id);
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const room = catalog.rooms.find(entry => entry.id === selected) ?? catalog.rooms[0] ?? VOICE_ROOMS[0]!;
  const { targetRoomId, leave } = voice;
  useEffect(() => {
    if (!catalog.loaded) return;
    if (targetRoomId && !catalog.rooms.some(r => r.id === targetRoomId)) { void leave(); setNotice('The room was deleted. You have left voice.'); }
    if (!catalog.rooms.some(r => r.id === selected)) {
      if (selected.startsWith('room-')) setNotice('The room was deleted. You have left voice.');
      setSelected(catalog.rooms[0]?.id ?? 'lounge');
    }
  }, [catalog.loaded, catalog.rooms, targetRoomId, leave, selected]);
  const open = (mode: 'create' | 'rename' | 'delete') => { setName(mode === 'create' ? '' : room.name); setFailure(''); setDialog(mode); };
  const save = async () => {
    if (!api || !dialog || operation.current) return;
    operation.current = true; setSaving(true); setFailure('');
    try {
      if (dialog === 'create') {
        if (!request.current || request.current.name !== name) request.current = {name, id:crypto.randomUUID()};
        const result = await api.request('/api/voice/rooms', {method:'POST',body:{name,requestId:request.current.id},status:[200,201]}) as {room:{id:string}};
        await catalog.refresh();
        if (mounted.current) setSelected(result.room.id);
      } else if (dialog === 'rename') await api.request(`/api/voice/rooms/${room.id}`, {method:'PATCH',body:{name}});
      else await api.request(`/api/voice/rooms/${room.id}`, {method:'DELETE',status:204});
      if (mounted.current) { setDialog(null); request.current = null; }
    } catch (e) { if (mounted.current) setFailure(roomFailure(e)); }
    finally { await catalog.refresh(); operation.current = false; if (mounted.current) setSaving(false); }
  };
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
          rooms={catalog.rooms} onCreate={api ? () => open('create') : undefined} onSelect={(roomId) => { setSelected(roomId); setMobileListOpen(false); }} onLeave={() => void voice.leave()} />} />
      <div className="messenger-main-column voice-main-column">
        {logoutError && <p className="voice-workspace-error" role="alert">{logoutError}</p>}
        {(catalog.error || notice) && <p role="status" className="voice-workspace-error">{catalog.error || notice}</p>}
        <div className="voice-room-management" role="group" aria-label="Room management">
          <span>Owner: {room.ownerName ?? 'SecuBuzz'} - Shared with signed-in users</span>
          {api && room.ownerId === user.id && <><Button size="sm" variant="ghost" onClick={() => open('rename')}>Rename room</Button><Button size="sm" variant="ghost" onClick={() => open('delete')}>Delete room</Button></>}
        </div>
        <VoiceRoomPanel room={room} controller={voice} user={user} onBack={() => setMobileListOpen(true)} />
      </div>
    </section>
    <VoiceRoomAudio controller={voice} />
    <Dialog open={dialog !== null} onOpenChange={value => { if (!value && !saving) setDialog(null); }} dismissible={!saving}
      title={dialog === 'delete' ? 'Delete voice room' : dialog === 'rename' ? 'Rename voice room' : 'Create voice room'}
      description={dialog === 'delete' ? 'Everyone in this room will be disconnected. This cannot be undone.' : 'Rooms are shared with all signed-in users. Choose a name from 1 to 64 characters.'}>
      <form onSubmit={e => { e.preventDefault(); void save(); }}>
        {dialog !== 'delete' && <label>Room name<input className="composer-input" aria-label="Room name" value={name} maxLength={64} required disabled={saving} onChange={e => setName(e.target.value)} /></label>}
        {failure && <p role="alert">{failure}</p>}
        <div className="voice-room-dialog-actions"><Button type="button" variant="ghost" disabled={saving} onClick={() => setDialog(null)}>Cancel</Button>
          <Button type="submit" variant={dialog === 'delete' ? 'danger' : 'primary'} disabled={saving || (dialog !== 'delete' && !name.trim())} loading={saving}>{dialog === 'delete' ? 'Delete room' : dialog === 'rename' ? 'Save name' : 'Create room'}</Button></div>
      </form>
    </Dialog>
  </div></main>;
}
