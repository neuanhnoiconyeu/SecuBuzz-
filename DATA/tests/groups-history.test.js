// T-5B-29 / P-11. The owner-approved oracle is authorization AND permitted
// ranges under the stored policy. The policy helper checks SQL agreement;
// the literal AF-14 scenario below independently pins the intended rule.
// All fixtures use the guarded disposable databases of support/groups.js.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { groupDatabase, createClock, snapshot, changedTables } = require('./support/groups');
const { forAll } = require('./support/random');
const { permittedRanges, inRanges } = require('../server/groups/policy');
const { createGroupRepository, withMembershipTransaction, RepositoryError } = require('../server/database/groupRepository');

const P11_SEED = 5129;
const P11_RUNS = 100;
const POLICIES = ['from_joined', 'all'];
const code = expected => error => error instanceof RepositoryError && error.code === expected;
const bounds = intervals => intervals.map(({ first_seq, last_seq }) => ({ first_seq, last_seq }));

function fixture(t) {
    const f = groupDatabase(t);
    const actors = {};
    for (const name of ['owner','target','peer','never']) {
        actors[name] = f.repositories.users.create({ user_id:`p11-${name}`, username:`p11-${name}`, display_name:`Synthetic ${name}` }).user_id;
    }
    return { ...f, actors, groups:createGroupRepository(f.db), clock:createClock('2030-01-01T00:00:00.000Z') };
}

// Bias high-water bounds toward 0, 1, N and neighboring interval boundaries.
// Joins occur at h+1; an immediate leave closes at h, giving an empty interval.
function boundary(random, low, high, n) {
    const choices = [low, high, 0, 1, n, high-1, low+1, random.int(low, high)].filter(x => x >= low && x <= high);
    return random.pick(choices);
}
function generate(random, info) {
    let n = random.pick([0,1,200,random.int(0,200)]);
    const count = info.run % 6;
    const active = count > 0 && Math.floor(info.run / 6) % 2 === 0;
    let previous = 0, intervals = [];
    for (let index = 0; index < count; index += 1) {
        const join = boundary(random, previous, n, n);
        const last = active && index === count-1 ? null : boundary(random, join, n, n);
        intervals.push({ first_seq:join+1, last_seq:last });
        previous = last ?? join;
    }
    // Pin difficult edges as well as generating them: the empty stream, both
    // endpoints, repeated empty intervals, gaps, and a removed nonempty member.
    const edges = [
        { n:0, intervals:[] },
        { n:1, intervals:[{ first_seq:1, last_seq:null }] },
        { n:200, intervals:[{ first_seq:1, last_seq:0 }, { first_seq:200, last_seq:null }] },
        { n:200, intervals:[{ first_seq:2, last_seq:3 }, { first_seq:5, last_seq:5 }, { first_seq:200, last_seq:null }] },
        { n:0, intervals:[{ first_seq:1, last_seq:0 }, { first_seq:1, last_seq:0 }, { first_seq:1, last_seq:0 }, { first_seq:1, last_seq:null }] },
        { n:200, intervals:[{ first_seq:1, last_seq:1 }, { first_seq:3, last_seq:2 }, { first_seq:5, last_seq:17 },
            { first_seq:19, last_seq:199 }, { first_seq:200, last_seq:200 }] },
    ];
    if (info.run < edges.length) ({ n, intervals } = edges[info.run]);
    return { n, intervals, active:intervals.length > 0 && intervals.at(-1).last_seq === null,
        limit:info.run % 10 === 0 ? 1 : info.run % 10 === 1 ? 50 : random.int(1,50),
        senders:Array.from({ length:n }, () => random.int(0,2)),
        timestamps:Array.from({ length:n }, () => random.int(-1000000,1000000)),
        tombstones:Array.from({ length:n }, (_, index) => index === 0 || random.bool(0.25)) };
}

function send(f, id, seq, sender, createdAt) {
    return f.repositories.messages.insertAuthenticated({ message_id:`${id}-message-${seq}`, conversation_id:id,
        sender_id:sender, receiver_id:null, ciphertext:'synthetic opaque ciphertext', iv:'synthetic-iv',
        envelope_version:1, encoding:'base64', sender_name:'Synthetic sender', client_timestamp:createdAt,
        message_type:'text', fingerprint:'a'.repeat(64), client_id:`p11-client-${seq}`, message_seq:seq, created_at:createdAt });
}

// Create a replica instead of editing stored message identity. In variant 1 the
// peer leaves for a message and rejoins, senders differ, and timestamps move
// from after the target's joins to before them. Target intervals stay identical.
function build(f, model, policy, variant, run) {
    return withMembershipTransaction(f.db, () => {
        const id = `p11-${run}-${policy}-${variant}`;
        f.groups.insertGroup({ conversation_id:id, created_by:f.actors.owner, title:'Synthetic P-11 group', historyPolicy:policy });
        f.groups.addMember(id, f.actors.peer, f.clock.iso());
        f.groups.openIntervalAt(id, f.actors.peer, f.clock.iso());
        const events = new Map();
        const at = (h, action) => { if (!events.has(h)) events.set(h, []); events.get(h).push(action); };
        model.intervals.forEach((interval, index) => {
            at(interval.first_seq-1, index === 0 ? 'join' : 'rejoin');
            if (interval.last_seq !== null) at(interval.last_seq, 'leave');
        });
        if (variant) {
            const split = Math.floor(model.n/2);
            at(split, 'peer-leave'); at(Math.min(model.n, split+1), 'peer-rejoin');
        }
        let active = false, peerActive = true;
        const messages = [];
        for (let h = 0; h <= model.n; h += 1) {
            for (const action of events.get(h) ?? []) {
                f.clock.advance(); const time = f.clock.iso();
                const user = action.startsWith('peer-') ? f.actors.peer : f.actors.target;
                if (action === 'leave' || action === 'peer-leave') {
                    f.groups.endMembership(id,user,time); f.groups.closeInterval(id,user,time);
                    if (action === 'leave') active = false; else peerActive = false;
                } else {
                    if (action === 'join') f.groups.addMember(id,user,time); else f.groups.reactivateMember(id,user,time);
                    f.groups.openIntervalAt(id,user,time);
                    if (action === 'peer-rejoin') peerActive = true; else active = true;
                }
            }
            if (h === model.n) break;
            const candidates = [f.actors.owner, ...(peerActive ? [f.actors.peer] : []), ...(active ? [f.actors.target] : [])];
            const sender = h === 0 ? (variant ? f.actors.owner : f.actors.peer)
                : candidates[(model.senders[h] + variant) % candidates.length];
            const base = variant ? '2001-01-01T00:00:00.000Z' : '2035-01-01T00:00:00.000Z';
            const createdAt = new Date(Date.parse(base) + model.timestamps[h] * (variant ? -1 : 1)).toISOString();
            messages.push(send(f,id,h+1,sender,createdAt));
        }
        for (const [index, tombstone] of model.tombstones.entries()) {
            if (tombstone) f.repositories.messages.tombstone(messages[index].message_id, '2040-01-01T00:00:00.000Z');
        }
        assert.equal(active, model.active);
        assert.deepEqual(bounds(f.groups.intervalsFor(id,f.actors.target)), model.intervals);
        const report = f.groups.invariantReport(id);
        assert.equal(report.activeOwners,1); assert.equal(report.openIntervals,report.activeMembers); assert.equal(report.mismatches,0);
        return { id, policy, messages, active, intervals:f.groups.intervalsFor(id,f.actors.target) };
    });
}

function traverse(f, data, model, expected) {
    const seen = []; let before = null;
    for (let page = 0; page <= model.n+1; page += 1) {
        const remaining = expected.filter(seq => before === null || seq < before);
        const rows = f.groups.historyPage(data.id,f.actors.target,{ policy:data.policy, limit:model.limit, highWater:model.n, before });
        assert.deepEqual(rows.map(row => row.message_seq),remaining.slice(0,model.limit+1), 'lookahead is also within permitted ranges');
        const items = rows.slice(0,model.limit);
        seen.push(...items.map(row => row.message_seq));
        if (rows.length <= model.limit) { assert.deepEqual(seen,expected); return seen; }
        assert.equal(items.length,model.limit);
        before = items.at(-1).message_seq;
    }
    return assert.fail('bounded history traversal must finish');
}

function checkReads(f, data, model) {
    const ranges = permittedRanges(model.intervals,data.policy);
    const expected = Array.from({ length:model.n }, (_, index) => model.n-index)
        .filter(seq => data.active && inRanges(seq,ranges));
    const seen = traverse(f,data,model,expected);
    for (let seq = 1; seq <= model.n; seq += 1) {
        const row = f.groups.getPermittedMessage(data.id,f.actors.target,data.policy,data.messages[seq-1].message_id);
        assert.equal(row?.message_seq ?? null,expected.includes(seq) ? seq : null, `single sequence ${seq}`);
        if (row) assert.equal(row.deleted_at !== null,model.tombstones[seq-1]);
    }
    const probes = [...new Set([0,1,model.n,model.n+1,...model.intervals.map(row => row.first_seq-1)])];
    for (const highWater of probes.filter(seq => seq >= 0 && seq <= model.n)) {
        assert.deepEqual(f.groups.historyPage(data.id,f.actors.target,{ policy:data.policy, limit:model.limit, highWater })
            .map(row => row.message_seq),expected.filter(seq => seq <= highWater).slice(0,model.limit+1));
    }
    for (const before of probes.filter(seq => seq > 0)) {
        assert.deepEqual(f.groups.historyPage(data.id,f.actors.target,{ policy:data.policy, limit:model.limit, highWater:model.n, before })
            .map(row => row.message_seq),expected.filter(seq => seq < before).slice(0,model.limit+1));
    }
    assert.deepEqual(f.groups.historyPage(data.id,f.actors.never,{ policy:data.policy, highWater:model.n }),[]);
    for (const seq of [1,model.n].filter(seq => seq > 0 && seq <= model.n)) {
        assert.equal(f.groups.getPermittedMessage(data.id,f.actors.never,data.policy,data.messages[seq-1].message_id),null);
    }
    assert.equal(f.groups.getPermittedMessage(data.id,f.actors.target,data.policy,'p11-unknown-message'),null);
    const override = data.policy === 'all' ? 'from_joined' : 'all';
    assert.deepEqual(f.groups.historyPage(data.id,f.actors.target,{ policy:override, highWater:model.n }),[]);
    const unread = position => expected.filter(seq => seq > position && !model.tombstones[seq-1]
        && data.messages[seq-1].sender_id !== f.actors.target).length;
    assert.equal(f.groups.unreadCount(data.id,f.actors.target,data.policy),unread(0));
    assert.equal(f.groups.getReadPosition(data.id,f.actors.target),0);
    return { seen, ranges, expected, unread, probes };
}

function checkReadState(f, data, model, result) {
    const write = n => f.db.transaction(() => f.groups.upsertReadPosition(data.id,f.actors.target,n,f.clock.iso())).immediate();
    if (!data.active) {
        assert.throws(() => write(0),code('CONFLICT'));
        assert.equal(f.groups.getReadPosition(data.id,f.actors.target),0);
        return;
    }
    const maximum = result.expected[0] ?? 0;
    assert.equal(write(maximum),maximum);
    const before = snapshot(f.db);
    f.clock.advance();
    assert.equal(write(0),maximum);
    assert.equal(write(maximum),maximum);
    for (const n of result.probes.filter(n => n > 0 && (n > model.n || !inRanges(n,result.ranges)))) {
        assert.throws(() => write(n),code('INVALID'));
    }
    assert.deepEqual(snapshot(f.db),before,'equal/lower valid and invalid reports preserve stored rows');
    assert.equal(f.groups.getReadPosition(data.id,f.actors.target),maximum);
    assert.equal(f.groups.unreadCount(data.id,f.actors.target,data.policy),result.unread(maximum));
    assert.equal(f.groups.listGroupsForUser(f.actors.target).find(row => row.conversation_id === data.id).unread_count,result.unread(maximum));
}

test('P-11: authorized range oracle agrees with repository history and read state in 100 seeded cases', async t => {
    const coverage = { counts:new Set(), streams:new Set(), limits:new Set(), active:0, removed:0, never:0, rejoined:0, empty:0, policies:0, replicas:0 };
    const summary = await forAll('P-11',{ seed:P11_SEED, runs:P11_RUNS, onRun:line => t.diagnostic(line) },generate,(model,info) => {
        const f = fixture(t);
        try {
            coverage.counts.add(model.intervals.length); coverage.streams.add(model.n); coverage.limits.add(model.limit);
            coverage[model.active ? 'active' : model.intervals.length ? 'removed' : 'never'] += 1;
            if (model.active && model.intervals.length > 1) coverage.rejoined += 1;
            if (model.intervals.some(row => row.last_seq === row.first_seq-1)) coverage.empty += 1;
            const datasets = POLICIES.flatMap(policy => [build(f,model,policy,0,info.run),build(f,model,policy,1,info.run)]);
            const before = snapshot(f.db), results = datasets.map(data => checkReads(f,data,model));
            assert.deepEqual(snapshot(f.db),before,'all history/read projections leave every table unchanged');
            for (let index = 0; index < datasets.length; index += 2) {
                const original = datasets[index], altered = datasets[index+1];
                assert.deepEqual(results[index].seen,results[index+1].seen,'metamorphic changes preserve visible sequences');
                assert.notDeepEqual(bounds(f.groups.intervalsFor(original.id,f.actors.peer)),bounds(f.groups.intervalsFor(altered.id,f.actors.peer)));
                if (model.n > 0) {
                    assert.notEqual(original.messages[0].sender_id,altered.messages[0].sender_id);
                    assert.notEqual(original.messages[0].created_at,altered.messages[0].created_at);
                }
                coverage.policies += 1; coverage.replicas += 2;
            }
            datasets.forEach((data,index) => checkReadState(f,data,model,results[index]));
            assert.deepEqual(changedTables(before,snapshot(f.db)),model.active ? ['GroupReadPositions'] : []);
            assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
        } finally { if (f.db.open) f.db.close(); }
    });
    if (summary.replay === null) {
        assert.equal(summary.runs,P11_RUNS);
        assert.deepEqual([...coverage.counts].sort(),[0,1,2,3,4,5]);
        for (const n of [0,1,200]) assert.ok(coverage.streams.has(n));
        for (const n of [1,50]) assert.ok(coverage.limits.has(n));
        for (const state of ['active','removed','never','rejoined','empty']) assert.ok(coverage[state] > 0,state);
        assert.equal(coverage.policies,200); assert.equal(coverage.replicas,400);
    }
    t.diagnostic(`P-11 seed=${summary.seed} runs=${summary.runs} policyCases=${coverage.policies} datasets=${coverage.replicas}; active=${coverage.active} removed=${coverage.removed} never=${coverage.never} rejoined=${coverage.rejoined} empty=${coverage.empty}`);
});

test('AF-14: a rejoin keeps the earlier interval and does not rewrite joined_at', t => {
    const f = fixture(t);
    for (const policy of POLICIES) {
        const id = `af14-${policy}`, target = f.actors.target;
        withMembershipTransaction(f.db,() => f.groups.insertGroup({ conversation_id:id, created_by:f.actors.owner, title:'Synthetic AF-14', historyPolicy:policy }));
        let sequence = 0;
        const next = () => { sequence += 1; return send(f,id,sequence,f.actors.owner,f.clock.iso()); };
        next(); next();
        withMembershipTransaction(f.db,() => { f.groups.addMember(id,target,f.clock.iso()); f.groups.openIntervalAt(id,target,f.clock.iso()); });
        const joinedAt = f.groups.getMember(id,target).joined_at;
        next(); next();
        f.db.transaction(() => f.groups.upsertReadPosition(id,target,3,f.clock.iso())).immediate();
        f.clock.advance();
        withMembershipTransaction(f.db,() => { f.groups.endMembership(id,target,f.clock.iso()); f.groups.closeInterval(id,target,f.clock.iso()); });
        const closed = f.groups.intervalsFor(id,target)[0];
        assert.deepEqual(bounds([closed]),[{ first_seq:3, last_seq:4 }]);
        next(); next();
        assert.deepEqual(f.groups.historyPage(id,target,{ policy, highWater:6 }),[]);
        assert.equal(f.groups.getPermittedMessage(id,target,policy,`${id}-message-3`),null);
        assert.equal(f.groups.getReadPosition(id,target),0);
        assert.throws(() => f.db.transaction(() => f.groups.upsertReadPosition(id,target,0,f.clock.iso())).immediate(),code('CONFLICT'));
        f.clock.advance();
        withMembershipTransaction(f.db,() => { f.groups.reactivateMember(id,target,f.clock.iso()); f.groups.openIntervalAt(id,target,f.clock.iso()); });
        next();
        const expected = policy === 'all' ? [7,4,3,2,1] : [7,4,3];
        assert.deepEqual(f.groups.historyPage(id,target,{ policy, highWater:7 }).map(row => row.message_seq),expected);
        for (let seq = 1; seq <= 7; seq += 1) {
            assert.equal(f.groups.getPermittedMessage(id,target,policy,`${id}-message-${seq}`)?.message_seq ?? null,expected.includes(seq) ? seq : null);
        }
        assert.equal(f.groups.getMember(id,target).joined_at,joinedAt);
        assert.equal(f.groups.getMember(id,target).role,'member');
        assert.deepEqual(f.groups.intervalsFor(id,target)[0],closed);
        assert.deepEqual(bounds(f.groups.intervalsFor(id,target)),[{ first_seq:3, last_seq:4 },{ first_seq:7, last_seq:null }]);
        assert.equal(f.groups.getReadPosition(id,target),3);
        assert.equal(f.groups.unreadCount(id,target,policy),2);
        const before = snapshot(f.db);
        assert.equal(f.db.transaction(() => f.groups.upsertReadPosition(id,target,0,f.clock.iso())).immediate(),3);
        assert.deepEqual(snapshot(f.db),before);
        assert.deepEqual(f.groups.historyPage(id,f.actors.never,{ policy, highWater:7 }),[]);
        assert.equal(f.groups.getPermittedMessage(id,f.actors.never,policy,`${id}-message-7`),null);
    }
});
