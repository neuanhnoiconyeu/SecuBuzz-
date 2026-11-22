// T-5C-11 and T-5C-12: the Invitation operations of the Group_Service (DB5-R04.1 to R04.7, R04.13 to R04.22, R12.4, R12.8).
// Service level: createInvitation (G12), listInvitations (G13), cancelInvitation (G14), listOwnInvitations (G15) and
// declineInvitation (G17) are called directly with real sessions and real CSRF proofs from the loopback application of
// support/groups.js. The HTTP adapters and their tests belong to the router tasks. Temporary databases only.
// Two clocks: the fixture clock stays where it is, so the sessions of the fixture stay valid, and the service clock moves,
// so Invitations age without logging anybody out.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { httpGroupFixture, snapshot, changedTables, createClock, openLimiter, INVITATION_EXPIRY_MS } = require('./support/groups');
const { createRepositories } = require('../server/database/repositories');
const { AuthError } = require('../server/auth/errors');
const { INVITATION_EXPIRY_SECONDS, roleMatrix } = require('../server/groups/policy');
const codec = require('../server/groups/cursor');
const { createGroupService } = require('../server/groups/service');

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
