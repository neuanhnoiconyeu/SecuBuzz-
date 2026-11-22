'use strict';

// T-5B-12. Context-bound cursor codec of every paged group and file route (design: module layout, groups/cursor.js;
// Correctness Properties P-13 and P-14). Requirements: DB5-R02.5, R02.6, DB5-R09.6, R09.7, R09.17.
//
// OP-01 provisional: this codec is UNSIGNED. That is the provisional default of OP-01, recommended by Kiro and NOT
// approved by the Project_Owner; the DB-5D review confirms or replaces it. The codec therefore:
//   - rejects a cursor that is too long, is not canonical base64url, or is malformed (not the exact structure below),
//     and a cursor bound to another user, route, conversation or filter digest (a foreign-context cursor);
//   - makes NO integrity claim for a well-formed altered payload. The context digest is an unkeyed SHA-256 of values
//     the requester already knows, so a client can build a well-formed cursor for its own context with any position
//     or high-water value. The digest binds a cursor to its context; it does not authenticate the cursor.
// What prevents exposure is the query, never this codec: the permitted-range predicate (and, for a listing, the
// membership predicate of the requester) runs in the same query as the page selection, so a crafted position can only
// move inside data the requester may already read. No keyed tag, server secret or setting exists here; adding one
// would decide OP-01 and needs the Project_Owner.
//
// API (no database, HTTP, clock, environment variable or randomness):
//   encode(payload, context) -> token    base64url without padding, at most MAX_CURSOR_LENGTH characters, deterministic
//   decode(token, context)   -> payload  a frozen copy; throws CursorError on any client fault of the token
// payload: { last, highWater? }
//   last       the ordering-key tuple of the last item of the page: 1 to MAX_KEYS keys, each a non-negative safe
//              integer or a string of 1 to MAX_KEY_LENGTH UTF-16 code units, well formed, without C0 or C1 controls
//   highWater  optional integer from 0 to 2^53 - 1 (the history high-water message_seq of the first page)
// context: { route, userId, conversationId | filters } as ROUTE_BINDINGS requires for the route kind
//   route           one of ROUTE_KINDS
//   userId          the session user (string of 1 to MAX_ID_LENGTH code units)
//   conversationId  routes bound to one conversation (string of 1 to MAX_ID_LENGTH code units)
//   filters         the file search: a plain object of 0 to MAX_FILTERS filters; names match FILTER_NAME, values are a
//                   string of at most MAX_ID_LENGTH code units (any Unicode), a safe integer, a boolean or null. The
//                   filter set enters the digest in name order, so the order of the object keys does not matter.
// The token is base64url of the UTF-8 JSON {"v":1,"context":<64 hex>,"last":[...]} with "highWater" last when present,
// the key layout of the existing helpers in social/validation.js, conversations/validation.js and
// messaging/validation.js. decode accepts only the canonical form: re-encoding the decoded record must give the same
// token, so one payload and context have exactly one token.
// Bounds: 3 keys of 128 code units at 3 UTF-8 bytes each, the digest and the largest high-water need at most 1283 bytes,
// which is 1711 base64url characters, so every valid payload fits the 2048-character limit.
// Faults: a bad token is a CursorError (an AuthError answered as 400 VALIDATION_ERROR with fields ["cursor"]) whose
// `reason` is one of CURSOR_ERROR_CODES; the reason is for tests and must not be sent to the client. A bad payload or
// context is a server fault and throws TypeError. Neither message contains the token.

const { createHash } = require('node:crypto');
const { AuthError } = require('../auth/errors');

const FORMAT_VERSION = 1;
// Separates this digest from the context digests of the existing direct and social cursors.
const DIGEST_LABEL = 'secubuzz-group-cursor-v1';
const MAX_CURSOR_LENGTH = 2048;
const MAX_HIGH_WATER = Number.MAX_SAFE_INTEGER; // 2^53 - 1
const MAX_KEYS = 3;
const MAX_KEY_LENGTH = 128;
const MAX_ID_LENGTH = 1024;
const MAX_FILTERS = 16;
const FILTER_NAME = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;

// Route kind -> what the cursor is bound to besides the user and the route.
const ROUTE_BINDINGS = Object.freeze({
    groups: 'user', // G02 GET /api/groups
    'group-members': 'conversation', // G05 GET /api/groups/:id/members
    'group-former-members': 'conversation', // G05 GET /api/groups/:id/members?former=true
    'group-invitations': 'conversation', // G13 GET /api/groups/:id/invitations
    'own-invitations': 'user', // G15 GET /api/groups/invitations
    'group-messages': 'conversation', // G18 GET /api/groups/:id/messages
    'file-search': 'filters', // A06 GET /api/files/search
});
const ROUTE_KINDS = Object.freeze(Object.keys(ROUTE_BINDINGS));
const CONTEXT_KEYS = Object.freeze({
    user: 'route,userId',
    conversation: 'conversationId,route,userId',
    filters: 'filters,route,userId',
});

const CURSOR_ERROR_CODES = Object.freeze({
    TOO_LONG: 'CURSOR_TOO_LONG',
    NOT_BASE64URL: 'CURSOR_NOT_BASE64URL',
    MALFORMED: 'CURSOR_MALFORMED',
    CONTEXT_MISMATCH: 'CURSOR_CONTEXT_MISMATCH',
});

class CursorError extends AuthError {
    constructor(reason) {
        super('VALIDATION_ERROR', 400, ['cursor']);
        this.name = 'CursorError';
        this.reason = reason;
    }
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function plainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
        Reflect.ownKeys(value).every(key => typeof key === 'string');
}
function plainArray(value) {
    return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype &&
        Reflect.ownKeys(value).length === value.length + 1; // the indices and length: no hole, no extra property
}
const keyList = value => Object.keys(value).sort().join(',');
const count = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const id = value => typeof value === 'string' && value.length >= 1 && value.length <= MAX_ID_LENGTH;
function orderingKey(value) {
    if (typeof value === 'string') {
        return value.length >= 1 && value.length <= MAX_KEY_LENGTH && value.isWellFormed() && !CONTROLS.test(value);
    }
    return count(value);
}
function filterValue(value) {
    return value === null || typeof value === 'boolean' || Number.isSafeInteger(value) ||
        (typeof value === 'string' && value.length <= MAX_ID_LENGTH);
}

// Returns the reason a payload is not valid, or null.
function payloadProblem(payload) {
    if (!plainObject(payload)) return 'payload must be a plain object';
    const keys = keyList(payload);
    if (keys !== 'last' && keys !== 'highWater,last') return 'payload holds exactly last and an optional highWater';
    const { last } = payload;
    if (!plainArray(last) || last.length < 1 || last.length > MAX_KEYS) return `last must be an array of 1 to ${MAX_KEYS} keys`;
    for (let index = 0; index < last.length; index += 1) {
        if (!orderingKey(last[index])) return `last[${index}] is not a valid ordering key`;
    }
    if (keys === 'highWater,last' && !count(payload.highWater)) return 'highWater must be an integer from 0 to 2^53 - 1';
    return null;
}

// Validates the context and returns its digest. A bad context is a server fault (TypeError).
function contextDigest(context) {
    if (!plainObject(context)) throw new TypeError('cursor context must be a plain object');
    const { route } = context;
    if (typeof route !== 'string' || !Object.hasOwn(ROUTE_BINDINGS, route)) throw new TypeError('cursor context names an unknown route kind');
    const binding = ROUTE_BINDINGS[route];
    if (keyList(context) !== CONTEXT_KEYS[binding]) throw new TypeError(`cursor context of ${route} holds exactly ${CONTEXT_KEYS[binding]}`);
    if (!id(context.userId)) throw new TypeError('cursor context needs a userId');
    let conversationId = null;
    let filters = null;
    if (binding === 'conversation') {
        if (!id(context.conversationId)) throw new TypeError('cursor context needs a conversationId');
        conversationId = context.conversationId;
    } else if (binding === 'filters') {
        if (!plainObject(context.filters)) throw new TypeError('cursor filters must be a plain object');
        const names = Object.keys(context.filters).sort();
        if (names.length > MAX_FILTERS || !names.every(name => FILTER_NAME.test(name))) throw new TypeError('cursor filters have an invalid name');
        if (!names.every(name => filterValue(context.filters[name]))) throw new TypeError('cursor filters have an invalid value');
        filters = names.map(name => [name, context.filters[name]]);
    }
    // JSON.stringify is injective on these values (lone surrogates and controls are escaped), so distinct contexts
    // give distinct digest inputs.
    return createHash('sha256').update(JSON.stringify([DIGEST_LABEL, route, context.userId, conversationId, filters]), 'utf8').digest('hex');
}

function serialize(digest, payload) {
    const record = payload.highWater === undefined
        ? { v: FORMAT_VERSION, context: digest, last: payload.last }
        : { v: FORMAT_VERSION, context: digest, last: payload.last, highWater: payload.highWater };
    return Buffer.from(JSON.stringify(record), 'utf8').toString('base64url');
}

function encode(payload, context) {
    const digest = contextDigest(context);
    const problem = payloadProblem(payload);
    if (problem) throw new TypeError(`cursor ${problem}`);
    const token = serialize(digest, payload);
    if (token.length > MAX_CURSOR_LENGTH) throw new RangeError(`cursor exceeds ${MAX_CURSOR_LENGTH} characters`);
    return token;
}

function fail(reason) { throw new CursorError(reason); }

function decode(token, context) {
    const digest = contextDigest(context);
    if (typeof token !== 'string') fail(CURSOR_ERROR_CODES.MALFORMED);
    if (token.length > MAX_CURSOR_LENGTH) fail(CURSOR_ERROR_CODES.TOO_LONG);
    if (!BASE64URL.test(token)) fail(CURSOR_ERROR_CODES.NOT_BASE64URL);
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.toString('base64url') !== token) fail(CURSOR_ERROR_CODES.NOT_BASE64URL);
    let record;
    try { record = JSON.parse(utf8.decode(bytes)); } catch { fail(CURSOR_ERROR_CODES.MALFORMED); }
    if (!plainObject(record)) fail(CURSOR_ERROR_CODES.MALFORMED);
    const keys = keyList(record);
    if ((keys !== 'context,last,v' && keys !== 'context,highWater,last,v') || record.v !== FORMAT_VERSION ||
        typeof record.context !== 'string' || !DIGEST.test(record.context)) fail(CURSOR_ERROR_CODES.MALFORMED);
    const payload = keys === 'context,last,v' ? { last: record.last } : { last: record.last, highWater: record.highWater };
    if (payloadProblem(payload) || serialize(record.context, payload) !== token) fail(CURSOR_ERROR_CODES.MALFORMED);
    if (record.context !== digest) fail(CURSOR_ERROR_CODES.CONTEXT_MISMATCH);
    const last = Object.freeze([...payload.last]);
    return Object.freeze(payload.highWater === undefined ? { last } : { last, highWater: payload.highWater });
}

module.exports = {
    MAX_CURSOR_LENGTH, MAX_HIGH_WATER, MAX_KEYS, MAX_KEY_LENGTH, MAX_ID_LENGTH, MAX_FILTERS,
    ROUTE_BINDINGS, ROUTE_KINDS, CURSOR_ERROR_CODES, CursorError, encode, decode,
};
