'use strict';

// T-5B-23 Option A: executable SQL, exclusively on guarded synthetic fixtures.
// Run with both recursive-trigger settings; implicit REPLACE deletes must not
// be the mechanism that protects any invariant. No application DB is opened.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { groupFixture, snapshot } = require('./support/groups');
const { normaliseError } = require('../server/database/groupRepository');

function fixture(t, recursive) {
    const f = groupFixture(t);
    assert.equal(f.db.pragma('foreign_keys', { simple:true }), 1);
    f.db.pragma(`recursive_triggers = ${recursive}`);
    assert.equal(f.db.pragma('recursive_triggers', { simple:true }), recursive);
    return f;
}
function rejected(db, work) {
    const before = snapshot(db);
    let error;
    try { work(); } catch (caught) { error = caught; }
    assert.ok(error && /^SQLITE_CONSTRAINT/.test(error.code), 'a SQLite constraint must reject the attempt');
    assert.deepEqual(snapshot(db), before, 'the whole statement leaves all snapshot rows unchanged');
    assert.equal(normaliseError(error).code, 'CONFLICT', 'trigger integrity conflicts retain the existing repository mapping');
}
function insert(db, table, row, verb = 'INSERT') {
    const columns = Object.keys(row);
    return db.prepare(`${verb} INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
        .run(...Object.values(row));
}
const rowOf = (db, table, where, ...args) => db.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(...args);

for (const recursive of [0, 1]) {
    const prefix = `T-5B-23 hardening recursive=${recursive}: `;
    test(prefix + 'an open interval rejects every following closed or open interval, including an empty one', t => {
        const { db, groupId, actors, clock } = fixture(t, recursive);
        for (const [first, last] of [[1, 1], [2, 3], [6, 7], [2, 1], [6, null]]) {
            rejected(db, () => insert(db, 'GroupMembershipIntervals', {
                conversation_id:groupId, user_id:actors.member.id, interval_no:2, first_seq:first,
                last_seq:last, joined_at:clock.iso(1000), left_at:last === null ? null : clock.iso(2000),
            }));
        }
    });
    test(prefix + 'inclusive closed boundaries reject overlap and accept the next sequence', t => {
        const { db, groupId, actors, clock, repositories } = fixture(t, recursive);
        repositories.members.insert({ conversation_id:groupId, user_id:actors.nonMember.id, role:'member' });
        const first = { conversation_id:groupId, user_id:actors.nonMember.id, interval_no:1,
            first_seq:4, last_seq:5, joined_at:clock.iso(), left_at:clock.iso(1000) };
        insert(db, 'GroupMembershipIntervals', first);
        rejected(db, () => insert(db, 'GroupMembershipIntervals', { ...first, interval_no:2, first_seq:5, last_seq:6 }));
        insert(db, 'GroupMembershipIntervals', { ...first, interval_no:2, first_seq:6, last_seq:null, left_at:null });
        assert.deepEqual(db.prepare('SELECT first_seq,last_seq FROM GroupMembershipIntervals WHERE conversation_id=? AND user_id=? ORDER BY interval_no')
            .all(groupId, actors.nonMember.id), [{ first_seq:4, last_seq:5 }, { first_seq:6, last_seq:null }]);
    });
    test(prefix + 'ordinary removal, empty interval closure and repeated rejoin remain valid', t => {
        const { db, groupId, actors, clock, builder } = fixture(t, recursive);
        for (let number = 2; number <= 5; number++) {
            builder.removeMember(groupId, actors.member.id);
            clock.advance();
            db.transaction(() => {
                db.prepare('UPDATE ConversationMembers SET left_at=NULL WHERE conversation_id=? AND user_id=?').run(groupId, actors.member.id);
                insert(db, 'GroupMembershipIntervals', { conversation_id:groupId, user_id:actors.member.id,
                    interval_no:number, first_seq:1, last_seq:null, joined_at:clock.iso(), left_at:null });
            }).immediate();
        }
        const rows = db.prepare('SELECT interval_no,first_seq,last_seq FROM GroupMembershipIntervals WHERE conversation_id=? AND user_id=? ORDER BY interval_no')
            .all(groupId, actors.member.id);
        assert.deepEqual(rows.map(r => r.interval_no), [1, 2, 3, 4, 5]);
        assert.ok(rows.slice(0, -1).every(r => r.first_seq === 1 && r.last_seq === 0));
        assert.equal(rows.at(-1).last_seq, null);
        assert.equal(db.prepare('SELECT joined_at FROM ConversationMembers WHERE conversation_id=? AND user_id=?').get(groupId, actors.member.id).joined_at,
            rowOf(db, 'GroupMembershipIntervals', 'conversation_id=? AND user_id=? AND interval_no=1', groupId, actors.member.id).joined_at);
    });
    for (const verb of ['REPLACE', 'INSERT OR REPLACE']) {
        test(prefix + verb + ' cannot replace extension policy, creation identity or revision', t => {
            const { db, groupId } = fixture(t, recursive);
            const row = rowOf(db, 'GroupExtensions', 'conversation_id=?', groupId);
            for (const changed of [{ history_policy:'all' }, { membership_revision:row.membership_revision + 2 },
                { created_at:'2099-01-01T00:00:00.000Z' }, {}]) {
                rejected(db, () => insert(db, 'GroupExtensions', { ...row, ...changed }, verb));
            }
        });
        test(prefix + verb + ' cannot replace a pending Invitation or reopen a resolved one', t => {
            const { db, groupId, invitationId, clock } = fixture(t, recursive);
            const row = rowOf(db, 'ConversationInvitations', 'invitation_id=?', invitationId);
            rejected(db, () => insert(db, 'ConversationInvitations', { ...row, invitation_id:'replacement-invitation' }, verb));
            rejected(db, () => insert(db, 'ConversationInvitations', row, verb));
            db.prepare("UPDATE ConversationInvitations SET state='declined',resolved_at=? WHERE invitation_id=?").run(clock.iso(1000), invitationId);
            rejected(db, () => insert(db, 'ConversationInvitations', row, verb));
            assert.equal(row.conversation_id, groupId);
        });
        test(prefix + verb + ' cannot replace an open interval through its partial unique index', t => {
            const { db, groupId, actors } = fixture(t, recursive);
            const row = rowOf(db, 'GroupMembershipIntervals', 'conversation_id=? AND user_id=? AND interval_no=1', groupId, actors.member.id);
            rejected(db, () => insert(db, 'GroupMembershipIntervals', { ...row, interval_no:2, first_seq:6 }, verb));
            rejected(db, () => insert(db, 'GroupMembershipIntervals', row, verb));
        });
        test(prefix + verb + ' cannot replace an existing read position or idempotency key', t => {
            const { db, groupId, actors, builder } = fixture(t, recursive);
            builder.setReadPosition(groupId, actors.member.id, 7);
            const row = rowOf(db, 'GroupReadPositions', 'conversation_id=? AND user_id=?', groupId, actors.member.id);
            for (const position of [1, 7, 9]) rejected(db, () => insert(db, 'GroupReadPositions', { ...row, position }, verb));
            const key = rowOf(db, 'GroupCreationKeys', 'conversation_id=?', groupId);
            rejected(db, () => insert(db, 'GroupCreationKeys', { ...key, fingerprint:'b'.repeat(64) }, verb));
        });
    }
    test(prefix + 'UPDATE OR REPLACE cannot move read identities or overwrite another creation key', t => {
        const { db, groupId, actors, clock, builder } = fixture(t, recursive);
        builder.setReadPosition(groupId, actors.member.id, 3);
        builder.setReadPosition(groupId, actors.admin.id, 9);
        rejected(db, () => db.prepare('UPDATE OR REPLACE GroupReadPositions SET user_id=?,position=4 WHERE conversation_id=? AND user_id=?')
            .run(actors.admin.id, groupId, actors.member.id));
        rejected(db, () => db.prepare('UPDATE GroupReadPositions SET user_id=? WHERE conversation_id=? AND user_id=?')
            .run(actors.owner.id, groupId, actors.member.id));
        const key = rowOf(db, 'GroupCreationKeys', 'conversation_id=?', groupId);
        insert(db, 'GroupCreationKeys', { ...key, idempotency_key:'another-key', created_at:clock.iso(2000) });
        rejected(db, () => db.prepare('UPDATE OR REPLACE GroupCreationKeys SET idempotency_key=? WHERE user_id=? AND idempotency_key=?')
            .run('another-key', key.user_id, key.idempotency_key));
    });
    test(prefix + 'REPLACE cannot steal an active owner even before any interval references that owner', t => {
        const { db, actors, repositories } = fixture(t, recursive);
        const group = repositories.conversations.create({ conversation_id:'bare-group', kind:'group', title:'Bare group', created_by:actors.owner.id, origin:'authenticated' });
        rejected(db, () => db.prepare("INSERT OR REPLACE INTO ConversationMembers(conversation_id,user_id,role) VALUES(?,?,'owner')")
            .run(group.conversation_id, actors.nonMember.id));
        repositories.members.insert({ conversation_id:group.conversation_id, user_id:actors.admin.id, role:'admin' });
        rejected(db, () => db.prepare("UPDATE OR REPLACE ConversationMembers SET role='owner' WHERE conversation_id=? AND user_id=?")
            .run(group.conversation_id, actors.admin.id));
    });
    test(prefix + 'a later replacement conflict rolls back earlier rows of a multi-row statement', t => {
        const { db, groupId, actors, clock, builder } = fixture(t, recursive);
        builder.setReadPosition(groupId, actors.member.id, 7);
        rejected(db, () => db.prepare('INSERT OR REPLACE INTO GroupReadPositions(conversation_id,user_id,position,updated_at) VALUES(?,?,0,?),(?,?,1,?)')
            .run(groupId, actors.admin.id, clock.iso(), groupId, actors.member.id, clock.iso()));
    });
    test(prefix + 'explicit rowid collisions and rowid updates cannot bypass logical-key guards', t => {
        for (const table of ['GroupExtensions', 'GroupMembershipIntervals', 'ConversationInvitations', 'GroupReadPositions', 'GroupCreationKeys']) {
            const { db, groupId, actors, repositories, builder } = fixture(t, recursive);
            builder.setReadPosition(groupId, actors.member.id, 7);
            const other = repositories.conversations.create({ conversation_id:'rowid-other', kind:'group', title:'Other', created_by:actors.owner.id, origin:'authenticated' });
            const { internal_rowid:rowid, ...row } = db.prepare(`SELECT rowid AS internal_rowid,* FROM ${table} LIMIT 1`).get();
            let changed;
            if (table === 'GroupExtensions') changed = { ...row, conversation_id:other.conversation_id };
            if (table === 'GroupMembershipIntervals') {
                repositories.members.insert({ conversation_id:groupId, user_id:actors.nonMember.id, role:'member' });
                changed = { ...row, conversation_id:groupId, user_id:actors.nonMember.id, interval_no:1 };
            }
            if (table === 'ConversationInvitations') changed = { ...row, invitation_id:'rowid-invitation', invitee_id:actors.member.id };
            if (table === 'GroupReadPositions') changed = { ...row, user_id:actors.admin.id };
            if (table === 'GroupCreationKeys') changed = { ...row, idempotency_key:'rowid-key' };
            rejected(db, () => insert(db, table, { rowid, ...changed }, 'INSERT OR REPLACE'));
            rejected(db, () => db.prepare(`UPDATE OR REPLACE ${table} SET rowid=rowid+100000 WHERE rowid=?`).run(rowid));
        }
        const { db, actors, repositories } = fixture(t, recursive);
        const group = repositories.conversations.create({ conversation_id:'bare-rowid', kind:'group', title:'Bare', created_by:actors.owner.id, origin:'authenticated' });
        repositories.members.insert({ conversation_id:group.conversation_id, user_id:actors.admin.id, role:'admin' });
        const ownerRowid = db.prepare('SELECT rowid n FROM ConversationMembers WHERE conversation_id=? AND user_id=?').get(group.conversation_id, actors.owner.id).n;
        rejected(db, () => db.prepare("INSERT OR REPLACE INTO ConversationMembers(rowid,conversation_id,user_id,role) VALUES(?,?,?,'member')")
            .run(ownerRowid, group.conversation_id, actors.nonMember.id));
        rejected(db, () => db.prepare('UPDATE OR REPLACE ConversationMembers SET rowid=? WHERE conversation_id=? AND user_id=?')
            .run(ownerRowid, group.conversation_id, actors.admin.id));
    });
    test(prefix + 'valid UPSERT insert/update/do-nothing paths preserve identity and monotonicity', t => {
        const { db, groupId, actors, clock, builder, invitationId } = fixture(t, recursive);
        for (const position of [3, 1, 3, 5]) builder.setReadPosition(groupId, actors.member.id, position);
        assert.equal(rowOf(db, 'GroupReadPositions', 'conversation_id=? AND user_id=?', groupId, actors.member.id).position, 5);
        assert.equal(db.prepare('SELECT count(*) n FROM GroupReadPositions WHERE conversation_id=? AND user_id=?').get(groupId, actors.member.id).n, 1);
        rejected(db, () => db.prepare('INSERT INTO GroupReadPositions(conversation_id,user_id,position,updated_at) VALUES(?,?,1,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET position=excluded.position')
            .run(groupId, actors.member.id, clock.iso()));
        db.prepare("INSERT INTO GroupExtensions(conversation_id,description) VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET description=excluded.description")
            .run(groupId, 'updated through UPSERT');
        assert.equal(rowOf(db, 'GroupExtensions', 'conversation_id=?', groupId).description, 'updated through UPSERT');
        const key = rowOf(db, 'GroupCreationKeys', 'conversation_id=?', groupId), before = snapshot(db);
        db.prepare('INSERT INTO GroupCreationKeys(user_id,idempotency_key,fingerprint,conversation_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,idempotency_key) DO NOTHING')
            .run(key.user_id, key.idempotency_key, 'c'.repeat(64), groupId, clock.iso());
        assert.deepEqual(snapshot(db), before);
        const invitation = rowOf(db, 'ConversationInvitations', 'invitation_id=?', invitationId);
        db.prepare("INSERT INTO ConversationInvitations(invitation_id,conversation_id,invitee_id,inviter_id,created_at,expires_at) VALUES(?,?,?,?,?,?) ON CONFLICT(invitation_id) DO UPDATE SET state='accepted',resolved_at=?")
            .run(invitationId, groupId, invitation.invitee_id, invitation.inviter_id, invitation.created_at, invitation.expires_at, clock.iso(1000));
        assert.equal(rowOf(db, 'ConversationInvitations', 'invitation_id=?', invitationId).state, 'accepted');
        // Plain duplicate inserts still retain their native DUPLICATE classification.
        let duplicate;
        try { insert(db, 'GroupReadPositions', rowOf(db, 'GroupReadPositions', 'conversation_id=? AND user_id=?', groupId, actors.member.id)); } catch (error) { duplicate = error; }
        assert.ok(duplicate);
        assert.equal(normaliseError(duplicate).code, 'DUPLICATE');
    });
}
