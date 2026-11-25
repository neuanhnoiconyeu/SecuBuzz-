import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useAuth } from '@/auth/AuthProvider';
import type { AuthContextValue } from '@/auth/AuthProvider';
import { ApiError, type SessionApi } from '@/api/sessionApi';
import { VoiceRoomsWorkspace } from '@/components/voice/VoiceRoomsWorkspace';
import { useLiveKitConnection } from '../useLiveKitConnection';
import { TestVoiceRoom, voiceService, voiceUser } from '@/test-support/liveVoiceFixture';
import { VOICE_ROOMS, type VoiceRoom } from '../voiceRooms';
import { parseRoomCatalog } from '../useRoomCatalog';

// Timing budget: these cases mount the full VoiceRoomsWorkspace under parallel Jest load (matching voiceWorkspace.test.tsx).
jest.setTimeout(20000);

jest.mock('@/auth/AuthProvider',()=>({useAuth:jest.fn()}));
jest.mock('../useLiveKitConnection',()=>({useLiveKitConnection:jest.fn()}));
const id='room-12345678-1234-1234-1234-123456789abc';
let rooms: VoiceRoom[], api:SessionApi, media:TestVoiceRoom;
beforeAll(()=>{
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.setAttribute('open','');}});
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.removeAttribute('open');}});
});
beforeEach(()=>{
 rooms=VOICE_ROOMS.map(r=>({...r,ownerId:null,ownerName:null}));media=new TestVoiceRoom();
 api={actor:voiceUser,dispose:jest.fn(),request:jest.fn(async(path,options)=>{
   if(path==='/api/voice/rooms'&&!options?.method)return {items:rooms};
   const name=(options?.body as {name:string})?.name;
   if(options?.method==='POST'){const room={id,name,description:'Shared room',ownerId:voiceUser.id,ownerName:voiceUser.displayName};rooms=[...rooms,room];return {room};}
   if(options?.method==='PATCH'){rooms=rooms.map(r=>r.id===id?{...r,name}:r);return {room:rooms.at(-1)};}
   if(options?.method==='DELETE'){rooms=rooms.filter(r=>r.id!==id);return undefined;}
   throw new Error('Unexpected request');
 })};
 jest.mocked(useAuth).mockReturnValue({createSessionApi:()=>api,sessionVersion:1} as unknown as AuthContextValue);
 jest.mocked(useLiveKitConnection).mockReturnValue({service:voiceService([media]),snapshot:{status:'disconnected',roomId:null,error:null}});
 jest.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue();jest.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
});
afterEach(()=>{cleanup();jest.clearAllTimers();jest.useRealTimers();jest.restoreAllMocks();});
const show=()=>render(<VoiceRoomsWorkspace user={voiceUser} onClose={jest.fn()} onLogout={jest.fn()} isLoggingOut={false} logoutError={null}/>);
async function create(){fireEvent.click(await screen.findByRole('button',{name:'Create room'}));
 const dialog=screen.getByRole('dialog');fireEvent.change(within(dialog).getByLabelText('Room name'),{target:{value:'Custom room'}});
 fireEvent.click(within(dialog).getByRole('button',{name:'Create room'}));await screen.findByRole('heading',{name:'Custom room'});}

test('create, reload and owner rename/delete reuse the existing room list/dialog and defaults',async()=>{
 const view=show();await create();
 expect(screen.getByRole('list',{name:'Available voice rooms'}).children).toHaveLength(4);
 expect(api.request).toHaveBeenCalledWith('/api/voice/rooms',expect.objectContaining({method:'POST',body:{name:'Custom room',requestId:expect.any(String)}}));
 fireEvent.click(screen.getByRole('button',{name:'Rename room'}));
 let dialog=screen.getByRole('dialog');fireEvent.change(within(dialog).getByLabelText('Room name'),{target:{value:'Renamed room'}});fireEvent.click(within(dialog).getByRole('button',{name:'Save name'}));
 await screen.findByRole('heading',{name:'Renamed room'});
 view.unmount();show();fireEvent.click(await screen.findByRole('button',{name:/Renamed room, participant count/}));
 expect(screen.getByRole('heading',{name:'Renamed room'})).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Delete room'}));dialog=screen.getByRole('dialog');fireEvent.click(within(dialog).getByRole('button',{name:'Cancel'}));
 expect(jest.mocked(api.request).mock.calls.some(([,o])=>o?.method==='DELETE')).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Delete room'}));fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Delete room'}));
 await waitFor(()=>expect(screen.getByRole('list',{name:'Available voice rooms'}).children).toHaveLength(3));
 expect(screen.queryByRole('button',{name:'Rename room'})).not.toBeInTheDocument();
});

test('joining a custom room uses one existing connection; duplicate join, mute and leaving clean up tracks',async()=>{
 show();await create();fireEvent.click(screen.getByRole('button',{name:'Join room'}));
 await screen.findByRole('button',{name:'Mute microphone'});expect(media.connect).toHaveBeenCalledTimes(1);
 expect(screen.getByRole('list',{name:'Room participants'}).children).toHaveLength(1);
 fireEvent.click(screen.getByRole('button',{name:'Mute microphone'}));await screen.findByRole('button',{name:'Unmute microphone'});
 fireEvent.click(screen.getByRole('button',{name:'Unmute microphone'}));await screen.findByRole('button',{name:'Mute microphone'});
 fireEvent.click(screen.getByRole('button',{name:'Leave room'}));await screen.findByRole('button',{name:'Join room'});
 expect(media.disconnect).toHaveBeenCalledWith(true);
});

test('peer-owned controls are absent; poll-based room deletion leaves an active media session',async()=>{
 jest.useFakeTimers({ advanceTimers: true });
 rooms.push({id,name:'Peer room',description:'Shared room',ownerId:'peer',ownerName:'Peer'});
 show();fireEvent.click(await screen.findByRole('button',{name:/Peer room, participant count/}));
 expect(screen.queryByRole('button',{name:'Rename room'})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Join room'}));await screen.findByRole('button',{name:'Mute microphone'});
 await act(async()=>{rooms=rooms.filter(r=>r.id!==id);await jest.advanceTimersByTimeAsync(3000);});
 await screen.findByText('The room was deleted. You have left voice.');expect(media.disconnect).toHaveBeenCalledWith(true);
});

test('create failure stays visible, retry retains its id and duplicate submits are locked',async()=>{
 show();await screen.findByRole('button',{name:'Create room'});
 const original=jest.mocked(api.request).getMockImplementation()!;let attempts=0;
 jest.mocked(api.request).mockImplementation(async(path,opts)=>{if(opts?.method==='POST'&&++attempts===1)throw new ApiError('unavailable');return original(path,opts);});
 fireEvent.click(screen.getByRole('button',{name:'Create room'}));const dialog=screen.getByRole('dialog');
 fireEvent.change(within(dialog).getByLabelText('Room name'),{target:{value:'Custom room'}});
 fireEvent.click(within(dialog).getByRole('button',{name:'Create room'}));
 fireEvent.submit(within(dialog).getByRole('button',{name:'Create room'}).closest('form')!);
 await within(dialog).findByRole('alert');
 expect(jest.mocked(api.request).mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(1);
 fireEvent.click(within(dialog).getByRole('button',{name:'Create room'}));await screen.findByRole('heading',{name:'Custom room'});
 const calls=jest.mocked(api.request).mock.calls.filter(([,o])=>o?.method==='POST');expect(calls).toHaveLength(2);expect(calls[0]?.[1]?.body).toEqual(calls[1]?.[1]?.body);
});

test('catalog validation rejects duplicates and untrusted response shapes',()=>{
 const r={id,name:'Room',description:'Shared',ownerId:'owner',ownerName:'Owner'};
 expect(parseRoomCatalog({items:[r]})).toEqual([r]);
 for(const value of [{},{items:[r,r]},{items:[{...r,id:'direct:private'}]},{items:[{...r,name:''}]}])expect(()=>parseRoomCatalog(value)).toThrow(ApiError);
});
