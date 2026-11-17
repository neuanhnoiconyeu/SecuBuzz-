const {test}=require('node:test');const assert=require('node:assert/strict');
const {messagingFixture,encrypted,submit}=require('./support/messaging');const {mutate,befriend}=require('./support/social');

test('bounded history handles identical timestamps and concurrent later insertions without duplicates or unstable ordering',async t=>{
    const now=Date.now();const f=await messagingFixture(t,{now:()=>now});const stored=[];
    for(let i=0;i<5;i++){const {envelope}=await encrypted(f.alice,f.conversationId,'page-'+i);const response=await submit(f,f.alice,envelope);assert.equal(response.status,201);stored.push(response.body.message);}
    assert.equal(new Set(stored.map(m=>m.storedAt)).size,1);
    const url=`/api/conversations/${f.conversationId}/messages`;const first=await f.bob.browser.request(url+'?limit=2');
    assert.deepEqual(first.body.items.map(m=>m.sequence),[5,4]);assert.ok(first.body.nextCursor);
    const newer=await encrypted(f.alice,f.conversationId,'after-snapshot');assert.equal((await submit(f,f.alice,newer.envelope)).status,201);
    await mutate(f.alice,'DELETE','/api/messages/'+stored[1].storageId);
    const second=await f.bob.browser.request(url+'?limit=2&cursor='+first.body.nextCursor),third=await f.bob.browser.request(url+'?limit=2&cursor='+second.body.nextCursor);
    assert.deepEqual(second.body.items.map(m=>m.sequence),[3,2]);assert.equal(second.body.items[1].state,'deleted');assert.equal(second.body.items[1].encryption,null);
    assert.deepEqual(third.body.items.map(m=>m.sequence),[1]);assert.equal(third.body.nextCursor,null);
    const ids=[...first.body.items,...second.body.items,...third.body.items].map(m=>m.storageId);assert.equal(new Set(ids).size,5);
    assert.equal((await f.bob.browser.request(url+'?limit=1')).body.items[0].sequence,6);
});
test('cursor validation binds history to actor, conversation and safe integer positions',async t=>{
    const f=await messagingFixture(t);for(let i=0;i<2;i++){const {envelope}=await encrypted(f.alice,f.conversationId,'cursor-'+i);await submit(f,f.alice,envelope);}
    const url=`/api/conversations/${f.conversationId}/messages`;const first=await f.alice.browser.request(url+'?limit=1'),cursor=first.body.nextCursor;
    assert.equal((await f.bob.browser.request(url+'?cursor='+cursor)).status,400);
    const decoded=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
    for(const patch of [{before:0},{before:1.5},{highWater:9007199254740992},{before:decoded.highWater+1},{extra:true},{context:'wrong'}]){
        const bad=Buffer.from(JSON.stringify({...decoded,...patch})).toString('base64url');assert.equal((await f.alice.browser.request(url+'?cursor='+bad)).status,400);
    }
    await befriend(f.alice,f.carol);const other=await mutate(f.alice,'POST','/api/conversations/dm',{recipientId:f.carol.id});
    assert.equal((await f.alice.browser.request(`/api/conversations/${other.body.conversation.id}/messages?cursor=`+cursor)).status,400);
    for(const query of ['limit=0','limit=51','limit=1.5','limit=01','limit=1&limit=2','cursor=bad-json','cursor='+('a'.repeat(1025))])assert.equal((await f.alice.browser.request(url+'?'+query)).status,400);
});
test('one client message ID may be used independently in another authorized conversation without a global PK collision',async t=>{
    const f=await messagingFixture(t);await befriend(f.alice,f.carol);const other=await mutate(f.alice,'POST','/api/conversations/dm',{recipientId:f.carol.id});
    const first=await encrypted(f.alice,f.conversationId,'same-wire-id'),second=await encrypted(f.alice,other.body.conversation.id,'same-wire-id');
    const a=await submit(f,f.alice,first.envelope),b=await mutate(f.alice,'POST',`/api/conversations/${other.body.conversation.id}/messages`,second.envelope);
    assert.equal(a.status,201);assert.equal(b.status,201);assert.notEqual(a.body.message.storageId,b.body.message.storageId);assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,2);
});
