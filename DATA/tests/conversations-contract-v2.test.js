const { test } = require('node:test');
const assert = require('node:assert/strict');
const { socialFixture,mutate,befriend } = require('./support/social');

const dm=(actor,recipient)=>mutate(actor,'POST','/api/conversations/dm',{recipientId:recipient.id});
async function created(t) {
    const f=await socialFixture(t);await befriend(f.alice,f.bob);
    const response=await dm(f.alice,f.bob);assert.equal(response.status,201);
    return {...f,conversation:response.body.conversation};
}

test('V2.5 DTOs require explicit contractVersion 2 and preserve the legacy response shape by default',async t=>{
    const f=await created(t),id=f.conversation.id;
    f.db.prepare(`INSERT INTO UserProfileAvatars(user_id,storage_key,mime_type,byte_size,sha256)
        VALUES(?,?,?,?,?)`).run(f.alice.id,'fixture-avatar.png','image/png',8,'a'.repeat(64));
    const v2=await f.alice.browser.request(`/api/conversations/${id}?contractVersion=2`);
    assert.equal(v2.status,200);
    assert.deepEqual(Object.keys(v2.body.conversation).sort(),
        ['createdAt','id','interactionAllowed','nicknames','participants','themeId','type','updatedAt']);
    assert.equal(v2.body.conversation.themeId,'default');assert.deepEqual(v2.body.conversation.nicknames,{});
    for(const participant of v2.body.conversation.participants){
        assert.deepEqual(Object.keys(participant).sort(),['avatar','avatarUrl','displayName','id','username']);
        assert.equal(participant.avatarUrl,participant.id===f.alice.id?`/api/users/${f.alice.id}/avatar?v=${'a'.repeat(12)}`:null);
    }

    const changed=await mutate(f.alice,'PATCH',`/api/conversations/${id}/preferences?contractVersion=2`,
        {themeId:'ocean',nicknames:{[f.bob.id]:'Bobby'}});
    assert.equal(changed.status,200);assert.equal(changed.body.conversation.themeId,'ocean');
    assert.deepEqual(changed.body.conversation.nicknames,{[f.bob.id]:'Bobby'});
    const listV2=await f.bob.browser.request('/api/conversations?contractVersion=2');
    assert.equal(listV2.body.items[0].themeId,'ocean');assert.deepEqual(listV2.body.items[0].nicknames,{[f.bob.id]:'Bobby'});
    const repeated=await mutate(f.bob,'POST','/api/conversations/dm?contractVersion=2',{recipientId:f.alice.id});
    assert.equal(repeated.status,200);assert.equal(repeated.body.conversation.themeId,'ocean');

    const legacy=await f.bob.browser.request(`/api/conversations/${id}`);
    assert.deepEqual(Object.keys(legacy.body.conversation).sort(),Object.keys(f.conversation).sort());
    for(const participant of legacy.body.conversation.participants)
        assert.deepEqual(Object.keys(participant).sort(),['avatar','displayName','id','username']);
    const listV1=await f.bob.browser.request('/api/conversations');
    assert.deepEqual(Object.keys(listV1.body.items[0]).sort(),Object.keys(f.conversation).sort());
});

test('conversation response-version and pagination queries reject invalid, duplicate, or cross-version cursors',async t=>{
    const f=await created(t);await befriend(f.alice,f.carol);assert.equal((await dm(f.alice,f.carol)).status,201);
    const legacyPage=await f.alice.browser.request('/api/conversations?limit=1');
    assert.equal(legacyPage.status,200);assert.ok(legacyPage.body.nextCursor);
    const crossVersion=await f.alice.browser.request(`/api/conversations?contractVersion=2&limit=1&cursor=${encodeURIComponent(legacyPage.body.nextCursor)}`);
    assert.equal(crossVersion.status,400);
    assert.equal((await f.alice.browser.request('/api/conversations?contractVersion=1&contractVersion=2')).status,400);
    assert.equal((await f.alice.browser.request(`/api/conversations/${f.conversation.id}?contractVersion=3`)).status,400);
    assert.equal((await mutate(f.alice,'POST','/api/conversations/dm?contractVersion=3',{recipientId:f.bob.id})).status,400);
    assert.equal((await mutate(f.alice,'PATCH',`/api/conversations/${f.conversation.id}/preferences?contractVersion=3`,{themeId:'ocean'})).status,400);
});
