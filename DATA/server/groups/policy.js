// T-5B-09. Pure rules of the Group_Service (design, section Group_Service: policy.js).
// Requirements: DB5-R04.1, R04.8 to R04.10, R04.15, DB5-R05.1 to R05.4, DB5-R06.7, R06.8, R06.13, DB5-R07.2, R07.10,
// DB5-R08.1, R08.12.
// This file loads no other module: no database, no HTTP, no clock and no environment variable. Time is always a
// parameter (the caller passes its injected server time), so every function returns one answer for one input.
// Entries that follow an open Project_Owner decision carry its OD flag and provisional: true. They implement exactly the
// provisional default printed in the requirements, so a later decision changes this file and no schema.

const ROLES = Object.freeze(['owner', 'admin', 'member']);
// OD-05 (decided): exactly these two values, chosen at group creation and immutable afterwards.
const HISTORY_POLICIES = Object.freeze(['all', 'from_joined']);
// OD-08 (decided in part): the Invitation expiry is a fixed 7 days. It is no setting and nothing overrides it.
const INVITATION_EXPIRY_SECONDS = 604800;
// OD-03 provisional default: the former owner becomes admin after a transfer (DB5-R06.8).
const FORMER_OWNER_ROLE = 'admin';
// Message sequences start at 1 (highWater + 1, and GroupMembershipIntervals.first_seq >= 1).
const MIN_SEQ = 1;

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

// The OD items whose provisional default (or decided value) this file applies. provisional is true when the behavior
// here follows a default that the Project_Owner has not yet decided.
const DECISIONS = deepFreeze({
    'OD-01': { state: 'decided in part', provisional: true,
        rule: 'Direct add stays disabled (decided, answered 503 before the matrix). Open: friendship with the inviter; until decided there is no friendship rule beyond blocks, so invitationRevalidation has no friendship check.' },
    'OD-02': { state: 'open', provisional: true, rule: 'Only the owner and admins may invite or add a user.' },
    'OD-03': { state: 'open', provisional: true,
        rule: 'Admin permissions as printed in DB5-R06.13 (no metadata edit, may cancel Invitations, may not remove admins, may not delete others\' attachments); the former owner becomes admin after a transfer.' },
    'OD-05': { state: 'decided', provisional: false, rule: 'The History_Policy is all or from_joined, chosen at creation only; no role may change it.' },
    'OD-06': { state: 'open', provisional: true,
        rule: 'permittedRanges keeps every earlier Membership_Interval of the requester and never includes a gap between intervals.' },
    'OD-07': { state: 'open', provisional: true,
        rule: 'permittedRanges does not depend on the sender, so content of a departed member stays visible; a departed member holds no role, so roleMatrix refuses every action.' },
    'OD-08': { state: 'decided in part', provisional: false, rule: 'The Invitation expiry is the constant INVITATION_EXPIRY_SECONDS (604800 seconds).' },
    'OD-09': { state: 'open', provisional: true, rule: 'Archive only: roleMatrix has no delete or unarchive action.' },
    'OD-10': { state: 'open', provisional: true, rule: 'The owner cannot leave (leave refused until transfer) and no automatic transfer exists.' },
    'OD-11': { state: 'open', provisional: true, rule: 'A block between inviter and invitee fails the acceptance re-validation; existing co-membership is unchanged.' },
    'OD-13': { state: 'open', provisional: true, rule: 'Only the sender or uploader may tombstone a message or delete an attachment; roleMatrix refuses the moderation actions for every role.' },
});

function cell(text, ...od) {
    return { allowed: text.startsWith('allowed'), text, od, provisional: od.some(id => DECISIONS[id].provisional) };
}
const INVITE_FLAGS = ['OD-01', 'OD-02', 'OD-03'];

// DB5-R06.13. The ten rows marked printed: true copy the table of the requirements (label and cell text as printed).
// Each cell also lists every OD item its value depends on: the printed flags, plus OD-03 for the admin cells it names
// (edit metadata, remove admins), OD-10 for the owner leave (DB5-R05.7) and OD-09 for archive. The two rows marked
// printed: false hold the moderation default of OD-13, which the printed table has no row for.
const ROLE_MATRIX = deepFreeze([
    { label: 'Read group, members, permitted history', printed: true, actions: ['read'],
        cells: { owner: cell('allowed'), admin: cell('allowed'), member: cell('allowed') } },
    { label: 'Change name or description', printed: true, actions: ['updateMetadata'],
        cells: { owner: cell('allowed'), admin: cell('refused', 'OD-03'), member: cell('refused') } },
    { label: 'Change History_Policy', printed: true, actions: ['changeHistoryPolicy'],
        cells: { owner: cell('refused (OD-05: chosen at creation only)', 'OD-05'), admin: cell('refused', 'OD-05'), member: cell('refused', 'OD-05') } },
    { label: 'Invite or add a user (OD-01, OD-02, OD-03)', printed: true, actions: ['invite', 'addMember'],
        cells: { owner: cell('allowed', ...INVITE_FLAGS), admin: cell('allowed', ...INVITE_FLAGS), member: cell('refused', ...INVITE_FLAGS) } },
    { label: 'Cancel an Invitation', printed: true, actions: ['cancelInvitation'],
        cells: { owner: cell('allowed'), admin: cell('allowed (OD-03)', 'OD-03'), member: cell('refused') } },
    { label: 'Remove a member', printed: true, actions: ['removeMember'],
        cells: { owner: cell('allowed'), admin: cell('allowed'), member: cell('refused') } },
    { label: 'Remove an admin', printed: true, actions: ['removeAdmin'],
        cells: { owner: cell('allowed'), admin: cell('refused', 'OD-03'), member: cell('refused') } },
    { label: 'Change a role or transfer ownership', printed: true, actions: ['changeRole', 'transferOwnership'],
        cells: { owner: cell('allowed'), admin: cell('refused'), member: cell('refused') } },
    { label: 'Leave the group', printed: true, actions: ['leave'],
        cells: { owner: cell('refused until transfer', 'OD-10'), admin: cell('allowed'), member: cell('allowed') } },
    { label: 'Archive the group (DB5-R07)', printed: true, actions: ['archive'],
        cells: { owner: cell('allowed', 'OD-09'), admin: cell('refused'), member: cell('refused') } },
    { label: 'Tombstone another member\'s message', printed: false, actions: ['tombstoneOthersMessage'],
        cells: { owner: cell('refused', 'OD-13'), admin: cell('refused', 'OD-13'), member: cell('refused', 'OD-13') } },
    { label: 'Delete another member\'s attachment', printed: false, actions: ['deleteOthersAttachment'],
        cells: { owner: cell('refused', 'OD-13'), admin: cell('refused', 'OD-03', 'OD-13'), member: cell('refused', 'OD-13') } },
]);
const ACTION_ROWS = new Map(ROLE_MATRIX.flatMap(row => row.actions.map(action => [action, row])));
const ACTIONS = Object.freeze([...ACTION_ROWS.keys()]);
// DB5-R07.2 and R07.10: refused with 409 while the group is archived. The role check comes first (403), as in the
// refusal order of update and invite. Read, leave (DB5-R07.11) and the other actions are not on the printed list.
const ARCHIVE_REFUSED = Object.freeze(['updateMetadata', 'invite', 'addMember', 'changeRole', 'transferOwnership', 'archive']);

// roleMatrix(role, action, {archived}) -> {action, role, allowed, refusal, od, provisional}
// refusal is null when allowed, 'notMember' for a role outside owner/admin/member (the caller answers 404),
// 'role' when the matrix refuses the role (403), 'immutable' for the owner's History_Policy change (answered by the
// 400 validation of DB5-R02.13), or 'archived' when the role may act but the group is archived (409).
function roleMatrix(role, action, options = {}) {
    const row = ACTION_ROWS.get(action);
    if (!row) throw new TypeError('unknown group action');
    const archived = options.archived ?? false;
    if (typeof archived !== 'boolean') throw new TypeError('archived must be a boolean');
    if (!ROLES.includes(role)) return Object.freeze({ action, role: null, allowed: false, refusal: 'notMember', od: Object.freeze([]), provisional: false });
    const entry = row.cells[role];
    let refusal = null;
    if (!entry.allowed) refusal = action === 'changeHistoryPolicy' && role === 'owner' ? 'immutable' : 'role';
    else if (archived && ARCHIVE_REFUSED.includes(action)) refusal = 'archived';
    return Object.freeze({ action, role, allowed: refusal === null, refusal, od: entry.od, provisional: entry.provisional });
}

// removalDecision(actorRole, targetRole) -> 'allow' | 'forbidden' (403) | 'conflict' (409). DB5-R05.1 to R05.4, R05.16.
// The caller answers 404 first for a requester or target that is not an Active_Member; any other value is refused.
function removalDecision(actorRole, targetRole) {
    if (!ROLES.includes(actorRole) || !ROLES.includes(targetRole)) return 'forbidden';
    if (targetRole === 'owner') return actorRole === 'owner' ? 'conflict' : 'forbidden';
    return roleMatrix(actorRole, targetRole === 'admin' ? 'removeAdmin' : 'removeMember').allowed ? 'allow' : 'forbidden';
}

const nonEmptyString = value => typeof value === 'string' && value.length > 0;

// transferDecision({actorId, actorRole, targetId, targetRole, archived, precondition, revision})
// -> {decision, ...}. decision is, in the order of DB5-R06.17 and the design: 'notFound' (requester not active, 404),
// 'forbidden' (not the owner, 403), 'conflict' (archived, 409, DB5-R07.2), 'invalid' (target missing, not active, the
// requester or an owner, 400), 'stale' (a Membership_Revision precondition that differs, 409), or 'allow'. An allowed
// transfer lists its two role writes in commit order: demote the owner first, then promote the target, because the
// index uq_members_active_owner rejects the reverse order. The Membership_Revision increases once.
function transferDecision(input) {
    if (!input || typeof input !== 'object') throw new TypeError('transfer input must be an object');
    const { actorId, actorRole, targetId, targetRole, precondition, revision } = input;
    if (!nonEmptyString(actorId)) throw new TypeError('actorId must be a non-empty string');
    const permission = roleMatrix(actorRole, 'transferOwnership', { archived: input.archived ?? false });
    const refused = { notMember: 'notFound', role: 'forbidden', archived: 'conflict' }[permission.refusal];
    if (refused) return Object.freeze({ decision: refused });
    if (!nonEmptyString(targetId) || targetId === actorId || !ROLES.includes(targetRole) || targetRole === 'owner') return Object.freeze({ decision: 'invalid' });
    if (precondition !== undefined && precondition !== null && precondition !== revision) return Object.freeze({ decision: 'stale' });
    return deepFreeze({
        decision: 'allow',
        formerOwnerRole: FORMER_OWNER_ROLE,
        steps: [{ userId: actorId, from: 'owner', to: FORMER_OWNER_ROLE }, { userId: targetId, from: targetRole, to: 'owner' }],
        revisionIncrement: 1,
        od: ['OD-03'],
        provisional: DECISIONS['OD-03'].provisional,
    });
}

function readInterval(interval) {
    if (!interval || typeof interval !== 'object') throw new TypeError('a membership interval must be an object');
    const first = interval.first_seq;
    const last = interval.last_seq;
    // A missing last_seq is refused instead of being read as an open interval, so a misnamed field never widens access.
    if (last === undefined) throw new TypeError('last_seq must be null (open) or an integer');
    if (!Number.isSafeInteger(first) || first < MIN_SEQ) throw new RangeError('first_seq must be an integer of at least 1');
    if (last !== null && (!Number.isSafeInteger(last) || last < first - 1)) throw new RangeError('last_seq must be null or at least first_seq - 1');
    return { first, last };
}
function byStart(a, b) {
    if (a.first !== b.first) return a.first - b.first;
    if ((a.last === null) !== (b.last === null)) return a.last === null ? 1 : -1;
    return a.last === null ? 0 : a.last - b.last;
}
function appendRange(ranges, from, to) {
    const previous = ranges[ranges.length - 1];
    if (previous && previous.to !== null && previous.to + 1 === from) previous.to = to;
    else ranges.push({ from, to });
}

// permittedRanges(intervals, policy) -> [{from, to}], DB5-R08.12. intervals are rows {first_seq, last_seq} with
// last_seq null for the open interval and last_seq = first_seq - 1 for an empty one. The permitted sequences are those
// inside the intervals (an open interval has no upper bound) and, under the policy all only, the sequences below the
// first_seq of the earliest interval. Earlier intervals stay permitted and gaps never are (OD-06 provisional default).
// The result is sorted, holds no empty range, merges adjacent ranges and marks no upper bound with to: null.
// Overlapping intervals, more than one open interval or an open interval before a closed one are refused (RangeError).
function permittedRanges(intervals, policy) {
    if (!HISTORY_POLICIES.includes(policy)) throw new TypeError('unknown history policy');
    if (!Array.isArray(intervals)) throw new TypeError('intervals must be an array');
    const sorted = intervals.map(readInterval).sort(byStart);
    for (let index = 1; index < sorted.length; index += 1) {
        const previous = sorted[index - 1];
        if (previous.last === null || sorted[index].first <= previous.last) throw new RangeError('membership intervals must be disjoint and ordered');
    }
    const ranges = [];
    if (policy === 'all' && sorted.length > 0 && sorted[0].first > MIN_SEQ) appendRange(ranges, MIN_SEQ, sorted[0].first - 1);
    for (const { first, last } of sorted) if (last === null || last >= first) appendRange(ranges, first, last);
    return deepFreeze(ranges);
}

// inRanges(seq, ranges) -> boolean. A value that is not a message sequence (an integer of at least 1) is never inside.
function inRanges(seq, ranges) {
    if (!Array.isArray(ranges)) throw new TypeError('ranges must be an array');
    if (!Number.isSafeInteger(seq) || seq < MIN_SEQ) return false;
    return ranges.some(({ from, to }) => seq >= from && (to === null || seq <= to));
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
function instant(value, name) {
    if (Number.isSafeInteger(value)) return value;
    if (typeof value === 'string' && ISO_UTC.test(value)) {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    throw new TypeError(`${name} must be epoch milliseconds or an ISO 8601 UTC time`);
}

// Checks of the acceptance re-validation, in the order they are applied (DB5-R04.8 to R04.10, R04.22; design, accept).
const INVITATION_CHECKS = Object.freeze([
    'pending', // R04.22: not pending -> 409 and no record changed
    'unexpired', // R04.9, R04.15: server time at or after the expiry -> state expired
    'inviteeNotMember', // R04.10: invitee already an Active_Member -> state cancelled, member row untouched
    'groupExists',
    'groupNotArchived',
    'inviterActive', // inviter still an Active_Member
    'inviterMayInvite', // with a role that DB5-R06 permits to invite (roleMatrix invite; OD-02)
    'noBlock', // no block in either direction between inviter and invitee (OD-11)
    'memberMaximum', // acceptance would not exceed the member maximum (OD-04 decided, configuration value)
    'inviteeNotRemovedSinceCreation', // the invitee left or was removed at or after the Invitation creation (AF-03)
]);
const verdict = (check, outcome) => Object.freeze({ ok: check === null, check, outcome });

// invitationRevalidation(state) -> {ok, check, outcome}. check names the first failing check of INVITATION_CHECKS,
// or is null when every check passes. outcome is the Invitation state to write: 'accepted', 'expired' (the expiry has
// passed, whatever else fails), 'cancelled' (any other failing check) or 'unchanged' (the Invitation is not pending).
// state = {
//   now,                                  server time, epoch milliseconds or ISO 8601 UTC (injected, never read here)
//   invitation: {state, createdAt, expiresAt},  expiresAt may be null; the earlier of expiresAt and
//                                         createdAt + INVITATION_EXPIRY_SECONDS applies
//   group: {archived} | null,             null when the group does not exist
//   inviter: {role} | null,               the inviter's Active_Member row, null when not active
//   invitee: {active, leftAt},            active: an Active_Member now; leftAt: latest left time or null (required)
//   blocked,                              a block exists in either direction between inviter and invitee
//   activeMembers, maxMembers,            the Active_Member count and the configured maximum
// }
// Any value other than false for group.archived, invitee.active or blocked fails its check (least access).
// The friendship sub-question of OD-01 is open, so no friendship check exists.
function invitationRevalidation(state) {
    if (!state || typeof state !== 'object') throw new TypeError('state must be an object');
    const { invitation, group, inviter, invitee, blocked, activeMembers, maxMembers } = state;
    if (!invitation || typeof invitation !== 'object') throw new TypeError('invitation must be an object');
    if (!invitee || typeof invitee !== 'object') throw new TypeError('invitee must be an object');
    if (invitee.leftAt === undefined) throw new TypeError('invitee.leftAt must be null or a time');
    const now = instant(state.now, 'now');
    const createdAt = instant(invitation.createdAt, 'invitation.createdAt');
    let expiresAt = createdAt + INVITATION_EXPIRY_SECONDS * 1000;
    if (invitation.expiresAt !== undefined && invitation.expiresAt !== null) expiresAt = Math.min(expiresAt, instant(invitation.expiresAt, 'invitation.expiresAt'));
    const leftAt = invitee.leftAt === null ? null : instant(invitee.leftAt, 'invitee.leftAt');

    if (invitation.state !== 'pending') return verdict('pending', 'unchanged');
    if (now >= expiresAt) return verdict('unexpired', 'expired');
    if (invitee.active !== false) return verdict('inviteeNotMember', 'cancelled');
    if (!group || typeof group !== 'object') return verdict('groupExists', 'cancelled');
    if (group.archived !== false) return verdict('groupNotArchived', 'cancelled');
    if (!inviter || typeof inviter !== 'object' || !ROLES.includes(inviter.role)) return verdict('inviterActive', 'cancelled');
    if (!roleMatrix(inviter.role, 'invite').allowed) return verdict('inviterMayInvite', 'cancelled');
    if (blocked !== false) return verdict('noBlock', 'cancelled');
    if (!Number.isSafeInteger(maxMembers) || maxMembers < 1 || !Number.isSafeInteger(activeMembers) || activeMembers < 0 ||
        activeMembers >= maxMembers) return verdict('memberMaximum', 'cancelled');
    if (leftAt !== null && leftAt >= createdAt) return verdict('inviteeNotRemovedSinceCreation', 'cancelled');
    return verdict(null, 'accepted');
}

module.exports = Object.freeze({
    ROLES,
    HISTORY_POLICIES,
    INVITATION_EXPIRY_SECONDS,
    FORMER_OWNER_ROLE,
    DECISIONS,
    ROLE_MATRIX,
    ACTIONS,
    ARCHIVE_REFUSED,
    INVITATION_CHECKS,
    roleMatrix,
    removalDecision,
    transferDecision,
    permittedRanges,
    inRanges,
    invitationRevalidation,
});
