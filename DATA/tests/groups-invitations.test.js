// T-5C-11 to T-5C-13: Invitation operations, including G16 acceptance and DC-09 committed refusals.
// Service level: createInvitation (G12), listInvitations (G13), cancelInvitation (G14), listOwnInvitations (G15) and
// declineInvitation (G17) are called directly with real sessions and real CSRF proofs from the loopback application of
// support/groups.js. The HTTP adapters and their tests belong to the router tasks. Temporary databases only.
// Two clocks: the fixture clock stays where it is, so the sessions of the fixture stay valid, and the service clock moves,
// so Invitations age without logging anybody out.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { httpGroupFixture, snapshot, changedTables, createClock, openLimiter, actorRequest, assertSecurityHeaders, INVITATION_EXPIRY_MS } = require('./support/groups');
const { Browser } = require('./support/contract');
const { envDefaults } = require('./support/auth');
const { createRepositories } = require('../server/database/repositories');
const { createGroupRepository, withMembershipTransaction } = require('../server/database/groupRepository');
const { AuthError } = require('../server/auth/errors');
const { INVITATION_EXPIRY_SECONDS, roleMatrix } = require('../server/groups/policy');
const codec = require('../server/groups/cursor');
const { createGroupService } = require('../server/groups/service');
const { forAll } = require('./support/random');

const SOURCE = '203.0.113.9';
const SENTINEL = 'SENTINEL-INVITATION-TEXT-5c11';
const HOUR_MS = 3600000;
const FEATURES = Object.freeze({ groupApi: true, groups: Object.freeze({ maxMembers: 50, maxPendingInvitationsPerGroup: 50, maxPendingInvitationsPerInvitee: 50 }) });
const withMaxima = (perGroup, perInvitee) => ({ groupApi: true, groups: { maxMembers: 50, maxPendingInvitationsPerGroup: perGroup, maxPendingInvitationsPerInvitee: perInvitee } });
const MANAGER_KEYS = ['createdAt', 'expiresAt', 'groupId', 'id', 'invitee', 'inviterId', 'state'];
const INVITEE_KEYS = ['avatar', 'displayName', 'id', 'username'];
const OWN_KEYS = ['createdAt', 'expiresAt', 'groupId', 'groupName', 'id', 'inviterDisplayName'];

const thrown = work => {
    try { work(); } catch (error) { return error; }
    return assert.fail('expected a throw');
};
function assertAuth(error, code, status) {
    assert.ok(error instanceof AuthError, `an AuthError, got ${error && error.name}: ${error && error.message}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    return error;
}
const refusal = (error, code, status, fields = []) => { assertAuth(error, code, status); assert.deepEqual(error.fields, fields); return error; };
const signature = error => JSON.stringify({ name: error.name, code: error.code, status: error.status, fields: error.fields, message: error.message });

function actorContext(f, actor) {
    const token = actor.browser.cookies.get(f.config.sessionCookie);
    const row = f.application.auth.resolveToken(token).row;
    return Object.freeze({ context: Object.freeze({ userId: row.user_id, sessionId: row.session_id }), proof: f.application.auth.csrfProof(token, null, actor.token) });
}

// The fixture group of support/groups.js: owner, admin, member, nonMember, pendingInvitee (one pending Invitation from the owner)
// and removedMember. svc is a service over the fixture database with its own clock; service(features, limiter) builds another.
async function world(t, { features = FEATURES, limiter = openLimiter() } = {}) {
    const f = await httpGroupFixture(t, { clock: createClock() });
    const clock = createClock();
    const service = (serviceFeatures, serviceLimiter = openLimiter()) => createGroupService({ db: f.db, auth: f.application.auth, limiter: serviceLimiter, now: clock.now, features: serviceFeatures });
    const who = {};
    for (const name of ['owner', 'admin', 'member', 'nonMember', 'pendingInvitee', 'removedMember']) who[name] = Object.freeze({ ...actorContext(f, f.actors[name]), id: f.actors[name].id });
    return { f, svc: service(features, limiter), service, clock, who, db: f.db, groupId: f.groupId, invitationId: f.invitationId, base: createRepositories(f.db) };
}
async function extraUser(w, name) {
    const browser = w.f.browser();
    assert.equal((await browser.register(name, { displayName: `Extra ${name}` })).status, 201);
    const login = await browser.login(name);
    assert.equal(login.status, 200);
    const actor = { id: login.body.user.id, browser, token: await browser.csrf() };
    return Object.freeze({ ...actorContext(w.f, actor), id: actor.id, name });
}
const invite = (w, actor, body, groupId = w.groupId, svc = w.svc) => svc.createInvitation(actor.context, actor.proof, groupId, body, SOURCE);
const rows = (db, sql, ...args) => db.prepare(sql).all(...args);
const invitationRow = (db, id) => db.prepare('SELECT * FROM ConversationInvitations WHERE invitation_id = ?').get(id);
const auditOf = (db, groupId) => rows(db, "SELECT * FROM AuditLogs WHERE source = 'groups' AND subject_id = ? ORDER BY rowid", groupId);
const inviteAudit = (db, groupId) => auditOf(db, groupId).filter(row => row.event_type.startsWith('group.invitation.'));
const memberState = (db, groupId) => ({ members: rows(db, 'SELECT * FROM ConversationMembers WHERE conversation_id = ? ORDER BY user_id', groupId),
    intervals: rows(db, 'SELECT * FROM GroupMembershipIntervals WHERE conversation_id = ? ORDER BY user_id, interval_no', groupId),
    revision: db.prepare('SELECT membership_revision FROM GroupExtensions WHERE conversation_id = ?').get(groupId).membership_revision });
// Inserts an Invitation row directly, in a state the service reaches only by its own rules.
function seed(db, { id, groupId, invitee, inviter, createdAt, expiresAt, state = 'pending', resolvedAt = null }) {
    db.prepare("INSERT INTO ConversationInvitations(invitation_id, conversation_id, invitee_id, inviter_id, state, created_at, expires_at, resolved_at) VALUES(?, ?, ?, ?, 'pending', ?, ?, NULL)")
        .run(id, groupId, invitee, inviter, createdAt, expiresAt);
    if (state !== 'pending') db.prepare('UPDATE ConversationInvitations SET state = ?, resolved_at = ? WHERE invitation_id = ?').run(state, resolvedAt ?? createdAt, id);
    return id;
}
// A limiter that counts like the real one: a bucket is refused once its limit is used up.
function countingLimiter() {
    const used = new Map();
    return { calls: [], consume(buckets, at) {
        this.calls.push({ buckets: buckets.map(bucket => ({ ...bucket })), at });
        for (const bucket of buckets) if ((used.get(bucket.key) ?? 0) + 1 > bucket.limit) return { allowed: false, retryAfterSeconds: Math.ceil(bucket.windowMs / 1000) };
        for (const bucket of buckets) used.set(bucket.key, (used.get(bucket.key) ?? 0) + 1);
        return { allowed: true };
    } };
}
const recordingLimiter = () => ({ calls: [], consume(buckets, at) { this.calls.push({ buckets: buckets.map(bucket => ({ ...bucket })), at }); return { allowed: true }; } });
const isoPlus = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

// ---------------------------------------------------------------------------------------------------------------
// T-5C-11: createInvitation (G12)
// ---------------------------------------------------------------------------------------------------------------
test('G12: an owner or admin creates a pending Invitation that expires 604,800 s after creation, with one audit row', async t => {
    const w = await world(t);
    assert.equal(INVITATION_EXPIRY_SECONDS, 604800);
    assert.equal(INVITATION_EXPIRY_MS, 604800000);
    for (const [actor, label] of [[w.who.owner, 'owner'], [w.who.admin, 'admin']]) {
        w.clock.advance(1234);
        const target = label === 'owner' ? w.who.nonMember : await extraUser(w, 'grp-extra-admin-target');
        const before = memberState(w.db, w.groupId);
        const result = invite(w, actor, { userId: target.id });
        assert.deepEqual(Object.keys(result), ['invitation']);
        const { invitation } = result;
        assert.deepEqual(Object.keys(invitation).sort(), MANAGER_KEYS, label);
        assert.deepEqual(Object.keys(invitation.invitee).sort(), INVITEE_KEYS);
        assert.deepEqual([invitation.groupId, invitation.inviterId, invitation.state, invitation.invitee.id], [w.groupId, actor.id, 'pending', target.id]);
        assert.equal(invitation.createdAt, w.clock.iso(), 'the creation time is the injected clock');
        assert.equal(invitation.expiresAt, isoPlus(w.clock.iso(), INVITATION_EXPIRY_SECONDS * 1000), 'expires_at is the creation time plus 604,800 s');
        assert.equal(Date.parse(invitation.expiresAt) - Date.parse(invitation.createdAt), 604800000);
        const stored = invitationRow(w.db, invitation.id);
        assert.deepEqual([stored.state, stored.invitee_id, stored.inviter_id, stored.created_at, stored.expires_at, stored.resolved_at],
            ['pending', target.id, actor.id, invitation.createdAt, invitation.expiresAt, null]);
        const audit = inviteAudit(w.db, w.groupId).at(-1);
        assert.deepEqual([audit.event_type, audit.actor_user_id, audit.source, audit.subject_id], ['group.invitation.created', actor.id, 'groups', w.groupId]);
        assert.deepEqual(JSON.parse(audit.metadata_json), { operation: 'invitation.created', outcome: 'confirmed', target_id: target.id });
        assert.deepEqual(memberState(w.db, w.groupId), before, 'no membership, interval or revision changes');
    }
    assert.equal(inviteAudit(w.db, w.groupId).length, 2);
});

test('G12: while an Invitation is pending the invitee is a non-member for every read and write of the group', async t => {
    const w = await world(t);
    invite(w, w.who.owner, { userId: w.who.nonMember.id });
    for (const invitee of [w.who.nonMember, w.who.pendingInvitee]) {
        assertAuth(thrown(() => w.svc.getGroup(invitee.context, w.groupId)), 'NOT_FOUND', 404);
        assertAuth(thrown(() => w.svc.listMembers(invitee.context, w.groupId, {})), 'NOT_FOUND', 404);
        assertAuth(thrown(() => w.svc.updateGroup(invitee.context, invitee.proof, w.groupId, { name: 'x' })), 'NOT_FOUND', 404);
        assertAuth(thrown(() => w.svc.listInvitations(invitee.context, w.groupId, {})), 'NOT_FOUND', 404);
        assertAuth(thrown(() => invite(w, invitee, { userId: w.who.removedMember.id })), 'NOT_FOUND', 404);
        assert.equal(w.svc.listGroups(invitee.context, {}).items.length, 0, 'the group is not listed');
    }
});

test('G12: an unset or invalid pending maximum answers 503 first, before the limiter, any lookup or any change', async t => {
    const w = await world(t);
    const before = snapshot(w.db);
    for (const features of [{ groupApi: true }, { groupApi: true, groups: {} }, { groupApi: true, groups: { maxPendingInvitationsPerGroup: 5 } },
        { groupApi: true, groups: { maxPendingInvitationsPerInvitee: 5 } }, withMaxima(0, 5), withMaxima(5, 0), withMaxima(-1, 5), withMaxima(1.5, 5), withMaxima('5', 5),
        withMaxima(5, null), withMaxima(Number.NaN, 5), withMaxima(5, Number.MAX_SAFE_INTEGER + 2), withMaxima(Infinity, 5)]) {
        const limiter = recordingLimiter();
        const svc = w.service(features, limiter);
        for (const [actor, body, group] of [[w.who.owner, { userId: w.who.nonMember.id }, w.groupId], [w.who.owner, {}, w.groupId], [w.who.nonMember, { userId: w.who.owner.id }, w.groupId],
            [w.who.member, undefined, w.groupId], [w.who.owner, { userId: w.who.nonMember.id }, 'no-such-group']]) {
            refusal(thrown(() => invite(w, actor, body, group, svc)), 'FEATURE_UNAVAILABLE', 503);
        }
        assert.deepEqual(limiter.calls, [], `no bucket is consumed: ${JSON.stringify(features)}`);
    }
    assert.deepEqual(changedTables(before, snapshot(w.db)), []);
    assert.ok(invite(w, w.who.owner, { userId: w.who.nonMember.id }, w.groupId, w.service(withMaxima(2, 1))).invitation, 'positive whole numbers work');
});

test('G12: the refusal order is 404, 403, 409 archived, 400 body, 404 target, 409 active, 409 pending or limit', async t => {
    const w = await world(t);
    const bad = { userId: 5, extra: 1 };
    const before = snapshot(w.db);
    for (const outsider of [w.who.nonMember, w.who.pendingInvitee, w.who.removedMember]) refusal(thrown(() => invite(w, outsider, bad)), 'NOT_FOUND', 404);
    refusal(thrown(() => invite(w, w.who.owner, { userId: w.who.nonMember.id }, 'no-such-group')), 'NOT_FOUND', 404);
    refusal(thrown(() => invite(w, w.who.owner, { userId: w.who.nonMember.id }, 'a b')), 'NOT_FOUND', 404);
    refusal(thrown(() => invite(w, w.who.member, bad)), 'FORBIDDEN', 403);
    refusal(thrown(() => invite(w, w.who.member, { userId: w.who.nonMember.id })), 'FORBIDDEN', 403);
    for (const [body, fields] of [[undefined, []], [{}, ['userId']], [[], []], ['x', []], [{ userId: 5 }, ['userId']], [{ userId: '' }, ['userId']], [{ userId: null }, ['userId']],
        [{ userId: w.who.nonMember.id, role: 'admin' }, ['role']], [{ userId: w.who.nonMember.id, groupId: 'x', inviterId: w.who.owner.id }, ['groupId', 'inviterId']], [bad, ['userId', 'extra']]]) {
        refusal(thrown(() => invite(w, w.who.owner, body)), 'VALIDATION_ERROR', 400, fields);
    }
    assert.deepEqual(changedTables(before, snapshot(w.db)), [], 'no refusal changed a table');
    w.db.prepare("UPDATE Conversations SET archived_at = '2026-01-01T00:00:00.000Z' WHERE conversation_id = ?").run(w.groupId);
    const archived = snapshot(w.db);
    for (const actor of [w.who.owner, w.who.admin]) {
        refusal(thrown(() => invite(w, actor, { userId: w.who.nonMember.id })), 'CONFLICT', 409);
        refusal(thrown(() => invite(w, actor, bad)), 'CONFLICT', 409);
    }
    refusal(thrown(() => invite(w, w.who.member, bad)), 'FORBIDDEN', 403);
    refusal(thrown(() => invite(w, w.who.nonMember, bad)), 'NOT_FOUND', 404);
    assert.deepEqual(changedTables(archived, snapshot(w.db)), []);
});

test('G12: an unknown, disabled, credential-less or blocked target answers one 404 that reveals no block, and a member target answers 409', async t => {
    const w = await world(t);
    const ghost = w.base.users.create({ user_id: 'grp-ghost-user', username: 'grp-ghost-user', display_name: 'Ghost' });
    const disabled = await extraUser(w, 'grp-extra-disabled');
    const blockedByOwner = await extraUser(w, 'grp-extra-blocked-by-owner');
    const blocksOwner = await extraUser(w, 'grp-extra-blocks-owner');
    w.db.prepare("UPDATE AccountCredentials SET status = 'disabled' WHERE user_id = ?").run(disabled.id);
    w.base.blocks.insert(w.who.owner.id, blockedByOwner.id);
    w.base.blocks.insert(blocksOwner.id, w.who.owner.id);
    const before = snapshot(w.db);
    const answers = [['unknown', 'no-such-user'], ['no credential', ghost.user_id], ['disabled', disabled.id], ['blocked by the inviter', blockedByOwner.id], ['blocks the inviter', blocksOwner.id]]
        .map(([label, userId]) => [label, refusal(thrown(() => invite(w, w.who.owner, { userId })), 'NOT_FOUND', 404)]);
    for (const [label, error] of answers) assert.equal(signature(error), signature(answers[0][1]), `${label} is the same answer as an unknown user`);
    assert.deepEqual(changedTables(before, snapshot(w.db)), []);
    for (const target of [w.who.member, w.who.admin, w.who.owner]) refusal(thrown(() => invite(w, w.who.owner, { userId: target.id })), 'CONFLICT', 409);
    assert.deepEqual(changedTables(before, snapshot(w.db)), []);
    assert.equal(invite(w, w.who.owner, { userId: w.who.removedMember.id }).invitation.state, 'pending', 'a removed member is invited like anyone else');
});

test('G12: a pending Invitation, a second identical call and a reached maximum answer 409 and create nothing', async t => {
    const w = await world(t, { features: withMaxima(2, 50) });
    const before = snapshot(w.db);
    refusal(thrown(() => invite(w, w.who.owner, { userId: w.who.pendingInvitee.id })), 'CONFLICT', 409);
    assert.deepEqual(changedTables(before, snapshot(w.db)), [], 'the existing pending Invitation blocks a second one');
    invite(w, w.who.owner, { userId: w.who.nonMember.id });
    refusal(thrown(() => invite(w, w.who.admin, { userId: w.who.nonMember.id })), 'CONFLICT', 409);
    assert.equal(rows(w.db, "SELECT * FROM ConversationInvitations WHERE conversation_id = ? AND invitee_id = ? AND state = 'pending'", w.groupId, w.who.nonMember.id).length, 1, 'exactly one pending row for the pair');
    const extra = await extraUser(w, 'grp-extra-limit');
    const full = snapshot(w.db);
    refusal(thrown(() => invite(w, w.who.owner, { userId: extra.id })), 'CONFLICT', 409);
    assert.deepEqual(changedTables(full, snapshot(w.db)), [], 'the group holds two pending Invitations, which is its maximum');
});

test('G12: the service refuses a second pending Invitation by its own check and does not rely on the unique index alone', async t => {
    const w = await world(t);
    w.db.exec('DROP INDEX uq_invitations_pending');
    const before = snapshot(w.db);
    refusal(thrown(() => invite(w, w.who.owner, { userId: w.who.pendingInvitee.id })), 'CONFLICT', 409);
    assert.deepEqual(changedTables(before, snapshot(w.db)), []);
    assert.equal(rows(w.db, "SELECT * FROM ConversationInvitations WHERE conversation_id = ? AND invitee_id = ? AND state = 'pending'", w.groupId, w.who.pendingInvitee.id).length, 1);
});

test('G12: the per-invitee maximum counts the Invitations of every group, and expired rows count for neither maximum', async t => {
    const w = await world(t, { features: withMaxima(50, 1) });
    const other = w.f.builder.createGroup({ ownerId: w.who.owner.id, title: 'Other group', idempotencyKey: null });
    seed(w.db, { id: 'seed-other-1', groupId: other, invitee: w.who.nonMember.id, inviter: w.who.owner.id, createdAt: w.clock.iso(), expiresAt: isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS) });
    const before = snapshot(w.db);
    refusal(thrown(() => invite(w, w.who.owner, { userId: w.who.nonMember.id })), 'CONFLICT', 409);
    assert.deepEqual(changedTables(before, snapshot(w.db)), []);
    w.clock.advance(INVITATION_EXPIRY_MS + 1000);
    assert.equal(invite(w, w.who.owner, { userId: w.who.nonMember.id }).invitation.state, 'pending', 'the other group row is expired by its time and no longer counts');
    assert.equal(invitationRow(w.db, 'seed-other-1').state, 'pending', 'only the pair of this group is expired lazily');
});

test('G12: a past-expiry pending row of the pair is expired first, with an audit row, and a new Invitation may follow at once', async t => {
    const w = await world(t);
    w.clock.advance(INVITATION_EXPIRY_MS);
    const result = invite(w, w.who.owner, { userId: w.who.pendingInvitee.id });
    assert.equal(result.invitation.state, 'pending');
    const old = invitationRow(w.db, w.invitationId);
    assert.deepEqual([old.state, old.resolved_at], ['expired', w.clock.iso()], 'expired at exactly expires_at');
    assert.notEqual(result.invitation.id, w.invitationId);
    assert.deepEqual(inviteAudit(w.db, w.groupId).map(row => row.event_type), ['group.invitation.expired', 'group.invitation.created']);
    assert.equal(JSON.parse(inviteAudit(w.db, w.groupId)[0].metadata_json).target_id, w.who.pendingInvitee.id);
    const early = await world(t);
    early.clock.advance(INVITATION_EXPIRY_MS - 1000);
    refusal(thrown(() => invite(early, early.who.owner, { userId: early.who.pendingInvitee.id })), 'CONFLICT', 409);
});

test('G12: a refusal after the lazy expiry rolls the expiry back, and the row is still treated as expired by its time', async t => {
    const w = await world(t, { features: withMaxima(50, 1) });
    const other = w.f.builder.createGroup({ ownerId: w.who.owner.id, title: 'Holder', idempotencyKey: null });
    w.clock.advance(INVITATION_EXPIRY_MS + 1000);
    seed(w.db, { id: 'seed-holder-1', groupId: other, invitee: w.who.pendingInvitee.id, inviter: w.who.owner.id, createdAt: w.clock.iso(), expiresAt: isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS) });
    const before = snapshot(w.db);
    refusal(thrown(() => invite(w, w.who.owner, { userId: w.who.pendingInvitee.id })), 'CONFLICT', 409);
    assert.deepEqual(changedTables(before, snapshot(w.db)), [], 'the expiry and its audit row were rolled back with the refusal');
    assert.equal(invitationRow(w.db, w.invitationId).state, 'pending');
    assert.ok(w.svc.listOwnInvitations(w.who.pendingInvitee.context, {}).items.every(item => item.id !== w.invitationId), 'but it is not listed: it is expired by its time');
});

test('G12: a decline sets no delay, so a new Invitation follows at once and expires 604,800 s after its own creation', async t => {
    const w = await world(t);
    w.svc.declineInvitation(w.who.pendingInvitee.context, w.who.pendingInvitee.proof, w.invitationId);
    const again = invite(w, w.who.owner, { userId: w.who.pendingInvitee.id });
    assert.deepEqual([again.invitation.state, again.invitation.expiresAt], ['pending', isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS)]);
    assert.equal(invitationRow(w.db, w.invitationId).state, 'declined', 'the declined row stays declined');
});

test('G12: the three buckets are consumed first with the documented limits, and the target bucket holds a digest and no identifier', async t => {
    const limiter = recordingLimiter();
    const w = await world(t, { limiter });
    const extra = await extraUser(w, 'grp-extra-buckets');
    limiter.calls.length = 0;
    invite(w, w.who.owner, { userId: w.who.nonMember.id });
    assert.equal(limiter.calls.length, 1, 'one limiter call');
    const buckets = limiter.calls[0].buckets;
    assert.deepEqual(buckets.map(bucket => [bucket.limit, bucket.windowMs]), [[20, HOUR_MS], [5, HOUR_MS], [60, HOUR_MS]]);
    assert.equal(buckets[0].key, `groups:invite:${w.who.owner.id}`);
    assert.match(buckets[1].key, /^groups:invite-target:[0-9a-f]{64}$/);
    assert.equal(buckets[2].key, `groups:invite-source:${SOURCE}`);
    for (const id of [w.who.owner.id, w.groupId, w.who.nonMember.id, SOURCE]) assert.ok(!buckets[1].key.includes(id), 'no identifier in the target key');
    refusal(thrown(() => invite(w, w.who.owner, { userId: w.who.nonMember.id })), 'CONFLICT', 409);
    assert.equal(limiter.calls[1].buckets[1].key, buckets[1].key, 'the same user, group and invitee give the same target bucket, even when the request is refused');
    invite(w, w.who.admin, { userId: extra.id });
    assert.notEqual(limiter.calls[2].buckets[1].key, buckets[1].key, 'another actor and invitee give another target bucket');
    assert.equal(limiter.calls[2].buckets[0].key, `groups:invite:${w.who.admin.id}`);
    for (const body of [undefined, {}, { userId: 5 }, { userId: '' }, [], 'x']) {
        limiter.calls.length = 0;
        thrown(() => invite(w, w.who.owner, body));
        assert.deepEqual(limiter.calls[0].buckets.map(bucket => bucket.key), [`groups:invite:${w.who.owner.id}`, `groups:invite-source:${SOURCE}`], JSON.stringify(body));
    }
});

test('G12: 5 requests per user, group and invitee and 20 per user per hour answer 429 with a retry delay and change nothing', async t => {
    const w = await world(t, { limiter: countingLimiter() });
    const target = w.who.pendingInvitee.id;
    for (let index = 0; index < 5; index++) refusal(thrown(() => invite(w, w.who.owner, { userId: target })), 'CONFLICT', 409);
    const before = snapshot(w.db);
    const limited = thrown(() => invite(w, w.who.owner, { userId: target }));
    assertAuth(limited, 'RATE_LIMITED', 429);
    assert.equal(limited.retryAfterSeconds, HOUR_MS / 1000);
    assert.deepEqual(changedTables(before, snapshot(w.db)), []);
    assert.equal(invite(w, w.who.owner, { userId: w.who.nonMember.id }).invitation.state, 'pending', 'another invitee has a bucket of its own');
    for (let index = 0; index < 14; index++) refusal(thrown(() => invite(w, w.who.owner, { userId: `unknown-user-${index}` })), 'NOT_FOUND', 404);
    assertAuth(thrown(() => invite(w, w.who.owner, { userId: 'unknown-user-last' })), 'RATE_LIMITED', 429);
    assertAuth(thrown(() => invite(w, w.who.owner, { userId: w.who.removedMember.id })), 'RATE_LIMITED', 429);
    assert.equal(invite(w, w.who.admin, { userId: w.who.removedMember.id }).invitation.state, 'pending', 'the bucket belongs to the user');
});

test('G12: the per-source bucket is shared by every user of one source, and a request from another source is not limited', async t => {
    const w = await world(t, { limiter: countingLimiter() });
    const actors = [w.who.owner, w.who.admin, w.who.member, w.who.nonMember, w.who.pendingInvitee, w.who.removedMember];
    let sent = 0;
    for (let round = 0; round < 10; round++) {
        for (const actor of actors) {
            const error = thrown(() => invite(w, actor, { userId: `source-test-${sent}` }));
            assert.ok(error instanceof AuthError && error.status !== 429, `request ${sent}`);
            sent += 1;
        }
    }
    assert.equal(sent, 60);
    assertAuth(thrown(() => invite(w, w.who.owner, { userId: 'source-test-next' })), 'RATE_LIMITED', 429);
    const elsewhere = w.svc.createInvitation(w.who.owner.context, w.who.owner.proof, w.groupId, { userId: w.who.nonMember.id }, '198.51.100.7');
    assert.equal(elsewhere.invitation.state, 'pending');
});

test('G12: a failed audit write rolls back the Invitation and the lazy expiry that came before it', async t => {
    const w = await world(t);
    w.clock.advance(INVITATION_EXPIRY_MS + 1000);
    const before = snapshot(w.db);
    w.db.exec("CREATE TRIGGER test_refuse_created_audit BEFORE INSERT ON AuditLogs WHEN NEW.event_type = 'group.invitation.created' BEGIN SELECT RAISE(ABORT, 'refused by the test'); END");
    try {
        const error = assertAuth(thrown(() => invite(w, w.who.owner, { userId: w.who.pendingInvitee.id })), 'INTERNAL_ERROR', 500);
        assert.deepEqual(error.fields, []);
        assert.ok(!JSON.stringify(error).includes('refused by the test') && !error.stack.includes('refused by the test'));
    } finally { w.db.exec('DROP TRIGGER test_refuse_created_audit'); }
    assert.deepEqual(changedTables(before, snapshot(w.db)), [], 'the new row, the expiry and the expiry audit row were all rolled back');
    assert.equal(invitationRow(w.db, w.invitationId).state, 'pending');
});

test('G12: the actor is the session user, a CSRF proof of the same session is required, and no request value is carried by an error', async t => {
    const w = await world(t);
    const before = snapshot(w.db);
    const forged = { context: { userId: w.who.owner.id, sessionId: w.who.member.context.sessionId }, proof: w.who.owner.proof };
    assertAuth(thrown(() => invite(w, forged, { userId: w.who.nonMember.id })), 'UNAUTHENTICATED', 401);
    assertAuth(thrown(() => w.svc.createInvitation(w.who.owner.context, undefined, w.groupId, { userId: w.who.nonMember.id }, SOURCE)), 'CSRF_INVALID', 403);
    assertAuth(thrown(() => w.svc.createInvitation(w.who.owner.context, w.who.member.proof, w.groupId, { userId: w.who.nonMember.id }, SOURCE)), 'CSRF_INVALID', 403);
    assert.ok(thrown(() => w.svc.createInvitation(w.who.owner.context, w.who.owner.proof, w.groupId, { userId: w.who.nonMember.id }, undefined)) instanceof TypeError, 'the route must pass the source');
    refusal(thrown(() => invite(w, w.who.member, { userId: w.who.nonMember.id, inviterId: w.who.owner.id })), 'FORBIDDEN', 403);
    refusal(thrown(() => invite(w, w.who.owner, { userId: w.who.nonMember.id, inviterId: w.who.admin.id })), 'VALIDATION_ERROR', 400, ['inviterId']);
    assert.deepEqual(changedTables(before, snapshot(w.db)), []);
    const hostile = `x${SENTINEL}`;
    for (const error of [thrown(() => invite(w, w.who.owner, { userId: hostile })), thrown(() => invite(w, w.who.nonMember, { userId: hostile }, hostile))]) {
        assert.ok(error.cause === undefined && error.message === error.code && !error.stack.includes(SENTINEL) && !JSON.stringify(error.fields).includes(SENTINEL));
    }
    const named = thrown(() => invite(w, w.who.owner, { userId: w.who.nonMember.id, [hostile]: 1 }));
    assert.ok(!JSON.stringify(named.fields).includes(SENTINEL), 'a hostile key is never reflected (the validator names well-formed keys only)');
});

test('G12: the roles that may invite or cancel are the roles of the policy matrix', () => {
    assert.deepEqual(['owner', 'admin', 'member'].filter(role => roleMatrix(role, 'invite').allowed), ['owner', 'admin']);
    assert.deepEqual(['owner', 'admin', 'member'].filter(role => roleMatrix(role, 'cancelInvitation').allowed), ['owner', 'admin']);
    assert.equal(roleMatrix('owner', 'invite', { archived: true }).refusal, 'archived');
    assert.equal(roleMatrix('member', 'invite', { archived: true }).refusal, 'role');
});

// ---------------------------------------------------------------------------------------------------------------
// T-5C-11: listInvitations (G13)
// ---------------------------------------------------------------------------------------------------------------
test('G13: owner and admin list the pending, unexpired Invitations of the group with the manager projection, newest first', async t => {
    const w = await world(t);
    const first = await extraUser(w, 'grp-extra-list-1');
    const second = await extraUser(w, 'grp-extra-list-2');
    w.clock.advance(1000);
    const a = invite(w, w.who.owner, { userId: first.id }).invitation;
    w.clock.advance(1000);
    const b = invite(w, w.who.admin, { userId: second.id }).invitation;
    for (const actor of [w.who.owner, w.who.admin]) {
        const page = w.svc.listInvitations(actor.context, w.groupId, {});
        assert.deepEqual(Object.keys(page), ['items', 'nextCursor']);
        assert.equal(page.nextCursor, null);
        assert.deepEqual(page.items.map(item => item.id), [b.id, a.id, w.invitationId], 'created time descending');
        for (const item of page.items) {
            assert.deepEqual(Object.keys(item).sort(), MANAGER_KEYS);
            assert.deepEqual(Object.keys(item.invitee).sort(), INVITEE_KEYS);
            assert.equal(item.state, 'pending');
            assert.equal(item.groupId, w.groupId);
        }
        assert.deepEqual(page.items[0], b);
        assert.deepEqual([page.items[2].inviterId, page.items[2].invitee.id], [w.who.owner.id, w.who.pendingInvitee.id]);
        assert.ok(!JSON.stringify(page).match(/email|password|session|csrf|device|credential|hash/i), 'no private data');
    }
    // Resolved and expired Invitations are not listed.
    w.svc.cancelInvitation(w.who.owner.context, w.who.owner.proof, w.groupId, a.id);
    w.svc.declineInvitation(second.context, second.proof, b.id);
    assert.deepEqual(w.svc.listInvitations(w.who.owner.context, w.groupId, {}).items.map(item => item.id), [w.invitationId]);
    w.clock.advance(INVITATION_EXPIRY_MS);
    assert.deepEqual(w.svc.listInvitations(w.who.owner.context, w.groupId, {}).items, [], 'expired by time, although the row is still pending');
});

test('G13: a member gets 403 and no data, any other user gets the 404, and both come before the query checks', async t => {
    const w = await world(t);
    const before = snapshot(w.db);
    refusal(thrown(() => w.svc.listInvitations(w.who.member.context, w.groupId, {})), 'FORBIDDEN', 403);
    refusal(thrown(() => w.svc.listInvitations(w.who.member.context, w.groupId, { limit: '0', foo: '1' })), 'FORBIDDEN', 403);
    const notFound = [w.who.nonMember, w.who.pendingInvitee, w.who.removedMember].map(actor => refusal(thrown(() => w.svc.listInvitations(actor.context, w.groupId, { limit: '0' })), 'NOT_FOUND', 404));
    for (const error of notFound) assert.equal(signature(error), signature(notFound[0]));
    refusal(thrown(() => w.svc.listInvitations(w.who.owner.context, 'no-such-group', {})), 'NOT_FOUND', 404);
    assert.deepEqual(changedTables(before, snapshot(w.db)), [], 'a read changes no table');
});

test('G13: pages by limit and an opaque cursor bound to the user, the group and the route, and refuses a bad query by name', async t => {
    const w = await world(t);
    const made = [];
    for (let index = 0; index < 4; index++) {
        const user = await extraUser(w, `grp-extra-page-${index}`);
        w.clock.advance(1000);
        made.push(invite(w, w.who.owner, { userId: user.id }).invitation.id);
    }
    const everything = w.svc.listInvitations(w.who.owner.context, w.groupId, {}).items.map(item => item.id);
    assert.equal(everything.length, 5);
    for (const limit of ['1', '2', '5', '50']) {
        const seen = [];
        let cursor = null;
        let pages = 0;
        do {
            const page = w.svc.listInvitations(w.who.owner.context, w.groupId, { limit, ...(cursor === null ? {} : { cursor }) });
            seen.push(...page.items.map(item => item.id));
            cursor = page.nextCursor;
            pages += 1;
            assert.ok(pages < 8);
        } while (cursor !== null);
        assert.deepEqual(seen, everything, `limit ${limit}`);
        assert.equal(pages, Math.ceil(everything.length / Number(limit)));
    }
    for (const query of [{ limit: '0' }, { limit: '51' }, { limit: 'x' }, { limit: '1.5' }, { limit: ['1', '2'] }, { limit: '' }]) refusal(thrown(() => w.svc.listInvitations(w.who.owner.context, w.groupId, query)), 'VALIDATION_ERROR', 400, ['limit']);
    refusal(thrown(() => w.svc.listInvitations(w.who.owner.context, w.groupId, { foo: '1', userId: 'x' })), 'VALIDATION_ERROR', 400, ['foo', 'userId']);
    for (const cursor of ['zzz', '', 'a'.repeat(2049), '!!!!']) refusal(thrown(() => w.svc.listInvitations(w.who.owner.context, w.groupId, { cursor })), 'VALIDATION_ERROR', 400, ['cursor']);
    const token = w.svc.listInvitations(w.who.owner.context, w.groupId, { limit: '1' }).nextCursor;
    refusal(thrown(() => w.svc.listInvitations(w.who.admin.context, w.groupId, { cursor: token })), 'VALIDATION_ERROR', 400, ['cursor']);
    const otherGroup = w.f.builder.createGroup({ ownerId: w.who.owner.id, title: 'Other', idempotencyKey: null });
    refusal(thrown(() => w.svc.listInvitations(w.who.owner.context, otherGroup, { cursor: token })), 'VALIDATION_ERROR', 400, ['cursor']);
    const ownRoute = w.svc.listOwnInvitations(w.who.pendingInvitee.context, { limit: '1' });
    assert.equal(ownRoute.nextCursor, null);
    const crafted = [['x'], ['not-a-time', 'id'], ['2026-01-01T00:00:00.000Z']].map(last => codec.encode({ last }, { route: 'group-invitations', userId: w.who.owner.id, conversationId: w.groupId }));
    for (const cursor of crafted) refusal(thrown(() => w.svc.listInvitations(w.who.owner.context, w.groupId, { cursor })), 'VALIDATION_ERROR', 400, ['cursor']);
    const wide = codec.encode({ last: ['2999-01-01T00:00:00.000Z', 'zzzz'] }, { route: 'group-invitations', userId: w.who.owner.id, conversationId: w.groupId });
    assert.deepEqual(w.svc.listInvitations(w.who.owner.context, w.groupId, { cursor: wide }).items.map(item => item.id), everything, 'a crafted position moves inside the visible Invitations only');
    // Another group's Invitations never appear.
    const seeded = seed(w.db, { id: 'seed-foreign-1', groupId: otherGroup, invitee: w.who.nonMember.id, inviter: w.who.owner.id, createdAt: w.clock.iso(), expiresAt: isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS) });
    assert.ok(!w.svc.listInvitations(w.who.owner.context, w.groupId, {}).items.some(item => item.id === seeded));
    assert.deepEqual(w.svc.listInvitations(w.who.owner.context, otherGroup, {}).items.map(item => item.id), [seeded]);
});

// ---------------------------------------------------------------------------------------------------------------
// T-5C-12: cancelInvitation (G14)
// ---------------------------------------------------------------------------------------------------------------
const cancel = (w, actor, groupId, invitationId) => w.svc.cancelInvitation(actor.context, actor.proof, groupId, invitationId);
const decline = (w, actor, invitationId) => w.svc.declineInvitation(actor.context, actor.proof, invitationId);

test('G14: the owner, an admin and the inviter cancel a pending Invitation, with one audit row and no membership change', async t => {
    const w = await world(t);
    const targets = [await extraUser(w, 'grp-extra-cancel-1'), await extraUser(w, 'grp-extra-cancel-2')];
    const byOwner = invite(w, w.who.owner, { userId: w.who.nonMember.id }).invitation;
    const byAdmin = invite(w, w.who.admin, { userId: targets[0].id }).invitation;
    // A plain member who is the inviter of a row (as after a demotion) may cancel it.
    const byMember = seed(w.db, { id: 'seed-by-member-1', groupId: w.groupId, invitee: targets[1].id, inviter: w.who.member.id, createdAt: w.clock.iso(), expiresAt: isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS) });
    const before = memberState(w.db, w.groupId);
    w.clock.advance(5000);
    const cases = [[w.who.owner, w.invitationId], [w.who.admin, byOwner.id], [w.who.owner, byAdmin.id], [w.who.member, byMember]];
    for (const [actor, id] of cases) {
        const result = cancel(w, actor, w.groupId, id);
        assert.deepEqual(result, { id, state: 'cancelled' });
        const row = invitationRow(w.db, id);
        assert.deepEqual([row.state, row.resolved_at], ['cancelled', w.clock.iso()]);
        const audit = inviteAudit(w.db, w.groupId).at(-1);
        assert.deepEqual([audit.event_type, audit.actor_user_id, audit.source, audit.subject_id], ['group.invitation.cancelled', actor.id, 'groups', w.groupId]);
        assert.deepEqual(Object.keys(JSON.parse(audit.metadata_json)).sort(), ['operation', 'outcome', 'target_id']);
    }
    assert.deepEqual(memberState(w.db, w.groupId), before, 'cancelling changes no membership');
    assert.equal(rows(w.db, "SELECT count(*) AS n FROM ConversationInvitations WHERE state = 'pending'")[0].n, 0);
});

test('G14: a member who is not the inviter gets 403 whether or not the Invitation exists, and any other user gets the 404', async t => {
    const w = await world(t);
    const other = w.f.builder.createGroup({ ownerId: w.who.owner.id, title: 'Other', idempotencyKey: null });
    const foreign = seed(w.db, { id: 'seed-foreign-2', groupId: other, invitee: w.who.nonMember.id, inviter: w.who.owner.id, createdAt: w.clock.iso(), expiresAt: isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS) });
    const before = snapshot(w.db);
    const existing = refusal(thrown(() => cancel(w, w.who.member, w.groupId, w.invitationId)), 'FORBIDDEN', 403);
    const unknown = refusal(thrown(() => cancel(w, w.who.member, w.groupId, 'no-such-invitation')), 'FORBIDDEN', 403);
    const malformed = refusal(thrown(() => cancel(w, w.who.member, w.groupId, 'a b')), 'FORBIDDEN', 403);
    assert.equal(signature(existing), signature(unknown));
    assert.equal(signature(existing), signature(malformed));
    refusal(thrown(() => cancel(w, w.who.member, w.groupId, foreign)), 'FORBIDDEN', 403);
    const snapshots = [w.who.nonMember, w.who.pendingInvitee, w.who.removedMember].map(actor => refusal(thrown(() => cancel(w, actor, w.groupId, w.invitationId)), 'NOT_FOUND', 404));
    for (const error of snapshots) assert.equal(signature(error), signature(snapshots[0]));
    // The invitee cannot cancel the Invitation that names them: they are no Active_Member.
    assert.equal(signature(refusal(thrown(() => cancel(w, w.who.pendingInvitee, w.groupId, w.invitationId)), 'NOT_FOUND', 404)), signature(snapshots[0]));
    refusal(thrown(() => cancel(w, w.who.owner, 'no-such-group', w.invitationId)), 'NOT_FOUND', 404);
    // An owner or admin gets the 404 for an unknown Invitation, a malformed id and an Invitation of another group.
    for (const actor of [w.who.owner, w.who.admin]) {
        for (const id of ['no-such-invitation', 'a b', 'x'.repeat(2000), foreign]) refusal(thrown(() => cancel(w, actor, w.groupId, id)), 'NOT_FOUND', 404);
    }
    assert.deepEqual(changedTables(before, snapshot(w.db)), [], 'no refusal changed a table');
    assert.equal(invitationRow(w.db, w.invitationId).state, 'pending');
    assert.equal(invitationRow(w.db, foreign).state, 'pending', 'the Invitation of another group is untouched');
});

test('G14: an Invitation that is no longer pending, or whose expiry time has passed, answers 409 and never changes again', async t => {
    const w = await world(t);
    const states = ['accepted', 'declined', 'cancelled', 'expired'].map((state, index) => seed(w.db, { id: `seed-state-${state}`, groupId: w.groupId, invitee: w.who.nonMember.id, inviter: w.who.owner.id,
        createdAt: isoPlus(w.clock.iso(), -(index + 10) * 1000), expiresAt: isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS), state, resolvedAt: isoPlus(w.clock.iso(), -(index + 5) * 1000) }));
    const before = snapshot(w.db);
    const rowsBefore = states.map(id => invitationRow(w.db, id));
    for (const id of states) for (const actor of [w.who.owner, w.who.admin]) refusal(thrown(() => cancel(w, actor, w.groupId, id)), 'CONFLICT', 409);
    assert.deepEqual(states.map(id => invitationRow(w.db, id)), rowsBefore);
    assert.deepEqual(changedTables(before, snapshot(w.db)), []);
    // The second call after a cancel is a 409, and so is the cancel of a pending row whose time has passed (the row is left as it is).
    cancel(w, w.who.owner, w.groupId, w.invitationId);
    refusal(thrown(() => cancel(w, w.who.owner, w.groupId, w.invitationId)), 'CONFLICT', 409);
    const late = invite(w, w.who.owner, { userId: w.who.pendingInvitee.id }).invitation;
    w.clock.advance(INVITATION_EXPIRY_MS);
    const frozen = snapshot(w.db);
    refusal(thrown(() => cancel(w, w.who.owner, w.groupId, late.id)), 'CONFLICT', 409);
    assert.deepEqual(changedTables(frozen, snapshot(w.db)), []);
    assert.equal(invitationRow(w.db, late.id).state, 'pending');
    // The store itself refuses to move a resolved row.
    assert.throws(() => w.db.prepare("UPDATE ConversationInvitations SET state = 'pending', resolved_at = NULL WHERE invitation_id = ?").run(states[0]), /invalid_invitation_transition/);
    assert.throws(() => w.db.prepare("UPDATE ConversationInvitations SET state = 'cancelled', resolved_at = ? WHERE invitation_id = ?").run('2027-01-01T00:00:00.000Z', states[0]), /invalid_invitation_transition/);
});

test('G14: cancelling is allowed in an archived group, a failed audit write rolls it back, and a session and CSRF proof are required', async t => {
    const w = await world(t);
    w.db.prepare("UPDATE Conversations SET archived_at = '2026-01-01T00:00:00.000Z' WHERE conversation_id = ?").run(w.groupId);
    const before = snapshot(w.db);
    w.db.exec("CREATE TRIGGER test_refuse_cancel_audit BEFORE INSERT ON AuditLogs WHEN NEW.event_type = 'group.invitation.cancelled' BEGIN SELECT RAISE(ABORT, 'refused by the test'); END");
    try {
        const error = assertAuth(thrown(() => cancel(w, w.who.owner, w.groupId, w.invitationId)), 'INTERNAL_ERROR', 500);
        assert.ok(!JSON.stringify(error).includes('refused by the test'));
    } finally { w.db.exec('DROP TRIGGER test_refuse_cancel_audit'); }
    assert.deepEqual(changedTables(before, snapshot(w.db)), []);
    assertAuth(thrown(() => w.svc.cancelInvitation(w.who.owner.context, undefined, w.groupId, w.invitationId)), 'CSRF_INVALID', 403);
    assertAuth(thrown(() => w.svc.cancelInvitation(w.who.owner.context, w.who.admin.proof, w.groupId, w.invitationId)), 'CSRF_INVALID', 403);
    assertAuth(thrown(() => cancel(w, { context: { userId: w.who.owner.id, sessionId: w.who.member.context.sessionId }, proof: w.who.owner.proof }, w.groupId, w.invitationId)), 'UNAUTHENTICATED', 401);
    assert.deepEqual(changedTables(before, snapshot(w.db)), []);
    assert.equal(cancel(w, w.who.owner, w.groupId, w.invitationId).state, 'cancelled');
});

// ---------------------------------------------------------------------------------------------------------------
// T-5C-12: listOwnInvitations (G15)
// ---------------------------------------------------------------------------------------------------------------
test('G15: lists only the caller\'s unexpired pending Invitations with the group name and the inviter\'s display name, newest first', async t => {
    const w = await world(t);
    const other = w.f.builder.createGroup({ ownerId: w.who.admin.id, title: 'Second group', idempotencyKey: null });
    w.clock.advance(1000);
    const second = seed(w.db, { id: 'seed-own-2', groupId: other, invitee: w.who.pendingInvitee.id, inviter: w.who.admin.id, createdAt: w.clock.iso(), expiresAt: isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS) });
    invite(w, w.who.owner, { userId: w.who.nonMember.id });
    const page = w.svc.listOwnInvitations(w.who.pendingInvitee.context, {});
    assert.deepEqual(Object.keys(page), ['items', 'nextCursor']);
    assert.deepEqual(page.items.map(item => item.id), [second, w.invitationId]);
    for (const item of page.items) assert.deepEqual(Object.keys(item).sort(), OWN_KEYS);
    assert.deepEqual(page.items[0], { id: second, groupId: other, groupName: 'Second group', inviterDisplayName: 'Group Admin', createdAt: w.clock.iso(), expiresAt: isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS) });
    assert.deepEqual([page.items[1].groupName, page.items[1].inviterDisplayName], ['Fixture group', 'Group Owner']);
    assert.ok(!/member|message|username|email|inviterId|invitee/i.test(JSON.stringify(page)), 'no member list, message data or other user data');
    // The caller sees nothing of the Invitations of other users.
    assert.deepEqual(w.svc.listOwnInvitations(w.who.nonMember.context, {}).items.map(item => item.groupId), [w.groupId]);
    assert.deepEqual(w.svc.listOwnInvitations(w.who.owner.context, {}).items, []);
    assert.deepEqual(w.svc.listOwnInvitations(w.who.member.context, {}).items, []);
});

test('G15: expired, resolved and non-group Invitations are not listed, and the list follows the server time', async t => {
    const w = await world(t);
    const soon = seed(w.db, { id: 'seed-soon-1', groupId: w.groupId, invitee: w.who.nonMember.id, inviter: w.who.owner.id, createdAt: w.clock.iso(), expiresAt: isoPlus(w.clock.iso(), 60000) });
    for (const state of ['accepted', 'declined', 'cancelled', 'expired']) {
        const group = w.f.builder.createGroup({ ownerId: w.who.owner.id, title: `Gone ${state}`, idempotencyKey: null });
        seed(w.db, { id: `seed-gone-${state}`, groupId: group, invitee: w.who.pendingInvitee.id, inviter: w.who.owner.id, createdAt: isoPlus(w.clock.iso(), -1000), expiresAt: isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS), state });
    }
    assert.deepEqual(w.svc.listOwnInvitations(w.who.pendingInvitee.context, {}).items.map(item => item.id), [w.invitationId]);
    assert.deepEqual(w.svc.listOwnInvitations(w.who.nonMember.context, {}).items.map(item => item.id), [soon]);
    w.clock.advance(60000);
    assert.deepEqual(w.svc.listOwnInvitations(w.who.nonMember.context, {}).items, [], 'at the expiry time the Invitation is expired');
    w.clock.advance(INVITATION_EXPIRY_MS);
    assert.deepEqual(w.svc.listOwnInvitations(w.who.pendingInvitee.context, {}).items, []);
});

test('G15: pages with a cursor bound to the user and the route, refuses a bad query by name, and changes no table', async t => {
    const w = await world(t);
    const user = w.who.pendingInvitee;
    for (let index = 0; index < 4; index++) {
        const group = w.f.builder.createGroup({ ownerId: w.who.owner.id, title: `Own page ${index}`, idempotencyKey: null });
        w.clock.advance(1000);
        seed(w.db, { id: `seed-own-page-${index}`, groupId: group, invitee: user.id, inviter: w.who.owner.id, createdAt: w.clock.iso(), expiresAt: isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS) });
    }
    const before = snapshot(w.db);
    const everything = w.svc.listOwnInvitations(user.context, {}).items.map(item => item.id);
    assert.equal(everything.length, 5);
    assert.equal(everything.at(-1), w.invitationId);
    for (const limit of ['1', '2', '3', '50']) {
        const seen = [];
        let cursor = null;
        let pages = 0;
        do {
            const page = w.svc.listOwnInvitations(user.context, { limit, ...(cursor === null ? {} : { cursor }) });
            seen.push(...page.items.map(item => item.id));
            cursor = page.nextCursor;
            pages += 1;
            assert.ok(pages < 8);
        } while (cursor !== null);
        assert.deepEqual(seen, everything, `limit ${limit}`);
        assert.equal(pages, Math.ceil(everything.length / Number(limit)));
    }
    for (const query of [{ limit: '0' }, { limit: '51' }, { limit: 'x' }, { limit: ['1', '1'] }]) refusal(thrown(() => w.svc.listOwnInvitations(user.context, query)), 'VALIDATION_ERROR', 400, ['limit']);
    refusal(thrown(() => w.svc.listOwnInvitations(user.context, { foo: '1', userId: 'x' })), 'VALIDATION_ERROR', 400, ['foo', 'userId']);
    for (const cursor of ['zzz', '', 'a'.repeat(2049)]) refusal(thrown(() => w.svc.listOwnInvitations(user.context, { cursor })), 'VALIDATION_ERROR', 400, ['cursor']);
    const token = w.svc.listOwnInvitations(user.context, { limit: '1' }).nextCursor;
    refusal(thrown(() => w.svc.listOwnInvitations(w.who.nonMember.context, { cursor: token })), 'VALIDATION_ERROR', 400, ['cursor']);
    const groupsRoute = codec.encode({ last: ['2026-01-01T00:00:00.000Z', 'x'] }, { route: 'groups', userId: user.id });
    refusal(thrown(() => w.svc.listOwnInvitations(user.context, { cursor: groupsRoute })), 'VALIDATION_ERROR', 400, ['cursor']);
    const wide = codec.encode({ last: ['2999-01-01T00:00:00.000Z', 'zzzz'] }, { route: 'own-invitations', userId: user.id });
    assert.deepEqual(w.svc.listOwnInvitations(user.context, { cursor: wide }).items.map(item => item.id), everything);
    assert.deepEqual(changedTables(before, snapshot(w.db)), []);
});

// ---------------------------------------------------------------------------------------------------------------
// T-5C-12: declineInvitation (G17)
// ---------------------------------------------------------------------------------------------------------------
test('G17: the invitee declines a pending Invitation with one audit row and no membership change', async t => {
    const w = await world(t);
    const before = memberState(w.db, w.groupId);
    w.clock.advance(7000);
    assert.deepEqual(decline(w, w.who.pendingInvitee, w.invitationId), { id: w.invitationId, state: 'declined' });
    const row = invitationRow(w.db, w.invitationId);
    assert.deepEqual([row.state, row.resolved_at, row.invitee_id], ['declined', w.clock.iso(), w.who.pendingInvitee.id]);
    const audit = inviteAudit(w.db, w.groupId).at(-1);
    assert.deepEqual([audit.event_type, audit.actor_user_id, audit.source, audit.subject_id], ['group.invitation.declined', w.who.pendingInvitee.id, 'groups', w.groupId]);
    assert.deepEqual(Object.keys(JSON.parse(audit.metadata_json)).sort(), ['operation', 'outcome']);
    assert.deepEqual(memberState(w.db, w.groupId), before, 'no member row, interval or revision changes');
    assertAuth(thrown(() => w.svc.getGroup(w.who.pendingInvitee.context, w.groupId)), 'NOT_FOUND', 404);
    assert.deepEqual(w.svc.listOwnInvitations(w.who.pendingInvitee.context, {}).items, []);
});

test('G17: any user but the invitee, an unknown id and a malformed id give the identical 404, and nothing changes', async t => {
    const w = await world(t);
    const before = snapshot(w.db);
    const answers = [];
    for (const actor of [w.who.owner, w.who.admin, w.who.member, w.who.nonMember, w.who.removedMember]) answers.push(refusal(thrown(() => decline(w, actor, w.invitationId)), 'NOT_FOUND', 404));
    for (const id of ['no-such-invitation', 'a b', 'x'.repeat(2000), '']) answers.push(refusal(thrown(() => decline(w, w.who.pendingInvitee, id)), 'NOT_FOUND', 404));
    for (const error of answers) assert.equal(signature(error), signature(answers[0]));
    assert.deepEqual(changedTables(before, snapshot(w.db)), []);
    assert.equal(invitationRow(w.db, w.invitationId).state, 'pending');
});

test('G17: a resolved or expired Invitation answers 409, a second decline answers 409, and a failed audit write rolls the decline back', async t => {
    const w = await world(t);
    const resolved = ['accepted', 'declined', 'cancelled', 'expired'].map(state => seed(w.db, { id: `seed-dec-${state}`, groupId: w.groupId, invitee: w.who.nonMember.id, inviter: w.who.owner.id,
        createdAt: isoPlus(w.clock.iso(), -20000), expiresAt: isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS), state, resolvedAt: isoPlus(w.clock.iso(), -10000) }));
    const before = snapshot(w.db);
    for (const id of resolved) refusal(thrown(() => decline(w, w.who.nonMember, id)), 'CONFLICT', 409);
    assert.deepEqual(changedTables(before, snapshot(w.db)), []);
    w.db.exec("CREATE TRIGGER test_refuse_decline_audit BEFORE INSERT ON AuditLogs WHEN NEW.event_type = 'group.invitation.declined' BEGIN SELECT RAISE(ABORT, 'refused by the test'); END");
    try {
        const error = assertAuth(thrown(() => decline(w, w.who.pendingInvitee, w.invitationId)), 'INTERNAL_ERROR', 500);
        assert.ok(!JSON.stringify(error).includes('refused by the test'));
    } finally { w.db.exec('DROP TRIGGER test_refuse_decline_audit'); }
    assert.deepEqual(changedTables(before, snapshot(w.db)), []);
    decline(w, w.who.pendingInvitee, w.invitationId);
    refusal(thrown(() => decline(w, w.who.pendingInvitee, w.invitationId)), 'CONFLICT', 409);
    refusal(thrown(() => cancel(w, w.who.owner, w.groupId, w.invitationId)), 'CONFLICT', 409);
    const late = await world(t);
    late.clock.advance(INVITATION_EXPIRY_MS);
    const frozen = snapshot(late.db);
    refusal(thrown(() => decline(late, late.who.pendingInvitee, late.invitationId)), 'CONFLICT', 409);
    assert.deepEqual(changedTables(frozen, snapshot(late.db)), [], 'at the expiry time the decline is refused and the row is left as it is');
});

test('G17: a session and a CSRF proof of the same session are required, and the invitee is the session user', async t => {
    const w = await world(t);
    const before = snapshot(w.db);
    assertAuth(thrown(() => w.svc.declineInvitation(w.who.pendingInvitee.context, undefined, w.invitationId)), 'CSRF_INVALID', 403);
    assertAuth(thrown(() => w.svc.declineInvitation(w.who.pendingInvitee.context, w.who.owner.proof, w.invitationId)), 'CSRF_INVALID', 403);
    assertAuth(thrown(() => decline(w, { context: { userId: w.who.pendingInvitee.id, sessionId: w.who.owner.context.sessionId }, proof: w.who.pendingInvitee.proof }, w.invitationId)), 'UNAUTHENTICATED', 401);
    assertAuth(thrown(() => decline(w, { context: { userId: w.who.owner.id, sessionId: w.who.owner.context.sessionId }, proof: w.who.owner.proof }, w.invitationId)), 'NOT_FOUND', 404);
    assert.deepEqual(changedTables(before, snapshot(w.db)), []);
});

test('invitations: the group invariants and the Membership_Revision hold through create, list, cancel and decline, and no secret is logged', async t => {
    const w = await world(t);
    const start = memberState(w.db, w.groupId);
    const extra = await extraUser(w, 'grp-extra-invariants');
    const made = invite(w, w.who.admin, { userId: extra.id }).invitation;
    w.svc.listInvitations(w.who.owner.context, w.groupId, {});
    w.svc.listOwnInvitations(extra.context, {});
    decline(w, extra, made.id);
    cancel(w, w.who.owner, w.groupId, w.invitationId);
    assert.deepEqual(memberState(w.db, w.groupId), start, 'members, intervals and the revision are exactly as they were');
    const report = createGroupRepositoryFor(w).invariantReport(w.groupId);
    assert.deepEqual([report.activeOwners, report.activeMembers, report.openIntervals, report.mismatches], [1, 3, 3, 0]);
    // Every pending-to-terminal move is recorded once: two resolved rows, two audit rows, and none of them moved again.
    assert.deepEqual(rows(w.db, "SELECT state FROM ConversationInvitations WHERE conversation_id = ? ORDER BY invitation_id", w.groupId).map(row => row.state).sort(), ['cancelled', 'declined']);
    const text = JSON.stringify(inviteAudit(w.db, w.groupId).map(row => row.metadata_json));
    assert.ok(!/Group Owner|Group Admin|grp-/.test(text), 'no name appears in an audit row');
});
function createGroupRepositoryFor(w) { return require('../server/database/groupRepository').createGroupRepository(w.db); }

// ---------------------------------------------------------------------------------------------------------------
// T-5C-13: acceptInvitation (G16)
// ---------------------------------------------------------------------------------------------------------------
const accept = (w, actor, invitationId, svc = w.svc) => svc.acceptInvitation(actor.context, actor.proof, invitationId);
const ACCEPT_GROUP_KEYS = ['archived', 'createdAt', 'description', 'historyPolicy', 'id', 'memberCount', 'membershipRevision', 'name', 'role', 'updatedAt'];
const YEAR_MS = 366 * 86400000; // the fixture removes members at the wall-clock time, so a service clock must be later than that
const MEMBERSHIP_TABLES = ['AuditLogs', 'ConversationInvitations', 'ConversationMembers', 'GroupExtensions', 'GroupMembershipIntervals'];
const invariants = w => createGroupRepository(w.db).invariantReport(w.groupId);
const eventsOf = (db, groupId) => inviteAudit(db, groupId).map(row => row.event_type);
// A refusal of the re-validation commits the Invitation state and its audit row, changes nothing else, and then answers 409.
function assertCommittedRefusal(w, actor, invitationId, state, event, groupId = w.groupId, svc = w.svc) {
    const members = memberState(w.db, groupId);
    const audits = inviteAudit(w.db, groupId).length;
    const others = snapshot(w.db);
    refusal(thrown(() => accept(w, actor, invitationId, svc)), 'CONFLICT', 409);
    const row = invitationRow(w.db, invitationId);
    assert.deepEqual([row.state, row.resolved_at], [state, w.clock.iso()]);
    const trail = inviteAudit(w.db, groupId);
    assert.equal(trail.length, audits + 1, 'exactly one audit row');
    assert.deepEqual([trail.at(-1).event_type, trail.at(-1).actor_user_id, trail.at(-1).subject_id], [event, actor.id, groupId]);
    assert.deepEqual(Object.keys(JSON.parse(trail.at(-1).metadata_json)).sort(), ['operation', 'outcome']);
    assert.deepEqual(memberState(w.db, groupId), members, 'membership, role, revision and intervals are unchanged');
    assert.deepEqual(changedTables(others, snapshot(w.db)).sort(), ['AuditLogs', 'ConversationInvitations'], 'only the Invitation state and its audit row were committed');
}

test('G16: the invitee accepts a pending Invitation: member added, interval opened, revision up by one, one audit row, {group}', async t => {
    const w = await world(t);
    const before = memberState(w.db, w.groupId);
    const tables = snapshot(w.db);
    w.clock.advance(3000);
    const result = accept(w, w.who.pendingInvitee, w.invitationId);
    assert.deepEqual(Object.keys(result), ['group']);
    assert.deepEqual(Object.keys(result.group).sort(), ACCEPT_GROUP_KEYS);
    assert.deepEqual([result.group.id, result.group.name, result.group.role, result.group.memberCount, result.group.membershipRevision, result.group.archived],
        [w.groupId, 'Fixture group', 'member', 4, before.revision + 1, false]);
    const invitation = invitationRow(w.db, w.invitationId);
    assert.deepEqual([invitation.state, invitation.resolved_at], ['accepted', w.clock.iso()]);
    const member = memberState(w.db, w.groupId).members.find(row => row.user_id === w.who.pendingInvitee.id);
    assert.deepEqual([member.role, member.left_at], ['member', null]);
    const intervals = memberState(w.db, w.groupId).intervals.filter(row => row.user_id === w.who.pendingInvitee.id);
    assert.deepEqual(intervals.map(row => [row.interval_no, row.first_seq, row.last_seq, row.joined_at, row.left_at]), [[1, 1, null, member.joined_at, null]]);
    assert.equal(memberState(w.db, w.groupId).revision, before.revision + 1, 'the revision rose by exactly one');
    const audit = inviteAudit(w.db, w.groupId).at(-1);
    assert.deepEqual([audit.event_type, audit.actor_user_id, audit.source, audit.subject_id], ['group.invitation.accepted', w.who.pendingInvitee.id, 'groups', w.groupId]);
    assert.deepEqual(JSON.parse(audit.metadata_json), { operation: 'invitation.accepted', outcome: 'confirmed', role: 'member' });
    assert.equal(inviteAudit(w.db, w.groupId).filter(row => row.event_type === 'group.invitation.accepted').length, 1);
    assert.deepEqual(changedTables(tables, snapshot(w.db)).sort(), MEMBERSHIP_TABLES);
    assert.equal(w.svc.getGroup(w.who.pendingInvitee.context, w.groupId).role, 'member', 'the invitee is a member now');
    assert.deepEqual(w.svc.listOwnInvitations(w.who.pendingInvitee.context, {}).items, []);
    assert.deepEqual(invariants(w), { activeOwners: 1, activeMembers: 4, openIntervals: 4, mismatches: 0 });
});

test('G16: a former member is reactivated with the role member, keeping the first join time and opening a second interval', async t => {
    const w = await world(t);
    const first = memberState(w.db, w.groupId);
    const wasRemoved = first.members.find(row => row.user_id === w.who.removedMember.id);
    w.clock.advance(YEAR_MS);
    const sent = invite(w, w.who.owner, { userId: w.who.removedMember.id }).invitation;
    w.clock.advance(5000);
    const result = accept(w, w.who.removedMember, sent.id);
    assert.deepEqual([result.group.role, result.group.memberCount, result.group.membershipRevision], ['member', 4, first.revision + 1]);
    const after = memberState(w.db, w.groupId);
    const row = after.members.find(member => member.user_id === w.who.removedMember.id);
    assert.deepEqual([row.role, row.left_at, row.joined_at], ['member', null, wasRemoved.joined_at], 'one row, reactivated; the first joined_at is kept');
    assert.equal(after.members.filter(member => member.user_id === w.who.removedMember.id).length, 1, 'no duplicate member row');
    const intervals = after.intervals.filter(interval => interval.user_id === w.who.removedMember.id);
    assert.deepEqual(intervals.map(interval => [interval.interval_no, interval.left_at === null]), [[1, false], [2, true]]);
    assert.deepEqual(intervals[0], first.intervals.find(interval => interval.user_id === w.who.removedMember.id), 'the closed interval is untouched');
    assert.equal(intervals[1].joined_at, w.clock.iso());
    assert.deepEqual(invariants(w), { activeOwners: 1, activeMembers: 4, openIntervals: 4, mismatches: 0 });
});

test('G16: an invitee removed since the Invitation was created cannot rejoin through it (AF-03), but a new Invitation works', async t => {
    const w = await world(t);
    // A removal after creation: the invitee left at or after the Invitation was created (AF-03).
    const removedAfter = seed(w.db, { id: 'seed-removed-after', groupId: w.groupId, invitee: w.who.removedMember.id, inviter: w.who.owner.id, createdAt: isoPlus(w.clock.iso(), -10000), expiresAt: isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS) });
    w.clock.advance(1000);
    assertCommittedRefusal(w, w.who.removedMember, removedAfter, 'cancelled', 'group.invitation.cancelled');
    // The same user may be invited again, after the removal, and then joins.
    w.clock.advance(YEAR_MS);
    const again = invite(w, w.who.owner, { userId: w.who.removedMember.id }).invitation;
    w.clock.advance(1000);
    assert.equal(accept(w, w.who.removedMember, again.id).group.role, 'member');
});

test('G16: an invitee who is already an Active_Member leaves the member row untouched, and a stale Invitation cannot demote the owner', async t => {
    const w = await world(t);
    const stale = seed(w.db, { id: 'seed-active-member', groupId: w.groupId, invitee: w.who.member.id, inviter: w.who.owner.id, createdAt: w.clock.iso(), expiresAt: isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS) });
    w.clock.advance(1000);
    assertCommittedRefusal(w, w.who.member, stale, 'cancelled', 'group.invitation.cancelled');
    const admin = seed(w.db, { id: 'seed-active-admin', groupId: w.groupId, invitee: w.who.admin.id, inviter: w.who.owner.id, createdAt: w.clock.iso(), expiresAt: isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS) });
    assertCommittedRefusal(w, w.who.admin, admin, 'cancelled', 'group.invitation.cancelled');
    // AF-04: an Invitation addressed to the current owner, accepted, leaves exactly one owner and the owner role.
    const ownerRow = seed(w.db, { id: 'seed-active-owner', groupId: w.groupId, invitee: w.who.owner.id, inviter: w.who.admin.id, createdAt: w.clock.iso(), expiresAt: isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS) });
    assertCommittedRefusal(w, w.who.owner, ownerRow, 'cancelled', 'group.invitation.cancelled');
    const state = memberState(w.db, w.groupId);
    assert.deepEqual(state.members.filter(row => row.role === 'owner' && row.left_at === null).map(row => row.user_id), [w.who.owner.id]);
    assert.deepEqual(invariants(w), { activeOwners: 1, activeMembers: 3, openIntervals: 3, mismatches: 0 });
});

test('P-07: accepting while the invitee is an active owner, admin or member cancels only the Invitation', { timeout: 240000 }, async t => {
    const roles = ['owner', 'admin', 'member'], coverage = new Set();
    await forAll('P-07', { runs: 30, seed: 0x5c070031, onRun: line => t.diagnostic(line), describe: role => [role] },
        (_random, info) => roles[info.run % roles.length], async role => {
            const w = await world(t), invitee = w.who.pendingInvitee, owner = w.who.owner;
            const svc = w.service({ groupApi: true, groups: { ...FEATURES.groups, directAdd: true } });
            const id = w.invitationId;
            svc.addMember(owner.context, owner.proof, w.groupId, { userId: invitee.id });
            if (role === 'admin') svc.changeMemberRole(owner.context, owner.proof, w.groupId, invitee.id, { role: 'admin' });
            if (role === 'owner') svc.transferOwnership(owner.context, owner.proof, w.groupId, { userId: invitee.id });
            const before = memberState(w.db, w.groupId), ownerIds = before.members.filter(row => row.role === 'owner' && row.left_at === null).map(row => row.user_id);
            assert.equal(before.members.find(row => row.user_id === invitee.id).role, role);
            assert.equal(ownerIds.length, 1);
            assertCommittedRefusal(w, invitee, id, 'cancelled', 'group.invitation.cancelled', w.groupId, svc);
            assert.deepEqual(memberState(w.db, w.groupId), before, `P-07 ${role} membership, intervals and revision unchanged`);
            assert.deepEqual(memberState(w.db, w.groupId).members.filter(row => row.role === 'owner' && row.left_at === null).map(row => row.user_id), ownerIds);
            coverage.add(role);
        });
    assert.deepEqual([...coverage].sort(), roles.slice().sort());
});

test('AF-04: a stale invitation accepted by the current owner leaves exactly one owner', async t => {
    for (const transition of ['transfer', 'role-change']) {
        const w = await world(t), owner = w.who.owner, invitee = w.who.pendingInvitee;
        const svc = w.service({ groupApi: true, groups: { ...FEATURES.groups, directAdd: true } });
        svc.addMember(owner.context, owner.proof, w.groupId, { userId: invitee.id });
        if (transition === 'transfer') svc.transferOwnership(owner.context, owner.proof, w.groupId, { userId: invitee.id });
        else svc.changeMemberRole(owner.context, owner.proof, w.groupId, invitee.id, { role: 'admin' });
        assertCommittedRefusal(w, invitee, w.invitationId, 'cancelled', 'group.invitation.cancelled', w.groupId, svc);
        assert.equal(invariants(w).activeOwners, 1, `AF-04 ${transition} preserves exactly one active owner`);
        assert.equal(createGroupRepository(w.db).getMember(w.groupId, invitee.id).role, transition === 'transfer' ? 'owner' : 'admin');
    }
});

test('G16: expiry is decided by the server time: one second before it the Invitation is accepted, at exactly expires_at it is expired', async t => {
    const early = await world(t);
    early.clock.advance(INVITATION_EXPIRY_MS - 1000);
    assert.equal(accept(early, early.who.pendingInvitee, early.invitationId).group.role, 'member');
    const late = await world(t);
    late.clock.advance(INVITATION_EXPIRY_MS);
    assertCommittedRefusal(late, late.who.pendingInvitee, late.invitationId, 'expired', 'group.invitation.expired');
    // An expired Invitation is expired whatever else fails: the archived group does not turn it into a cancellation.
    const both = await world(t);
    both.db.prepare("UPDATE Conversations SET archived_at = '2026-01-01T00:00:00.000Z' WHERE conversation_id = ?").run(both.groupId);
    both.clock.advance(INVITATION_EXPIRY_MS + 1);
    assertCommittedRefusal(both, both.who.pendingInvitee, both.invitationId, 'expired', 'group.invitation.expired');
    // After the refusal the row never moves again.
    refusal(thrown(() => accept(both, both.who.pendingInvitee, both.invitationId)), 'CONFLICT', 409);
    assert.equal(invitationRow(both.db, both.invitationId).state, 'expired');
});

test('G16: an archived group, an inviter who left or may not invite, and a block in either direction cancel the Invitation', async t => {
    const archived = await world(t);
    archived.db.prepare("UPDATE Conversations SET archived_at = '2026-01-01T00:00:00.000Z' WHERE conversation_id = ?").run(archived.groupId);
    archived.clock.advance(1000);
    assertCommittedRefusal(archived, archived.who.pendingInvitee, archived.invitationId, 'cancelled', 'group.invitation.cancelled');
    const w = await world(t);
    w.db.prepare("UPDATE ConversationInvitations SET state = 'cancelled', resolved_at = ? WHERE invitation_id = ?").run(w.clock.iso(), w.invitationId);
    const formerInviter = seed(w.db, { id: 'seed-former-inviter', groupId: w.groupId, invitee: w.who.nonMember.id, inviter: w.who.removedMember.id, createdAt: w.clock.iso(), expiresAt: isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS) });
    const memberInviter = seed(w.db, { id: 'seed-member-inviter', groupId: w.groupId, invitee: w.who.pendingInvitee.id, inviter: w.who.member.id, createdAt: w.clock.iso(), expiresAt: isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS) });
    w.clock.advance(1000);
    assertCommittedRefusal(w, w.who.nonMember, formerInviter, 'cancelled', 'group.invitation.cancelled');
    assertCommittedRefusal(w, w.who.pendingInvitee, memberInviter, 'cancelled', 'group.invitation.cancelled');

    for (const [label, blocker, blocked] of [['the inviter blocks the invitee', 'owner', 'nonMember'], ['the invitee blocks the inviter', 'nonMember', 'owner']]) {
        const b = await world(t);
        const sent = invite(b, b.who.owner, { userId: b.who.nonMember.id }).invitation;
        b.base.blocks.insert(b.who[blocker].id, b.who[blocked].id);
        b.clock.advance(1000);
        assertCommittedRefusal(b, b.who.nonMember, sent.id, 'cancelled', 'group.invitation.cancelled');
        assert.equal(invitationRow(b.db, sent.id).state, 'cancelled', label);
    }
});

test('G16: the member maximum comes from the configuration, is checked inside the transaction, and the last free slot goes to one invitee only', async t => {
    const w = await world(t);
    const maxima = count => w.service({ groupApi: true, groups: { maxMembers: count } });
    const second = seed(w.db, { id: 'seed-second-invitee', groupId: w.groupId, invitee: w.who.nonMember.id, inviter: w.who.owner.id, createdAt: w.clock.iso(), expiresAt: isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS) });
    w.clock.advance(1000);
    // Three Active_Members and a maximum of three: acceptance would exceed it.
    assertCommittedRefusal(w, w.who.pendingInvitee, w.invitationId, 'cancelled', 'group.invitation.cancelled', w.groupId, maxima(3));
    // A maximum of four leaves one slot, and the first acceptance takes it.
    assert.equal(accept(w, w.who.nonMember, second, maxima(4)).group.memberCount, 4);
    const third = seed(w.db, { id: 'seed-third-invitee', groupId: w.groupId, invitee: w.who.pendingInvitee.id, inviter: w.who.owner.id, createdAt: w.clock.iso(), expiresAt: isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS) });
    assertCommittedRefusal(w, w.who.pendingInvitee, third, 'cancelled', 'group.invitation.cancelled', w.groupId, maxima(4));
    // The number is the configured one and no constant: 50 admits the same acceptance that 3 refused.
    const roomy = await world(t);
    roomy.clock.advance(1000);
    assert.equal(accept(roomy, roomy.who.pendingInvitee, roomy.invitationId, roomy.service({ groupApi: true, groups: { maxMembers: 50 } })).group.memberCount, 4);
    assert.deepEqual(invariants(w), { activeOwners: 1, activeMembers: 4, openIntervals: 4, mismatches: 0 });
});
test('G16: an unset or invalid member maximum answers 503 before any read or change, and never cancels an Invitation', async t => {
    const w = await world(t);
    const before = snapshot(w.db);
    for (const features of [{ groupApi: true }, { groupApi: true, groups: {} }, { groupApi: true, groups: { maxMembers: 0 } }, { groupApi: true, groups: { maxMembers: -1 } },
        { groupApi: true, groups: { maxMembers: 1.5 } }, { groupApi: true, groups: { maxMembers: '50' } }, { groupApi: true, groups: { maxMembers: null } }, { groupApi: true, groups: { maxMembers: Infinity } }]) {
        const svc = w.service(features);
        for (const actor of [w.who.pendingInvitee, w.who.owner, w.who.nonMember]) refusal(thrown(() => accept(w, actor, w.invitationId, svc)), 'FEATURE_UNAVAILABLE', 503);
        refusal(thrown(() => accept(w, w.who.pendingInvitee, 'no-such-invitation', svc)), 'FEATURE_UNAVAILABLE', 503);
    }
    assert.deepEqual(changedTables(before, snapshot(w.db)), []);
    assert.equal(invitationRow(w.db, w.invitationId).state, 'pending');
});

test('G16: a user who is not the invitee, an unknown id and a malformed id get the identical 404 and change nothing', async t => {
    const w = await world(t);
    const before = snapshot(w.db);
    const answers = [];
    for (const actor of [w.who.owner, w.who.admin, w.who.member, w.who.nonMember, w.who.removedMember]) answers.push(refusal(thrown(() => accept(w, actor, w.invitationId)), 'NOT_FOUND', 404));
    for (const id of ['no-such-invitation', 'a b', 'x'.repeat(2000), '', undefined, null]) answers.push(refusal(thrown(() => accept(w, w.who.pendingInvitee, id)), 'NOT_FOUND', 404));
    for (const error of answers) assert.equal(signature(error), signature(answers[0]));
    assert.deepEqual(changedTables(before, snapshot(w.db)), []);
    assert.equal(invitationRow(w.db, w.invitationId).state, 'pending');
});

test('G16: an Invitation that is not pending answers 409 with no change, and a second accept never repeats the first', async t => {
    const w = await world(t);
    const resolved = ['accepted', 'declined', 'cancelled', 'expired'].map((state, index) => seed(w.db, { id: `seed-acc-${state}`, groupId: w.groupId, invitee: w.who.nonMember.id, inviter: w.who.owner.id,
        createdAt: isoPlus(w.clock.iso(), -(index + 20) * 1000), expiresAt: isoPlus(w.clock.iso(), INVITATION_EXPIRY_MS), state, resolvedAt: isoPlus(w.clock.iso(), -(index + 10) * 1000) }));
    const before = snapshot(w.db);
    const rowsBefore = resolved.map(id => invitationRow(w.db, id));
    for (const id of resolved) refusal(thrown(() => accept(w, w.who.nonMember, id)), 'CONFLICT', 409);
    assert.deepEqual(changedTables(before, snapshot(w.db)), []);
    assert.deepEqual(resolved.map(id => invitationRow(w.db, id)), rowsBefore);
    accept(w, w.who.pendingInvitee, w.invitationId);
    const afterFirst = snapshot(w.db);
    refusal(thrown(() => accept(w, w.who.pendingInvitee, w.invitationId)), 'CONFLICT', 409);
    assert.deepEqual(changedTables(afterFirst, snapshot(w.db)), [], 'the second accept changes nothing, not even a revision or an audit row');
    assert.equal(memberState(w.db, w.groupId).intervals.filter(row => row.user_id === w.who.pendingInvitee.id).length, 1, 'no duplicate interval');
    refusal(thrown(() => decline(w, w.who.pendingInvitee, w.invitationId)), 'CONFLICT', 409);
    refusal(thrown(() => cancel(w, w.who.owner, w.groupId, w.invitationId)), 'CONFLICT', 409);
});

test('G16: a failed audit write rolls back the acceptance and also the committed refusal that would have preceded the 409', async t => {
    const success = await world(t);
    const before = snapshot(success.db);
    success.db.exec("CREATE TRIGGER test_refuse_accept_audit BEFORE INSERT ON AuditLogs WHEN NEW.event_type = 'group.invitation.accepted' BEGIN SELECT RAISE(ABORT, 'refused by the test'); END");
    try {
        const error = assertAuth(thrown(() => accept(success, success.who.pendingInvitee, success.invitationId)), 'INTERNAL_ERROR', 500);
        assert.deepEqual(error.fields, []);
        assert.ok(!JSON.stringify(error).includes('refused by the test') && !error.stack.includes('refused by the test'));
    } finally { success.db.exec('DROP TRIGGER test_refuse_accept_audit'); }
    assert.deepEqual(changedTables(before, snapshot(success.db)), [], 'no member row, interval, revision, state or audit row survived');
    assert.equal(invitationRow(success.db, success.invitationId).state, 'pending');
    assert.equal(accept(success, success.who.pendingInvitee, success.invitationId).group.role, 'member', 'and the Invitation is still acceptable');

    for (const [event, setup] of [['group.invitation.cancelled', w => w.db.prepare("UPDATE Conversations SET archived_at = '2026-01-01T00:00:00.000Z' WHERE conversation_id = ?").run(w.groupId)],
        ['group.invitation.expired', w => w.clock.advance(INVITATION_EXPIRY_MS)]]) {
        const w = await world(t);
        setup(w);
        const snap = snapshot(w.db);
        w.db.exec(`CREATE TRIGGER test_refuse_refusal_audit BEFORE INSERT ON AuditLogs WHEN NEW.event_type = '${event}' BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`);
        try {
            assertAuth(thrown(() => accept(w, w.who.pendingInvitee, w.invitationId)), 'INTERNAL_ERROR', 500);
        } finally { w.db.exec('DROP TRIGGER test_refuse_refusal_audit'); }
        assert.deepEqual(changedTables(snap, snapshot(w.db)), [], `${event}: the state change rolled back with the audit failure`);
        assert.equal(invitationRow(w.db, w.invitationId).state, 'pending');
    }
});

test('G16: a session and a CSRF proof of the same session are required, and the invitee is the session user', async t => {
    const w = await world(t);
    const before = snapshot(w.db);
    assertAuth(thrown(() => w.svc.acceptInvitation(w.who.pendingInvitee.context, undefined, w.invitationId)), 'CSRF_INVALID', 403);
    assertAuth(thrown(() => w.svc.acceptInvitation(w.who.pendingInvitee.context, w.who.owner.proof, w.invitationId)), 'CSRF_INVALID', 403);
    assertAuth(thrown(() => accept(w, { context: { userId: w.who.pendingInvitee.id, sessionId: w.who.owner.context.sessionId }, proof: w.who.pendingInvitee.proof }, w.invitationId)), 'UNAUTHENTICATED', 401);
    assertAuth(thrown(() => accept(w, { context: undefined, proof: w.who.pendingInvitee.proof }, w.invitationId)), 'UNAUTHENTICATED', 401);
    assertAuth(thrown(() => accept(w, { context: { userId: w.who.owner.id, sessionId: w.who.owner.context.sessionId }, proof: w.who.owner.proof }, w.invitationId)), 'NOT_FOUND', 404);
    assert.deepEqual(changedTables(before, snapshot(w.db)), []);
});

test('G16: the re-validation uses the policy function and its order, and the audit trail records one event per accepted or refused request', async t => {
    const w = await world(t);
    w.clock.advance(1000);
    accept(w, w.who.pendingInvitee, w.invitationId);
    assert.deepEqual(eventsOf(w.db, w.groupId), ['group.invitation.accepted']);
    const sent = invite(w, w.who.owner, { userId: w.who.nonMember.id }).invitation;
    w.db.prepare("UPDATE Conversations SET archived_at = '2026-01-01T00:00:00.000Z' WHERE conversation_id = ?").run(w.groupId);
    refusal(thrown(() => accept(w, w.who.nonMember, sent.id)), 'CONFLICT', 409);
    assert.deepEqual(eventsOf(w.db, w.groupId), ['group.invitation.accepted', 'group.invitation.created', 'group.invitation.cancelled']);
    assert.ok(!JSON.stringify(inviteAudit(w.db, w.groupId).map(row => row.metadata_json)).match(/Group Owner|Fixture group|grp-/));
});

// ---------------------------------------------------------------------------------------------------------------
// T-5C-13 over HTTP: the real application with the Group_API switched on, real sessions and real CSRF proofs.
// ---------------------------------------------------------------------------------------------------------------
test('G16: populated histories open at high-water plus one for both policies, including an empty interval and rejoin', async t => {
    const w = await world(t);
    const repository = createGroupRepository(w.db);
    const periods = groupId => memberState(w.db, groupId).intervals.filter(row => row.user_id === w.who.nonMember.id);
    function message(groupId) {
        const seq = w.base.messages.highWater(groupId) + 1;
        w.base.messages.insertAuthenticated({ message_id: `g16-${groupId}-${seq}`, conversation_id: groupId, sender_id: w.who.owner.id,
            receiver_id: null, ciphertext: 'synthetic ciphertext', iv: 'synthetic-iv', envelope_version: 1, encoding: 'base64',
            sender_name: 'Synthetic sender', client_timestamp: w.clock.iso(), message_type: 'text', fingerprint: 'a'.repeat(64),
            client_id: `g16-client-${seq}`, message_seq: seq, created_at: w.clock.iso() });
    }
    for (const historyPolicy of ['all', 'from_joined']) {
        const groupId = w.f.builder.createGroup({ ownerId: w.who.owner.id, historyPolicy, idempotencyKey: null });
        w.db.transaction(() => { message(groupId); message(groupId); }).immediate();
        const first = invite(w, w.who.owner, { userId: w.who.nonMember.id }, groupId).invitation;
        const before = snapshot(w.db);
        assert.equal(accept(w, w.who.nonMember, first.id).group.historyPolicy, historyPolicy);
        assert.deepEqual(changedTables(before, snapshot(w.db)).sort(), MEMBERSHIP_TABLES, 'acceptance changes no messages or read positions');
        assert.deepEqual(periods(groupId).map(row => [row.first_seq, row.last_seq]), [[3, null]]);
        const joinedAt = repository.getMember(groupId, w.who.nonMember.id).joined_at;
        w.clock.advance(1000);
        withMembershipTransaction(w.db, () => {
            repository.endMembership(groupId, w.who.nonMember.id, w.clock.iso());
            repository.closeInterval(groupId, w.who.nonMember.id, w.clock.iso());
            repository.bumpRevision(groupId);
        });
        const closed = periods(groupId)[0];
        assert.deepEqual([closed.first_seq, closed.last_seq], [3, 2], 'no messages during membership: a valid empty interval');
        w.db.transaction(() => message(groupId)).immediate();
        w.clock.advance(1000);
        const again = invite(w, w.who.owner, { userId: w.who.nonMember.id }, groupId).invitation;
        const revision = repository.getVisibleGroup(groupId).membership_revision;
        assert.equal(accept(w, w.who.nonMember, again.id).group.membershipRevision, revision + 1);
        assert.equal(repository.getMember(groupId, w.who.nonMember.id).joined_at, joinedAt);
        const intervals = periods(groupId);
        assert.deepEqual(intervals[0], closed, 'the historical interval stays intact');
        assert.deepEqual(intervals.map(row => [row.interval_no, row.first_seq, row.last_seq]), [[1, 3, 2], [2, 4, null]]);
        assert.deepEqual(repository.invariantReport(groupId), { activeOwners: 1, activeMembers: 2, openIntervals: 2, mismatches: 0 });
    }
});

test('G16: inviter role and active membership are re-read after invitation creation', async t => {
    for (const revoke of ['demote', 'leave']) {
        const w = await world(t);
        const repository = createGroupRepository(w.db);
        const inviter = repository.getMember(w.groupId, w.who.admin.id);
        w.clock.advance(Math.max(1000, Date.parse(inviter.joined_at) - w.clock.now() + 1000));
        const sent = invite(w, w.who.admin, { userId: w.who.nonMember.id }).invitation;
        w.clock.advance(1000);
        const at = w.clock.iso();
        withMembershipTransaction(w.db, () => {
            if (revoke === 'demote') repository.changeRole(w.groupId, w.who.admin.id, 'admin', 'member');
            else {
                repository.endMembership(w.groupId, w.who.admin.id, at);
                repository.closeInterval(w.groupId, w.who.admin.id, at);
            }
            repository.bumpRevision(w.groupId);
        });
        assert.equal(invitationRow(w.db, sent.id).state, 'pending');
        assertCommittedRefusal(w, w.who.nonMember, sent.id, 'cancelled', 'group.invitation.cancelled');
    }
});

const HTTP_FEATURES = Object.freeze({ groupApi: true, groups: Object.freeze({ maxMembers: 50, maxPendingInvitationsPerGroup: 50, maxPendingInvitationsPerInvitee: 50 }) });
const acceptUrl = id => `/api/groups/invitations/${id}/accept`;
const accepting = (actor, id, options = {}) => actorRequest(actor, 'POST', acceptUrl(id), options);
const httpWorld = (t, features = HTTP_FEATURES) => httpGroupFixture(t, { clock: createClock(), features });
const error409 = { code: 'CONFLICT', fields: [] };
const error404 = { code: 'NOT_FOUND', fields: [] };

test('G16 HTTP: the invitee accepts and gets 200 {group}; the body and any identity claim in it change nothing', async t => {
    const f = await httpWorld(t);
    const before = memberState(f.db, f.groupId);
    const response = await accepting(f.actors.pendingInvitee, f.invitationId, { body: { userId: f.actors.owner.id, role: 'owner', groupId: 'other', inviterId: f.actors.owner.id } });
    assert.equal(response.status, 200);
    assertSecurityHeaders(response, 'G16');
    assert.deepEqual(Object.keys(response.body), ['group']);
    assert.deepEqual(Object.keys(response.body.group).sort(), ACCEPT_GROUP_KEYS);
    assert.deepEqual([response.body.group.id, response.body.group.role, response.body.group.memberCount, response.body.group.membershipRevision], [f.groupId, 'member', 4, before.revision + 1]);
    const state = memberState(f.db, f.groupId);
    assert.deepEqual(state.members.filter(row => row.role === 'owner').map(row => row.user_id), [f.actors.owner.id], 'the body role was ignored');
    assert.equal(state.members.find(row => row.user_id === f.actors.pendingInvitee.id).role, 'member');
    assert.equal(invitationRow(f.db, f.invitationId).state, 'accepted');
    assert.equal((await actorRequest(f.actors.pendingInvitee, 'GET', `/api/groups/${f.groupId}`)).body.group.role, 'member', 'the new member reads the group');
    assert.equal((await accepting(f.actors.pendingInvitee, f.invitationId)).status, 409, 'a second accept');
    assert.equal(rows(f.db, "SELECT * FROM AuditLogs WHERE event_type = 'group.invitation.accepted' AND subject_id = ?", f.groupId).length, 1);
});

test('G16 HTTP: a refused re-validation is committed first and answers 409 afterwards, with the state and audit row visible on another connection', async t => {
    const f = await httpWorld(t);
    createRepositories(f.db).blocks.insert(f.actors.owner.id, f.actors.pendingInvitee.id);
    const before = memberState(f.db, f.groupId);
    const response = await accepting(f.actors.pendingInvitee, f.invitationId);
    assert.deepEqual([response.status, response.body], [409, error409]);
    assertSecurityHeaders(response, 'G16 409');
    // Read through a second connection to the same file: the refusal was committed, not held in the first transaction.
    const Database = require('better-sqlite3');
    const other = new Database(f.filename, { readonly: true });
    f.connections.push(other); // The fixture closes all connections before unlinking its database (also on Windows).
    assert.equal(other.prepare('SELECT state FROM ConversationInvitations WHERE invitation_id = ?').get(f.invitationId).state, 'cancelled');
    assert.equal(other.prepare("SELECT count(*) AS n FROM AuditLogs WHERE event_type = 'group.invitation.cancelled' AND subject_id = ? AND actor_user_id = ?").get(f.groupId, f.actors.pendingInvitee.id).n, 1);
    assert.deepEqual(memberState(f.db, f.groupId), before, 'no membership, role, revision or interval changed');
    assert.equal((await accepting(f.actors.pendingInvitee, f.invitationId)).status, 409);
    assert.equal(other.prepare("SELECT count(*) AS n FROM AuditLogs WHERE event_type LIKE 'group.invitation.%' AND subject_id = ?").get(f.groupId).n, 1, 'the second request wrote nothing');
});

test('G16 HTTP: unauthenticated, CSRF-less, foreign-CSRF and non-invitee requests are refused without a change, and a switched-off group API answers 503', async t => {
    const f = await httpWorld(t);
    const before = snapshot(f.db);
    assert.equal((await accepting(f.actors.unauthenticated, f.invitationId)).status, 401);
    const noProof = await accepting(f.actors.pendingInvitee, f.invitationId, { csrf: false });
    assert.deepEqual([noProof.status, noProof.body], [403, { code: 'CSRF_INVALID', fields: [] }]);
    const foreign = await accepting(f.actors.pendingInvitee, f.invitationId, { csrf: false, headers: { 'X-CSRF-Token': f.actors.owner.token } });
    assert.deepEqual([foreign.status, foreign.body.code], [403, 'CSRF_INVALID']);
    const answers = [];
    for (const name of ['owner', 'admin', 'member', 'nonMember', 'removedMember']) answers.push(await accepting(f.actors[name], f.invitationId));
    for (const id of ['no-such-invitation', 'a%20b', 'x'.repeat(2000)]) answers.push(await accepting(f.actors.pendingInvitee, id));
    for (const response of answers) assert.deepEqual([response.status, response.text], [404, JSON.stringify(error404)]);
    assert.deepEqual(changedTables(before, snapshot(f.db)), []);
    assert.equal(invitationRow(f.db, f.invitationId).state, 'pending');
    const off = await httpGroupFixture(t, { clock: createClock() });
    const gated = await accepting(off.actors.pendingInvitee, off.invitationId);
    assert.deepEqual([gated.status, gated.body], [503, { code: 'FEATURE_UNAVAILABLE', fields: [] }]);
    assert.equal(invitationRow(off.db, off.invitationId).state, 'pending');
});

test('G16 HTTP: a failed audit write answers a bare 500 and leaves the Invitation pending and the membership untouched', async t => {
    const f = await httpWorld(t);
    const before = snapshot(f.db);
    f.db.exec("CREATE TRIGGER test_refuse_http_accept_audit BEFORE INSERT ON AuditLogs WHEN NEW.event_type = 'group.invitation.accepted' BEGIN SELECT RAISE(ABORT, 'refused by the test'); END");
    try {
        const response = await accepting(f.actors.pendingInvitee, f.invitationId);
        assert.deepEqual([response.status, response.body], [500, { code: 'INTERNAL_ERROR', fields: [] }]);
        assert.ok(!response.text.includes('refused by the test'));
    } finally { f.db.exec('DROP TRIGGER test_refuse_http_accept_audit'); }
    assert.deepEqual(changedTables(before, snapshot(f.db)), []);
    assert.equal((await accepting(f.actors.pendingInvitee, f.invitationId)).status, 200, 'the Invitation is still acceptable');
});

test('G16 HTTP: two simultaneous accepts of one Invitation give one 200 and one 409 and one membership', async t => {
    const f = await httpWorld(t);
    const results = await Promise.all([accepting(f.actors.pendingInvitee, f.invitationId), accepting(f.actors.pendingInvitee, f.invitationId), accepting(f.actors.pendingInvitee, f.invitationId)]);
    assert.deepEqual(results.map(response => response.status).sort(), [200, 409, 409]);
    const state = memberState(f.db, f.groupId);
    assert.equal(state.members.filter(row => row.user_id === f.actors.pendingInvitee.id).length, 1);
    assert.equal(state.intervals.filter(row => row.user_id === f.actors.pendingInvitee.id).length, 1);
    assert.equal(rows(f.db, "SELECT * FROM AuditLogs WHERE event_type = 'group.invitation.accepted' AND subject_id = ?", f.groupId).length, 1);
});

// ---------------------------------------------------------------------------------------------------------------
// T-5C-13 across processes: two server.js processes on one database file, started from the environment configuration
// (GROUPS_API_ENABLED and the GROUP_MAX_* settings), so each request runs in its own process and SQLite connection and the
// two transactions contend for the one write lock. The fixture clock is the wall clock at the start and is never advanced,
// because the child processes read the real time for sessions and Invitations.
// ---------------------------------------------------------------------------------------------------------------
const REPEATS = 20; // DB5-R15.5: twenty repeats per concurrent operation pair.
async function childServer(f, maxMembers) {
    const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...envDefaults, DB_PATH: f.filename, GROUPS_API_ENABLED: 'true', GROUP_MESSAGING_ENABLED: 'false', ATTACHMENTS_API_ENABLED: 'false',
            GROUP_MAX_MEMBERS: String(maxMembers), GROUP_MAX_PENDING_INVITATIONS_PER_GROUP: '50', GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE: '50' } });
    f.children.push(child);
    const port = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { child.kill(); reject(new Error('the child server did not start')); }, 20000);
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; const match = /listening on port (\d+)/.exec(output); if (match) { clearTimeout(timeout); resolve(Number(match[1])); } });
        child.stderr.on('data', () => {});
        child.once('exit', code => { clearTimeout(timeout); reject(new Error(`the child server exited with ${code}`)); });
    });
    return port;
}
// The same session on another server: the cookies and the CSRF token of the fixture actor, sent to that port.
function through(port, actor) {
    const browser = new Browser(`http://127.0.0.1:${port}`);
    browser.cookies = new Map(actor.browser.cookies);
    return Object.freeze({ browser, token: actor.token });
}
async function twoServers(t, maxMembers) {
    const f = await httpGroupFixture(t, { clock: createClock(new Date().toISOString()) });
    const ports = [await childServer(f, maxMembers), await childServer(f, maxMembers)];
    const as = (index, name) => through(ports[index], f.actors[name]);
    for (const index of [0, 1]) assert.equal((await actorRequest(as(index, 'owner'), 'GET', '/api/groups/feature-status')).status, 200, 'the child is up and the session works');
    return { f, as, repository: createGroupRepository(f.db) };
}
const sorted = values => [...values].sort((a, b) => a - b);

test('G16 across processes: two simultaneous accepts of one Invitation commit exactly one acceptance', async t => {
    const { f, as, repository } = await twoServers(t, 50);
    for (let repeat = 0; repeat < REPEATS; repeat++) {
        const group = f.builder.createGroup({ ownerId: f.actors.owner.id, title: `Accept race ${repeat}`, idempotencyKey: null });
        const invitation = f.builder.invite(group, f.actors.owner.id, f.actors.pendingInvitee.id);
        const before = memberState(f.db, group);
        const results = await Promise.all([accepting(as(0, 'pendingInvitee'), invitation), accepting(as(1, 'pendingInvitee'), invitation)]);
        assert.deepEqual(sorted(results.map(response => response.status)), [200, 409], `repeat ${repeat}: ${results.map(response => response.status)}`);
        assert.deepEqual(results.find(response => response.status === 409).body, error409);
        assert.equal(invitationRow(f.db, invitation).state, 'accepted');
        const state = memberState(f.db, group);
        assert.equal(state.revision, before.revision + 1, 'the revision rose exactly once');
        assert.equal(state.members.filter(row => row.user_id === f.actors.pendingInvitee.id && row.left_at === null).length, 1);
        assert.equal(state.intervals.filter(row => row.user_id === f.actors.pendingInvitee.id).length, 1, 'one interval');
        assert.deepEqual(eventsOf(f.db, group), ['group.invitation.accepted']);
        assert.deepEqual(repository.invariantReport(group), { activeOwners: 1, activeMembers: 2, openIntervals: 2, mismatches: 0 });
    }
});

test('P-05: generated invitation-heavy sequences preserve one pending row per group/invitee pair',{timeout:240000},async t=>{
    const coverage={requests:0,advances:0,refusals:0,successes:0,duplicate:0,limit:0,expiredReinvite:0,directSqlAttempts:0,managerIds:new Set(),inviteeIds:new Set(),limits:new Set()};
    const runs=20,events=30,seed=0x5c050029,targets=['pendingInvitee','removedMember','nonMember'];
    await forAll('P-05',{runs,seed,onRun:line=>t.diagnostic(line),describe:plan=>plan.events.map((event,index)=>`${index}:${event.kind}:${event.actor}:${event.target}`)},
        (random,info)=>({perGroup:info.run%4+1,perInvitee:(info.run*3)%4+1,events:Array.from({length:events},(_,index)=>{
            if(index===0)return{kind:'invite',actor:'owner',target:'pendingInvitee'};
            if(index===1)return{kind:'advance',ms:INVITATION_EXPIRY_MS+1};
            if(index===2)return{kind:'invite',actor:'admin',target:'pendingInvitee'};
            if(index===3)return{kind:'invite',actor:'admin',target:'nonMember'};
            if(index===4)return{kind:'invite',actor:'owner',target:'pendingInvitee'};
            return random.bool(0.25)?{kind:'advance',ms:random.int(0,2)*INVITATION_EXPIRY_MS}:
                {kind:'invite',actor:random.pick(['owner','admin']),target:random.pick(targets)};
        })}),async(plan,info)=>{
            const w=await world(t,{features:withMaxima(plan.perGroup,plan.perInvitee)}),svc=w.svc;
            const state=[];
            // Known fixture input: one pending owner -> pendingInvitee row, created at the injected fixture time.
            state.push({id:w.invitationId,conversation_id:w.groupId,invitee_id:w.who.pendingInvitee.id,inviter_id:w.who.owner.id,
                state:'pending',created_at:w.clock.iso(),expires_at:isoPlus(w.clock.iso(),INVITATION_EXPIRY_MS),resolved_at:null});
            coverage.limits.add(plan.perGroup);coverage.inviteeIds.add('pendingInvitee');
            const actualRows=()=>rows(w.db,'SELECT invitation_id AS id,conversation_id,invitee_id,inviter_id,state,created_at,expires_at,resolved_at FROM ConversationInvitations WHERE conversation_id=? ORDER BY invitation_id',w.groupId);
            const pendingAt=(items,at)=>items.filter(row=>row.state==='pending'&&Date.parse(row.expires_at)>at);
            const assertModel=()=>{
                const actual=actualRows();
                assert.deepEqual(actual,state.slice().sort((a,b)=>a.id.localeCompare(b.id)),'P-05 every persisted Invitation equals independent transition model');
                const pairs=new Set();
                for(const row of actual)if(row.state==='pending') {
                    const pair=`${row.conversation_id}:${row.invitee_id}`;assert.ok(!pairs.has(pair),`P-05 duplicate pending pair ${pair}`);pairs.add(pair);
                }
            };
            assertModel();
            for(let index=0;index<plan.events.length;index++) {
                const event=plan.events[index],before=snapshot(w.db),at=w.clock.now();
                if(event.kind==='advance') {w.clock.advance(event.ms);coverage.advances++;assert.deepEqual(snapshot(w.db),before,'P-05 clock advances do not write rows');assertModel();continue;}
                const actor=w.who[event.actor],invitee=w.who[event.target];coverage.managerIds.add(event.actor);coverage.inviteeIds.add(event.target);
                const prior=state.find(row=>row.invitee_id===invitee.id&&row.state==='pending');
                const expiredPrior=prior&&Date.parse(prior.expires_at)<=at;
                const candidate=state.map(row=>row===prior&&expiredPrior?{...row,state:'expired',resolved_at:w.clock.iso()}:row);
                const groupCount=pendingAt(candidate,at).length;
                const inviteeCount=candidate.filter(row=>row.invitee_id===invitee.id&&row.state==='pending'&&Date.parse(row.expires_at)>at).length;
                const duplicate=prior&&!expiredPrior;
                const limited=!duplicate&&(groupCount>=plan.perGroup||inviteeCount>=plan.perInvitee);
                const expected=duplicate||limited?409:201;
                let result;
                try {result=invite(w,actor,{userId:invitee.id},w.groupId,svc);}
                catch(error) {assertAuth(error,'CONFLICT',409);result=null;}
                const actual=result?201:409;assert.equal(actual,expected,`P-05 seed=${info.seed} run=${info.run} step=${index}`);coverage.requests++;
                if(expected===409) {
                    coverage.refusals++;if(duplicate)coverage.duplicate++;if(limited)coverage.limit++;
                    assert.deepEqual(snapshot(w.db),before,'P-05 refused duplicate or limit request is atomic');
                } else {
                    coverage.successes++;
                    if(expiredPrior) {state.splice(state.indexOf(prior),1,{...prior,state:'expired',resolved_at:w.clock.iso()});coverage.expiredReinvite++;}
                    const created=result.invitation;
                    assert.deepEqual([created.inviterId,created.invitee.id,created.state,created.createdAt,created.expiresAt],
                        [actor.id,invitee.id,'pending',w.clock.iso(),isoPlus(w.clock.iso(),INVITATION_EXPIRY_MS)]);
                    state.push({id:created.id,conversation_id:w.groupId,invitee_id:invitee.id,inviter_id:actor.id,state:'pending',
                        created_at:w.clock.iso(),expires_at:isoPlus(w.clock.iso(),INVITATION_EXPIRY_MS),resolved_at:null});
                }
                assertModel();
            }
            const pending=state.find(row=>row.state==='pending');assert.ok(pending,'P-05 direct INSERT needs an existing pending pair');
            const before=snapshot(w.db),duplicateId=`p05-duplicate-${info.run}`;
            assert.throws(()=>w.db.prepare(`INSERT INTO ConversationInvitations(invitation_id,conversation_id,invitee_id,inviter_id,state,created_at,expires_at,resolved_at)
                VALUES(?,?,?,?, 'pending',?,?,NULL)`).run(duplicateId,pending.conversation_id,pending.invitee_id,pending.inviter_id,w.clock.iso(),isoPlus(w.clock.iso(),INVITATION_EXPIRY_MS)),
                /uq_invitations_pending|UNIQUE constraint failed/i,'P-05 unique pending index rejects a direct duplicate INSERT');
            assert.deepEqual(snapshot(w.db),before,'P-05 rejected direct INSERT leaves database unchanged');coverage.directSqlAttempts++;
            assertModel();
        });
    t.diagnostic(`P-05 coverage ${JSON.stringify({requests:coverage.requests,refusals:coverage.refusals,successes:coverage.successes,
        duplicates:coverage.duplicate,limit:coverage.limit,expiredReinvites:coverage.expiredReinvite,directSqlAttempts:coverage.directSqlAttempts,
        managers:coverage.managerIds.size,invitees:coverage.inviteeIds.size,limits:[...coverage.limits]})}`);
    assert.equal(coverage.requests+coverage.advances,runs*events);assert.ok(coverage.duplicate>0);assert.ok(coverage.limit>0);assert.ok(coverage.expiredReinvite>0);
    assert.equal(coverage.directSqlAttempts,runs);assert.equal(coverage.managerIds.size,2);assert.equal(coverage.inviteeIds.size,3);
    assert.deepEqual([...coverage.managerIds].sort(),['admin','owner']);assert.deepEqual([...coverage.inviteeIds].sort(),['nonMember','pendingInvitee','removedMember']);
    assert.deepEqual([...coverage.limits].sort(),[1,2,3,4]);
});

test('AF-05: duplicate pending invitations are rejected',async t=>{
    const w=await world(t),before=rows(w.db,'SELECT * FROM ConversationInvitations WHERE conversation_id=? ORDER BY invitation_id',w.groupId);
    refusal(thrown(()=>invite(w,w.who.admin,{userId:w.who.pendingInvitee.id})),'CONFLICT',409);
    const after=rows(w.db,'SELECT * FROM ConversationInvitations WHERE conversation_id=? ORDER BY invitation_id',w.groupId);
    assert.equal(after.filter(row=>row.invitee_id===w.who.pendingInvitee.id&&row.state==='pending').length,1);
    assert.equal(after.length,before.length,'duplicate invitation adds no row');
    const pending=after.find(row=>row.invitee_id===w.who.pendingInvitee.id&&row.state==='pending');
    assert.throws(()=>w.db.prepare(`INSERT INTO ConversationInvitations(invitation_id,conversation_id,invitee_id,inviter_id,state,created_at,expires_at,resolved_at)
        VALUES(?,?,?,?, 'pending',?,?,NULL)`).run('af05-direct-duplicate',pending.conversation_id,pending.invitee_id,pending.inviter_id,
        w.clock.iso(),isoPlus(w.clock.iso(),INVITATION_EXPIRY_MS)),/uq_invitations_pending|UNIQUE constraint failed/i);
    assert.equal(rows(w.db,'SELECT count(*) AS n FROM ConversationInvitations WHERE conversation_id=?',w.groupId)[0].n,before.length);
});

async function exerciseP06Scenario(t,mode,run=0) {
    const w=await world(t),svc=w.service({groupApi:true,groups:{...FEATURES.groups,directAdd:true}});
    const owner=w.who.owner,admin=w.who.admin,outsider=w.who.nonMember;
    let subject,inviteId,invitee;
    if(mode==='direct-add-then-remove') {
        subject=w.who.pendingInvitee;inviteId=w.invitationId;invitee=subject;
        svc.addMember(owner.context,owner.proof,w.groupId,{userId:subject.id});
    } else {
        subject=admin;
        seed(w.db,{id:`p06-to-${run}`,groupId:w.groupId,invitee:subject.id,inviter:owner.id,createdAt:w.clock.iso(),expiresAt:isoPlus(w.clock.iso(),INVITATION_EXPIRY_MS)});
        const issued=invite(w,admin,{userId:outsider.id},w.groupId,svc);inviteId=issued.invitation.id;invitee=outsider;
    }
    const incomingAndOutgoing=rows(w.db,"SELECT * FROM ConversationInvitations WHERE conversation_id=? AND state='pending' AND (invitee_id=? OR inviter_id=?) ORDER BY invitation_id",w.groupId,subject.id,subject.id);
    assert.ok(incomingAndOutgoing.length>=1,`P-06 ${mode} has invitations to/from removed user`);
    const beforeRemoval=memberState(w.db,w.groupId),revisionBefore=beforeRemoval.revision;
    if(mode==='leave')svc.leaveGroup(subject.context,subject.proof,w.groupId);
    else svc.removeMember(owner.context,owner.proof,w.groupId,subject.id);
    const afterRemoval=memberState(w.db,w.groupId),revisionAfterRemoval=afterRemoval.revision;
    assert.equal(revisionAfterRemoval,revisionBefore+1,'P-06 committed leave/removal increments revision once');
    for(const old of incomingAndOutgoing) {
        const resolved=invitationRow(w.db,old.invitation_id);assert.deepEqual([resolved.state,resolved.resolved_at],['cancelled',w.clock.iso()]);
    }
    assert.ok(!afterRemoval.members.some(row=>row.user_id===subject.id&&row.left_at===null),'P-06 removed user has no active membership');
    assert.equal(afterRemoval.intervals.filter(row=>row.user_id===subject.id&&row.left_at===null&&row.last_seq===null).length,0,
        'P-06 removed user has no open interval');
    const staleActor=subject;
    if(mode!=='leave') {
        for(const request of [
            ()=>invite(w,staleActor,{userId:outsider.id},w.groupId,svc),
            ()=>svc.addMember(staleActor.context,staleActor.proof,w.groupId,{userId:outsider.id}),
            ()=>svc.removeMember(staleActor.context,staleActor.proof,w.groupId,w.who.member.id),
            ()=>svc.changeMemberRole(staleActor.context,staleActor.proof,w.groupId,w.who.member.id,{role:'admin'})
        ]) {const before=snapshot(w.db);assertAuth(thrown(request),'NOT_FOUND',404);assert.deepEqual(snapshot(w.db),before,'P-06 stale removed-actor refusal changes no row');}
    }
    assertAuth(thrown(()=>w.svc.getGroup(subject.context,w.groupId)),'NOT_FOUND',404,'removed user cannot see group');
    const revisionBeforeAccept=memberState(w.db,w.groupId).revision,acceptedAudits=inviteAudit(w.db,w.groupId).filter(row=>row.event_type==='group.invitation.accepted').length;
    const beforeAccept=snapshot(w.db);
    refusal(thrown(()=>accept(w,invitee,inviteId,svc)),'CONFLICT',409);
    assert.deepEqual(snapshot(w.db),beforeAccept,'P-06 cancelled-invitation replay is a no-op');
    assert.equal(memberState(w.db,w.groupId).revision,revisionBeforeAccept,'P-06 refused replay does not change revision');
    refusal(thrown(()=>accept(w,owner,inviteId,svc)),'NOT_FOUND',404);
    assert.equal(inviteAudit(w.db,w.groupId).filter(row=>row.event_type==='group.invitation.accepted').length,acceptedAudits,
        'P-06 replay writes no invitation.accepted audit');
    w.clock.advance(1000);const newInvitation=invite(w,owner,{userId:subject.id},w.groupId,svc).invitation;
    assert.equal(newInvitation.createdAt,w.clock.iso(),'P-06 a new invitation may be created after the removal');
    const revisionBeforeNewAccept=memberState(w.db,w.groupId).revision;
    const rejoined=accept(w,subject,newInvitation.id,svc);
    assert.equal(rejoined.group.role,'member','P-06 rejoin occurs only through the new post-removal invitation');
    assert.equal(memberState(w.db,w.groupId).revision,revisionBeforeNewAccept+1);
    return {w,svc,subject,inviteId,invitee,revisionAfterRemoval};
}

test('P-06: generated removal and leave scenarios cancel all invitations to or from the departing user',{timeout:240000},async t=>{
    const modes=['direct-add-then-remove','inviter-removed','leave'],coverage={modes:new Set(),scenarios:0,relatedCancelled:0,staleRefusals:0};
    await forAll('P-06',{runs:24,seed:0x5c060030,onRun:line=>t.diagnostic(line),describe:mode=>[mode]},
        (_random,info)=>modes[info.run%modes.length],async(mode,info)=>{
            const result=await exerciseP06Scenario(t,mode,info.run);coverage.modes.add(mode);coverage.scenarios++;
            coverage.relatedCancelled+=rows(result.w.db,"SELECT * FROM ConversationInvitations WHERE conversation_id=? AND state='cancelled' AND (invitee_id=? OR inviter_id=?)",
                result.w.groupId,result.subject.id,result.subject.id).length;
            if(mode!=='leave')coverage.staleRefusals+=4;
        });
    t.diagnostic(`P-06 coverage ${JSON.stringify({scenarios:coverage.scenarios,modes:[...coverage.modes],relatedCancelled:coverage.relatedCancelled,staleRefusals:coverage.staleRefusals})}`);
    assert.equal(coverage.scenarios,24);assert.deepEqual([...coverage.modes].sort(),['direct-add-then-remove','inviter-removed','leave']);
    assert.ok(coverage.relatedCancelled>=24);assert.equal(coverage.staleRefusals,64);
});

test('AF-03: an invitation issued before removal cannot restore the removed member',async t=>{
    for(const mode of ['direct-add-then-remove','inviter-removed'])await exerciseP06Scenario(t,mode,`af03-${mode}`);
});

test('G16 across processes: an accept and a cancel of the same Invitation end in one of the two legal serial outcomes', async t => {
    const { f, as, repository } = await twoServers(t, 50);
    const outcomes = new Set();
    for (let repeat = 0; repeat < REPEATS; repeat++) {
        const group = f.builder.createGroup({ ownerId: f.actors.owner.id, title: `Accept or cancel ${repeat}`, idempotencyKey: null });
        const invitation = f.builder.invite(group, f.actors.owner.id, f.actors.pendingInvitee.id);
        const before = memberState(f.db, group);
        const [accepted, cancelled] = await Promise.all([accepting(as(0, 'pendingInvitee'), invitation),
            actorRequest(as(1, 'owner'), 'DELETE', `/api/groups/${group}/invitations/${invitation}`)]);
        const state = memberState(f.db, group);
        const joined = state.members.some(row => row.user_id === f.actors.pendingInvitee.id && row.left_at === null);
        if (accepted.status === 200) {
            assert.equal(cancelled.status, 409, `repeat ${repeat}: accept first`);
            assert.deepEqual([invitationRow(f.db, invitation).state, joined, state.revision], ['accepted', true, before.revision + 1]);
            assert.deepEqual(eventsOf(f.db, group), ['group.invitation.accepted']);
            outcomes.add('accept first');
        } else {
            assert.deepEqual([accepted.status, cancelled.status], [409, 204], `repeat ${repeat}: cancel first`);
            assert.deepEqual([invitationRow(f.db, invitation).state, joined, state.revision], ['cancelled', false, before.revision]);
            assert.deepEqual(eventsOf(f.db, group), ['group.invitation.cancelled']);
            outcomes.add('cancel first');
        }
        assert.deepEqual(repository.invariantReport(group), { activeOwners: 1, activeMembers: joined ? 2 : 1, openIntervals: joined ? 2 : 1, mismatches: 0 });
    }
    assert.ok(outcomes.size >= 1);
});

test('G16 across processes: two invitees racing for the last free slot commit one acceptance, and the other Invitation is cancelled', async t => {
    const { f, as, repository } = await twoServers(t, 2);
    for (let repeat = 0; repeat < REPEATS; repeat++) {
        const group = f.builder.createGroup({ ownerId: f.actors.owner.id, title: `Last slot ${repeat}`, idempotencyKey: null });
        const first = f.builder.invite(group, f.actors.owner.id, f.actors.pendingInvitee.id);
        const second = f.builder.invite(group, f.actors.owner.id, f.actors.nonMember.id);
        const before = memberState(f.db, group);
        const results = await Promise.all([accepting(as(0, 'pendingInvitee'), first), accepting(as(1, 'nonMember'), second)]);
        assert.deepEqual(sorted(results.map(response => response.status)), [200, 409], `repeat ${repeat}: ${results.map(response => response.status)}`);
        const states = [invitationRow(f.db, first).state, invitationRow(f.db, second).state].sort();
        assert.deepEqual(states, ['accepted', 'cancelled']);
        const state = memberState(f.db, group);
        assert.equal(state.members.filter(row => row.left_at === null).length, 2, 'the maximum of 2 was not exceeded');
        assert.equal(state.revision, before.revision + 1);
        assert.deepEqual(eventsOf(f.db, group).sort(), ['group.invitation.accepted', 'group.invitation.cancelled']);
        assert.deepEqual(repository.invariantReport(group), { activeOwners: 1, activeMembers: 2, openIntervals: 2, mismatches: 0 });
    }
});
