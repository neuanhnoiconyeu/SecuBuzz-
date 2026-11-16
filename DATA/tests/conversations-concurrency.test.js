const { test } = require('node:test');
const assert = require('node:assert/strict');
const { socialFixture,mutate,befriend } = require('./support/social');
const { childBackend } = require('./support/auth');
const dm=(a,b)=>mutate(a,'POST','/api/conversations/dm',{recipientId:b.id});
async function workers(f) {
    const first=await childBackend(f),second=await childBackend(f);
    const copy=(actor,origin)=>{const browser=actor.browser.clone();browser.origin=origin;return {...actor,browser};};
    return {alice:copy(f.alice,first.browser.origin),bob:copy(f.bob,second.browser.origin)};
}

test('six reversed/concurrent HTTP creations in independent native server processes commit exactly one DM',async t=>{
    const f=await socialFixture(t);await befriend(f.alice,f.bob);const w=await workers(f);
    const results=await Promise.all(Array.from({length:6},(_,i)=>i%2 ? dm(w.bob,w.alice) : dm(w.alice,w.bob)));
    assert.equal(results.filter(r=>r.status===201).length,1);assert.equal(results.filter(r=>r.status===200).length,5);
    assert.equal(new Set(results.map(r=>r.body.conversation.id)).size,1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Conversations').get().n,1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM ConversationMembers').get().n,2);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM AuditLogs WHERE source='conversations'").get().n,1);
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('creation versus block across real processes is serialized and leaves no authorized interaction after block',async t=>{
    const f=await socialFixture(t);await befriend(f.alice,f.bob);const w=await workers(f);
    const [made,blocked]=await Promise.all([dm(w.alice,w.bob),mutate(w.bob,'POST','/api/blocks',{userId:w.alice.id})]);
    assert.equal(blocked.status,204);assert.ok([201,404].includes(made.status));
    const count=f.db.prepare('SELECT count(*) AS n FROM Conversations').get().n;
    assert.equal(count,made.status===201 ? 1 : 0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM ConversationMembers').get().n,count*2);
    assert.deepEqual((await w.alice.browser.request('/api/conversations')).body.items,[]);
    if(count)assert.equal((await w.alice.browser.request('/api/conversations/'+made.body.conversation.id)).status,404);
    assert.equal((await dm(w.bob,w.alice)).status,404);
});

test('creation versus friendship removal across processes cannot create a new DM after consent is removed',async t=>{
    const f=await socialFixture(t);await befriend(f.alice,f.bob);const w=await workers(f);
    const [made,removed]=await Promise.all([dm(w.alice,w.bob),mutate(w.bob,'DELETE','/api/friends/'+w.alice.id)]);
    assert.equal(removed.status,204);assert.ok([201,403].includes(made.status));
    const count=f.db.prepare('SELECT count(*) AS n FROM Conversations').get().n;
    assert.equal(count,made.status===201 ? 1 : 0);
    const listed=await w.alice.browser.request('/api/conversations');assert.equal(listed.body.items.length,count);
    assert.ok(listed.body.items.every(row=>row.interactionAllowed===false));
});

test('second-membership failure rolls back the conversation and first membership without leaking diagnostics',async t=>{
    const f=await socialFixture(t);await befriend(f.alice,f.bob);
    f.db.exec(`CREATE TRIGGER test_second_member BEFORE INSERT ON ConversationMembers
        WHEN NEW.user_id=(SELECT dm_user_high FROM Conversations WHERE conversation_id=NEW.conversation_id)
        BEGIN SELECT RAISE(ABORT,'PRIVATE_MEMBERSHIP_FAILURE'); END;`);
    const failed=await dm(f.alice,f.bob);assert.equal(failed.status,500);assert.ok(!failed.text.includes('PRIVATE_MEMBERSHIP_FAILURE'));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Conversations').get().n,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM ConversationMembers').get().n,0);
    f.db.exec('DROP TRIGGER test_second_member');assert.equal((await dm(f.alice,f.bob)).status,201);
});

test('audit failure after both memberships rolls the entire creation back',async t=>{
    const f=await socialFixture(t);await befriend(f.alice,f.bob);
    f.db.exec("CREATE TRIGGER test_conversation_audit BEFORE INSERT ON AuditLogs WHEN NEW.source='conversations' BEGIN SELECT RAISE(ABORT,'PRIVATE_AUDIT_FAILURE'); END;");
    const failed=await dm(f.alice,f.bob);assert.equal(failed.status,500);assert.ok(!failed.text.includes('PRIVATE_AUDIT_FAILURE'));
    for(const table of ['Conversations','ConversationMembers','Messages'])assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);
});

test('database uniqueness rejects a second trusted DAL conversation for the unordered pair',async t=>{
    const f=await socialFixture(t);await befriend(f.alice,f.bob);assert.equal((await dm(f.alice,f.bob)).status,201);
    assert.throws(()=>f.application.conversations.repositories.conversations.createAuthenticatedDirect(f.bob.id,f.alice.id),{code:'DUPLICATE'});
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Conversations').get().n,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM ConversationMembers').get().n,2);
});

test('a competing writer produces bounded safe unavailability and no partial conversation',async t=>{
    const f=await socialFixture(t);await befriend(f.alice,f.bob);const other=await f.anotherServer();f.connections[1].pragma('busy_timeout=20');
    const browser=f.alice.browser.clone();browser.origin=other.origin;const alice={...f.alice,browser};
    f.db.exec('BEGIN IMMEDIATE');
    try {const response=await dm(alice,f.bob);assert.equal(response.status,503);assert.equal(response.body.code,'SERVICE_UNAVAILABLE');
        assert.equal(f.db.prepare('SELECT count(*) AS n FROM Conversations').get().n,0);
    } finally {f.db.exec('ROLLBACK');}
    assert.equal((await dm(alice,f.bob)).status,201);
});
