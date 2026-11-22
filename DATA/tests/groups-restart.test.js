// T-5B-30 / P-32, DB-5B repository scope. API startup and worker-kill variants
// belong to later phases. Every connection uses a guarded disposable fixture.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { groupFixture, createClock, guardPath, snapshot, changedTables, INVITATION_EXPIRY_MS } = require('./support/groups');
const { forAll } = require('./support/random');
const { openDatabase } = require('../server/database/connection');
const { createGroupRepository, withMembershipTransaction, RepositoryError } = require('../server/database/groupRepository');

const SEED = 5130;
const RUNS = 20;
const code = expected => error => error instanceof RepositoryError && error.code === expected;
const ledger = db => db.prepare('SELECT * FROM SchemaMigrations ORDER BY version').all();
const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();

function fixture(t, run = 0, policy = 'from_joined') {
    const f = groupFixture(t,{ clock:createClock('2030-01-01T00:00:00.000Z'), group:{ conversationId:`p32-primary-${run}`, historyPolicy:policy } });
    const candidate = f.repositories.users.create({ user_id:`p32-candidate-${run}`, username:`p32-candidate-${run}`, display_name:'Synthetic candidate' }).user_id;
    return { ...f, groups:createGroupRepository(f.db), candidate, ids:[f.groupId], invitations:[f.invitationId],
        users:[...Object.values(f.actors).map(actor => actor.id).filter(Boolean),candidate],
        keys:[{ user:f.actors.owner.id, key:'fixture-group-create', id:f.groupId }] };
}

function history(groups, id, user, policy, highWater) {
    const rows = []; let before = null;
    for (let page = 0; page <= highWater+1; page += 1) {
        const result = groups.historyPage(id,user,{ policy, highWater, before, limit:3 });
        rows.push(...result.slice(0,3));
        if (result.length <= 3) return rows;
        before = result[2].message_seq;
    }
    return assert.fail('bounded history traversal must finish');
}

// Includes retained rows and caller-visible projections: authorization outcomes
// and history are compared for active, former and never-member subjects alike.
function projection(db, f, nowIso) {
    const g = createGroupRepository(db);
    return {
        groups:f.ids.map(id => {
            const group = g.getVisibleGroup(id);
            if (!group) return { id, group:null };
            const highWater = g.repositories.messages.highWater(id);
            const messages = g.repositories.messages.history(id,{ limit:200, highWater, before:null });
            assert.equal(messages.length,highWater,'the projection includes every stored authenticated message');
            return { group, highWater, messages, memberships:g.repositories.members.list(id),
                active:g.listMembers(id,{ limit:50 }), former:g.listMembers(id,{ limit:50, former:true }),
                invariants:g.invariantReport(id), pending:g.listPendingForGroup(id,nowIso,{ limit:50 }),
                pendingCount:g.countPendingForGroup(id,nowIso),
                subjects:f.users.map(user => ({ user, member:g.getMember(id,user), intervals:g.intervalsFor(id,user),
                    open:g.openInterval(id,user), pending:g.findPending(id,user),
                    closedSince:g.closedIntervalSince(id,user,'2030-01-01T00:00:00.000Z'),
                    history:history(g,id,user,group.history_policy,highWater),
                    singles:messages.map(row => g.getPermittedMessage(id,user,group.history_policy,row.message_id)),
                    position:g.getReadPosition(id,user), unread:g.unreadCount(id,user,group.history_policy) })) };
        }),
        subjects:f.users.map(user => ({ user, groups:g.listGroupsForUser(user,{ limit:50 }),
            invitations:g.listPendingForInvitee(user,nowIso,{ limit:50 }), count:g.countPendingForInvitee(user,nowIso) })),
        invitations:f.invitations.map(id => g.getInvitation(id)),
        keys:f.keys.map(({ user,key }) => g.getCreationKey(user,key)),
    };
}

function reopen(f, expectedLedger) {
    const db = openDatabase({ filename:guardPath(f.filename) }); // real automatic migration path
    f.connections.push(db);
    // This connection has only just opened: zero changes plus an identical
    // ledger proves that automatic migration applied no migration or backfill.
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n,0);
    assert.deepEqual(ledger(db),expectedLedger);
    assert.equal(db.pragma('foreign_keys',{ simple:true }),1);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
    assert.equal(db.pragma('integrity_check',{ simple:true }),'ok');
    return db;
}

function send(f, id, sender) {
    const seq = f.repositories.messages.highWater(id)+1;
    return f.repositories.messages.insertAuthenticated({ message_id:`${id}-message-${seq}`, conversation_id:id,
        sender_id:sender, receiver_id:null, ciphertext:'synthetic opaque ciphertext', iv:'synthetic-iv', envelope_version:1,
        encoding:'base64', sender_name:'Synthetic sender', client_timestamp:f.clock.iso(), message_type:'text',
        fingerprint:'a'.repeat(64), client_id:`p32-client-${seq}`, message_seq:seq, created_at:f.clock.iso() });
}

function generate(random, info) {
    const prefix = ['create','message','join','message','role','read','invite','resolve','leave','message','join','message',
        'read','transfer','settings','key','tombstone','revision'];
    const pool = ['message','join','leave','role','transfer','read','invite','resolve','settings','key','tombstone','revision'];
    const types = [...prefix,...Array.from({ length:20 },() => random.pick(pool)),'archive'];
    return { policy:info.run % 2 ? 'all' : 'from_joined', operations:types.map((type,index) => ({ type,index,
        pick:random.int(0,100), count:random.int(1,3), outcome:random.pick(['declined','cancelled']), token:random.string('abc012',4,8) })) };
}

function execute(f, model, run) {
    const g = f.groups, id = f.groupId, outsider = f.actors.nonMember.id;
    const owner = () => g.repositories.members.list(id).find(row => row.role === 'owner' && row.left_at === null).user_id;
    const add = user => {
        const member = g.getMember(id,user);
        if (member?.left_at === null) return false;
        if (member) g.reactivateMember(id,user,f.clock.iso()); else g.addMember(id,user,f.clock.iso());
        g.openIntervalAt(id,user,f.clock.iso()); g.bumpRevision(id); return true;
    };
    const invite = suffix => {
        const previous = g.findPending(id,f.candidate);
        if (previous) g.resolveInvitation(previous.invitation_id,'cancelled',f.clock.iso());
        const invitation_id = `p32-invite-${run}-${suffix}`;
        g.insertInvitation({ invitation_id, conversation_id:id, invitee_id:f.candidate, inviter_id:owner(), created_at:f.clock.iso() });
        f.invitations.push(invitation_id);
        return invitation_id;
    };
    for (const op of model.operations) {
        f.clock.advance();
        withMembershipTransaction(f.db,() => {
            switch (op.type) {
            case 'create': {
                const secondary = `p32-secondary-${run}`;
                g.insertGroup({ conversation_id:secondary, created_by:f.actors.owner.id, title:'Synthetic secondary',
                    description:'Persisted description', historyPolicy:model.policy === 'all' ? 'from_joined' : 'all' });
                g.addMember(secondary,f.actors.member.id,f.clock.iso()); g.openIntervalAt(secondary,f.actors.member.id,f.clock.iso());
                send(f,secondary,f.actors.owner.id); g.touchConversation(secondary,f.clock.iso());
                g.upsertReadPosition(secondary,f.actors.owner.id,1,f.clock.iso());
                const invitation_id = `p32-secondary-invite-${run}`;
                g.insertInvitation({ invitation_id, conversation_id:secondary, invitee_id:f.candidate,
                    inviter_id:f.actors.owner.id, created_at:f.clock.iso() });
                f.invitations.push(invitation_id); f.ids.push(secondary);
                break;
            }
            case 'message': {
                const member = g.getMember(id,outsider);
                const sender = member?.left_at === null && op.pick % 2 ? outsider : owner();
                for (let i = 0; i < op.count; i += 1) send(f,id,sender);
                g.touchConversation(id,f.clock.iso()); break;
            }
            case 'join':
                if (!add(outsider)) assert.throws(() => g.reactivateMember(id,outsider,f.clock.iso()),code('CONFLICT'));
                break;
            case 'leave': {
                const member = g.getMember(id,outsider);
                if (!member || member.left_at !== null) assert.throws(() => g.endMembership(id,outsider,f.clock.iso()),code('CONFLICT'));
                else {
                    g.endMembership(id,outsider,f.clock.iso()); g.closeInterval(id,outsider,f.clock.iso());
                    g.cancelPendingFor(id,outsider,f.clock.iso()); g.bumpRevision(id);
                }
                break;
            }
            case 'role': {
                const member = [f.actors.member.id,f.actors.admin.id].map(user => g.getMember(id,user)).find(row => row.role !== 'owner');
                g.changeRole(id,member.user_id,member.role,member.role === 'admin' ? 'member' : 'admin'); g.bumpRevision(id); break;
            }
            case 'transfer': {
                const from = owner();
                const targets = [f.actors.member.id,f.actors.admin.id,f.actors.owner.id].filter(user => user !== from);
                g.transferOwnership(id,from,targets[op.pick % targets.length]); g.bumpRevision(id); break;
            }
            case 'read': {
                const user = g.getMember(id,outsider)?.left_at === null ? outsider : owner();
                const latest = g.historyPage(id,user,{ policy:model.policy, highWater:g.repositories.messages.highWater(id), limit:1 })[0];
                const previous = g.getReadPosition(id,user);
                assert.equal(g.upsertReadPosition(id,user,latest?.message_seq ?? 0,f.clock.iso()),Math.max(previous,latest?.message_seq ?? 0)); break;
            }
            case 'invite': invite(op.index); break;
            case 'resolve': {
                const pending = g.findPending(id,f.candidate);
                const invitation = pending?.invitation_id ?? invite(op.index);
                g.resolveInvitation(invitation,op.outcome,f.clock.iso()); break;
            }
            case 'settings': g.updateSettings(id,{ title:`Synthetic ${run}-${op.index}`, description:`Synthetic ${op.token}` },f.clock.iso()); break;
            case 'key': {
                const user = owner(), key = `p32-key-${op.index}`;
                g.claimCreationKey(user,key,'a'.repeat(64),id,f.clock.iso()); f.keys.push({ user,key,id }); break;
            }
            case 'tombstone': {
                const rows = g.repositories.messages.history(id,{ limit:200, highWater:g.repositories.messages.highWater(id), before:null })
                    .filter(row => row.deleted_at === null);
                const row = rows.length ? rows[op.pick % rows.length] : send(f,id,owner());
                g.repositories.messages.tombstone(row.message_id,f.clock.iso()); break;
            }
            case 'revision': g.bumpRevision(id); break;
            case 'archive': g.archiveGroup(f.ids[1],f.clock.iso()); break;
            default: assert.fail(`unhandled synthetic operation ${op.type}`);
            }
        });
        for (const groupId of f.ids) {
            const report = g.invariantReport(groupId);
            assert.equal(report.activeOwners,1); assert.equal(report.openIntervals,report.activeMembers); assert.equal(report.mismatches,0);
        }
    }
}

test('P-32: 20 seeded repository sequences retain every projection after close/open with zero migrations', async t => {
    const policies = new Set(), operations = new Set(); let executed = 0;
    const result = await forAll('P-32',{ seed:SEED, runs:RUNS, onRun:line => t.diagnostic(line) },generate,(model,info) => {
        const f = fixture(t,info.run,model.policy);
        try {
            execute(f,model,info.run);
            model.operations.forEach(op => operations.add(op.type)); policies.add(model.policy); executed += model.operations.length;
            const before = snapshot(f.db), beforeSchema = schema(f.db), beforeLedger = ledger(f.db);
            const beforeProjection = projection(f.db,f,f.clock.iso());
            f.db.close();
            const db = reopen(f,beforeLedger);
            assert.deepEqual(schema(db),beforeSchema);
            assert.deepEqual(snapshot(db),before);
            assert.deepEqual(projection(db,f,f.clock.iso()),beforeProjection);
            assert.equal(db.prepare('SELECT total_changes() AS n').get().n,0,'projections after reopen perform no write');
        } finally { for (const db of f.connections) if (db.open) db.close(); }
    });
    if (result.replay === null) {
        assert.equal(result.runs,RUNS); assert.equal(policies.size,2);
        assert.equal(executed,780); assert.equal(operations.size,14);
    }
    t.diagnostic(`P-32 seed=${result.seed} sequences=${result.runs} operations=${executed} categories=${operations.size}; all reopen changes=0, ledgers/schema/projections identical`);
});

test('P-32: closing an uncommitted immediate transaction restores message, invitation, settings and read state', t => {
    const f = fixture(t), g = f.groups, id = f.groupId;
    send(f,id,f.actors.owner.id);
    f.db.transaction(() => g.upsertReadPosition(id,f.actors.member.id,1,f.clock.iso())).immediate();
    f.keys.push({ user:f.actors.owner.id, key:'p32-uncommitted', id });
    const before = snapshot(f.db), beforeProjection = projection(f.db,f,f.clock.iso()), beforeLedger = ledger(f.db);
    f.db.prepare('BEGIN IMMEDIATE').run();
    g.updateSettings(id,{ title:'Uncommitted settings', description:'Synthetic uncommitted' },f.clock.iso());
    const pendingMessage = send(f,id,f.actors.member.id);
    g.upsertReadPosition(id,f.actors.member.id,2,f.clock.iso()); g.bumpRevision(id);
    g.resolveInvitation(f.invitationId,'declined',f.clock.iso());
    g.claimCreationKey(f.actors.owner.id,'p32-uncommitted','b'.repeat(64),id,f.clock.iso());
    assert.equal(f.db.inTransaction,true);
    assert.deepEqual(changedTables(before,snapshot(f.db)).sort(),['Conversations','GroupExtensions','ConversationInvitations','GroupReadPositions','GroupCreationKeys','Messages'].sort());
    f.db.close(); // intentionally no COMMIT, ROLLBACK or transaction callback return
    const db = reopen(f,beforeLedger), restored = createGroupRepository(db);
    assert.deepEqual(snapshot(db),before);
    assert.deepEqual(projection(db,f,f.clock.iso()),beforeProjection);
    assert.equal(restored.getPermittedMessage(id,f.actors.member.id,'from_joined',pendingMessage.message_id),null);
});

test('P-32: closing the approved membership transaction before validation cannot commit any partial operation', t => {
    const f = fixture(t), g = f.groups, newId = 'p32-abandoned-group';
    f.ids.push(newId);
    const before = snapshot(f.db), beforeProjection = projection(f.db,f,f.clock.iso()), beforeLedger = ledger(f.db);
    assert.throws(() => withMembershipTransaction(f.db,() => {
        g.insertGroup({ conversation_id:newId, created_by:f.actors.owner.id, title:'Synthetic abandoned group' });
        g.addMember(f.groupId,f.actors.nonMember.id,f.clock.iso()); g.openIntervalAt(f.groupId,f.actors.nonMember.id,f.clock.iso());
        g.bumpRevision(f.groupId); g.upsertReadPosition(f.groupId,f.actors.nonMember.id,0,f.clock.iso());
        assert.notDeepEqual(snapshot(f.db),before);
        f.db.close();
    }),code('DATABASE'));
    const db = reopen(f,beforeLedger);
    assert.deepEqual(snapshot(db),before);
    assert.deepEqual(projection(db,f,f.clock.iso()),beforeProjection);
    assert.equal(createGroupRepository(db).getVisibleGroup(newId),null);
});

test('P-32: invitations expiring at or during downtime are excluded without mutating retained data on reopen', t => {
    for (const elapsed of [0,1]) {
        const f = fixture(t,elapsed), g = f.groups, invitation = g.getInvitation(f.invitationId);
        const now = new Date(Date.parse(invitation.expires_at)+elapsed).toISOString();
        const before = snapshot(f.db), beforeLedger = ledger(f.db);
        assert.equal(g.countPendingForGroup(f.groupId,f.clock.iso()),1);
        const expected = projection(f.db,f,now);
        f.db.close(); f.clock.advance(INVITATION_EXPIRY_MS+elapsed);
        assert.equal(f.clock.iso(),now);
        const db = reopen(f,beforeLedger), restored = createGroupRepository(db);
        assert.deepEqual(snapshot(db),before);
        assert.deepEqual(projection(db,f,f.clock.iso()),expected);
        assert.equal(restored.countPendingForGroup(f.groupId,now),0);
        assert.equal(restored.countPendingForInvitee(f.actors.pendingInvitee.id,now),0);
        assert.deepEqual(restored.listPendingForGroup(f.groupId,now),[]);
        assert.deepEqual(restored.listPendingForInvitee(f.actors.pendingInvitee.id,now),[]);
        assert.deepEqual(restored.getInvitation(f.invitationId),invitation,'reads preserve the lazy pending row');
        db.transaction(() => assert.equal(restored.expirePast(f.groupId,f.actors.pendingInvitee.id,now),1)).immediate();
        assert.throws(() => db.transaction(() => restored.resolveInvitation(f.invitationId,'accepted',now)).immediate(),code('CONFLICT'));
        assert.equal(restored.getMember(f.groupId,f.actors.pendingInvitee.id),null);
    }
});
