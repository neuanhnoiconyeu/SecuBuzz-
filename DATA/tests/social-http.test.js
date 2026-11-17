const { test }=require('node:test');
const assert=require('node:assert/strict');
const { socialFixture,mutate,send,befriend }=require('./support/social');
const { setup,Browser,childBackend }=require('./support/auth');

test('authenticated discovery is case-insensitive username-prefix search with safe public projections and keyset pages',async t=>{
    const f=await socialFixture(t);const b=f.alice.browser;
    const first=await b.request('/api/users/search?q=SOCIAL-&limit=2');assert.equal(first.status,200);
    assert.deepEqual(first.body.items.map(u=>u.username),['social-alice','social-bob']);assert.ok(first.body.nextCursor);
    assert.equal(first.body.items[0].relationship,'self');
    const second=await b.request('/api/users/search?q=social-&limit=2&cursor='+first.body.nextCursor);
    assert.deepEqual(second.body.items.map(u=>u.username),['social-carol']);assert.equal(second.body.nextCursor,null);
    for(const person of [...first.body.items,...second.body.items]) assert.deepEqual(Object.keys(person).sort(),['avatar','displayName','id','relationship','username']);
    assert.deepEqual((await b.request('/api/users/search?q=nonexistent')).body,{items:[],nextCursor:null});
});

for(const query of ['','?q=a','?q=%25','?q='+('a'.repeat(65)),'?q=social-&limit=0','?q=social-&limit=51','?q=social-&limit=1.5','?q=social-&q=other','?q=social-&userId=other']) {
    test(`discovery rejects invalid or ownership-selecting query ${query || '(missing q)'}`,async t=>{
        const f=await socialFixture(t);assert.equal((await f.alice.browser.request('/api/users/search'+query)).status,400);
    });
}

test('cursor scope is bound to actor, endpoint and search/filter context',async t=>{
    const f=await socialFixture(t);const page=await f.alice.browser.request('/api/users/search?q=social-&limit=1');const cursor=page.body.nextCursor;
    for(const [browser,path] of [[f.bob.browser,'/api/users/search?q=social-&limit=1'],[f.alice.browser,'/api/users/search?q=social-b&limit=1'],
        [f.alice.browser,'/api/friends?limit=1']]) {
        assert.equal((await browser.request(path+'&cursor='+cursor)).status,400);
    }
    assert.equal((await f.alice.browser.request('/api/users/search?q=social-&cursor=not-json')).status,400);
});

test('own profile updates persist supported fields, preserve omitted values and keep preferences private',async t=>{
    const f=await socialFixture(t);const {alice,bob}=f;
    const changed=await mutate(alice,'PATCH','/api/users/me',{displayName:'  Alice Updated  ',statusMessage:'  Private preference text  ',avatar:'cat',presencePreference:'invisible'});
    assert.equal(changed.status,200);assert.equal(changed.body.profile.displayName,'Alice Updated');
    assert.equal(changed.body.profile.statusMessage,'Private preference text');assert.equal(changed.body.profile.presencePreference,'invisible');
    assert.equal(changed.body.profile.id,alice.id);assert.equal(changed.body.profile.isDemo,false);
    const again=await mutate(alice,'PATCH','/api/users/me',{avatar:'star'});
    assert.equal(again.body.profile.statusMessage,'Private preference text');assert.equal(again.body.profile.displayName,'Alice Updated');
    assert.equal((await alice.browser.request('/api/users/me')).body.profile.avatar,'star');
    const publicProfile=await bob.browser.request('/api/users/'+alice.id);
    assert.deepEqual(Object.keys(publicProfile.body.user).sort(),['avatar','displayName','id','relationship','username']);
    assert.ok(!publicProfile.text.includes('Private preference text'));assert.ok(!publicProfile.text.includes('invisible'));
    assert.equal((await alice.browser.request('/api/auth/me')).body.user.displayName,'Alice Updated');
    assert.equal(f.db.prepare('SELECT display_name FROM Users WHERE user_id=?').get(alice.id).display_name,'Alice Updated');
});

for(const body of [{},{displayName:''},{displayName:'x'.repeat(41)},{displayName:'bad\nname'},{statusMessage:'x'.repeat(161)},
    {statusMessage:'bad\u0000value'},{avatar:'https://external/avatar.png'},{presencePreference:'online'},{displayName:null},
    {id:'other'},{user_id:'other'},{username:'protected'},{email:'private@example.test'},{isDemo:true},{discoverable:false}]) {
    test(`profile patch rejects invalid/protected fields ${Object.keys(body).join(',') || '(empty)'}`,async t=>{
        const f=await socialFixture(t);const response=await mutate(f.alice,'PATCH','/api/users/me',body);
        assert.equal(response.status,400);assert.equal((await f.alice.browser.request('/api/users/me')).body.profile.displayName,'Alice');
    });
}

test('profile validation counts Unicode code points and trims/clears status without uploading files',async t=>{
    const f=await socialFixture(t);const displayName='😀'.repeat(40);
    const updated=await mutate(f.alice,'PATCH','/api/users/me',{displayName,statusMessage:'  '});
    assert.equal(updated.status,200);assert.equal(updated.body.profile.displayName,displayName);assert.equal(updated.body.profile.statusMessage,'');
    assert.equal((await mutate(f.alice,'PATCH','/api/users/me',{displayName:displayName+'😀'})).status,400);
});

test('request send/list/accept establishes one symmetric friendship and returns only participant-owned metadata',async t=>{
    const f=await socialFixture(t);const sent=await send(f.alice,f.bob);assert.equal(sent.status,201);
    assert.equal(sent.body.request.direction,'outgoing');assert.equal(sent.body.request.status,'pending');
    assert.equal(sent.body.request.user.id,f.bob.id);const id=sent.body.request.id;
    const incoming=await f.bob.browser.request('/api/friends/requests?direction=incoming');
    assert.equal(incoming.body.items[0].id,id);assert.equal(incoming.body.items[0].user.id,f.alice.id);
    assert.equal((await f.alice.browser.request('/api/friends/requests?direction=outgoing')).body.items[0].id,id);
    assert.deepEqual((await f.carol.browser.request('/api/friends/requests')).body.items,[]);
    assert.equal((await f.bob.browser.request('/api/users/'+f.alice.id)).body.user.relationship,'incoming');
    assert.equal((await f.alice.browser.request('/api/users/'+f.bob.id)).body.user.requestId,id);
    const accepted=await mutate(f.bob,'POST',`/api/friends/requests/${id}/accept`);assert.equal(accepted.status,200);
    assert.equal(accepted.body.request.status,'accepted');assert.ok(accepted.body.request.resolvedAt);
    assert.equal((await f.alice.browser.request('/api/friends')).body.items[0].id,f.bob.id);
    assert.equal((await f.bob.browser.request('/api/friends')).body.items[0].id,f.alice.id);
    assert.equal((await f.bob.browser.request('/api/friends/requests')).body.items.length,0);
    assert.equal((await f.bob.browser.request('/api/friends/requests?status=accepted')).body.items[0].id,id);
    assert.equal((await f.alice.browser.request('/api/users/'+f.bob.id)).body.user.relationship,'friend');
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM Friendships WHERE origin='authenticated'").get().n,1);
});

test('self, unknown, duplicate reversed and already-friend requests cannot create invalid relationships',async t=>{
    const f=await socialFixture(t);assert.equal((await send(f.alice,f.alice)).status,400);
    assert.equal((await mutate(f.alice,'POST','/api/friends/requests',{userId:'nonexistent'})).status,404);
    const first=await send(f.alice,f.bob);assert.equal(first.status,201);
    assert.equal((await send(f.alice,f.bob)).status,409);assert.equal((await send(f.bob,f.alice)).status,409);
    await mutate(f.bob,'POST',`/api/friends/requests/${first.body.request.id}/accept`);
    assert.equal((await send(f.alice,f.bob)).status,409);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM FriendRequests WHERE origin='authenticated'").get().n,1);
});

test('only recipients decline/accept and only senders cancel; repeated actions have fixed outcomes',async t=>{
    const f=await socialFixture(t);const first=await send(f.alice,f.bob);const id=first.body.request.id;
    for(const action of ['accept','decline']) {
        assert.equal((await mutate(f.alice,'POST',`/api/friends/requests/${id}/${action}`)).status,404);
        assert.equal((await mutate(f.carol,'POST',`/api/friends/requests/${id}/${action}`)).status,404);
    }
    assert.equal((await mutate(f.bob,'DELETE',`/api/friends/requests/${id}`)).status,404);
    assert.equal((await mutate(f.carol,'DELETE',`/api/friends/requests/${id}`)).status,404);
    assert.equal((await mutate(f.bob,'POST',`/api/friends/requests/${id}/decline`)).status,200);
    assert.equal((await mutate(f.bob,'POST',`/api/friends/requests/${id}/decline`)).status,409);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Friendships').get().n,0);
    const second=await send(f.alice,f.bob);const secondId=second.body.request.id;
    assert.equal((await mutate(f.alice,'DELETE',`/api/friends/requests/${secondId}`)).status,204);
    assert.equal((await mutate(f.alice,'DELETE',`/api/friends/requests/${secondId}`)).status,204);
    assert.equal((await mutate(f.bob,'POST',`/api/friends/requests/${secondId}/accept`)).status,409);
    const acceptedId=await befriend(f.alice,f.bob);
    assert.equal((await mutate(f.alice,'DELETE',`/api/friends/requests/${acceptedId}`)).status,409);
});

test('friends and request listings use bounded deterministic pages without exposing another actor collections',async t=>{
    const f=await socialFixture(t);await befriend(f.alice,f.bob);await befriend(f.alice,f.carol);
    const page=await f.alice.browser.request('/api/friends?limit=1');assert.equal(page.body.items[0].id,f.bob.id);assert.ok(page.body.nextCursor);
    const next=await f.alice.browser.request('/api/friends?limit=1&cursor='+page.body.nextCursor);
    assert.equal(next.body.items[0].id,f.carol.id);assert.equal(next.body.nextCursor,null);
    const requests=await f.alice.browser.request('/api/friends/requests?status=all&limit=1');assert.equal(requests.body.items.length,1);
    const requestNext=await f.alice.browser.request('/api/friends/requests?status=all&limit=1&cursor='+requests.body.nextCursor);
    assert.equal(requestNext.body.items.length,1);assert.notEqual(requestNext.body.items[0].id,requests.body.items[0].id);
    assert.equal((await f.alice.browser.request('/api/friends?userId='+f.bob.id)).status,400);
    assert.equal((await f.alice.browser.request('/api/friends/requests?ownerId='+f.bob.id)).status,400);
    assert.equal((await f.alice.browser.request('/api/blocks?userId='+f.bob.id)).status,400);
});

test('friend removal is symmetric and idempotent, cannot select another owner or delete accounts/sessions',async t=>{
    const f=await socialFixture(t);await befriend(f.bob,f.carol);
    const sessions=f.db.prepare('SELECT count(*) AS n FROM Sessions').get().n;
    assert.equal((await mutate(f.alice,'DELETE','/api/friends/'+f.carol.id)).status,204);
    assert.equal((await f.bob.browser.request('/api/friends')).body.items[0].id,f.carol.id);
    await befriend(f.alice,f.bob);
    assert.equal((await mutate(f.alice,'DELETE','/api/friends/'+f.bob.id)).status,204);
    assert.equal((await mutate(f.alice,'DELETE','/api/friends/'+f.bob.id)).status,204);
    assert.deepEqual((await f.alice.browser.request('/api/friends')).body.items,[]);
    assert.equal((await f.bob.browser.request('/api/friends')).body.items[0].id,f.carol.id);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Users').get().n,3);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Sessions').get().n,sessions);
});

test('two real accounts complete the requested search/request/accept/restart/block/unblock HTTP scenario',async t=>{
    const f=await setup(t);const first=await childBackend(f);const alice={browser:first.browser};
    const bob={browser:new Browser(first.browser.origin)};
    for(const [name,actor] of [['alice',alice],['bob',bob]]) {
        assert.equal((await actor.browser.register('http-'+name,{displayName:name})).status,201);
        const login=await actor.browser.login('http-'+name);assert.equal(login.status,200);actor.id=login.body.user.id;actor.token=await actor.browser.csrf();
    }
    assert.equal((await alice.browser.request('/api/users/search?q=http-bob')).body.items[0].id,bob.id);
    const sent=await send(alice,bob);assert.equal(sent.status,201);
    assert.equal((await bob.browser.request('/api/friends/requests?direction=incoming')).body.items[0].id,sent.body.request.id);
    assert.equal((await mutate(bob,'POST',`/api/friends/requests/${sent.body.request.id}/accept`)).status,200);
    assert.equal((await alice.browser.request('/api/friends')).body.items[0].id,bob.id);
    assert.equal((await bob.browser.request('/api/friends')).body.items[0].id,alice.id);
    await first.stop();const restarted=await childBackend(f);alice.browser.origin=restarted.browser.origin;bob.browser.origin=restarted.browser.origin;
    assert.equal((await alice.browser.request('/api/friends')).body.items[0].id,bob.id);
    assert.equal((await bob.browser.request('/api/friends')).body.items[0].id,alice.id);
    assert.equal((await mutate(alice,'POST','/api/blocks',{userId:bob.id})).status,204);
    assert.deepEqual((await alice.browser.request('/api/friends')).body.items,[]);
    assert.deepEqual((await bob.browser.request('/api/friends')).body.items,[]);
    assert.equal((await send(bob,alice)).status,404);
    assert.equal((await mutate(alice,'DELETE','/api/blocks/'+bob.id)).status,204);
    assert.deepEqual((await alice.browser.request('/api/friends')).body.items,[]);
    assert.deepEqual((await bob.browser.request('/api/friends')).body.items,[]);
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
    await restarted.stop();
});
