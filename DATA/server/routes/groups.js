'use strict';

// Group router skeleton (T-5C-04; DB5-R12.1 to R12.4, R12.10 to R12.12, R12.14, R13.2, R16.2, R16.13, R07.5, NFR-08).
// It owns the HTTP chain and nothing else: no group operation, no SQL and no repository. Every group operation arrives in
// a later task as one row of GROUP_ROUTES plus one handler, and calls the Group_Service (groups/service.js), which holds
// the session, CSRF, membership and role checks. The router never decides who may do what.
//
// HTTP trust boundaries, in the order a request meets them (design, Error Handling, refusal order):
//  1. The Origin check that app.js applies to every /api request (403 FORBIDDEN), before any group code.
//  2. requireAuth: the session cookie is the only source of the actor. The actor is req.auth, set by the middleware from the
//     stored session. A user, role, owner or permission claim in a path, query, header or body is never read here.
//  3. GET /feature-status: read bucket, no gate. It reports the switches, so it must work while the Group_API is off.
//  4. requireCsrf for every method except GET and HEAD (403 CSRF_INVALID), before the gate is read.
//  5. The gate: while the Group_API switch is off every other request answers 503 FEATURE_UNAVAILABLE before any limiter
//     write, group read or body read. This is the only check that decides whether a function exists.
//  6. The rate limit: separate read (GET, HEAD) and mutation (every other method, PUT included) buckets, keyed by the
//     session user and by the direct peer address of the socket only (app.js sets trust proxy off, so no header can name it).
//  7. The body: Content-Length above 8192 gives 413, a body that is not JSON gives 400, and a content encoding or charset
//     the router cannot read gives the existing 415 (DB5-R12.11, DC-05). JSON is read as UTF-8 only: the router refuses any
//     other declared charset itself, before the parser runs, because the installed parser accepts utf-7.
//  8. The route table, then a final 404. DELETE /api/groups/:id has no route, so it ends in that 404 (DB5-R07.5).
// Nothing here reads the environment or the module hook of the standalone server. Every route of GROUP_ROUTES calls one Group_Service
// method and nothing else; a route that is not in the table (DELETE /api/groups/:id, any unarchive path) ends in the final 404.

const express = require('express');
const { AuthError, sendError } = require('../auth/errors');
const { createFeatureGate } = require('../features/gate');

// Group routes accept at most 8 KiB (design, Error Handling, step 6).
const MAX_BODY_BYTES = 8192;
const READ_METHODS = Object.freeze(['GET', 'HEAD']);
// The only charset names a JSON body may declare (RFC 8259 fixes JSON as UTF-8). Anything else is a 415, not a decode attempt.
const READABLE_CHARSETS = Object.freeze(['utf-8']);
const ROUTE_METHODS = Object.freeze(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
const ROUTE_ID = /^G[0-9]{2}$/;
const ROUTE_PATH = /^\/[A-Za-z0-9/:_-]*$/;
const PARAMETER = /^:[A-Za-z][A-Za-z0-9]*$/;

// One row per mounted route. gated is false only for GET /feature-status. A task that adds an operation adds its row and its
// handler together: the router refuses a row without a handler and a handler without a row. Fixed paths come before every
// path that starts with a parameter, so a group identifier can never capture them.
const route = (id, method, path, gated) => Object.freeze({ id, method, path, gated });
const GROUP_ROUTES = Object.freeze([
    route('G26', 'GET', '/feature-status', false),
    route('G15', 'GET', '/invitations', true),
    route('G17', 'POST', '/invitations/:invitationId/decline', true),
    route('G01', 'POST', '/', true),
    route('G02', 'GET', '/', true),
    route('G03', 'GET', '/:id', true),
    route('G04', 'PATCH', '/:id', true),
    route('G05', 'GET', '/:id/members', true),
    route('G12', 'POST', '/:id/invitations', true),
    route('G13', 'GET', '/:id/invitations', true),
    route('G14', 'DELETE', '/:id/invitations/:invitationId', true)
]);

// The collection root '/' (POST and GET /api/groups) has no segment.
const segments = path => (path === '/' ? [] : path.split('/').slice(1));
const isParameter = segment => segment.startsWith(':');
// A path pattern as a matcher: a parameter matches any one segment.
function matcher(path) {
    const parts = segments(path).map(segment => (isParameter(segment) ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return new RegExp(parts.length > 0 ? `^/${parts.join('/')}/?$` : '^/?$');
}

// Refuses a table that could expose an operation by accident. Returns the table.
function assertRouteTable(rows) {
    if (!Array.isArray(rows) || !Object.isFrozen(rows)) throw new TypeError('The route table must be a frozen array.');
    const ids = new Set();
    const keys = new Set();
    rows.forEach((row, index) => {
        if (!row || typeof row !== 'object' || !Object.isFrozen(row)) throw new TypeError('A route row must be a frozen object.');
        if (Object.keys(row).sort().join() !== 'gated,id,method,path') throw new TypeError('A route row holds id, method, path and gated only.');
        if (typeof row.id !== 'string' || !ROUTE_ID.test(row.id) || ids.has(row.id)) throw new TypeError('A route id is unique and has the form G00.');
        if (!ROUTE_METHODS.includes(row.method)) throw new TypeError('A route method is GET, POST, PATCH, PUT or DELETE.');
        if (typeof row.path !== 'string' || !ROUTE_PATH.test(row.path) || (row.path !== '/' && row.path.endsWith('/')) || row.path.includes('//')) {
            throw new TypeError('A route path starts with / and holds plain segments.');
        }
        if (!segments(row.path).every(segment => segment.length > 0 && (!isParameter(segment) || PARAMETER.test(segment)))) {
            throw new TypeError('A route path holds plain segments and named parameters.');
        }
        if (typeof row.gated !== 'boolean' || (!row.gated && row.method !== 'GET')) throw new TypeError('Only a GET route may be ungated.');
        // DB5-R07.5, OD-09: a group has no deletion route and no unarchive route.
        if (row.method === 'DELETE' && /^\/:[A-Za-z0-9]+\/?$/.test(row.path)) throw new TypeError('A group has no deletion route.');
        if (/unarchive|restore/i.test(row.path)) throw new TypeError('A group has no unarchive route.');
        ids.add(row.id);
        const key = `${row.method} ${row.path}`;
        if (keys.has(key)) throw new TypeError('A method and path pair appears once.');
        keys.add(key);
        // A fixed path must come before any earlier-registered pattern that would capture it.
        for (const earlier of rows.slice(0, index)) {
            if (earlier.method === row.method && !segments(row.path).some(isParameter) && matcher(earlier.path).test(row.path)) {
                throw new TypeError('A fixed route comes before a route with a parameter in its place.');
            }
        }
    });
    return rows;
}
assertRouteTable(GROUP_ROUTES);

// The direct peer address of the socket, as the existing routers use it. No header and no derived address is consulted.
const sourceOf = request => request.socket.remoteAddress || 'unknown';
const isRead = request => READ_METHODS.includes(request.method);
// True when the Content-Type header declares a charset other than UTF-8. Every charset parameter is read, whatever its case,
// spacing or quoting, so no spelling hides a charset from this check. Only the header is read, never the body.
function declaresUnreadableCharset(request) {
    const parameters = String(request.headers['content-type'] || '').split(';').slice(1);
    return parameters.some(parameter => {
        const index = parameter.indexOf('=');
        if (index < 0 || parameter.slice(0, index).trim().toLowerCase() !== 'charset') return false;
        const value = parameter.slice(index + 1).trim().replace(/^"(.*)"$/, '$1').trim().toLowerCase();
        return !READABLE_CHARSETS.includes(value);
    });
}

function requireFunction(value, label) {
    if (typeof value !== 'function') throw new TypeError(`createGroupRouter needs ${label}.`);
}

function createGroupRouter({ groups, features } = {}, middleware) {
    if (!groups || typeof groups !== 'object') throw new TypeError('createGroupRouter needs the Group_Service.');
    for (const name of ['rate', 'createGroup', 'listGroups', 'getGroup', 'updateGroup', 'listMembers',
        'createInvitation', 'listInvitations', 'cancelInvitation', 'listOwnInvitations', 'declineInvitation']) requireFunction(groups[name], `groups.${name}`);
    if (!middleware || typeof middleware !== 'object') throw new TypeError('createGroupRouter needs the authentication middleware.');
    requireFunction(middleware.requireAuth, 'requireAuth');
    requireFunction(middleware.requireCsrf, 'requireCsrf');
    const gate = createFeatureGate(features);

    // One handler per row. A handler reads req.auth and the path, query and body as targets only.
    // The actor is request.auth (set by requireAuth from the stored session) and the proof is request.csrfProof (set by
    // requireCsrf). A path, query or body value is passed on as a target or an input and never read as an identity.
    const handlers = Object.freeze({
        G26: (request, response) => response.json(gate.status()),
        G01: (request, response) => {
            const result = groups.createGroup(request.auth, request.csrfProof, request.body, sourceOf(request));
            response.status(result.created ? 201 : 200).json({ group: result.group });
        },
        G02: (request, response) => response.json(groups.listGroups(request.auth, request.query)),
        G03: (request, response) => response.json({ group: groups.getGroup(request.auth, request.params.id) }),
        G04: (request, response) => response.json({ group: groups.updateGroup(request.auth, request.csrfProof, request.params.id, request.body) }),
        G05: (request, response) => response.json(groups.listMembers(request.auth, request.params.id, request.query)),
        G12: (request, response) => response.status(201).json(groups.createInvitation(request.auth, request.csrfProof, request.params.id, request.body, sourceOf(request))),
        G13: (request, response) => response.json(groups.listInvitations(request.auth, request.params.id, request.query)),
        G14: (request, response) => {
            groups.cancelInvitation(request.auth, request.csrfProof, request.params.id, request.params.invitationId);
            response.status(204).end();
        },
        G15: (request, response) => response.json(groups.listOwnInvitations(request.auth, request.query)),
        G17: (request, response) => {
            groups.declineInvitation(request.auth, request.csrfProof, request.params.invitationId);
            response.status(204).end();
        }
    });
    const table = GROUP_ROUTES;
    if (Object.keys(handlers).sort().join() !== table.map(row => row.id).sort().join()) {
        throw new TypeError('Every route row has one handler and every handler one row.');
    }

    const guard = work => (request, response, next) => {
        try { work(request, response); next(); } catch (error) { next(error); }
    };
    const limitRead = guard(request => groups.rate('read', request.auth, sourceOf(request)));
    const requireCsrf = (request, response, next) => (isRead(request) ? next() : middleware.requireCsrf(request, response, next));
    const gateStep = guard(() => gate.assertEnabled('groupApi'));
    const limitRequest = guard(request => groups.rate(isRead(request) ? 'read' : 'write', request.auth, sourceOf(request)));
    const parser = express.json({ limit: MAX_BODY_BYTES, strict: true, inflate: false });
    const bodyStep = (request, response, next) => {
        if (isRead(request)) return next();
        const length = Number(request.headers['content-length'] || 0);
        if (length > MAX_BODY_BYTES) return sendError(response, 'PAYLOAD_TOO_LARGE', 413);
        // No body: req.body stays undefined and the validator of the operation answers 400 (DB5-R13.4).
        if (!request.headers['transfer-encoding'] && !length) return next();
        if (!request.is('application/json')) return sendError(response, 'VALIDATION_ERROR', 400);
        if (declaresUnreadableCharset(request)) return sendError(response, 'UNSUPPORTED_MEDIA_TYPE', 415);
        return parser(request, response, next);
    };

    const router = express.Router({ caseSensitive: true });
    router.use(middleware.requireAuth);
    for (const row of table) if (!row.gated) router[row.method.toLowerCase()](row.path, limitRead, handlers[row.id]);
    router.use(requireCsrf);
    router.use(gateStep);
    router.use(limitRequest);
    router.use(bodyStep);
    for (const row of table) if (row.gated) router[row.method.toLowerCase()](row.path, handlers[row.id]);
    router.use((request, response) => sendError(response, 'NOT_FOUND', 404));
    return router;
}

module.exports = { createGroupRouter, GROUP_ROUTES, assertRouteTable, MAX_BODY_BYTES };
