const { test }=require('node:test');
const assert=require('node:assert/strict');
const { socialFixture,mutate,send,befriend }=require('./support/social');

test('friends, requests and blocks can be reconciled into one actor-scoped snapshot revision',async t=>{
    const f=await socialFixture(t);await befriend(f.alice,f.bob);await send(f.carol,f.alice);
    const friends=await f.alice.browser.request('/api/friends');assert.match(friends.body.revision,/^[0-9]+$/);
    const revision=friends.body.revision;
    const requests=await f.alice.browser.request('/api/friends/requests?revision='+revision);
    const blocks=await f.alice.browser.request('/api/blocks?revision='+revision);
    assert.equal(requests.status,200);assert.equal(blocks.status,200);
    assert.equal(requests.body.revision,revision);assert.equal(blocks.body.revision,revision);
    assert.equal(friends.body.items[0].id,f.bob.id);assert.equal(requests.body.items[0].user.id,f.carol.id);
});

test('relationship and public-profile changes invalidate old collection cursors and revisions',async t=>{
    const f=await socialFixture(t);await befriend(f.alice,f.bob);await befriend(f.alice,f.carol);
    const old=await f.alice.browser.request('/api/friends?limit=1');assert.ok(old.body.nextCursor);
    await mutate(f.bob,'PATCH','/api/users/me',{displayName:'Bob new name'});
    const stale=await f.alice.browser.request('/api/friends?limit=1&cursor='+old.body.nextCursor);
    assert.equal(stale.status,409);assert.equal(stale.body.code,'STALE_STATE');
    assert.equal((await f.alice.browser.request('/api/blocks?revision='+old.body.revision)).status,409);
    const fresh=await f.alice.browser.request('/api/friends');assert.equal(fresh.body.items[0].displayName,'Bob new name');
    await mutate(f.alice,'POST','/api/blocks',{userId:f.carol.id});
    assert.equal((await f.alice.browser.request('/api/friends/requests?revision='+fresh.body.revision)).status,409);
});

test('private preference edits and unrelated graph changes do not leak through someone else revision',async t=>{
    const f=await socialFixture(t);await befriend(f.alice,f.bob);
    const before=(await f.alice.browser.request('/api/friends')).body.revision;
    await mutate(f.bob,'PATCH','/api/users/me',{statusMessage:'private text',presencePreference:'invisible'});
    assert.equal((await f.alice.browser.request('/api/friends')).body.revision,before);
    await send(f.bob,f.carol);
    assert.equal((await f.alice.browser.request('/api/friends')).body.revision,before);
});

test('account disable invalidates peers snapshots and removes the disabled profile from results',async t=>{
    const f=await socialFixture(t);await befriend(f.alice,f.bob);
    const before=(await f.alice.browser.request('/api/friends')).body.revision;
    f.application.auth.repository.disableAccount(f.bob.id);
    assert.equal((await f.alice.browser.request('/api/friends?revision='+before)).status,409);
    assert.deepEqual((await f.alice.browser.request('/api/friends')).body.items,[]);
});

test('a user cannot track blocked-away public edits through revision changes',async t=>{
    const f=await socialFixture(t);await befriend(f.alice,f.bob);
    await mutate(f.alice,'POST','/api/blocks',{userId:f.bob.id});
    const before=(await f.bob.browser.request('/api/friends')).body.revision;
    await mutate(f.alice,'PATCH','/api/users/me',{displayName:'Hidden from Bob'});
    assert.equal((await f.bob.browser.request('/api/friends')).body.revision,before);
    const ownBlockVersion=(await f.alice.browser.request('/api/blocks')).body.revision;
    await mutate(f.bob,'PATCH','/api/users/me',{displayName:'Visible in owner block list'});
    const stale=await f.alice.browser.request('/api/blocks?revision='+ownBlockVersion);assert.equal(stale.status,409);
});

test('failed mutations roll back revision increments along with profile/relationship state',async t=>{
    const f=await socialFixture(t);const before=(await f.alice.browser.request('/api/friends')).body.revision;
    f.db.exec("CREATE TRIGGER fail_social_audit BEFORE INSERT ON AuditLogs WHEN NEW.event_type='social.profile.updated' BEGIN SELECT RAISE(ABORT,'test'); END;");
    assert.equal((await mutate(f.alice,'PATCH','/api/users/me',{displayName:'Should roll back'})).status,500);
    assert.equal((await f.alice.browser.request('/api/friends')).body.revision,before);
});

test('discovery uses a bounded credential-index range and paginated listings avoid per-row queries',async t=>{
    const f=await socialFixture(t);const original=f.db.prepare.bind(f.db);let statements=[];
    t.mock.method(f.db,'prepare',sql=>{statements.push(sql);return original(sql);});
    assert.equal((await f.alice.browser.request('/api/users/search?q=social-')).status,200);
    const sql=statements.find(value=>value.includes('a.username_key>=@prefix'));assert.ok(sql);
    const plan=original('EXPLAIN QUERY PLAN '+sql).all({actor:f.alice.id,prefix:'social-',end:'social-\uffff',lastName:null,lastId:null,take:21});
    assert.ok(plan.some(row=>row.detail.includes('idx_social_discovery') && row.detail.includes('SEARCH')));
    statements=[];await f.alice.browser.request('/api/friends');const emptyCount=statements.length;
    await befriend(f.alice,f.bob);await befriend(f.alice,f.carol);
    statements=[];const populated=await f.alice.browser.request('/api/friends');
    assert.equal(populated.body.items.length,2);assert.equal(statements.length,emptyCount);
});
