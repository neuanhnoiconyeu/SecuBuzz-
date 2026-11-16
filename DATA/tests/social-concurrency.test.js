const { test }=require('node:test');
const assert=require('node:assert/strict');
const { socialFixture,mutate,send,befriend }=require('./support/social');

async function secondActor(f,actor) {
    const remote=await f.anotherServer();const copy={...actor,browser:actor.browser.clone()};copy.browser.origin=remote.origin;return copy;
}
test('two concurrent reversed requests on independent HTTP servers create one pending pair',async t=>{
    const f=await socialFixture(t);const bob=await secondActor(f,f.bob);
    const responses=await Promise.all([send(f.alice,bob),send(bob,f.alice)]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM FriendRequests WHERE status='pending'").get().n,1);
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('two concurrent accept calls create exactly one canonical friendship',async t=>{
    const f=await socialFixture(t);const sent=await send(f.alice,f.bob);const bob=await secondActor(f,f.bob);
    const path=`/api/friends/requests/${sent.body.request.id}/accept`;
    const responses=await Promise.all([mutate(f.bob,'POST',path),mutate(bob,'POST',path)]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Friendships').get().n,1);
    const row=f.db.prepare('SELECT * FROM Friendships').get();assert.ok(row.user_low<row.user_high);assert.equal(row.origin,'authenticated');
});

test('accept versus cancel is serializable and cannot leave a cancelled request with a friendship',async t=>{
    const f=await socialFixture(t);const sent=await send(f.alice,f.bob);const bob=await secondActor(f,f.bob);const id=sent.body.request.id;
    const [accepted,cancelled]=await Promise.all([mutate(bob,'POST',`/api/friends/requests/${id}/accept`),mutate(f.alice,'DELETE',`/api/friends/requests/${id}`)]);
    assert.ok((accepted.status===200 && cancelled.status===409) || (accepted.status===409 && cancelled.status===204));
    const status=f.db.prepare('SELECT status FROM FriendRequests WHERE request_id=?').get(id).status;
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Friendships').get().n,status==='accepted' ? 1 : 0);
});

test('accept versus block always leaves a block and no friendship regardless of lock acquisition order',async t=>{
    const f=await socialFixture(t);const sent=await send(f.alice,f.bob);const bob=await secondActor(f,f.bob);const id=sent.body.request.id;
    const [accepted,blocked]=await Promise.all([mutate(bob,'POST',`/api/friends/requests/${id}/accept`),mutate(f.alice,'POST','/api/blocks',{userId:f.bob.id})]);
    assert.ok([200,404,409].includes(accepted.status));assert.equal(blocked.status,204);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Friendships').get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Blocks').get().n,1);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM FriendRequests WHERE status='pending'").get().n,0);
    assert.equal((await f.bob.browser.request('/api/users/'+f.alice.id)).status,404);
});

test('duplicate removals and blocks across workers remain idempotent without deleting accounts',async t=>{
    const f=await socialFixture(t);await befriend(f.alice,f.bob);const alice=await secondActor(f,f.alice);
    const removals=await Promise.all([mutate(f.alice,'DELETE','/api/friends/'+f.bob.id),mutate(alice,'DELETE','/api/friends/'+f.bob.id)]);
    assert.deepEqual(removals.map(r=>r.status),[204,204]);
    const blocks=await Promise.all([mutate(f.alice,'POST','/api/blocks',{userId:f.bob.id}),mutate(alice,'POST','/api/blocks',{userId:f.bob.id})]);
    assert.deepEqual(blocks.map(r=>r.status),[204,204]);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Blocks').get().n,1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Users').get().n,3);
});

test('a competing writer returns a safe unavailable error and commits no partial request',async t=>{
    const f=await socialFixture(t);const alice=await secondActor(f,f.alice);const writer=f.connections[1];
    writer.pragma('busy_timeout=20');f.db.exec('BEGIN IMMEDIATE');
    try {
        const response=await send(alice,f.bob);assert.equal(response.status,503);assert.equal(response.body.code,'SERVICE_UNAVAILABLE');
        assert.equal(f.db.prepare('SELECT count(*) AS n FROM FriendRequests').get().n,0);
    } finally {f.db.exec('ROLLBACK');}
    assert.equal((await send(alice,f.bob)).status,201);
});
