import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { TokenVerifier } from 'livekit-server-sdk';
import { loadLiveKitConfig, directCallRoomName, directCallParticipantIdentity } from '../../src/livekit/config.ts';
import { DataStack, until } from './support/stack.ts';
import { Browser } from '../e2ee/support/dataApp.ts';
import { tsImport } from 'tsx/esm/api';
import { io } from 'socket.io-client';
import { fileURLToPath } from 'node:url';

// Real DATA sessions, policy, SQLite and Socket.IO. Only the absent media server is stubbed.
// These tests verify signaling/token authorization, NOT audio/video transport.
describe('DATA authenticated direct-call integration',()=>{
  let stack:DataStack;
  const key=randomBytes(16).toString('hex'),secret=randomBytes(32).toString('hex');
  const prepared:string[]=[],finished:string[]=[];
  before(async()=>{stack=await DataStack.start({bridge:{
    rates:{send:{capacity:100,refillPerSecond:100}}, // exercise many lifecycle transitions without the production burst limiter
    livekit:loadLiveKitConfig({LIVEKIT_ENABLED:'true',LIVEKIT_URL:'wss://media.example.invalid',LIVEKIT_API_KEY:key,LIVEKIT_API_SECRET:secret}),
    directCalls:{ringTimeoutMs:1500,media:{async prepare(id){prepared.push(id);},async finish(id){finished.push(id);}}}
  }});});
  after(async()=>{await stack?.close();});
  test('two real accounts initiate voice/video, receive, accept, sync, end, cancel and decline without duplicate sessions',async()=>{
    const {alice,bob,conversationId}=await stack.pair('calls-a','calls-b');
    const a=await stack.connect(alice),b=await stack.connect(bob);
    for(const kind of ['voice','video']){
      const intent={requestId:randomUUID(),conversationId,recipientId:bob.id,kind};
      const outgoing=await a.emitAck('call:initiate',intent);
      assert.equal(outgoing.status,'ok',JSON.stringify(outgoing));assert.equal(outgoing.call.caller.userId,alice.id);
      assert.equal(outgoing.call.caller.displayName,alice.displayName);
      assert.deepEqual(await b.waitFor('call:state',c=>c.callId===outgoing.call.callId),outgoing.call);
      assert.deepEqual(await a.emitAck('call:initiate',intent),outgoing);
      assert.equal((await a.emitAck('call:initiate',{...intent,requestId:randomUUID()})).code,'call_busy');
      const accepted=await b.emitAck('call:accept',{callId:outgoing.call.callId});assert.equal(accepted.call.status,'accepted');
      assert.deepEqual((await a.emitAck('call:sync',{})).calls.find((c:{callId:string})=>c.callId===outgoing.call.callId),accepted.call);
      const ended=await a.emitAck('call:end',{callId:outgoing.call.callId});assert.equal(ended.call.status,'ended');
      assert.deepEqual(await b.emitAck('call:end',{callId:outgoing.call.callId}),ended);
      assert.deepEqual(await b.waitFor('call:state',c=>c.callId===ended.call.callId&&c.status==='ended'),ended.call);
    }
    for(const action of ['cancel','decline']){
      const created=await a.emitAck('call:initiate',{requestId:randomUUID(),conversationId,recipientId:bob.id,kind:'voice'});
      assert.equal(created.status,'ok',JSON.stringify(created));
      const result=await (action==='cancel'?a:b).emitAck(`call:${action}`,{callId:created.call.callId});
      assert.equal(result.call.status,action==='cancel'?'cancelled':'declined');
    }
  });
  test('tokens require current DATA session, CSRF, accepted membership and the owning socket; scope and expiration are bounded',async()=>{
    const {alice,bob,conversationId}=await stack.pair('tokens-a','tokens-b'),outsider=await stack.person('tokens-c');
    const a=await stack.connect(alice),b=await stack.connect(bob),a2=await stack.connect(alice);
    const {call}=await a.emitAck('call:initiate',{requestId:randomUUID(),conversationId,recipientId:bob.id,kind:'video'});
    const route='/api/calls/token',body={callId:call.callId,connectionId:a.socket.id};
    assert.equal((await alice.browser.mutate('POST',route,body)).status,403);
    await b.emitAck('call:accept',{callId:call.callId});
    assert.equal((await new Browser(stack.url).request(route,{method:'POST',body})).status,401);
    assert.equal((await alice.browser.request(route,{method:'POST',body})).status,403);
    assert.equal((await outsider.browser.mutate('POST',route,body)).status,403);
    assert.equal((await bob.browser.mutate('POST',route,body)).status,403);
    assert.equal((await alice.browser.mutate('POST',route,{...body,connectionId:a2.socket.id})).status,409);
    assert.equal((await alice.browser.mutate('POST',route,{...body,userId:bob.id})).status,400);
    for(const [person,socket]of [[alice,a],[bob,b]]as const){
      const response=await person.browser.mutate('POST',route,{callId:call.callId,connectionId:socket.socket.id});
      assert.equal(response.status,200,JSON.stringify(response.body));
      const claims=await new TokenVerifier(key,secret).verify(response.body.token);
      assert.equal(claims.video?.room,directCallRoomName(call.callId));assert.equal(claims.sub,directCallParticipantIdentity(call.callId,person.id));
      assert.equal(claims.video?.canPublishData,false);assert.ok(!claims.video?.roomAdmin&&!claims.video?.roomCreate);
      assert.ok((claims.exp!-claims.nbf!)<=30);assert.ok(Date.parse(response.body.expiresAt)<=Date.now()+30_000);
      assert.ok(!JSON.stringify(response.body).includes(secret));assert.ok(!JSON.stringify(response.body).includes(person.browser.cookies.get('secubuzz_session')!));
    }
    assert.equal(prepared.filter(id=>id===call.callId).length,2); // each participant obtains a media grant
    await a.emitAck('call:end',{callId:call.callId});await until(()=>finished.includes(call.callId));
    assert.equal((await alice.browser.mutate('POST',route,body)).status,403);
  });
  test('authoritative participants, blocks, disconnects, offline recipients and ring timeouts fail safely',async()=>{
    const {alice,bob,conversationId}=await stack.pair('policy-a','policy-b'),outsider=await stack.person('policy-c');
    const a=await stack.connect(alice),b=await stack.connect(bob),c=await stack.connect(outsider);
    const intent={requestId:randomUUID(),conversationId,recipientId:bob.id,kind:'voice'};
    assert.equal((await c.emitAck('call:initiate',intent)).code,'call_not_allowed');
    assert.equal((await a.emitAck('call:initiate',{...intent,callerId:outsider.id})).code,'invalid_payload');
    assert.ok(['call_not_allowed','recipient_unavailable'].includes((await a.emitAck('call:initiate',{...intent,recipientId:outsider.id})).code));
    const first=await a.emitAck('call:initiate',intent);
    assert.equal((await c.emitAck('call:accept',{callId:first.call.callId})).code,'call_not_found');
    assert.equal((await a.emitAck('call:accept',{callId:first.call.callId})).code,'call_not_allowed');
    const missed=await b.waitFor('call:state',s=>s.callId===first.call.callId&&s.status==='missed');assert.equal(missed.reason,'unanswered');
    b.close();await until(()=>!b.socket.connected);
    // Server must observe departure before the next invitation.
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal((await a.emitAck('call:initiate',{...intent,requestId:randomUUID()})).code,'recipient_unavailable');
    const b2=await stack.connect(bob);
    const next=await a.emitAck('call:initiate',{...intent,requestId:randomUUID()});await b2.emitAck('call:accept',{callId:next.call.callId});
    await alice.browser.mutate('POST','/api/blocks',{userId:bob.id});
    await a.waitFor('call:cleared',s=>s.callId===next.call.callId);
    assert.equal((await a.emitAck('call:initiate',{...intent,requestId:randomUUID()})).code,'call_not_allowed');
    assert.equal((await bob.browser.mutate('POST','/api/calls/token',{callId:next.call.callId,connectionId:b2.socket.id})).status,403);
  });
  test('session logout ends the owning call and revokes media authorization',async()=>{
    const {alice,bob,conversationId}=await stack.pair('logout-a','logout-b'),a=await stack.connect(alice),b=await stack.connect(bob);
    const {call}=await a.emitAck('call:initiate',{requestId:randomUUID(),conversationId,recipientId:bob.id,kind:'voice'});
    await b.emitAck('call:accept',{callId:call.callId});
    assert.equal((await alice.browser.mutate('POST','/api/auth/logout')).status,204);
    await b.waitFor('call:state',s=>s.callId===call.callId&&s.status==='ended');
    assert.equal((await alice.browser.mutate('POST','/api/calls/token',{callId:call.callId,connectionId:a.socket.id})).status,401);
  });
  test('the actual frontend encrypted socket adapter and SessionApi interoperate with DATA calling without a second socket',async()=>{
    const loader={parentURL:import.meta.url,tsconfig:fileURLToPath(new URL('../../../client/tsconfig.json',import.meta.url))};
    const {AuthenticatedSocketIoClient}=await tsImport('../../../client/src/realtime/AuthenticatedSocketIoClient.ts',loader);
    const {HttpAuthService}=await tsImport('../../../client/src/auth/httpAuthService.ts',loader);
    const {alice,bob,conversationId}=await stack.pair('client-a','client-b');
    const clients:any[]=[],apis:any[]=[],events:any[]=[],counts:number[]=[];
    try{
      for(const [index,person]of [alice,bob].entries()){
        const headers={Origin:'http://localhost:3000',Cookie:[...person.browser.cookies].map(([k,v])=>`${k}=${v}`).join('; ')};
        const auth=new HttpAuthService({fetch:(path:string,options:RequestInit)=>fetch(stack.url+path,{...options,headers:{...options.headers,...headers}})});
        const api=auth.createSessionApi((await person.browser.request('/api/auth/me')).body.user);apis.push(api);counts[index]=0;
        assert.match((await api.realtimeAuth()).csrfToken,/^[A-Za-z0-9_-]{43}$/);
        const client=new AuthenticatedSocketIoClient(api,{connection(){},message:async()=>true,keys(){},receipt(){},typing(){},presence(){},updated(){}},stack.url,
          // Direct DATA route and explicit browser headers replace Next's path rewrite and Node's empty cookie jar.
          (url:string,options:any)=>{counts[index]!++;const socket=io(url,{...options,addTrailingSlash:true,withCredentials:false,extraHeaders:headers});
            socket.on('connect_error',error=>events.push({failure:(error as any).data?.code??error.message}));return socket;});
        clients.push(client);client.calls.subscribe((event:string,call:any)=>events.push({index,event,call}));client.start();
      }
      const [a,b]=clients;
      try{await until(()=>a.connected&&b.connected,5000);}catch{assert.fail(JSON.stringify({states:clients.map(c=>c.state),counts,errors:events.filter(e=>e.failure)}));}
      const {call}=await a.calls.request('call:initiate',{requestId:randomUUID(),conversationId,recipientId:bob.id,kind:'video'});
      assert.ok(call);await until(()=>events.some(e=>e.index===1&&e.call.callId===call.callId&&e.call.status==='ringing'));
      assert.equal((await b.calls.request('call:accept',{callId:call.callId})).call.status,'accepted');
      const details=await apis[0].request('/api/calls/token',{method:'POST',body:{callId:call.callId,connectionId:a.calls.getConnectionId()}});
      const claims=await new TokenVerifier(key,secret).verify(details.token);assert.equal(claims.sub,directCallParticipantIdentity(call.callId,alice.id));
      assert.deepEqual(counts,[1,1]);
      const oldConnection=b.calls.getConnectionId();b.refreshRooms();
      await until(()=>b.connected&&b.calls.getConnectionId()!==oldConnection);
      await until(()=>events.some(e=>e.index===0&&e.call.callId===call.callId&&e.call.status==='ended'));
      const sync=await b.calls.request('call:sync',{});assert.equal(sync.calls.find((c:any)=>c.callId===call.callId).status,'ended');
      assert.equal((await a.calls.request('call:initiate',{requestId:randomUUID(),conversationId,recipientId:bob.id,kind:'voice'})).status,'ok');
    }finally{for(const client of clients)client.dispose();for(const api of apis)api.dispose();}
  });
});

test('unconfigured LiveKit leaves the production DATA call flow unavailable',async()=>{
  const stack=await DataStack.start({bridge:{livekit:loadLiveKitConfig({})}});
  try{
    const {alice,bob,conversationId}=await stack.pair('disabled-a','disabled-b'),a=await stack.connect(alice);await stack.connect(bob);
    assert.deepEqual(await a.emitAck('call:initiate',{requestId:randomUUID(),conversationId,recipientId:bob.id,kind:'voice'}),{status:'error',code:'unavailable'});
    assert.equal((await alice.browser.mutate('POST','/api/calls/token',{callId:randomUUID(),connectionId:a.socket.id})).status,503);
  }finally{await stack.close();}
});
