const { test } = require('node:test');
const assert = require('node:assert/strict');
const { socialFixture,mutate,befriend } = require('./support/social');
const { setup,childBackend } = require('./support/auth');

const dm=(actor,recipient)=>mutate(actor,'POST','/api/conversations/dm',{recipientId:recipient.id});
async function created(t) {
    const f=await socialFixture(t);await befriend(f.alice,f.bob);
    const response=await dm(f.alice,f.bob);assert.equal(response.status,201);
    return {...f,conversation:response.body.conversation};
}

test('real friendship-approved DM records the session actor and both public participants atomically',async t=>{
    const f=await created(t);const c=f.conversation;
    assert.equal(c.type,'direct');assert.equal(c.interactionAllowed,true);
    assert.match(c.id,/^[0-9a-f-]{36}$/);assert.ok(Number.isFinite(Date.parse(c.createdAt)));
    assert.equal(c.createdAt,c.updatedAt);
    assert.deepEqual(c.participants.map(p=>p.id).sort(),[f.alice.id,f.bob.id].sort());
    for(const participant of c.participants)assert.deepEqual(Object.keys(participant).sort(),['avatar','displayName','id','username']);
    assert.deepEqual(Object.keys(c).sort(),['createdAt','id','interactionAllowed','participants','type','updatedAt']);
    const row=f.db.prepare('SELECT * FROM Conversations').get();assert.equal(row.created_by,f.alice.id);assert.equal(row.origin,'authenticated');
    const members=f.db.prepare('SELECT * FROM ConversationMembers ORDER BY user_id').all();
    assert.equal(members.length,2);assert.ok(members.every(member=>member.role==='member'&&member.left_at===null));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,0);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM AuditLogs WHERE event_type='conversation.direct.ready'").get().n,1);
});

test('repeat and reversed creation return the same ID and do not change timestamps, memberships or audit events',async t=>{
    const f=await created(t);const first=await dm(f.alice,f.bob),second=await dm(f.bob,f.alice);
    assert.equal(first.status,200);assert.equal(second.status,200);
    assert.deepEqual(first.body.conversation,f.conversation);assert.deepEqual(second.body.conversation,f.conversation);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Conversations').get().n,1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM ConversationMembers').get().n,2);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM AuditLogs WHERE source='conversations'").get().n,1);
});

test('both participants can retrieve the same metadata; unrelated and unknown IDs have identical 404 bodies',async t=>{
    const f=await created(t);const url='/api/conversations/'+f.conversation.id;
    for(const actor of [f.alice,f.bob])assert.deepEqual((await actor.browser.request(url)).body,{conversation:f.conversation});
    const outsider=await f.carol.browser.request(url),unknown=await f.carol.browser.request('/api/conversations/unknown');
    assert.equal(outsider.status,404);assert.equal(unknown.status,404);assert.deepEqual(outsider.body,unknown.body);
    assert.deepEqual((await f.carol.browser.request('/api/conversations')).body,{items:[],nextCursor:null});
});

test('self, missing, non-friend, pending and legacy friendship recipients cannot start an authenticated DM',async t=>{
    const f=await socialFixture(t);
    assert.equal((await dm(f.alice,f.alice)).status,400);
    assert.equal((await dm(f.alice,{id:'missing-user'})).status,404);
    assert.equal((await dm(f.alice,f.bob)).status,403);
    f.application.social.repository.repositories.friendships.insert(f.alice.id,f.bob.id);
    assert.equal((await dm(f.alice,f.bob)).status,403);
    f.db.prepare('DELETE FROM Friendships').run();
    assert.equal((await mutate(f.alice,'POST','/api/friends/requests',{userId:f.bob.id})).status,201);
    assert.equal((await dm(f.alice,f.bob)).status,403);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Conversations').get().n,0);
});

test('unfriend preserves read-only metadata and stable ID but the shared interaction policy requires renewed friendship',async t=>{
    const f=await created(t);await mutate(f.alice,'DELETE','/api/friends/'+f.bob.id);
    const again=await dm(f.alice,f.bob);assert.equal(again.status,200);assert.equal(again.body.conversation.id,f.conversation.id);
    assert.equal(again.body.conversation.interactionAllowed,false);
    assert.equal((await f.bob.browser.request('/api/conversations/'+f.conversation.id)).body.conversation.interactionAllowed,false);
    assert.equal((await f.alice.browser.request('/api/conversations')).body.items.length,1);
    const context=f.application.auth.resolveToken(f.alice.browser.cookies.get(f.config.sessionCookie)).row;
    assert.throws(()=>f.application.conversations.withInteraction({userId:context.user_id,sessionId:context.session_id},
        f.application.auth.csrfProof(f.alice.browser.cookies.get(f.config.sessionCookie),null,f.alice.token),f.conversation.id,()=>{}),{code:'FORBIDDEN'});
    await befriend(f.alice,f.bob);assert.equal((await dm(f.alice,f.bob)).body.conversation.interactionAllowed,true);
});

test('either-direction block hides existing metadata and lookup, preserves records, and unblock restores no interaction grant',async t=>{
    const f=await created(t);await mutate(f.bob,'POST','/api/blocks',{userId:f.alice.id});
    for(const actor of [f.alice,f.bob]){
        assert.equal((await actor.browser.request('/api/conversations/'+f.conversation.id)).status,404);
        assert.deepEqual((await actor.browser.request('/api/conversations')).body.items,[]);
    }
    assert.equal((await dm(f.alice,f.bob)).status,404);assert.equal((await dm(f.bob,f.alice)).status,404);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Conversations').get().n,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM ConversationMembers').get().n,2);
    await mutate(f.bob,'DELETE','/api/blocks/'+f.alice.id);
    const restored=await dm(f.alice,f.bob);assert.equal(restored.status,200);assert.equal(restored.body.conversation.id,f.conversation.id);
    assert.equal(restored.body.conversation.interactionAllowed,false);
});

test('blocked, disabled and credential-less recipients cannot create conversations',async t=>{
    const f=await socialFixture(t);await befriend(f.alice,f.bob);await mutate(f.alice,'POST','/api/blocks',{userId:f.bob.id});
    assert.equal((await dm(f.alice,f.bob)).status,404);
    f.application.auth.repository.disableAccount(f.carol.id);assert.equal((await dm(f.alice,f.carol)).status,404);
    f.application.social.repository.repositories.users.create({user_id:'legacy-person',username:'legacy-person',display_name:'Legacy'});
    assert.equal((await dm(f.alice,{id:'legacy-person'})).status,404);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Conversations').get().n,0);
});

test('archived, left-member and inactive-peer conversations are not listed, retrieved, repaired or duplicated',async t=>{
    const f=await created(t);const id=f.conversation.id;
    f.db.prepare("UPDATE ConversationMembers SET left_at='2026-01-01T00:00:00.000Z' WHERE user_id=?").run(f.bob.id);
    assert.equal((await dm(f.alice,f.bob)).status,404);assert.deepEqual((await f.alice.browser.request('/api/conversations')).body.items,[]);
    f.db.prepare('UPDATE ConversationMembers SET left_at=NULL').run();
    f.db.prepare("UPDATE Conversations SET archived_at='2026-01-01T00:00:00.000Z'").run();
    assert.equal((await f.alice.browser.request('/api/conversations/'+id)).status,404);assert.equal((await dm(f.alice,f.bob)).status,404);
    f.db.prepare('UPDATE Conversations SET archived_at=NULL').run();f.application.auth.repository.disableAccount(f.bob.id);
    assert.equal((await f.alice.browser.request('/api/conversations/'+id)).status,404);assert.deepEqual((await f.alice.browser.request('/api/conversations')).body.items,[]);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Conversations').get().n,1);
});

test('conversation lists are bounded, deterministically ordered, actor-scoped and exclude legacy/groups',async t=>{
    const f=await created(t);await befriend(f.alice,f.carol);const other=await dm(f.alice,f.carol);assert.equal(other.status,201);
    const r=f.application.conversations.repositories;
    r.conversations.create({conversation_id:'unexposed-group',kind:'group',title:'PRIVATE_GROUP_TITLE',created_by:f.alice.id,origin:'authenticated'});
    f.db.prepare("UPDATE Conversations SET updated_at='2026-11-01T00:00:00.000Z' WHERE kind='direct'").run();
    const first=await f.alice.browser.request('/api/conversations?limit=1');assert.equal(first.status,200);assert.equal(first.body.items.length,1);assert.ok(first.body.nextCursor);
    const second=await f.alice.browser.request('/api/conversations?limit=1&cursor='+first.body.nextCursor);
    assert.equal(second.body.items.length,1);assert.equal(second.body.nextCursor,null);
    assert.deepEqual([...first.body.items,...second.body.items].map(c=>c.id),[f.conversation.id,other.body.conversation.id].sort().reverse());
    assert.equal((await f.bob.browser.request('/api/conversations?cursor='+first.body.nextCursor)).status,400);
    assert.equal((await f.alice.browser.request('/api/conversations/unexposed-group')).status,404);
    for(const result of [first,second])assert.ok(!result.text.includes('PRIVATE_GROUP_TITLE')&&!result.text.includes('ciphertext')&&!result.text.includes('statusMessage'));
});

for(const input of [{},null,[],{recipientId:''},{recipientId:17},{recipientId:'x'.repeat(129)},
    {recipientId:'../alice'},{recipientId:'valid',senderId:'spoofed'},{recipientId:'valid',userId:'spoofed'},
    {recipientId:'valid',conversationId:'chosen'},{recipientId:'valid',type:'group'}]){
    test(`DM rejects invalid or owner-selecting body ${JSON.stringify(input)}`,async t=>{
        const f=await socialFixture(t);assert.equal((await mutate(f.alice,'POST','/api/conversations/dm',input)).status,400);
        assert.equal(f.db.prepare('SELECT count(*) AS n FROM Conversations').get().n,0);
    });
}
for(const query of ['?limit=0','?limit=51','?limit=1.5','?limit=01','?limit=1&limit=2','?userId=other','?cursor=bad-json','?cursor='+('a'.repeat(2049))]){
    test(`conversation listing rejects invalid pagination/owner query ${query.slice(0,45)}`,async t=>{
        const f=await socialFixture(t);assert.equal((await f.alice.browser.request('/api/conversations'+query)).status,400);
    });
}

test('real session/CSRF HTTP scenario survives two native backend processes with stable ID and memberships',async t=>{
    const f=await setup(t);const first=await childBackend(f);const alice=first.browser,bob=alice.clone(),charlie=alice.clone();
    for(const [browser,name] of [[alice,'dm-alice'],[bob,'dm-bob'],[charlie,'dm-charlie']]){assert.equal((await browser.register(name)).status,201);assert.equal((await browser.login(name)).status,200);}
    const a={browser:alice,id:(await alice.request('/api/auth/me')).body.user.id,token:await alice.csrf()};
    const b={browser:bob,id:(await bob.request('/api/auth/me')).body.user.id,token:await bob.csrf()};
    await befriend(a,b);const made=await dm(a,b);assert.equal(made.status,201);const id=made.body.conversation.id;
    assert.equal((await bob.request('/api/conversations/'+id)).status,200);assert.equal((await dm(a,b)).body.conversation.id,id);
    assert.equal((await charlie.request('/api/conversations/'+id)).status,404);await first.stop();
    const second=await childBackend(f);for(const browser of [alice,bob,charlie])browser.origin=second.browser.origin;
    for(const browser of [alice,bob])assert.equal((await browser.request('/api/conversations/'+id)).body.conversation.id,id);
    const again=await dm(b,a);assert.equal(again.status,200);assert.equal(again.body.conversation.id,id);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Conversations').get().n,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM ConversationMembers').get().n,2);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,0);
    await mutate(b,'POST','/api/blocks',{userId:a.id});assert.equal((await dm(a,b)).status,404);assert.equal((await alice.request('/api/conversations/'+id)).status,404);
});
