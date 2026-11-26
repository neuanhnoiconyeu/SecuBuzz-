const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {socialFixture,mutate}=require('./support/social');
const {fixture,temporary,Database}=require('./support/database');
const {loadMigrations,migrate}=require('../server/database/migrate');
const create=(actor,name='Team lounge',requestId=randomUUID())=>mutate(actor,'POST','/api/voice/rooms',{name,requestId});

test('community rooms require authentication; defaults survive and cannot be managed by users',async t=>{
 const f=await socialFixture(t);
 assert.equal((await f.browser().request('/api/voice/rooms')).status,401);
 const rooms=(await f.alice.browser.request('/api/voice/rooms')).body.items;
 assert.deepEqual(rooms.map(r=>[r.id,r.name]),[['lounge','Lounge'],['study-room','Study Room'],['dev-corner','Gaming Room']]);
 assert.equal((await create(f.alice,'Gaming Room')).status,409);
 for(const r of rooms){assert.equal(r.ownerId,null);assert.equal((await mutate(f.alice,'DELETE',`/api/voice/rooms/${r.id}`)).status,403);}
});
test('create is idempotent and persistent; only the authenticated owner may rename or delete',async t=>{
 const f=await socialFixture(t),requestId=randomUUID();
 const first=await create(f.alice,' Team lounge ',requestId);assert.equal(first.status,201);
 const r=first.body.room;assert.equal(r.ownerId,f.alice.id);assert.equal(r.name,'Team lounge');
 assert.equal((await create(f.alice,'Team lounge',requestId)).status,200);
 const duplicates=await Promise.all([create(f.alice,'Team lounge',requestId),create(f.alice,'Team lounge',requestId)]);
 assert.ok(duplicates.every(r=>r.status===200));
 assert.equal(f.db.prepare('SELECT count(*) n FROM VoiceRooms WHERE owner_id=?').get(f.alice.id).n,1);
 assert.equal((await create(f.bob,'Team lounge',requestId)).status,409);
 assert.equal((await create(f.alice,'Different',requestId)).status,409);
 assert.equal((await create(f.bob,'TEAM LOUNGE')).status,409);
 const other=await f.anotherServer();await other.login(f.alice.username);
 assert.ok((await other.request('/api/voice/rooms')).body.items.some(x=>x.id===r.id));
 assert.equal((await mutate(f.bob,'PATCH',`/api/voice/rooms/${r.id}`,{name:'Hijacked'})).status,403);
 assert.equal((await mutate(f.bob,'DELETE',`/api/voice/rooms/${r.id}`)).status,403);
 assert.equal((await mutate(f.alice,'PATCH',`/api/voice/rooms/${r.id}`,{name:'Renamed room'})).body.room.name,'Renamed room');
 assert.ok((await f.bob.browser.request('/api/voice/rooms')).body.items.some(x=>x.name==='Renamed room'));
 assert.equal((await mutate(f.alice,'DELETE',`/api/voice/rooms/${r.id}`)).status,204);
 assert.equal((await mutate(f.alice,'DELETE',`/api/voice/rooms/${r.id}`)).status,204);
 assert.ok(!(await f.bob.browser.request('/api/voice/rooms')).body.items.some(x=>x.id===r.id));
 assert.equal((await create(f.alice,'Team lounge',requestId)).status,409);
 assert.ok(f.db.prepare('SELECT deleted_at FROM VoiceRooms WHERE room_id=?').get(r.id).deleted_at);
});
test('names, identity fields, CSRF and Origin are validated; failed writes leave no custom rooms',async t=>{
 const f=await socialFixture(t);
 for(const name of ['', ' '.repeat(5),'a'.repeat(65),'bad\u0000name','hidden\u202ename'])assert.equal((await create(f.alice,name)).status,400);
 assert.equal((await mutate(f.alice,'POST','/api/voice/rooms',{name:'Room',requestId:randomUUID(),ownerId:f.bob.id})).status,400);
 assert.equal((await f.alice.browser.request('/api/voice/rooms',{method:'POST',body:{name:'Room',requestId:randomUUID()}})).status,403);
 assert.equal((await mutate(f.alice,'POST','/api/voice/rooms',{name:'Room',requestId:randomUUID()},{Origin:'http://evil.invalid'})).status,403);
 assert.equal(f.db.prepare('SELECT count(*) n FROM VoiceRooms WHERE owner_id IS NOT NULL').get().n,0);
});
test('additive schema 13-to-14 upgrade preserves records/checksums, repeats and retains default/tombstone integrity',t=>{
 const {db}=fixture(t,{migrate:false}),dir=temporary(t),all=loadMigrations();
 for(const m of all.filter(m=>m.version<=13))fs.writeFileSync(path.join(dir,m.name),m.sql);
 migrate(db,{directory:dir});
 db.prepare("INSERT INTO Users(user_id,username,display_name) VALUES('owner','owner','Owner')").run();
 const before=db.prepare('SELECT * FROM Users').all(),ledger=db.prepare('SELECT * FROM SchemaMigrations').all();
 assert.deepEqual(migrate(db).applied,['0014-voice-rooms.sql','0015-conversation-customization.sql','0016-customization-retention.sql']);
 assert.deepEqual(db.prepare('SELECT * FROM Users').all(),before);assert.deepEqual(db.prepare('SELECT * FROM SchemaMigrations WHERE version<=13').all(),ledger);
 assert.equal(migrate(db).applied.length,0);assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
 assert.throws(()=>db.prepare("DELETE FROM VoiceRooms WHERE room_id='lounge'").run(),/voice_room_retained/);
 assert.throws(()=>db.prepare("UPDATE VoiceRooms SET name='changed' WHERE room_id='lounge'").run(),/voice_room_immutable/);
 const isolated=new Database(':memory:');isolated.pragma('foreign_keys=ON');assert.equal(migrate(isolated).version,16);isolated.close();
});
