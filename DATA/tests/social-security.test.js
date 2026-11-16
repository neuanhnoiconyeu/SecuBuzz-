const { test }=require('node:test');
const assert=require('node:assert/strict');
const { socialFixture,mutate,send,befriend }=require('./support/social');
const { freshToken }=require('../server/auth/security');

test('blocking atomically removes friendships, hides both profiles/search directions and restores nothing on unblock',async t=>{
    const f=await socialFixture(t);await befriend(f.alice,f.bob);
    assert.equal((await mutate(f.alice,'POST','/api/blocks',{userId:f.bob.id})).status,204);
    assert.deepEqual((await f.alice.browser.request('/api/friends')).body.items,[]);
    assert.deepEqual((await f.bob.browser.request('/api/friends')).body.items,[]);
    assert.equal((await f.alice.browser.request('/api/blocks')).body.items[0].id,f.bob.id);
    assert.deepEqual((await f.bob.browser.request('/api/blocks')).body.items,[]);
    const missing=await f.bob.browser.request('/api/users/nonexistent');
    for(const [actor,other] of [[f.alice,f.bob],[f.bob,f.alice]]) {
        const hidden=await actor.browser.request('/api/users/'+other.id);assert.equal(hidden.status,404);assert.deepEqual(hidden.body,missing.body);
        assert.deepEqual((await actor.browser.request('/api/users/search?q='+other.username)).body.items,[]);
        assert.equal((await send(actor,other)).status,404);
    }
    assert.equal((await mutate(f.alice,'POST','/api/blocks',{userId:f.bob.id})).status,204);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Blocks').get().n,1);
    assert.equal((await mutate(f.alice,'DELETE','/api/blocks/'+f.bob.id)).status,204);
    assert.equal((await mutate(f.alice,'DELETE','/api/blocks/'+f.bob.id)).status,204);
    assert.deepEqual((await f.alice.browser.request('/api/friends')).body.items,[]);
    assert.equal((await f.alice.browser.request('/api/users/'+f.bob.id)).body.user.relationship,'none');
});

test('block cancels pending requests in either direction and cancellation is not undone by unblocking',async t=>{
    const f=await socialFixture(t);const sent=await send(f.bob,f.alice);const id=sent.body.request.id;
    assert.equal((await mutate(f.alice,'POST','/api/blocks',{userId:f.bob.id})).status,204);
    assert.equal(f.db.prepare('SELECT status FROM FriendRequests WHERE request_id=?').get(id).status,'cancelled');
    assert.deepEqual((await f.bob.browser.request('/api/friends/requests?status=all')).body.items,[]);
    assert.equal((await mutate(f.alice,'POST',`/api/friends/requests/${id}/accept`)).status,404);
    await mutate(f.alice,'DELETE','/api/blocks/'+f.bob.id);
    assert.equal((await mutate(f.alice,'POST',`/api/friends/requests/${id}/accept`)).status,409);
    assert.equal((await f.bob.browser.request('/api/friends/requests?status=all')).body.items[0].status,'cancelled');
    assert.deepEqual((await f.alice.browser.request('/api/friends')).body.items,[]);
});

test('mutual blocks are independent and Alice cannot manage Bob block list or friendships',async t=>{
    const f=await socialFixture(t);await mutate(f.bob,'POST','/api/blocks',{userId:f.carol.id});
    await mutate(f.alice,'DELETE','/api/blocks/'+f.carol.id);
    assert.ok(f.db.prepare('SELECT 1 FROM Blocks WHERE blocker_id=? AND blocked_id=?').get(f.bob.id,f.carol.id));
    assert.equal((await mutate(f.alice,'POST','/api/blocks',{userId:f.carol.id,blockerId:f.bob.id})).status,400);
    await mutate(f.alice,'POST','/api/blocks',{userId:f.bob.id});
    assert.equal((await mutate(f.bob,'POST','/api/blocks',{userId:f.alice.id})).status,204);
    await mutate(f.alice,'DELETE','/api/blocks/'+f.bob.id);
    assert.equal((await f.alice.browser.request('/api/users/'+f.bob.id)).status,404);
    assert.equal((await f.alice.browser.request('/api/blocks')).body.items.length,0);
    assert.equal((await f.bob.browser.request('/api/blocks')).body.items.length,2);
});

test('self-block, unknown users and mass-assigned owners cannot create blocks or requests',async t=>{
    const f=await socialFixture(t);
    assert.equal((await mutate(f.alice,'POST','/api/blocks',{userId:f.alice.id})).status,400);
    assert.equal((await mutate(f.alice,'POST','/api/blocks',{userId:'nonexistent'})).status,404);
    for(const body of [{userId:f.bob.id,senderId:f.carol.id},{userId:f.bob.id,ownerId:f.carol.id},{recipientId:f.bob.id},{}]) {
        assert.equal((await mutate(f.alice,'POST','/api/friends/requests',body)).status,400);
    }
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Blocks').get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM FriendRequests').get().n,0);
});

test('missing, revoked and expired sessions are rejected across DB-3 reads and writes',async t=>{
    let clock=Date.now();const f=await socialFixture(t,{now:()=>clock});
    for(const route of ['/api/users/me','/api/users/search?q=social-','/api/friends','/api/friends/requests','/api/blocks']) {
        assert.equal((await f.browser().request(route)).status,401);
    }
    const old=f.alice.browser.clone();await f.alice.browser.post('/api/auth/logout');
    assert.equal((await old.request('/api/friends')).status,401);
    assert.equal((await old.request('/api/friends/requests',{method:'POST',body:{userId:f.bob.id},headers:{'X-CSRF-Token':f.alice.token}})).status,401);
    clock+=f.config.sessionTtlMs+1;
    assert.equal((await f.bob.browser.request('/api/blocks')).status,401);
    assert.equal((await mutate(f.bob,'PATCH','/api/users/me',{displayName:'Should not update'})).status,401);
});

test('DB-3 preserves CSRF and exact Origin enforcement for every mutation family',async t=>{
    const f=await socialFixture(t);
    const routes=[['PATCH','/api/users/me',{displayName:'Nope'}],['POST','/api/friends/requests',{userId:f.bob.id}],
        ['DELETE','/api/friends/'+f.bob.id],['POST','/api/blocks',{userId:f.bob.id}],['DELETE','/api/blocks/'+f.bob.id]];
    for(const [method,path,body] of routes) {
        assert.equal((await f.alice.browser.request(path,{method,body})).status,403);
        assert.equal((await mutate(f.alice,method,path,body,{'X-CSRF-Token':freshToken()})).status,403);
        const foreign=await mutate(f.alice,method,path,body,{Origin:'https://evil.example'});
        assert.equal(foreign.status,403);assert.equal(foreign.headers.get('access-control-allow-origin'),null);
    }
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM FriendRequests').get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Blocks').get().n,0);
});

test('Alice cannot edit Bob profile or use spoofed headers/query/body as ownership',async t=>{
    const f=await socialFixture(t);
    assert.equal((await mutate(f.alice,'PATCH','/api/users/'+f.bob.id,{displayName:'Spoofed'})).status,404);
    assert.equal((await mutate(f.alice,'PATCH','/api/users/me',{userId:f.bob.id,displayName:'Spoofed'})).status,400);
    assert.equal((await mutate(f.alice,'PATCH','/api/users/me?userId='+f.bob.id,{displayName:'Spoofed'})).status,400);
    const updated=await mutate(f.alice,'PATCH','/api/users/me',{displayName:'Alice valid'},{'X-User-Id':f.bob.id});
    assert.equal(updated.body.profile.id,f.alice.id);
    assert.equal((await f.bob.browser.request('/api/users/me')).body.profile.displayName,'Bob');
});

test('disabled and credential-less/demo identities are not discoverable or targetable',async t=>{
    const f=await socialFixture(t);
    f.application.auth.repository.repositories.users.create({user_id:'demo-hidden',username:'social-demo',display_name:'Legacy Demo'});
    f.application.auth.repository.disableAccount(f.bob.id);
    const result=await f.alice.browser.request('/api/users/search?q=social-');
    assert.deepEqual(result.body.items.map(u=>u.id).sort(),[f.alice.id,f.carol.id].sort());
    for(const id of [f.bob.id,'demo-hidden']) {
        assert.equal((await f.alice.browser.request('/api/users/'+id)).status,404);
        assert.equal((await mutate(f.alice,'POST','/api/friends/requests',{userId:id})).status,404);
    }
});

test('public reads never expose private profile, credentials, presence preferences or request owners',async t=>{
    const f=await socialFixture(t);await mutate(f.alice,'PATCH','/api/users/me',{statusMessage:'DO_NOT_DISCLOSE_STATUS',presencePreference:'busy'});
    await befriend(f.alice,f.bob);
    const responses=await Promise.all(['/api/friends','/api/friends/requests?status=all','/api/users/'+f.alice.id,'/api/users/search?q=social-'].map(path=>f.bob.browser.request(path)));
    for(const response of responses) {
        for(const secret of ['DO_NOT_DISCLOSE_STATUS','presencePreference','password_hash','token_hash','session_id','email_key','sender_id','recipient_id']) assert.ok(!response.text.includes(secret));
        assert.equal(response.headers.get('cache-control'),'no-store');
    }
});

test('legacy projections remain hidden and non-actionable until both users explicitly consent',async t=>{
    const f=await socialFixture(t);const r=f.application.auth.repository.repositories;
    r.friendships.insert(f.alice.id,f.bob.id);
    const historical=r.friendRequests.insert({request_id:'historical-request',sender_id:f.bob.id,recipient_id:f.alice.id});
    f.db.prepare("INSERT INTO Contacts(contact_id,user_id,friend_id,status) VALUES('historical-contact',?,?,'accepted')").run(f.alice.id,f.bob.id);
    const before=f.db.prepare('SELECT * FROM Contacts').all();
    assert.deepEqual((await f.alice.browser.request('/api/friends')).body.items,[]);
    assert.deepEqual((await f.alice.browser.request('/api/friends/requests?status=all')).body.items,[]);
    assert.equal((await f.alice.browser.request('/api/users/'+f.bob.id)).body.user.relationship,'none');
    assert.equal((await mutate(f.alice,'POST',`/api/friends/requests/${historical.request_id}/accept`)).status,404);
    assert.equal((await mutate(f.bob,'DELETE',`/api/friends/requests/${historical.request_id}`)).status,404);
    const sent=await send(f.alice,f.bob);assert.equal(sent.status,201);
    assert.equal(f.db.prepare('SELECT status FROM FriendRequests WHERE request_id=?').get(historical.request_id).status,'cancelled');
    assert.deepEqual((await f.alice.browser.request('/api/friends')).body.items,[]);
    assert.equal((await mutate(f.bob,'POST',`/api/friends/requests/${sent.body.request.id}/accept`)).status,200);
    assert.equal((await f.alice.browser.request('/api/friends')).body.items[0].id,f.bob.id);
    assert.deepEqual(f.db.prepare('SELECT * FROM Contacts').all(),before);
});

test('legacy blocks remain restrictive and owner-visible without granting social relationships',async t=>{
    const f=await socialFixture(t);f.application.auth.repository.repositories.blocks.insert(f.alice.id,f.bob.id);
    assert.equal((await send(f.bob,f.alice)).status,404);
    assert.equal((await f.alice.browser.request('/api/blocks')).body.items[0].id,f.bob.id);
    assert.ok(f.application.social.repository.isBlocked(f.alice.id,f.bob.id));
    assert.ok(f.application.social.repository.blockedIds(f.bob.id).includes(f.alice.id));
    assert.equal((await mutate(f.alice,'DELETE','/api/blocks/'+f.bob.id)).status,204);
    assert.equal((await send(f.bob,f.alice)).status,201);
});

test('acceptance rollback leaves request pending and no partial friendship',async t=>{
    const f=await socialFixture(t);const sent=await send(f.alice,f.bob);
    f.db.exec("CREATE TRIGGER fail_accept BEFORE UPDATE OF status ON FriendRequests WHEN NEW.status='accepted' BEGIN SELECT RAISE(ABORT,'private diagnostics'); END;");
    const result=await mutate(f.bob,'POST',`/api/friends/requests/${sent.body.request.id}/accept`);assert.equal(result.status,500);
    assert.deepEqual(result.body,{code:'INTERNAL_ERROR',fields:[]});
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Friendships').get().n,0);
    assert.equal(f.db.prepare('SELECT status FROM FriendRequests').get().status,'pending');
});

test('block rollback restores friendship and pending legacy projection when audit storage fails',async t=>{
    const f=await socialFixture(t);await befriend(f.alice,f.bob);
    const legacy=f.application.auth.repository.repositories.friendRequests.insert({sender_id:f.alice.id,recipient_id:f.bob.id});
    f.db.exec("CREATE TRIGGER fail_block BEFORE INSERT ON AuditLogs WHEN NEW.event_type='social.user.blocked' BEGIN SELECT RAISE(ABORT,'private diagnostics'); END;");
    assert.equal((await mutate(f.alice,'POST','/api/blocks',{userId:f.bob.id})).status,500);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Blocks').get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Friendships').get().n,1);
    assert.equal(f.db.prepare('SELECT status FROM FriendRequests WHERE request_id=?').get(legacy.request_id).status,'pending');
});

test('profile failure rolls back changes without logging private payloads or database diagnostics',async t=>{
    const f=await socialFixture(t);const output=[];t.mock.method(console,'log',(...args)=>output.push(args));t.mock.method(console,'error',(...args)=>output.push(args));
    f.db.exec("CREATE TRIGGER fail_profile BEFORE INSERT ON AuditLogs WHEN NEW.event_type='social.profile.updated' BEGIN SELECT RAISE(ABORT,'DO_NOT_LOG'); END;");
    const result=await mutate(f.alice,'PATCH','/api/users/me',{statusMessage:'PRIVATE_PROFILE_PAYLOAD'});
    assert.equal(result.status,500);assert.deepEqual(result.body,{code:'INTERNAL_ERROR',fields:[]});assert.deepEqual(output,[]);
    assert.equal((await f.alice.browser.request('/api/users/me')).body.profile.statusMessage,'');
});

test('request and search abuse limits use shared SQLite and cannot be bypassed with forwarded IPs',async t=>{
    const f=await socialFixture(t);assert.equal((await send(f.alice,f.bob)).status,201);
    for(let i=0;i<4;i++)assert.equal((await send(f.alice,f.bob)).status,409);
    const remote=await f.anotherServer();const actor={...f.alice,browser:f.alice.browser.clone()};actor.browser.origin=remote.origin;
    const limited=await mutate(actor,'POST','/api/friends/requests',{userId:f.bob.id},{'X-Forwarded-For':'192.0.2.1'});
    assert.equal(limited.status,429);assert.ok(Number(limited.headers.get('retry-after'))>0);
    for(let i=0;i<30;i++)assert.equal((await f.bob.browser.request('/api/users/search?q=social-')).status,200);
    assert.equal((await f.bob.browser.request('/api/users/search?q=social-')).status,429);
});

test('list filters, cursor tampering, unsafe identifiers and malformed bodies fail safely',async t=>{
    const f=await socialFixture(t);
    for(const path of ['/api/friends/requests?direction=other','/api/friends/requests?status=unknown','/api/friends?limit=1000','/api/blocks?cursor=%25',
        '/api/users/'+encodeURIComponent("x' OR 1=1 --")])assert.equal((await f.alice.browser.request(path)).status,400);
    assert.equal((await mutate(f.alice,'POST','/api/friends/requests',['not-an-object'])).status,400);
    assert.equal((await mutate(f.alice,'DELETE','/api/friends/'+f.bob.id,{ownerId:f.carol.id})).status,400);
    assert.equal((await f.alice.browser.request('/api/users/me',{method:'PATCH',rawBody:'{private',headers:{'X-CSRF-Token':f.alice.token}})).status,400);
    assert.equal((await mutate(f.alice,'PATCH','/api/users/me',{statusMessage:'x'.repeat(9000)})).status,413);
});
