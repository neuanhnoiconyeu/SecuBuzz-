// T-5B-04 (ARCH-R02.3, ARCH-R02.4, DB5-R15.4): replays tests/fixtures/direct-baseline-d7cd40a.json, which
// tests/support/record-baseline.js recorded from the functional baseline d7cd40a, against the current code.
// Each scenario drives the real createApp over loopback on its own temporary database (support/auth.js setup)
// with an injected clock and limiter, masks every answer by the rule stored in the fixture, and fails on the
// first entry whose status, error code, response fields or request differ from the recording.
// The fixture is only read; nothing here writes it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { BASELINE, DIRECT_OUTPUT, DIRECT_FAMILIES, DIRECT_SCENARIOS, directHeader } = require('./support/record-baseline');

const recorded = fs.readFileSync(DIRECT_OUTPUT, 'utf8');
const fixture = JSON.parse(recorded);
const digest = () => createHash('sha256').update(fs.readFileSync(DIRECT_OUTPUT)).digest('hex');

test('the direct-message fixture is the d7cd40a recording with its masking rule and entry counts', () => {
    assert.equal(fixture.baseline, BASELINE);
    assert.match(recorded, /^[\t\n\r\x20-\x7e]*$/, 'the fixture is ASCII text');
    const { entries, ...header } = fixture;
    assert.deepEqual(header, directHeader(entries));
    assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length, 'entry ids are unique');
    const scenarios = DIRECT_SCENARIOS.map(scenario => scenario.name);
    for (const entry of entries) {
        assert.ok(DIRECT_FAMILIES.includes(entry.family), `${entry.id} has a known route family`);
        assert.ok(scenarios.includes(entry.scenario), `${entry.id} has a known scenario`);
        assert.ok(Number.isInteger(entry.status) && (entry.code === null || typeof entry.code === 'string'), `${entry.id} holds status and code`);
    }
    for (const family of DIRECT_FAMILIES) assert.ok(header.counts.families[family] > 0, `route family ${family} is recorded`);
    for (const name of scenarios) assert.ok(header.counts.scenarios[name] > 0, `scenario ${name} is recorded`);
});

for (const scenario of DIRECT_SCENARIOS) {
    test(`direct-message routes answer as at d7cd40a: ${scenario.name}`, async t => {
        const before = digest();
        const expected = fixture.entries.filter(entry => entry.scenario === scenario.name);
        const replayed = await scenario.run(t, { expected });
        assert.equal(replayed.length, expected.length, `${scenario.name} replayed ${replayed.length} of ${expected.length} recorded entries`);
        assert.equal(digest(), before, 'the replay leaves the fixture file unchanged');
    });
}

// T-5B-31 / P-19. Populate the same isolated databases used by the frozen
// replay; its expected entries and masking rules are never regenerated.
const path = require('node:path');
const { forAll } = require('./support/random');
const { guardPath, snapshot, createClock } = require('./support/groups');
const { createGroupRepository, withMembershipTransaction } = require('../server/database/groupRepository');
const P19_SEED = 5131;
const P19_RUNS = 10;
const ZERO_KEY = Buffer.alloc(16).toString('base64url');

function encodedRows(statement, ...parameters) {
    return statement.raw(true).safeIntegers(true).all(...parameters).map(row => JSON.stringify(row.map(value =>
        typeof value === 'bigint' ? { integer:String(value) } : Buffer.isBuffer(value) ? { blob:value.toString('hex') } : value))).sort();
}
function rowDigest(rows) { return createHash('sha256').update(JSON.stringify(rows)).digest('hex'); }
function tableName(name) { return '"' + name.replaceAll('"','""') + '"'; }

// Unlike the domain snapshot, this includes every table (credentials, sessions,
// limiter counters and migration ledger too). The replay's injected limiter
// performs no counter writes, so denied requests must change no row at all.
function allTables(db) {
    return db.transaction(() => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
        .map(({ name }) => [name,rowDigest(encodedRows(db.prepare('SELECT * FROM '+tableName(name))))])))();
}
function groupRows(db, ids) {
    return db.transaction(() => Object.fromEntries(['Conversations','ConversationMembers','GroupExtensions','GroupMembershipIntervals',
        'ConversationInvitations','GroupReadPositions','GroupCreationKeys','Messages','MessageReceipts','Attachments'].map(name => {
        const select = db.prepare('SELECT * FROM '+tableName(name)+' WHERE conversation_id=?');
        return [name,rowDigest(ids.flatMap(id => encodedRows(select,id)).sort())];
    })))();
}

function clientKeys() {
    const source = fs.readFileSync(path.join(__dirname,'../../client/src/security/e2ee/api.ts'),'utf8');
    const conversation = source.slice(source.indexOf('  conversation(input:'),source.indexOf('  async conversations('));
    const list = source.slice(source.indexOf('  async conversations('),source.indexOf('  async getConversation('));
    const quoted = text => [...text.matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
    const object = conversation.match(/exact\(input,\s*\[([^\]]+)\]/);
    const participant = conversation.match(/exact\(p,\s*\[([^\]]+)\]/);
    const page = list.match(/,\s*\[([^\]]+)\]\);/);
    assert.ok(object && participant && page,'the current client parser declares each exact key set');
    return { object:quoted(object[1]), participant:quoted(participant[1]), page:quoted(page[1]) };
}
function assertDirect(row, actor, expectedIds, groupIds, keys, pair) {
    assert.deepEqual(Object.keys(row).sort(),keys.object);
    assert.equal(row.type,'direct'); assert.ok(expectedIds.includes(row.id)); assert.ok(!groupIds.includes(row.id));
    assert.equal(typeof row.interactionAllowed,'boolean');
    for (const value of [row.createdAt,row.updatedAt]) { assert.equal(typeof value,'string'); assert.ok(Number.isFinite(Date.parse(value))); }
    assert.equal(row.participants.length,2);
    assert.equal(new Set(row.participants.map(user => user.id)).size,2);
    assert.deepEqual(row.participants.map(user => user.id).sort(),[...pair].sort());
    assert.ok(row.participants.some(user => user.id === actor.id));
    for (const user of row.participants) {
        assert.deepEqual(Object.keys(user).sort(),keys.participant);
        for (const name of ['id','username','displayName','avatar']) assert.equal(typeof user[name],'string');
        assert.ok(user.id && user.displayName.trim());
    }
}

function generatePopulation(random, info) {
    return { extraUsers:info.run % 4, archiveDirect:info.run % 3 === 0, outcome:random.pick(['declined','cancelled']),
        managed:['member','removed','rejoined','pending'].map((state,index) => ({ state,
            policy:(info.run+index)%2 ? 'all' : 'from_joined', archived:index === 0 ? false : index === 1 ? true : random.bool(),
            messages:state === 'pending' ? info.run%2 : random.int(1,3), admin:random.bool(), tombstone:random.bool() })),
        legacy:[{ removed:false, archived:false },{ removed:true, archived:true }] };
}

function populate(f, dm, model, run) {
    guardPath(f.filename);
    const g = createGroupRepository(f.db), r = g.repositories, clock = createClock('2030-01-01T00:00:00.000Z');
    const groups = ['fixture-group-conversation'], messages = [], directs = [dm];
    const extraUsers = [];
    for (let index = 0; index < model.extraUsers; index += 1) {
        extraUsers.push(r.users.create({ user_id:`p19-extra-${run}-${index}`, username:`p19-extra-${run}-${index}`, display_name:'Synthetic extra' }).user_id);
    }
    assert.equal(r.users.list().length,3+model.extraUsers);
    const otherDirect = r.conversations.createAuthenticatedDirect(f.bob.id,f.carol.id);
    directs.push(otherDirect.conversation_id);
    const pair = [f.alice.id,f.carol.id].sort();
    const legacyDirect = r.conversations.create({ conversation_id:`p19-legacy-dm-${run}`, kind:'direct', origin:'legacy',
        created_by:f.alice.id, dm_user_low:pair[0], dm_user_high:pair[1] });
    directs.push(legacyDirect.conversation_id);
    if (extraUsers.length >= 2) {
        const hidden = r.conversations.createAuthenticatedDirect(extraUsers[0],extraUsers[1]); directs.push(hidden.conversation_id);
    }
    const stored = (id, sender, seq, receiver = null) => r.messages.insertAuthenticated({
        message_id:seq === 1 && id.startsWith('p19-group-') ? id : `${id}-message-${seq}`,
        conversation_id:id, sender_id:sender, receiver_id:receiver, ciphertext:'synthetic opaque ciphertext', iv:'synthetic-iv',
        envelope_version:1, encoding:'base64', sender_name:'Synthetic sender', client_timestamp:clock.iso(),
        message_type:'text', fingerprint:'a'.repeat(64), client_id:`p19-client-${seq}`, message_seq:seq, created_at:clock.iso() });
    const directMessage = stored(otherDirect.conversation_id,f.bob.id,1,f.carol.id);
    if (model.archiveDirect) r.conversations.archive(otherDirect.conversation_id,clock.iso());
    for (const [index, spec] of model.managed.entries()) {
        const id = `p19-group-${run}-${spec.state}`;
        withMembershipTransaction(f.db,() => {
            g.insertGroup({ conversation_id:id, created_by:f.alice.id, title:`Synthetic ${spec.state}`, historyPolicy:spec.policy });
            if (spec.state !== 'pending') {
                g.addMember(id,f.bob.id,clock.iso()); g.openIntervalAt(id,f.bob.id,clock.iso()); g.bumpRevision(id);
                if (spec.admin) { g.changeRole(id,f.bob.id,'member','admin'); g.bumpRevision(id); }
            }
            let seq = 0;
            const send = sender => { seq += 1; const message = stored(id,sender,seq); messages.push(message); return message; };
            for (let n = 0; n < spec.messages; n += 1) send(f.alice.id);
            const firstJoin = g.getMember(id,f.bob.id)?.joined_at;
            if (['removed','rejoined'].includes(spec.state)) {
                clock.advance(); g.endMembership(id,f.bob.id,clock.iso()); g.closeInterval(id,f.bob.id,clock.iso()); g.bumpRevision(id);
                send(f.alice.id);
            }
            if (spec.state === 'rejoined') {
                clock.advance(); g.reactivateMember(id,f.bob.id,clock.iso()); g.openIntervalAt(id,f.bob.id,clock.iso()); g.bumpRevision(id);
                send(f.bob.id); assert.equal(g.getMember(id,f.bob.id).joined_at,firstJoin);
            }
            const invitee = ['removed','pending'].includes(spec.state) ? f.bob.id : f.carol.id;
            g.insertInvitation({ invitation_id:`p19-invite-${run}-${index}`, conversation_id:id,
                inviter_id:f.alice.id, invitee_id:invitee, created_at:clock.iso() });
            if (index === 0) g.resolveInvitation(`p19-invite-${run}-${index}`,model.outcome,clock.iso());
            g.upsertReadPosition(id,f.alice.id,seq,clock.iso());
            if (seq > 0 && spec.tombstone) r.messages.tombstone(messages.at(-1).message_id,clock.iso());
            if (seq > 0) r.attachments.insert({ attachment_id:`p19-attachment-${run}-${index}`, conversation_id:id,
                message_id:id, uploaded_by:f.alice.id, storage_key:`p19-synthetic-${run}-${index}`, byte_size:index%2,
                encrypted_metadata:'synthetic encrypted metadata' });
            if (spec.archived) g.archiveGroup(id,clock.iso());
        });
        const report = g.invariantReport(id);
        assert.equal(report.activeOwners,1); assert.equal(report.openIntervals,report.activeMembers); assert.equal(report.mismatches,0);
        groups.push(id);
    }
    for (const [index, spec] of model.legacy.entries()) {
        const id = `p19-legacy-group-${run}-${index}`;
        r.transaction(() => {
            r.conversations.create({ conversation_id:id, kind:'group', origin:'legacy', created_by:f.alice.id, title:'Synthetic legacy group' });
            r.members.insert({ conversation_id:id, user_id:f.bob.id });
            const message = r.messages.insert({ message_id:id, conversation_id:id, sender_id:f.alice.id,
                receiver_id:null, ciphertext:'synthetic legacy ciphertext', iv:'legacy-iv' });
            messages.push(message);
            if (spec.removed) r.members.leave(id,f.bob.id,clock.iso());
            if (spec.archived) r.conversations.archive(id,clock.iso());
        });
        groups.push(id);
    }
    const bare = r.conversations.create({ conversation_id:`p19-bare-${run}`, kind:'group', origin:'authenticated',
        created_by:f.alice.id, title:'Synthetic missing extension' });
    assert.equal(g.getVisibleGroup(bare.conversation_id),null); groups.push(bare.conversation_id);
    const pairs = Object.fromEntries(directs.map(id => { const row = r.conversations.get(id); return [id,[row.dm_user_low,row.dm_user_high]]; }));
    assert.equal(groups.length,8);
    return { groups, messages, directs, directMessage, pairs,
        expected:{ alice:[dm], bob:model.archiveDirect ? [dm] : [dm,otherDirect.conversation_id], carol:model.archiveDirect ? [] : [otherDirect.conversation_id] } };
}

function envelope(actor, id, run) {
    const senderName = { 'social-alice':'Alice', 'social-bob':'Bob', 'social-carol':'Carol' }[actor.username];
    return { id:`p19-probe-${run}`, conversationId:id, senderId:actor.id, senderName,
        timestamp:'2030-01-01T00:00:00.000Z', type:'text',
        encryption:{ version:1, algorithm:'AES-256-GCM', encoding:'base64', iv:Buffer.alloc(12).toString('base64'), ciphertext:Buffer.alloc(32).toString('base64') } };
}

// Keyed to file existence, so the check follows the router: absent in DB-5B, present from T-5C-04.
const GROUP_ROUTER_EXISTS = fs.existsSync(path.join(__dirname,'../server/routes/groups.js'));
async function isolation(f, data, run, keys) {
    const unchanged = allTables(f.db), domain = snapshot(f.db);
    for (const name of ['Sessions','AccountCredentials','AuthRateLimits','SchemaMigrations']) assert.ok(Object.hasOwn(unchanged,name));
    const request = async (actor, method, url, body) => {
        const result = await actor.browser.request(url,{ method, body, headers:['GET','HEAD'].includes(method) ? {} : { 'X-CSRF-Token':actor.token } });
        // Group paths: 404 while routes/groups.js is absent (DB-5B). Once the router exists (T-5C-04) every switch is off here, so the
        // answer is the 503 of DB5-R16.2. Every other path keeps the 404 of an identifier that is not the route's kind.
        const [status,code] = GROUP_ROUTER_EXISTS && url.startsWith('/api/groups') ? [503,'FEATURE_UNAVAILABLE'] : [404,'NOT_FOUND'];
        assert.equal(result.status,status,`${method} ${url}: ${JSON.stringify(result.body)}`);
        assert.deepEqual(result.body,{ code, fields:[] });
        assert.deepEqual(allTables(f.db),unchanged,`${method} ${url} changed a table`);
    };
    for (const name of ['alice','bob','carol']) {
        const actor = f[name], expected = data.expected[name], seen = [];
        let cursor = null;
        for (let page = 0; page < 5; page += 1) {
            const response = await actor.browser.request('/api/conversations?limit=1'+(cursor ? '&cursor='+encodeURIComponent(cursor) : ''));
            assert.equal(response.status,200); assert.deepEqual(Object.keys(response.body).sort(),keys.page);
            assert.ok(response.body.items.length <= 1);
            for (const row of response.body.items) { assertDirect(row,actor,expected,data.groups,keys,data.pairs[row.id]); seen.push(row.id); }
            cursor = response.body.nextCursor;
            assert.ok(cursor === null || typeof cursor === 'string');
            if (cursor === null) break;
            assert.equal(response.body.items.length,1);
        }
        assert.equal(cursor,null,'bounded list traversal finishes');
        assert.deepEqual(seen.sort(),[...expected].sort());
    }
    assert.deepEqual(allTables(f.db),unchanged,'direct listings are read-only');
    for (const id of data.groups) {
        for (const actor of [f.alice,f.bob,f.carol]) {
            for (const [method,url,body] of [
                ['GET',`/api/conversations/${id}`], ['GET',`/api/conversations/${id}/messages?limit=1`],
                ['POST',`/api/conversations/${id}/messages`,envelope(actor,id,run)],
                ['GET',`/api/conversations/${id}/keys`], ['GET',`/api/conversations/${id}/keys/epochs/${ZERO_KEY}`],
                ['POST',`/api/conversations/${id}/keys/epochs`,{}],
                ['POST',`/api/messages/${id}/read`], ['DELETE',`/api/messages/${id}`], ['PATCH',`/api/messages/${id}`,{}],
            ]) await request(actor,method,url,body);
        }
    }
    for (const message of data.messages) {
        for (const [method,url,body] of [['POST',`/api/messages/${message.message_id}/read`],
            ['DELETE',`/api/messages/${message.message_id}`], ['PATCH',`/api/messages/${message.message_id}`,{}]]) {
            await request(f.alice,method,url,body);
        }
    }
    for (const id of data.directs) {
        for (const [method,url,body] of [
            ['GET',`/api/groups/${id}`], ['PATCH',`/api/groups/${id}`,{ name:'No change' }],
            ['GET',`/api/groups/${id}/members`], ['POST',`/api/groups/${id}/members`,{ userId:f.carol.id }],
            ['DELETE',`/api/groups/${id}/members/${f.bob.id}`], ['POST',`/api/groups/${id}/leave`], ['POST',`/api/groups/${id}/archive`],
            ['GET',`/api/groups/${id}/invitations`], ['POST',`/api/groups/${id}/invitations`,{ userId:f.carol.id }],
            ['GET',`/api/groups/${id}/messages`], ['POST',`/api/groups/${id}/messages`,envelope(f.alice,id,run)],
            ['GET',`/api/groups/${id}/messages/${data.directMessage.message_id}`],
            ['GET',`/api/groups/${id}/read-position`], ['PUT',`/api/groups/${id}/read-position`,{ position:0 }],
        ]) await request(f.alice,method,url,body);
    }
    assert.deepEqual(snapshot(f.db),domain);
}

test('P-19: seeded populated groups cannot enter direct routes or change the frozen fixture replay', async t => {
    const beforeDigest = digest(), keys = clientKeys(), scenarios = new Set();
    let populations = 0, replayedEntries = 0;
    t.diagnostic(GROUP_ROUTER_EXISTS ? 'routes/groups.js exists: group paths answer 503 FEATURE_UNAVAILABLE while every switch is off' : 'routes/groups.js is absent: group paths answer 404');
    const summary = await forAll('P-19',{ seed:P19_SEED, runs:P19_RUNS, onRun:line => t.diagnostic(line) },generatePopulation,async (model,info) => {
        let failure;
        await t.test(info.line,async child => {
            try {
                const scenario = DIRECT_SCENARIOS[info.run % DIRECT_SCENARIOS.length]; scenarios.add(scenario.name);
                const expected = fixture.entries.filter(entry => entry.scenario === scenario.name);
                let populated, database, groupDigest;
                const replayed = await scenario.run(child,{ expected, populate:async (f,{ conversationId }) => {
                    populated = populate(f,conversationId,model,info.run); database = f.db;
                    await isolation(f,populated,info.run,keys);
                    groupDigest = groupRows(f.db,populated.groups);
                } });
                assert.ok(populated); assert.equal(replayed.length,expected.length);
                assert.deepEqual(groupRows(database,populated.groups),groupDigest,'successful direct replay cannot mutate group rows');
                assert.equal(digest(),beforeDigest,'frozen fixture stays byte-identical');
                assert.deepEqual(database.pragma('foreign_key_check'),[]);
                populations += 1; replayedEntries += replayed.length;
            } catch (error) { failure = error; throw error; }
        });
        if (failure) throw failure;
    });
    if (summary.replay === null) { assert.equal(populations,P19_RUNS); assert.equal(scenarios.size,DIRECT_SCENARIOS.length); }
    assert.equal(digest(),beforeDigest);
    t.diagnostic(`P-19 seed=${summary.seed} populations=${populations} scenarios=${scenarios.size} replayedEntries=${replayedEntries}; all-table denial snapshots and group replay snapshots unchanged`);
});
