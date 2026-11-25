import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {TokenVerifier} from 'livekit-server-sdk';
import {DataStack} from './support/stack.ts';
import {loadLiveKitConfig} from '../../src/livekit/index.ts';
import {catalogRoomName} from '../../src/livekit/config.ts';

test('DATA sessions issue shared-room tokens, enforce owner changes and disconnect deleted rooms without affecting DMs',async()=>{
 const apiKey='synthetic-room-key',apiSecret='synthetic-room-signing-secret-at-least-32';
 const config=loadLiveKitConfig({NODE_ENV:'test',LIVEKIT_ENABLED:'true',LIVEKIT_URL:'ws://localhost:7880',LIVEKIT_API_KEY:apiKey,LIVEKIT_API_SECRET:apiSecret});
 const removed:string[]=[],prepared:{name:string;maxParticipants:number}[]=[];
 config.createRoomService=()=>({async deleteRoom(name:string){removed.push(name);},async createRoom(options:{name:string;maxParticipants:number}){prepared.push(options);}} as unknown as ReturnType<typeof config.createRoomService>);
 const stack=await DataStack.start({bridge:{livekit:config}});
 try {
  const a=await stack.person('rooms-a','Alice'),b=await stack.person('rooms-b','Bob');
  const requestId=randomUUID();
  const created=await a.browser.mutate('POST','/api/voice/rooms',{name:'Shared room',requestId});assert.equal(created.status,201);
  const id=created.body.room.id;
  for(const actor of [a,b]){
   for(const roomId of [id,'lounge','study-room','dev-corner']){
    const response=await actor.browser.mutate('POST','/api/voice/token',{roomId});assert.equal(response.status,200);
    const claims=await new TokenVerifier(apiKey,apiSecret).verify(response.body.token);
    assert.equal(claims.name,actor.displayName);assert.equal(claims.video?.room,catalogRoomName(roomId));
    assert.equal(claims.video?.canPublishData,false);assert.ok((claims.exp as number)-(claims.nbf as number)<=30);
   }
  }
  assert.equal((await b.browser.mutate('DELETE',`/api/voice/rooms/${id}`)).status,403);assert.equal(removed.length,0);
  assert.equal(prepared.length,8);assert.ok(prepared.every(room=>room.maxParticipants===32));
  assert.equal((await a.browser.mutate('PATCH',`/api/voice/rooms/${id}`,{name:'Renamed room'})).status,200);
  assert.ok((await b.browser.request('/api/voice/rooms')).body.items.some((r:{name:string})=>r.name==='Renamed room'));
  assert.equal((await a.browser.mutate('DELETE',`/api/voice/rooms/${id}`)).status,204);assert.ok(removed.includes(catalogRoomName(id)));
  assert.equal((await b.browser.mutate('POST','/api/voice/token',{roomId:id})).status,403);
  assert.equal((await b.browser.mutate('POST','/api/voice/token',{roomId:'unknown'})).status,403);
  assert.equal((await b.browser.request('/api/voice/token',{method:'POST',body:{roomId:'lounge'}})).status,403);
  assert.equal(stack.data.application.db.prepare('SELECT count(*) n FROM Conversations').get().n,0);
  assert.equal(stack.data.application.db.prepare('SELECT count(*) n FROM Messages').get().n,0);
 }finally{await stack.close();}
});
