'use strict';

// T-5B-13. Request validators of the Group_API (design: module layout, groups/validation.js; API contracts: groups,
// rows G01 to G26; Error model; ASM-01). Requirements: DB5-R01.4 to R01.7, R01.12, R01.15, DB5-R02.5 to R02.7, R02.10,
// R02.13, R02.14, DB5-R03.7, DB5-R06.4, R06.9, DB5-R10.4, DB5-R13.4.
//
// Scope. Each function checks the shape and the values of one request part. None decides a refusal order between
// layers: the Group_Service (DB-5C) calls each one at its step of the operation table (body values only after the group
// lookup and the role check, as the Uniform 404 rules require) and alone answers 403, 404, 409 and 503. Nothing here
// reads a database, an HTTP object, a clock, an environment variable or a random source.
//
// Errors.
//   - A client fault throws AuthError('VALIDATION_ERROR', 400, fields), the convention of social/validation.js.
//     fields names every offending body key or query parameter: the documented keys of the request in their documented
//     order, then the unknown keys in key order. A name is listed only if it matches FIELD_NAME, so a hostile key is
//     never reflected. A fault without a nameable field (a body that is not a plain object, a PATCH without name and
//     description) gives []. When the cursor is the only fault, the error is the CursorError of groups/cursor.js
//     (fields ["cursor"]); otherwise "cursor" is one of the listed fields.
//   - No other error escapes for any client value. A body or a query is first copied by snapshot(), which accepts only
//     a plain object (prototype Object.prototype or null) of enumerable data properties with string keys. An array, a
//     class instance, an accessor, a symbol key or a proxy whose trap throws counts as "not a plain object". The checks
//     then read primitive values only.
//   - Arguments that the server supplies (the cursor context, a cursor shape, the read-position bounds) are trusted. A
//     bad one is a server fault and throws TypeError, as in groups/cursor.js. The codec checks the context whenever a
//     cursor is present.
//   - Results are frozen plain objects.
//
// Value rules.
//   name                a string, well formed (no lone surrogate), trimmed with String.prototype.trim (DB5-R01.4); the
//                       trimmed text has 1 to NAME_MAX code points and no C0 or C1 control character or DEL (ASM-01).
//   description         null, or a well-formed string of at most DESCRIPTION_MAX code points (DB5-R01.6). Tab, line
//                       feed and carriage return are allowed; every other C0 or C1 control character and DEL is refused
//                       (ASM-01). It is not trimmed. Absent on POST means null.
//   historyPolicy       POST: optional. When the key is present its value must be exactly "all" or "from_joined"
//                       (case-sensitive; null counts as supplied and fails; DB5-R01.15, OD-05 decided). Absent means
//                       DEFAULT_HISTORY_POLICY (DB5-R01.14). PATCH: never accepted, whatever its value (DB5-R02.13).
//   idempotencyKey      POST only, optional: a well-formed string of 1 to IDEMPOTENCY_KEY_MAX code points (DB5-R01.12).
//                       Characters are counted as code points, as SQLite length() counts them in GroupCreationKeys; a
//                       lone surrogate is not a character and is refused.
//   membershipRevision  optional precondition of PATCH, role change and transfer: a JSON number that is an integer from
//                       1 to 2^53 - 1. null, strings and other numbers fail.
//   userId              the user identifier format of identifier() in social/validation.js.
//   role                exactly "admin" or "member" (DB5-R06.4); "owner" and every other value fail.
//   position            an integer from 0 to 2^53 - 1; with bounds also at most the high-water and, above 0, inside the
//                       permitted ranges of the member (DB5-R10.4).
//   limit               a decimal integer from 1 to LIMIT_MAX without sign or leading zero, default LIMIT_DEFAULT
//                       (DB5-R02.5, R02.7; the bounds of the existing conversation listing).
//   cursor              decoded by groups/cursor.js against the request context (DB5-R02.5, R02.6), then matched with
//                       the ordering-key shape of its route kind where CURSOR_SHAPES fixes one.
//   former              GET /api/groups/:id/members only: "true" or "false", default false.
// Path identifiers never give a 400. The Uniform 404 rules make a malformed id and an unknown id the same case, so
// pathId() returns the id for the lookup, or null for a value that no row can hold, and the service answers both with
// its one NOT_FOUND.

const { AuthError } = require('../auth/errors');
const { identifier, invalid } = require('../social/validation');
const codec = require('./cursor');
const { ROLES, HISTORY_POLICIES, inRanges } = require('./policy');

const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/;
const NAME_MAX = 100;
const DESCRIPTION_MAX = 1000;
const IDEMPOTENCY_KEY_MAX = 256;
const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 50;
// OD-05 decided: the History_Policy of a group created without historyPolicy.
const DEFAULT_HISTORY_POLICY = 'from_joined';
// DB5-R06.4: the roles a role change may name. The owner role changes only by transfer.
const ASSIGNABLE_ROLES = Object.freeze(ROLES.filter(role => role !== 'owner'));

// The widest identifier a DATA table holds: the DB-1 legacy conversation ids of conversations/validation.js.
const PATH_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,1023}$/;
const LIMIT = /^[1-9][0-9]?$/;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
const DESCRIPTION_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const STORED_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/;
const BAD = Symbol('invalid');

// The documented keys of each request part, in documented order (G01, G04, G06 and G12, G08, G10, G23; G02 and G05).
const CREATE_FIELDS = Object.freeze(['name', 'description', 'historyPolicy', 'idempotencyKey']);
const PATCH_FIELDS = Object.freeze(['name', 'description', 'historyPolicy', 'membershipRevision']);
const TARGET_FIELDS = Object.freeze(['userId']);
const ROLE_FIELDS = Object.freeze(['role', 'membershipRevision']);
const TRANSFER_FIELDS = Object.freeze(['userId', 'membershipRevision']);
const POSITION_FIELDS = Object.freeze(['position']);
const LIST_PARAMETERS = Object.freeze(['limit', 'cursor']);
const MEMBER_PARAMETERS = Object.freeze(['limit', 'cursor', 'former']);

// A stored time: the ISO 8601 UTC form with milliseconds that toISOString() and strftime('%Y-%m-%dT%H:%M:%fZ') write.
function storedTime(value) {
    const match = typeof value === 'string' ? STORED_TIME.exec(value) : null;
    if (!match) return false;
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    return month >= 1 && month <= 12 && day >= 1 && day <= days && hour <= 23 && minute <= 59 && second <= 59;
}

// Runs a helper of social/validation.js and turns its VALIDATION_ERROR into BAD.
function accepted(check) {
    try {
        return check();
    } catch (error) {
        if (error instanceof AuthError && error.code === 'VALIDATION_ERROR') return BAD;
        throw error;
    }
}

// Kinds of ordering key in a cursor shape.
const KEY_KINDS = Object.freeze({
    time: storedTime,
    id: value => accepted(() => identifier(value, 'cursor')) !== BAD,
    seq: value => Number.isSafeInteger(value) && value >= 1,
});
const shapeOf = (last, highWater) => Object.freeze({ last: Object.freeze(last), highWater });
// The ordering-key tuple ("last") of the route kinds whose order the requirements fix, and whether the payload carries
// a high-water. A route kind without an entry is checked by the codec only, until the service that pages it fixes its
// order and passes a shape (or adds an entry here).
const CURSOR_SHAPES = Object.freeze({
    groups: shapeOf(['time', 'id'], false), // G02, DB5-R02.4: updated_at DESC, then conversation_id DESC
    'group-members': shapeOf(['time', 'id'], false), // G05, DB5-R03.1: joined time, then user id, ascending
    'group-messages': shapeOf(['seq'], true), // G18, DB5-R09.6: message_seq DESC with the high-water of the first page
});

// Copies a client object into a Map of its own properties, or returns null when the value is not a plain object of
// enumerable data properties with string keys. An exception of a hostile object (a proxy trap) also gives null.
function snapshot(value) {
    try {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return null;
        const entries = new Map();
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== 'string') return null;
            const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
            entries.set(key, descriptor.value);
        }
        return entries;
    } catch {
        return null;
    }
}

// True when a well-formed string has more than max code points. A code point takes one or two UTF-16 code units, and
// in a well-formed string every low surrogate continues the code point of the high surrogate before it.
function exceeds(text, max) {
    if (text.length <= max) return false;
    if (text.length > 2 * max) return true;
    let count = 0;
    for (let index = 0; index < text.length; index += 1) {
        const unit = text.charCodeAt(index);
        if (unit < 0xdc00 || unit > 0xdfff) count += 1;
    }
    return count > max;
}

function nameValue(value) {
    if (typeof value !== 'string' || !value.isWellFormed()) return BAD;
    const text = value.trim();
    return text.length === 0 || CONTROLS.test(text) || exceeds(text, NAME_MAX) ? BAD : text;
}
function descriptionValue(value) {
    if (value === null) return null;
    if (typeof value !== 'string' || !value.isWellFormed() || DESCRIPTION_CONTROLS.test(value) || exceeds(value, DESCRIPTION_MAX)) return BAD;
    return value;
}
const historyPolicyValue = value => (typeof value === 'string' && HISTORY_POLICIES.includes(value) ? value : BAD);
function idempotencyKeyValue(value) {
    return typeof value === 'string' && value.length > 0 && value.isWellFormed() && !exceeds(value, IDEMPOTENCY_KEY_MAX) ? value : BAD;
}
const revisionValue = value => (Number.isSafeInteger(value) && value >= 1 ? value : BAD);
const userIdValue = value => accepted(() => identifier(value, 'userId'));
const roleValue = value => (typeof value === 'string' && ASSIGNABLE_ROLES.includes(value) ? value : BAD);
// value + 0 turns -0 into 0.
const positionValue = value => (Number.isSafeInteger(value) && value >= 0 ? value + 0 : BAD);
const limitValue = value => (typeof value === 'string' && LIMIT.test(value) && Number(value) <= LIMIT_MAX ? Number(value) : BAD);
const formerValue = value => (value === 'true' ? true : value === 'false' ? false : BAD);

const NO_PAGE = Object.freeze({ payload: null, error: null });

function checkShape(shape) {
    if (shape === null || typeof shape !== 'object' || !Array.isArray(shape.last) || shape.last.length < 1 ||
        shape.last.length > codec.MAX_KEYS || !shape.last.every(kind => typeof kind === 'string' && Object.hasOwn(KEY_KINDS, kind)) ||
        typeof shape.highWater !== 'boolean') throw new TypeError('a cursor shape is {last: [time | id | seq, ...], highWater: boolean}');
    return shape;
}
// The shape a cursor of this context must have: the argument, or the CURSOR_SHAPES entry of the route kind when the
// argument is undefined; null means none. A context without a known route kind is a server fault.
function expectedShape(context, shape) {
    if (context === null || typeof context !== 'object' || !codec.ROUTE_KINDS.includes(context.route)) {
        throw new TypeError('the cursor context must name a route kind of groups/cursor.js');
    }
    if (shape === undefined) return Object.hasOwn(CURSOR_SHAPES, context.route) ? CURSOR_SHAPES[context.route] : null;
    return shape === null ? null : checkShape(shape);
}
function fits(payload, shape) {
    return payload.last.length === shape.last.length && shape.last.every((kind, index) => KEY_KINDS[kind](payload.last[index])) &&
        (payload.highWater !== undefined) === shape.highWater;
}

// Opens one request part. A value that is not a plain object fails at once without a field (DB5-R01.7, R02.10,
// R03.7, R13.4). The reader then records every offending key, and done() throws them all.
function open(value, known) {
    const entries = snapshot(value);
    if (!entries) invalid();
    const problems = new Set();
    const reader = {
        required(key, check) {
            if (!entries.has(key)) {
                problems.add(key);
                return BAD;
            }
            return reader.optional(key, check, BAD);
        },
        optional(key, check, fallback) {
            if (!entries.has(key)) return fallback;
            const result = check(entries.get(key));
            if (result === BAD) problems.add(key);
            return result;
        },
        refuse(key) {
            if (entries.has(key)) problems.add(key);
        },
        cursor(context, shape) {
            if (!entries.has('cursor')) return NO_PAGE;
            let payload;
            try {
                payload = codec.decode(entries.get('cursor'), context);
            } catch (error) {
                if (!(error instanceof codec.CursorError)) throw error; // a bad context is a server fault
                problems.add('cursor');
                return Object.freeze({ payload: null, error });
            }
            if (shape && !fits(payload, shape)) {
                problems.add('cursor');
                return Object.freeze({ payload: null, error: new codec.CursorError(codec.CURSOR_ERROR_CODES.MALFORMED) });
            }
            return Object.freeze({ payload, error: null });
        },
        done(cursorError = null) {
            const offending = [...known.filter(key => problems.has(key)), ...[...entries.keys()].filter(key => !known.includes(key))];
            if (offending.length === 0) return;
            const fields = offending.filter(name => FIELD_NAME.test(name));
            if (cursorError && fields.length === 1 && fields[0] === 'cursor') throw cursorError;
            throw new AuthError('VALIDATION_ERROR', 400, fields);
        },
    };
    return reader;
}

// G01 POST /api/groups: {name, description?, historyPolicy?, idempotencyKey?} -> {name, description, historyPolicy,
// idempotencyKey}. description is null and idempotencyKey is null when absent; historyPolicy is the supplied value or
// DEFAULT_HISTORY_POLICY, which is also the value the idempotency fingerprint uses (DB5-R01.10, R01.14).
function createBody(body) {
    const request = open(body, CREATE_FIELDS);
    const name = request.required('name', nameValue);
    const description = request.optional('description', descriptionValue, null);
    const historyPolicy = request.optional('historyPolicy', historyPolicyValue, DEFAULT_HISTORY_POLICY);
    const idempotencyKey = request.optional('idempotencyKey', idempotencyKeyValue, null);
    request.done();
    return Object.freeze({ name, description, historyPolicy, idempotencyKey });
}

// G04 PATCH /api/groups/:id: {name?, description?, membershipRevision?} -> {changes, membershipRevision}. changes holds
// only the supplied keys (a description of null clears it); membershipRevision is null when absent. A historyPolicy key
// fails whatever its value (DB5-R02.13); a body with neither name nor description fails with [] (DB5-R02.10).
function patchBody(body) {
    const request = open(body, PATCH_FIELDS);
    const name = request.optional('name', nameValue, undefined);
    const description = request.optional('description', descriptionValue, undefined);
    request.refuse('historyPolicy');
    const membershipRevision = request.optional('membershipRevision', revisionValue, null);
    request.done();
    if (name === undefined && description === undefined) invalid();
    const changes = {};
    if (name !== undefined) changes.name = name;
    if (description !== undefined) changes.description = description;
    return Object.freeze({ changes: Object.freeze(changes), membershipRevision });
}

// Path parameters :id, :userId, :invitationId and :messageId -> the id, or null when no row can hold the value. Never
// throws and never gives a 400 (Uniform 404 rules): the service answers null and an unknown id with one NOT_FOUND.
function pathId(value) {
    return typeof value === 'string' && PATH_ID.test(value) ? value : null;
}

// G02, G13, G15 and G18: the query {limit?, cursor?} -> {limit, cursor}. context is the cursor context of the request
// ({route, userId} or {route, userId, conversationId}, as groups/cursor.js requires for the route kind); cursor is the
// decoded payload {last, highWater?} or null. shape overrides the CURSOR_SHAPES entry of the route kind (null: none).
function listQuery(query, context, shape) {
    const expected = expectedShape(context, shape);
    const request = open(query, LIST_PARAMETERS);
    const limit = request.optional('limit', limitValue, LIMIT_DEFAULT);
    const page = request.cursor(context, expected);
    request.done(page.error);
    return Object.freeze({ limit, cursor: page.payload });
}

// G05 GET /api/groups/:id/members: the query {limit?, cursor?, former?} -> {limit, former, cursor}. context is
// {userId, conversationId}; the cursor is bound to the route kind group-former-members when former is true and to
// group-members otherwise. An invalid former leaves the cursor unchecked, because its route kind is unknown. The 403
// for a member who sets former (DB5-R03.15) is the service's.
function membersQuery(query, context) {
    if (context === null || typeof context !== 'object') throw new TypeError('the member list context must be an object');
    const request = open(query, MEMBER_PARAMETERS);
    const limit = request.optional('limit', limitValue, LIMIT_DEFAULT);
    const former = request.optional('former', formerValue, false);
    let page = NO_PAGE;
    if (former !== BAD) {
        const bound = { route: former ? 'group-former-members' : 'group-members', userId: context.userId, conversationId: context.conversationId };
        page = request.cursor(bound, expectedShape(bound, undefined));
    }
    request.done(page.error);
    return Object.freeze({ limit, former, cursor: page.payload });
}

// G06 POST /api/groups/:id/members and G12 POST /api/groups/:id/invitations: {userId} only -> {userId}. Any other key,
// a role field included, fails and is named (DB5-R03.7).
function targetBody(body) {
    const request = open(body, TARGET_FIELDS);
    const userId = request.required('userId', userIdValue);
    request.done();
    return Object.freeze({ userId });
}

// G08 PATCH /api/groups/:id/members/:userId: {role, membershipRevision?} -> {role, membershipRevision} (DB5-R06.4).
function roleChangeBody(body) {
    const request = open(body, ROLE_FIELDS);
    const role = request.required('role', roleValue);
    const membershipRevision = request.optional('membershipRevision', revisionValue, null);
    request.done();
    return Object.freeze({ role, membershipRevision });
}

// G10 POST /api/groups/:id/transfer: {userId, membershipRevision?} -> {userId, membershipRevision}. A missing or
// malformed userId fails here (DB5-R06.9); a target that is not an Active_Member, or the requester, is the service's
// 400 (transferDecision of groups/policy.js).
function transferBody(body) {
    const request = open(body, TRANSFER_FIELDS);
    const userId = request.required('userId', userIdValue);
    const membershipRevision = request.optional('membershipRevision', revisionValue, null);
    request.done();
    return Object.freeze({ userId, membershipRevision });
}

function positionBounds(bounds) {
    if (bounds === null || typeof bounds !== 'object') throw new TypeError('read-position bounds must be {highWater, ranges}');
    const { highWater, ranges } = bounds;
    if (!Number.isSafeInteger(highWater) || highWater < 0) throw new TypeError('highWater must be an integer from 0 to 2^53 - 1');
    if (!Array.isArray(ranges)) throw new TypeError('ranges must be the array of permittedRanges');
    return { highWater, ranges };
}

// G23 PUT /api/groups/:id/read-position: {position} -> {position}. Without bounds only the shape is checked. With the
// bounds {highWater, ranges} that the service reads inside its transaction (the highest stored message_seq of the
// group and permittedRanges(intervals, policy) of the member), a position above the high-water, or above 0 and outside
// the ranges, fails with position named (DB5-R10.4).
function readPositionBody(body, bounds) {
    const limits = bounds === undefined ? null : positionBounds(bounds);
    const request = open(body, POSITION_FIELDS);
    const position = request.required('position', positionValue);
    request.done();
    if (limits && (position > limits.highWater || (position > 0 && !inRanges(position, limits.ranges)))) {
        throw new AuthError('VALIDATION_ERROR', 400, ['position']);
    }
    return Object.freeze({ position });
}

module.exports = Object.freeze({
    FIELD_NAME,
    NAME_MAX,
    DESCRIPTION_MAX,
    IDEMPOTENCY_KEY_MAX,
    LIMIT_DEFAULT,
    LIMIT_MAX,
    DEFAULT_HISTORY_POLICY,
    ASSIGNABLE_ROLES,
    CURSOR_SHAPES,
    createBody,
    patchBody,
    pathId,
    listQuery,
    membersQuery,
    memberBody: targetBody,
    invitationBody: targetBody,
    roleChangeBody,
    transferBody,
    readPositionBody,
});
