'use strict';

// T-5C-04: the group router skeleton (DB5-R12.1 to R12.4, R12.10 to R12.12, R12.14, R13.2, R16.2, R16.13, R07.5, NFR-08).
// Two kinds of test. The real createApp runs on loopback over a temporary database (support/auth.js), with real sessions and
// real CSRF tokens, to show the HTTP behavior. A small express app around createGroupRouter, with fake middleware and a fake
// service that record their calls, shows the exact order of the chain. T-5C-07 to T-5C-10 mount G01 to G05 (create, list, read,
// update, member list) beside feature-status. T-5C-11/12 add G12-G15 and G17; T-5C-13 adds G16 (accept).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { setup } = require('./support/auth');
const { snapshot, createClock, assertSecurityHeaders, createGroupBuilder } = require('./support/groups');
const { createGroupRouter, GROUP_ROUTES, assertRouteTable, MAX_BODY_BYTES } = require('../server/routes/groups');
const { AuthError, sendError } = require('../server/auth/errors');
const { DISABLED_FEATURES } = require('../server/features/config');

const SERVER_ROOT = path.join(__dirname, '..', 'server');
const SENTINEL = 'SENTINEL-HTTP-TEXT-5c04';
const ON = Object.freeze({ groupApi: true, groupMessaging: true, attachmentApi: false });
const OFF_SHAPE = Object.freeze({ groupApi: false, groupMessaging: false, attachmentApi: false });
const EVERY_METHOD = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const WRITE_METHODS = Object.freeze(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const PATHS = Object.freeze(['/api/groups', '/api/groups/', '/api/groups/some-group', '/api/groups/some-group/members', '/api/groups/some-group/members/some-user',
    '/api/groups/invitations', '/api/groups/invitations/some-invitation/accept', '/api/groups/some-group/unarchive', '/api/groups/some/deep/unknown/path']);
const error503 = { code: 'FEATURE_UNAVAILABLE', fields: [] };
const error404 = { code: 'NOT_FOUND', fields: [] };
const error415 = { code: 'UNSUPPORTED_MEDIA_TYPE', fields: [] };

// A limiter that records every bucket list it is asked about, and answers allowed unless told to deny.
function recordingLimiter() {
    const calls = [];
    return { calls, deny: false, consume(buckets, at) {
        calls.push({ buckets: buckets.map(bucket => ({ ...bucket })), at });
        return this.deny ? { allowed: false, retryAfterSeconds: 7 } : { allowed: true };
    } };
}
const thrown = work => {
    try { work(); } catch (error) { return error; }
    return assert.fail('expected a throw');
};
const keysOf = limiter => limiter.calls.flatMap(call => call.buckets.map(bucket => bucket.key));
const authRateRows = db => db.prepare('SELECT count(*) AS n FROM AuthRateLimits').get().n;

// A real application with one registered, logged-in user per name, over a recording limiter.
async function application(t, { features, limiter = recordingLimiter(), users = ['grp-http-alice'], clock = createClock() } = {}) {
    const f = await setup(t, { now: clock.now, limiter, ...(features === undefined ? {} : { features }) });
    const actors = {};
    for (const name of users) {
        const browser = f.browser();
        const registered = await browser.register(name);
        assert.equal(registered.status, 201, `register ${name}`);
        const login = await browser.login(name);
        assert.equal(login.status, 200, `login ${name}`);
        actors[name] = { browser, id: login.body.user.id, token: await browser.csrf() };
    }
    limiter.calls.length = 0;
    return { f, limiter, actors, db: f.db, application: f.application, clock };
}
const send = (actor, method, url, { body, rawBody, headers = {}, csrf = true } = {}) => actor.browser.request(url, {
    method, body, rawBody, headers: { ...(csrf && !['GET', 'HEAD'].includes(method) ? { 'X-CSRF-Token': actor.token } : {}), ...headers }
});
function assertError(response, status, expected) {
    assert.equal(response.status, status);
    if (response.text !== '') assert.deepEqual(response.body, expected);
}
// A request with a chunked body (no Content-Length), which fetch cannot send.
function chunked(app, actor, url, chunks, headers = {}) {
    return new Promise((resolve, reject) => {
        const target = new URL(url, actor.browser.origin);
        const cookie = [...actor.browser.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
        const request = http.request({ host: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: {
            Origin: actor.browser.sourceOrigin, Cookie: cookie, 'X-CSRF-Token': actor.token, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked', ...headers } }, response => {
            let text = '';
            response.on('data', piece => { text += piece; });
            response.on('end', () => resolve({ status: response.statusCode, text, body: text ? JSON.parse(text) : null, headers: response.headers }));
        });
        request.on('error', reject);
        for (const chunk of chunks) request.write(chunk);
        request.end();
    });
}

// ---------------------------------------------------------------------------------------------------------------
// The frozen route table and the order of the chain, without a database.
// ---------------------------------------------------------------------------------------------------------------
// A service with every method the router calls. The methods answer a fixed value and record nothing, so the order tests
// below see the chain steps only.
const fakeGroups = (extra = {}) => ({
    rate() {}, createGroup: () => ({ created: true, group: {} }), listGroups: () => ({ items: [], nextCursor: null }), getGroup: () => ({}),
    updateGroup: () => ({}), listMembers: () => ({ items: [], nextCursor: null }),
    createInvitation: () => ({ invitation: {} }), listInvitations: () => ({ items: [], nextCursor: null }),
    cancelInvitation: () => ({}), listOwnInvitations: () => ({ items: [], nextCursor: null }), declineInvitation: () => ({}), acceptInvitation: () => ({ group: {} }), ...extra
});

test('Batch 2A adapters: exact session/proof/target/query calls, socket source, projections and empty 204 bodies', async t => {
    const actor = Object.freeze({ userId: 'session-actor', sessionId: 'session-id' });
    const proof = Object.freeze({ type: 'session', userId: actor.userId, sessionId: actor.sessionId });
    const calls = [], rates = [];
    const record = (name, result) => (...args) => { calls.push({ name, args }); return result; };
    const groups = fakeGroups({ rate: (...args) => rates.push(args),
        createInvitation: record('createInvitation', { invitation: { id: 'created-invitation' } }),
        listInvitations: record('listInvitations', { items: [{ id: 'manager-invitation' }], nextCursor: null }),
        cancelInvitation: record('cancelInvitation', { mustNeverBeSerialized: SENTINEL }),
        listOwnInvitations: record('listOwnInvitations', { items: [{ id: 'own-invitation' }], nextCursor: null }),
        declineInvitation: record('declineInvitation', { mustNeverBeSerialized: SENTINEL }),
        acceptInvitation: record('acceptInvitation', { group: { id: 'accepted-group' } }) });
    const app = express();
    app.use('/api/groups', createGroupRouter({ groups, features: ON }, {
        requireAuth(req, res, next) { req.auth = actor; next(); },
        requireCsrf(req, res, next) { req.csrfProof = proof; next(); }
    }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const cases = [
        ['POST', '/g/invitations', { userId: 'target-user' }, 'createInvitation', 201, { invitation: { id: 'created-invitation' } }],
        ['GET', '/g/invitations?limit=2', undefined, 'listInvitations', 200, { items: [{ id: 'manager-invitation' }], nextCursor: null }],
        ['DELETE', '/g/invitations/i', undefined, 'cancelInvitation', 204, null],
        ['GET', '/invitations?limit=2', undefined, 'listOwnInvitations', 200, { items: [{ id: 'own-invitation' }], nextCursor: null }],
        ['POST', '/invitations/i/decline', undefined, 'declineInvitation', 204, null],
        ['POST', '/invitations/i/accept', undefined, 'acceptInvitation', 200, { group: { id: 'accepted-group' } }]
    ];
    for (const [method, route, body, name, status, expected] of cases) {
        const response = await fetch(origin + '/api/groups' + route, { method,
            headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.99' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const text = await response.text();
        assert.equal(response.status, status, name);
        assert.deepEqual(text ? JSON.parse(text) : null, expected, name);
        if (status === 204) assert.equal(text, '', 'the service return value is not exposed');
        const call = calls.at(-1); assert.equal(call.name, name); assert.equal(call.args[0], actor);
        if (name === 'createInvitation') assert.deepEqual(call.args, [actor, proof, 'g', body, '127.0.0.1']);
        if (name === 'listInvitations') assert.deepEqual([...call.args.slice(0, 2), { ...call.args[2] }], [actor, 'g', { limit: '2' }]);
        if (name === 'cancelInvitation') assert.deepEqual(call.args, [actor, proof, 'g', 'i']);
        if (name === 'listOwnInvitations') assert.deepEqual([call.args[0], { ...call.args[1] }], [actor, { limit: '2' }]);
        if (name === 'declineInvitation' || name === 'acceptInvitation') assert.deepEqual(call.args, [actor, proof, 'i']);
    }
    assert.equal(calls.length, 6); assert.equal(rates.length, 6, 'one generic rate call per request');
});

test('the route table is frozen, and holds only the routes that are mounted', () => {
    assert.ok(Object.isFrozen(GROUP_ROUTES));
    for (const row of GROUP_ROUTES) assert.ok(Object.isFrozen(row));
    assert.deepEqual(GROUP_ROUTES.map(row => ({ ...row })), [
        { id: 'G26', method: 'GET', path: '/feature-status', gated: false },
        { id: 'G15', method: 'GET', path: '/invitations', gated: true },
        { id: 'G16', method: 'POST', path: '/invitations/:invitationId/accept', gated: true },
        { id: 'G17', method: 'POST', path: '/invitations/:invitationId/decline', gated: true },
        { id: 'G01', method: 'POST', path: '/', gated: true },
        { id: 'G02', method: 'GET', path: '/', gated: true },
        { id: 'G03', method: 'GET', path: '/:id', gated: true },
        { id: 'G04', method: 'PATCH', path: '/:id', gated: true },
        { id: 'G05', method: 'GET', path: '/:id/members', gated: true },
        { id: 'G12', method: 'POST', path: '/:id/invitations', gated: true },
        { id: 'G13', method: 'GET', path: '/:id/invitations', gated: true },
        { id: 'G14', method: 'DELETE', path: '/:id/invitations/:invitationId', gated: true }
    ]);
    assert.equal(assertRouteTable(GROUP_ROUTES), GROUP_ROUTES);
    assert.equal(MAX_BODY_BYTES, 8192);
    const router = createGroupRouter({ groups: fakeGroups(), features: OFF_SHAPE }, { requireAuth() {}, requireCsrf() {} });
    const mounted = router.stack.filter(layer => layer.route).map(layer => `${Object.keys(layer.route.methods).map(method => method.toUpperCase()).sort().join('+')} ${layer.route.path}`);
    assert.deepEqual(mounted, ['GET /feature-status', 'GET /invitations', 'POST /invitations/:invitationId/accept', 'POST /invitations/:invitationId/decline',
        'POST /', 'GET /', 'GET /:id', 'PATCH /:id', 'GET /:id/members', 'POST /:id/invitations',
        'GET /:id/invitations', 'DELETE /:id/invitations/:invitationId'], 'the mounted layer stack equals the table');
    assert.ok(!GROUP_ROUTES.some(row => row.method === 'DELETE' && /^\/:[^/]+$/.test(row.path)), 'no group deletion route');
    assert.ok(!GROUP_ROUTES.some(row => /unarchive|restore/i.test(row.path)), 'no unarchive or restore route');
});

test('a route table that could expose an operation by accident is refused', () => {
    const row = (id, method, path, gated = true) => Object.freeze({ id, method, path, gated });
    const frozen = (...rows) => Object.freeze(rows);
    assert.doesNotThrow(() => assertRouteTable(frozen(row('G26', 'GET', '/feature-status', false), row('G03', 'GET', '/:id'), row('G05', 'GET', '/:id/members'))));
    assert.doesNotThrow(() => assertRouteTable(frozen(row('G15', 'GET', '/invitations'), row('G03', 'GET', '/:id'))));
    assert.doesNotThrow(() => assertRouteTable(frozen(row('G05', 'GET', '/:id/members'), row('G15', 'GET', '/invitations/pending'))), 'a pattern that cannot capture a later path is allowed');
    const bad = [
        ['not frozen', [row('G26', 'GET', '/feature-status', false)]],
        ['not an array', Object.freeze({})], ['null', null],
        ['row not frozen', frozen({ id: 'G26', method: 'GET', path: '/feature-status', gated: false })],
        ['extra key', frozen(Object.freeze({ id: 'G26', method: 'GET', path: '/x', gated: true, roleOnly: 'owner' }))],
        ['duplicate id', frozen(row('G03', 'GET', '/a'), row('G03', 'GET', '/b'))],
        ['duplicate pair', frozen(row('G03', 'GET', '/a'), row('G04', 'GET', '/a'))],
        ['bad id', frozen(row('g3', 'GET', '/a'))], ['bad method', frozen(row('G03', 'TRACE', '/a'))], ['lower-case method', frozen(row('G03', 'get', '/a'))],
        ['relative path', frozen(row('G03', 'GET', 'a'))], ['empty path', frozen(row('G03', 'GET', ''))], ['trailing slash', frozen(row('G03', 'GET', '/a/'))],
        ['empty segment', frozen(row('G03', 'GET', '/a//b'))], ['bad character', frozen(row('G03', 'GET', '/a*'))], ['unnamed parameter', frozen(row('G03', 'GET', '/:'))],
        ['ungated POST', frozen(row('G01', 'POST', '/a', false))], ['ungated non-boolean', frozen(row('G03', 'GET', '/a', 'no'))],
        ['group deletion', frozen(row('G99', 'DELETE', '/:id'))], ['group deletion with slash name', frozen(row('G99', 'DELETE', '/:groupId'))],
        ['unarchive', frozen(row('G98', 'POST', '/:id/unarchive'))], ['restore', frozen(row('G97', 'POST', '/:id/restore'))],
        ['parameter before a fixed route', frozen(row('G03', 'GET', '/:id'), row('G26', 'GET', '/feature-status', false))],
        ['parameter before a fixed deeper route', frozen(row('G05', 'GET', '/:id/members'), row('G15', 'GET', '/invitations/members'))]
    ];
    for (const [label, table] of bad) assert.ok(thrown(() => assertRouteTable(table)) instanceof TypeError, label);
    assert.doesNotThrow(() => assertRouteTable(frozen(row('G07', 'DELETE', '/:id/members/:userId'))), 'a member removal is not a group deletion');
    assert.doesNotThrow(() => assertRouteTable(frozen(row('G01', 'POST', '/'), row('G02', 'GET', '/'), row('G03', 'GET', '/:id'))), 'the collection root is a route of its own');
    assert.ok(thrown(() => assertRouteTable(frozen(row('G01', 'POST', '/'), row('G09', 'POST', '/')))) instanceof TypeError, 'the root appears once per method');
});

test('createGroupRouter refuses missing dependencies and a handler that does not match the table', () => {
    const middleware = { requireAuth() {}, requireCsrf() {} };
    const groups = fakeGroups();
    for (const method of Object.keys(groups)) {
        assert.ok(thrown(() => createGroupRouter({ groups: { ...groups, [method]: undefined }, features: OFF_SHAPE }, middleware)) instanceof TypeError, `no ${method}`);
    }
    for (const [label, args] of [['no arguments', []], ['no service', [{ features: OFF_SHAPE }, middleware]], ['service without rate', [{ groups: {}, features: OFF_SHAPE }, middleware]],
        ['no middleware', [{ groups, features: OFF_SHAPE }]], ['no requireAuth', [{ groups, features: OFF_SHAPE }, { requireCsrf() {} }]],
        ['no requireCsrf', [{ groups, features: OFF_SHAPE }, { requireAuth() {} }]],
        ['features not booleans', [{ groups, features: { groupApi: 'true', groupMessaging: false, attachmentApi: false } }, middleware]],
        ['features null', [{ groups, features: null }, middleware]]]) {
        assert.ok(thrown(() => createGroupRouter(...args)) instanceof TypeError, label);
    }
    assert.ok(createGroupRouter({ groups, features: DISABLED_FEATURES }, middleware));
});

test('a router built without features is fully disabled, as the default of the spec requires', async t => {
    const order = [];
    const middleware = { requireAuth(request, response, next) { order.push('auth'); Object.defineProperty(request, 'auth', { value: { userId: 'u' } }); next(); },
        requireCsrf(request, response, next) { order.push('csrf'); next(); } };
    const app = express();
    app.use('/api/groups', createGroupRouter({ groups: fakeGroups({ rate() { order.push('rate'); } }) }, middleware));
    app.use((error, request, response, next) => sendError(response, error.code, error.status, error.fields));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    const status = await fetch(base + '/api/groups/feature-status');
    assert.deepEqual([status.status, await status.json()], [200, OFF_SHAPE]);
    order.length = 0;
    for (const [method, url] of [['GET', '/api/groups'], ['GET', '/api/groups/x'], ['POST', '/api/groups'], ['DELETE', '/api/groups/x']]) {
        const response = await fetch(base + url, { method });
        assert.deepEqual([response.status, await response.json()], [503, error503], method + ' ' + url);
    }
    assert.ok(!order.includes('rate'), 'the limiter is never used');
});

// A router with fake middleware and a fake service. Every call is recorded in order.
async function isolated(t, features) {
    const order = [];
    const middleware = {
        requireAuth(request, response, next) {
            order.push('auth');
            if (request.headers['x-test-anonymous']) return next(new AuthError('UNAUTHENTICATED', 401));
            Object.defineProperty(request, 'auth', { value: Object.freeze({ userId: 'session-user', sessionId: 'session-1' }), enumerable: false });
            return next();
        },
        requireCsrf(request, response, next) {
            order.push('csrf');
            if (request.headers['x-test-bad-csrf']) return next(new AuthError('CSRF_INVALID', 403));
            request.csrfProof = Object.freeze({ type: 'session' });
            return next();
        }
    };
    const groups = fakeGroups({ rate(operation, context, source) {
        order.push(`rate:${operation}`);
        order.push(`actor:${context.userId}`);
        order.push(`source:${source}`);
        if (isolated.failRate) throw isolated.failRate;
    } });
    const app = express();
    app.use('/api/groups', createGroupRouter({ groups, features }, middleware));
    app.use((error, request, response, next) => {
        if (error instanceof AuthError) return sendError(response, error.code, error.status, error.fields);
        if (error.type === 'entity.too.large') return sendError(response, 'PAYLOAD_TOO_LARGE', 413);
        if (['encoding.unsupported', 'charset.unsupported'].includes(error.type)) return sendError(response, 'UNSUPPORTED_MEDIA_TYPE', 415);
        if (error.type === 'entity.parse.failed') return sendError(response, 'VALIDATION_ERROR', 400);
        return sendError(response, 'INTERNAL_ERROR', 500);
    });
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, { body, headers = {} } = {}) => {
        order.length = 0;
        const response = await fetch(base + url, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body });
        const text = await response.text();
        return { status: response.status, text, body: text ? JSON.parse(text) : null, order: [...order] };
    };
    return { call };
}

test('the chain runs in the order of the design for every request kind', async t => {
    const off = await isolated(t, OFF_SHAPE);
    const on = await isolated(t, ON);
    const peer = 'source:127.0.0.1';
    // feature-status: authentication and the read bucket only, with no CSRF step and no gate, switch off or on.
    for (const { call } of [off, on]) {
        const status = await call('GET', '/api/groups/feature-status');
        assert.equal(status.status, 200);
        assert.deepEqual(status.order, ['auth', 'rate:read', 'actor:session-user', peer]);
    }
    // Switch off: a read stops at the gate after authentication, and a write after CSRF. No limiter call, ever.
    assert.deepEqual((await off.call('GET', '/api/groups/anything')).order, ['auth']);
    assert.deepEqual((await off.call('HEAD', '/api/groups/anything')).order, ['auth']);
    for (const method of WRITE_METHODS) {
        const refused = await off.call(method, '/api/groups/anything', { body: method === 'OPTIONS' ? undefined : '{}' });
        assert.equal(refused.status, 503, method);
        assert.deepEqual(refused.order, ['auth', 'csrf'], method);
    }
    // Switch on: reads use the read bucket and no CSRF step, every other method uses CSRF then the mutation bucket.
    for (const method of ['GET', 'HEAD']) assert.deepEqual((await on.call(method, '/api/groups/anything')).order, ['auth', 'rate:read', 'actor:session-user', peer], method);
    for (const method of WRITE_METHODS) assert.deepEqual((await on.call(method, '/api/groups/anything')).order, ['auth', 'csrf', 'rate:write', 'actor:session-user', peer], method);
    // A failed step ends the chain: no later step runs.
    assert.deepEqual((await on.call('GET', '/api/groups/anything', { headers: { 'x-test-anonymous': '1' } })).order, ['auth']);
    const noCsrf = await on.call('POST', '/api/groups/anything', { headers: { 'x-test-bad-csrf': '1' } });
    assert.deepEqual([noCsrf.status, noCsrf.body, noCsrf.order], [403, { code: 'CSRF_INVALID', fields: [] }, ['auth', 'csrf']]);
    const anonymous = await off.call('GET', '/api/groups/anything', { headers: { 'x-test-anonymous': '1' } });
    assert.deepEqual([anonymous.status, anonymous.body.code, anonymous.order], [401, 'UNAUTHENTICATED', ['auth']], 'authentication comes before the gate');
    const badCsrfOff = await off.call('POST', '/api/groups/anything', { headers: { 'x-test-bad-csrf': '1' } });
    assert.deepEqual([badCsrfOff.status, badCsrfOff.body.code], [403, 'CSRF_INVALID'], 'CSRF comes before the gate');
});

test('the gate answers before the limiter, the body parser and the route table', async t => {
    const off = await isolated(t, OFF_SHAPE);
    const payload = JSON.stringify({ filler: 'x'.repeat(MAX_BODY_BYTES * 4) });
    for (const [label, options] of [['oversized JSON', { body: payload }], ['text body', { body: 'hello', headers: { 'Content-Type': 'text/plain' } }],
        ['broken JSON', { body: '{bad' }], ['gzip body', { body: '{}', headers: { 'Content-Encoding': 'gzip' } }], ['utf-7 body', { body: '{}', headers: { 'Content-Type': 'application/json; charset=utf-7' } }]]) {
        const refused = await off.call('POST', '/api/groups', options);
        assert.deepEqual([refused.status, refused.body, refused.order], [503, error503, ['auth', 'csrf']], label);
    }
});

test('a failing limiter becomes the error the handler maps, after the gate and CSRF', async t => {
    const on = await isolated(t, ON);
    isolated.failRate = new AuthError('RATE_LIMITED', 429);
    try {
        const limited = await on.call('GET', '/api/groups/anything');
        assert.deepEqual([limited.status, limited.body, limited.order.slice(0, 2)], [429, { code: 'RATE_LIMITED', fields: [] }, ['auth', 'rate:read']]);
        isolated.failRate = new Error(SENTINEL);
        const broken = await on.call('POST', '/api/groups/anything');
        assert.deepEqual([broken.status, broken.body], [500, { code: 'INTERNAL_ERROR', fields: [] }]);
        assert.ok(!broken.text.includes(SENTINEL));
    } finally { isolated.failRate = undefined; }
});
// ---------------------------------------------------------------------------------------------------------------
// The real application, switches off (the default of createApp).
// ---------------------------------------------------------------------------------------------------------------
test('switches off: every group route but feature-status answers 503 before any group read, body read or limiter write', async t => {
    const limiter = recordingLimiter();
    const { actors, db, application: app } = await application(t, { limiter, users: ['grp-http-alice'] });
    const alice = actors['grp-http-alice'];
    assert.deepEqual(app.features, DISABLED_FEATURES);
    assert.equal(typeof app.groups.groupRead, 'function');
    const before = { tables: snapshot(db).total, rate: authRateRows(db) };
    const spied = [];
    const prepare = db.prepare.bind(db);
    db.prepare = sql => { spied.push(String(sql)); return prepare(sql); };
    t.after(() => { db.prepare = prepare; });
    const huge = JSON.stringify({ filler: 'x'.repeat(MAX_BODY_BYTES * 4) });
    for (const method of EVERY_METHOD) {
        for (const url of PATHS) {
            for (const [label, options] of [['no body', {}], ['huge JSON body', { body: JSON.stringify({ a: 1 }), rawBody: huge }],
                ['text body', { rawBody: 'plain', headers: { 'Content-Type': 'text/plain' } }], ['broken JSON', { rawBody: '{bad', headers: { 'Content-Type': 'application/json' } }]]) {
                if (['GET', 'HEAD'].includes(method) && label !== 'no body') continue;
                const response = await send(alice, method, url, options);
                assert.equal(response.status, 503, `${method} ${url} ${label}`);
                if (method !== 'HEAD') assert.deepEqual(response.body, error503, `${method} ${url} ${label}`);
                assertSecurityHeaders(response, `${method} ${url} ${label}`);
            }
        }
    }
    db.prepare = prepare;
    const groupSql = spied.filter(sql => /Group|Invitation|Conversation|Message|Attachment/i.test(sql));
    assert.deepEqual(groupSql, [], 'no group, conversation or message statement runs');
    assert.ok(spied.length > 0, 'the spy saw the authentication statements, so it was active');
    assert.deepEqual(limiter.calls, [], 'the limiter is never consulted');
    assert.equal(authRateRows(db), before.rate, 'no limiter row is written');
    assert.equal(snapshot(db).total, before.tables, 'no table changes');
});

test('switches off: Origin, session and CSRF are refused first, and each with its own existing answer', async t => {
    const { actors, application: app, limiter } = await application(t, { users: ['grp-http-alice'] });
    const alice = actors['grp-http-alice'];
    const origin = app.auth.config.origins[0];
    // Origin: 403 before authentication, whatever the session.
    for (const headers of [{ Origin: 'http://evil.example' }, { Origin: 'null' }, { Origin: `${origin}.evil.example` }]) {
        const response = await send(alice, 'GET', '/api/groups/some-group', { headers });
        assertError(response, 403, { code: 'FORBIDDEN', fields: [] });
    }
    // Session: 401, with the cookie cleared, before the gate.
    const stranger = (await application(t, { users: [] })).f.browser();
    for (const method of ['GET', 'HEAD', 'POST', 'DELETE']) {
        const response = await stranger.request('/api/groups/some-group', { method });
        assert.equal(response.status, 401, method);
        if (method !== 'HEAD') assert.equal(response.body.code, 'UNAUTHENTICATED', method);
    }
    const forged = alice.browser.clone();
    forged.cookies.set(app.auth.config.sessionCookie, 'f'.repeat(64));
    assertError(await forged.request('/api/groups/some-group'), 401, { code: 'UNAUTHENTICATED', fields: [] });
    // CSRF: missing or wrong gives 403 before the gate for every method except GET and HEAD.
    for (const method of WRITE_METHODS) {
        assertError(await send(alice, method, '/api/groups/some-group', { csrf: false }), 403, { code: 'CSRF_INVALID', fields: [] });
        assertError(await send(alice, method, '/api/groups/some-group', { csrf: false, headers: { 'X-CSRF-Token': 'a'.repeat(64) } }), 403, { code: 'CSRF_INVALID', fields: [] });
        assertError(await send(alice, method, '/api/groups/some-group', { csrf: false, headers: { 'X-CSRF-Token': 'not a token' } }), 403, { code: 'CSRF_INVALID', fields: [] });
        assert.equal((await send(alice, method, '/api/groups/some-group')).status, 503, `${method} with a valid proof reaches the gate`);
    }
    for (const method of ['GET', 'HEAD']) assert.equal((await send(alice, method, '/api/groups/some-group', { csrf: false })).status, 503, `${method} needs no proof`);
    assert.deepEqual(limiter.calls, [], 'none of these touched the limiter');
});

test('feature-status needs a session, reads the read bucket, ignores any identity claim and reports the switches', async t => {
    const limiter = recordingLimiter();
    const { actors, application: app } = await application(t, { limiter, users: ['grp-http-alice', 'grp-http-bob'] });
    const alice = actors['grp-http-alice'];
    const bob = actors['grp-http-bob'];
    const anonymous = (await application(t, { users: [] })).f.browser();
    assertError(await anonymous.request('/api/groups/feature-status'), 401, { code: 'UNAUTHENTICATED', fields: [] });
    limiter.calls.length = 0;
    const response = await send(alice, 'GET', '/api/groups/feature-status');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, OFF_SHAPE);
    assert.deepEqual(Object.keys(response.body), ['groupApi', 'groupMessaging', 'attachmentApi']);
    assertSecurityHeaders(response, 'feature-status');
    assert.equal((await send(alice, 'HEAD', '/api/groups/feature-status')).status, 200);
    assert.equal(limiter.calls.length, 2);
    const aliceKeys = keysOf(limiter);
    assert.deepEqual(aliceKeys.slice(0, 2), [`groups:read:${alice.id}`, 'groups:read-source:127.0.0.1']);
    // Identity claims in the query, headers and cookies of another user change nothing.
    limiter.calls.length = 0;
    const claimed = await send(alice, 'GET', `/api/groups/feature-status?userId=${bob.id}&actor=${bob.id}&role=owner`,
        { headers: { 'X-User-Id': bob.id, 'X-Actor': bob.id, 'X-Role': 'owner', 'X-Forwarded-User': bob.id } });
    assert.deepEqual([claimed.status, claimed.body], [200, OFF_SHAPE]);
    assert.deepEqual(keysOf(limiter), [`groups:read:${alice.id}`, 'groups:read-source:127.0.0.1'], 'the bucket belongs to the session user');
    limiter.calls.length = 0;
    await send(bob, 'GET', '/api/groups/feature-status');
    assert.equal(keysOf(limiter)[0], `groups:read:${bob.id}`);
    assert.ok(!keysOf(limiter).some(key => key.includes(alice.id)));
    assert.deepEqual(app.features, DISABLED_FEATURES);
});

test('feature-status is not gated: a POST to the same path takes the CSRF and gate steps and answers 503', async t => {
    const { actors } = await application(t, { users: ['grp-http-alice'] });
    const alice = actors['grp-http-alice'];
    assertError(await send(alice, 'POST', '/api/groups/feature-status', { csrf: false }), 403, { code: 'CSRF_INVALID', fields: [] });
    assertError(await send(alice, 'POST', '/api/groups/feature-status'), 503, error503);
    assertError(await send(alice, 'DELETE', '/api/groups/feature-status'), 503, error503);
    assert.equal((await send(alice, 'GET', '/api/groups/Feature-Status')).status, 503, 'the exemption is the exact path, not a case variant');
    assert.equal((await send(alice, 'GET', '/api/groups/feature-status/')).status, 200, 'a trailing slash is the same path');
    assert.equal((await send(alice, 'GET', '/api/groups/feature-status/extra')).status, 503);
});

test('feature-status answers 429 with a retry delay when the read bucket is exhausted, and counts a source from the socket only', async t => {
    const limiter = recordingLimiter();
    const { actors } = await application(t, { limiter, users: ['grp-http-alice'] });
    const alice = actors['grp-http-alice'];
    limiter.calls.length = 0;
    const spoofed = { 'X-Forwarded-For': '6.6.6.6', Forwarded: 'for=7.7.7.7', 'X-Real-IP': '8.8.8.8', 'X-Client-IP': '9.9.9.9', 'CF-Connecting-IP': '4.4.4.4', 'True-Client-IP': '5.5.5.5' };
    assert.equal((await send(alice, 'GET', '/api/groups/feature-status', { headers: spoofed })).status, 200);
    const keys = keysOf(limiter).join(' ');
    assert.ok(keys.includes('groups:read-source:127.0.0.1'), 'the peer address is the source');
    assert.ok(!/6\.6\.6\.6|7\.7\.7\.7|8\.8\.8\.8|9\.9\.9\.9|4\.4\.4\.4|5\.5\.5\.5/.test(keys), 'no forwarding header names the source');
    limiter.deny = true;
    const limited = await send(alice, 'GET', '/api/groups/feature-status');
    assertError(limited, 429, { code: 'RATE_LIMITED', fields: [] });
    assert.equal(limited.headers.get('retry-after'), '7');
    assertSecurityHeaders(limited, 'limited');
});
// ---------------------------------------------------------------------------------------------------------------
// The real application, switches injected (the test harness of DB5-R16.5).
// ---------------------------------------------------------------------------------------------------------------
test('every switch assignment is reported by feature-status, group messaging only while the Group_API is on', async t => {
    for (let mask = 0; mask < 8; mask++) {
        const features = { groupApi: !!(mask & 1), groupMessaging: !!(mask & 2), attachmentApi: !!(mask & 4) };
        const { actors, application: app } = await application(t, { features, users: ['grp-http-alice'] });
        const expected = { groupApi: features.groupApi, groupMessaging: features.groupApi && features.groupMessaging, attachmentApi: features.attachmentApi };
        const response = await send(actors['grp-http-alice'], 'GET', '/api/groups/feature-status');
        assert.deepEqual([response.status, response.body], [200, expected], JSON.stringify(features));
        assert.deepEqual({ groupApi: app.features.groupApi, groupMessaging: app.features.groupMessaging, attachmentApi: app.features.attachmentApi }, { ...features, groupMessaging: features.groupMessaging });
        const probe = await send(actors['grp-http-alice'], 'GET', '/api/groups/anything');
        assert.equal(probe.status, features.groupApi ? 404 : 503, `the gate follows groupApi alone: ${JSON.stringify(features)}`);
    }
});

test('two applications keep separate switches: enabling one does not enable the other', async t => {
    const on = await application(t, { features: ON, users: ['grp-http-alice'] });
    const off = await application(t, { users: ['grp-http-alice'] });
    assert.equal((await send(on.actors['grp-http-alice'], 'GET', '/api/groups/anything')).status, 404);
    assert.equal((await send(off.actors['grp-http-alice'], 'GET', '/api/groups/anything')).status, 503);
    assert.equal((await send(on.actors['grp-http-alice'], 'GET', '/api/groups/anything')).status, 404);
    assert.deepEqual(off.application.features, DISABLED_FEATURES);
});

test('a malformed features object stops the application from being built, and never enables a function', async t => {
    for (const features of [null, 'on', 5, [], { groups: 5 }, { attachments: 'x' }]) {
        await assert.rejects(setup(t, { features }), TypeError, JSON.stringify(features));
    }
    const lenient = await application(t, { features: { groupApi: 'true', groupMessaging: 1, attachmentApi: 'yes' }, users: ['grp-http-alice'] });
    assert.deepEqual(lenient.application.features, { ...DISABLED_FEATURES, groups: {}, attachments: {} }, 'a value that is not exactly true is off');
    assert.equal((await send(lenient.actors['grp-http-alice'], 'GET', '/api/groups/anything')).status, 503);
});

test('switch on: a method and path with no route, and every request that names no visible group, end in the one 404', async t => {
    const limiter = recordingLimiter();
    // G16 is mounted: a valid member maximum lets unknown invitation ids reach its uniform 404 check.
    const { actors, db } = await application(t, { features: { ...ON, groups: { maxMembers: 50 } }, limiter, users: ['grp-http-alice'] });
    const alice = actors['grp-http-alice'];
    const before = snapshot(db).total;
    // Newly mounted GET /invitations is a private collection, not a group id; its empty page is 200.
    // Here they carry a body with identity claims and unknown fields (400 for the POST) or name no group the user can see (404).
    const answered = (method, url) => {
        const clean = url.replace(/\/$/, '');
        if (clean === '/api/groups') return method === 'POST' ? 400 : ['GET', 'HEAD'].includes(method) ? 200 : 404;
        if (clean === '/api/groups/invitations' && ['GET', 'HEAD'].includes(method)) return 200;
        return 404;
    };
    for (const method of EVERY_METHOD) {
        for (const url of PATHS) {
            const response = await send(alice, method, url, ['GET', 'HEAD'].includes(method) ? {} : { body: { name: 'Group', userId: alice.id, role: 'owner' } });
            assert.equal(response.status, answered(method, url), `${method} ${url}`);
            if (response.status === 404 && method !== 'HEAD') assert.deepEqual(response.body, error404, `${method} ${url}`);
            assertSecurityHeaders(response, `${method} ${url}`);
        }
    }
    assert.equal(snapshot(db).total, before, 'no group, conversation or message row changes');
    assert.ok(limiter.calls.length >= EVERY_METHOD.length * PATHS.length, 'every request used the limiter');
    for (const url of ['/api/groups/some-group', '/api/groups/some-group/']) {
        assertError(await send(alice, 'DELETE', url), 404, error404);
    }
});

test('switch on: reads use the read buckets, every other method the mutation buckets, keyed by the session user and the socket peer', async t => {
    const limiter = recordingLimiter();
    const { actors } = await application(t, { features: ON, limiter, users: ['grp-http-alice', 'grp-http-bob'] });
    const alice = actors['grp-http-alice'];
    const bob = actors['grp-http-bob'];
    const spoofed = { 'X-Forwarded-For': '6.6.6.6', Forwarded: 'for=7.7.7.7', 'X-Real-IP': '8.8.8.8', 'X-User-Id': bob.id };
    for (const method of EVERY_METHOD) {
        limiter.calls.length = 0;
        const body = ['GET', 'HEAD'].includes(method) ? undefined : { userId: bob.id, actor: bob.id };
        await send(alice, method, '/api/groups/some-group', { body, headers: spoofed });
        const family = ['GET', 'HEAD'].includes(method) ? 'read' : 'write';
        assert.deepEqual(keysOf(limiter), [`groups:${family}:${alice.id}`, `groups:${family}-source:127.0.0.1`], method);
        const [first, second] = limiter.calls[0].buckets;
        const expected = family === 'read' ? [[120, 60000], [240, 60000]] : [[60, 60000], [120, 60000]];
        assert.deepEqual([[first.limit, first.windowMs], [second.limit, second.windowMs]], expected, method);
    }
    limiter.calls.length = 0;
    await send(bob, 'POST', '/api/groups', { body: {} });
    assert.equal(keysOf(limiter)[0], `groups:write:${bob.id}`);
    assert.ok(!keysOf(limiter).some(key => key.includes(alice.id)));
});

test('switch on: a denied limiter answers 429 with Retry-After after the gate and CSRF, for reads and mutations alike', async t => {
    const limiter = recordingLimiter();
    const { actors, db } = await application(t, { features: ON, limiter, users: ['grp-http-alice'] });
    const alice = actors['grp-http-alice'];
    const before = snapshot(db).total;
    limiter.deny = true;
    for (const method of EVERY_METHOD) {
        const response = await send(alice, method, '/api/groups/some-group');
        assert.equal(response.status, 429, method);
        if (method !== 'HEAD') assert.deepEqual(response.body, { code: 'RATE_LIMITED', fields: [] }, method);
        assert.equal(response.headers.get('retry-after'), '7', method);
        assertSecurityHeaders(response, method);
    }
    assertError(await send(alice, 'POST', '/api/groups', { csrf: false }), 403, { code: 'CSRF_INVALID', fields: [] });
    assert.equal(snapshot(db).total, before);
});

test('switch on: a limiter that fails becomes a bare 500 that carries none of its text, on every route that uses it', async t => {
    const { actors, limiter } = await application(t, { features: ON, users: ['grp-http-alice'] });
    const alice = actors['grp-http-alice'];
    limiter.consume = () => { throw new Error(SENTINEL + ' SQLITE_BUSY GroupExtensions uq_invitations_pending'); };
    for (const [method, url] of [['GET', '/api/groups/feature-status'], ['GET', '/api/groups/some-group'], ['POST', '/api/groups'], ['DELETE', '/api/groups/some-group']]) {
        const response = await send(alice, method, url);
        assert.deepEqual([response.status, response.body], [500, { code: 'INTERNAL_ERROR', fields: [] }], method + ' ' + url);
        assert.ok(!response.text.includes(SENTINEL) && !/sqlite|uq_|GroupExtensions|stack/i.test(response.text), method + ' ' + url);
        assertSecurityHeaders(response, method + ' ' + url);
    }
});
// ---------------------------------------------------------------------------------------------------------------
// Body handling (DB5-R12.11, R12.14, R13.4; DC-05). The requests below go to POST, PUT, PATCH and DELETE on one group path
// that names no visible group, so a request that passes every body rule ends in the 404, and a refusal is the status of its own step.
// ---------------------------------------------------------------------------------------------------------------
test('switch on: the body rules answer 413, 400 and 415 in the order of the design, and a valid body reaches the 404', async t => {
    const { actors, db } = await application(t, { features: ON, users: ['grp-http-alice'] });
    const alice = actors['grp-http-alice'];
    const before = snapshot(db).total;
    const json = { 'Content-Type': 'application/json' };
    const exact = JSON.stringify({ filler: 'x'.repeat(MAX_BODY_BYTES - 13) });
    assert.equal(Buffer.byteLength(exact), MAX_BODY_BYTES, 'the boundary body is exactly 8192 bytes');
    const over = JSON.stringify({ filler: 'x'.repeat(MAX_BODY_BYTES - 12) });
    assert.equal(Buffer.byteLength(over), MAX_BODY_BYTES + 1);
    const cases = [
        ['8192 bytes of JSON passes the size rule', { rawBody: exact, headers: json }, 404, error404],
        ['8193 bytes of JSON', { rawBody: over, headers: json }, 413, { code: 'PAYLOAD_TOO_LARGE', fields: [] }],
        ['an oversized body with the wrong type is 413 first', { rawBody: over, headers: { 'Content-Type': 'text/plain' } }, 413, { code: 'PAYLOAD_TOO_LARGE', fields: [] }],
        ['no body at all', {}, 404, error404],
        ['text/plain', { rawBody: 'hello', headers: { 'Content-Type': 'text/plain' } }, 400, { code: 'VALIDATION_ERROR', fields: [] }],
        ['form encoding', { rawBody: 'a=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 400, { code: 'VALIDATION_ERROR', fields: [] }],
        ['multipart', { rawBody: '--b\r\n\r\n--b--', headers: { 'Content-Type': 'multipart/form-data; boundary=b' } }, 400, { code: 'VALIDATION_ERROR', fields: [] }],
        ['a near-miss JSON type', { rawBody: '{}', headers: { 'Content-Type': 'application/jsonx' } }, 400, { code: 'VALIDATION_ERROR', fields: [] }],
        ['a JSON patch type', { rawBody: '{}', headers: { 'Content-Type': 'application/json-patch+json' } }, 400, { code: 'VALIDATION_ERROR', fields: [] }],
        ['a body with no content type', { rawBody: '{}', headers: { 'Content-Type': '' } }, 400, { code: 'VALIDATION_ERROR', fields: [] }],
        ['broken JSON', { rawBody: '{bad', headers: json }, 400, { code: 'VALIDATION_ERROR', fields: [] }],
        ['a bare string root', { rawBody: '"text"', headers: json }, 400, { code: 'VALIDATION_ERROR', fields: [] }],
        ['a number root', { rawBody: '42', headers: json }, 400, { code: 'VALIDATION_ERROR', fields: [] }],
        ['a null root', { rawBody: 'null', headers: json }, 400, { code: 'VALIDATION_ERROR', fields: [] }],
        ['an object root', { rawBody: '{"name":"x"}', headers: json }, 404, error404],
        ['an array root', { rawBody: '[]', headers: json }, 404, error404],
        ['utf-8 charset', { rawBody: '{}', headers: { 'Content-Type': 'application/json; charset=utf-8' } }, 404, error404],
        ['a latin1 charset', { rawBody: '{}', headers: { 'Content-Type': 'application/json; charset=latin1' } }, 415, { code: 'UNSUPPORTED_MEDIA_TYPE', fields: [] }],
        ['an iso-8859-1 charset', { rawBody: '{}', headers: { 'Content-Type': 'application/json; charset=iso-8859-1' } }, 415, { code: 'UNSUPPORTED_MEDIA_TYPE', fields: [] }],
        ['an unknown charset', { rawBody: '{}', headers: { 'Content-Type': 'application/json; charset=bogus' } }, 415, { code: 'UNSUPPORTED_MEDIA_TYPE', fields: [] }],
        // T-5C-04 names charset=utf-7 as a 415 example. body-parser 2.4.0 reads utf-7 without complaint and answers 400 for utf-16,
        // so the router refuses every declared charset other than UTF-8 itself, before the parser runs (DB5-R12.11).
        ['a utf-7 charset', { rawBody: '{}', headers: { 'Content-Type': 'application/json; charset=utf-7' } }, 415, error415],
        ['an upper-case UTF-7 charset', { rawBody: '{}', headers: { 'Content-Type': 'application/json; charset=UTF-7' } }, 415, error415],
        ['a quoted utf-7 charset', { rawBody: '{}', headers: { 'Content-Type': 'application/json; charset="utf-7"' } }, 415, error415],
        ['a utf-7 charset without spaces', { rawBody: '{}', headers: { 'Content-Type': 'application/json;charset=utf-7' } }, 415, error415],
        ['a spaced charset parameter', { rawBody: '{}', headers: { 'Content-Type': 'application/json; charset = utf-7' } }, 415, error415],
        ['an upper-case parameter name', { rawBody: '{}', headers: { 'Content-Type': 'application/json; CHARSET=utf-7' } }, 415, error415],
        ['a utf-7 charset after another parameter', { rawBody: '{}', headers: { 'Content-Type': 'application/json; a=b; charset=utf-7' } }, 415, error415],
        ['a utf-7 charset that follows a utf-8 one', { rawBody: '{}', headers: { 'Content-Type': 'application/json; charset=utf-8; charset=utf-7' } }, 415, error415],
        ['a utf-16 charset', { rawBody: '{}', headers: { 'Content-Type': 'application/json; charset=utf-16' } }, 415, error415],
        ['a utf-16le charset', { rawBody: '{}', headers: { 'Content-Type': 'application/json; charset=utf-16le' } }, 415, error415],
        ['a utf-32 charset', { rawBody: '{}', headers: { 'Content-Type': 'application/json; charset=utf-32' } }, 415, error415],
        ['an empty charset', { rawBody: '{}', headers: { 'Content-Type': 'application/json; charset=' } }, 415, error415],
        ['an upper-case UTF-8 charset', { rawBody: '{}', headers: { 'Content-Type': 'application/json; charset=UTF-8' } }, 404, error404],
        ['a quoted utf-8 charset', { rawBody: '{}', headers: { 'Content-Type': 'application/json; charset="utf-8"' } }, 404, error404],
        ['the utf8 spelling the parser has always refused', { rawBody: '{}', headers: { 'Content-Type': 'application/json; charset=utf8' } }, 415, error415],
        ['a non-JSON type is 400 before the charset is read', { rawBody: '{}', headers: { 'Content-Type': 'text/plain; charset=utf-7' } }, 400, { code: 'VALIDATION_ERROR', fields: [] }],
        ['a gzip content encoding', { rawBody: '{}', headers: { ...json, 'Content-Encoding': 'gzip' } }, 415, { code: 'UNSUPPORTED_MEDIA_TYPE', fields: [] }],
        ['a deflate content encoding', { rawBody: '{}', headers: { ...json, 'Content-Encoding': 'deflate' } }, 415, { code: 'UNSUPPORTED_MEDIA_TYPE', fields: [] }],
        ['a gzip encoding on a non-JSON type is 400 first', { rawBody: 'x', headers: { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' } }, 400, { code: 'VALIDATION_ERROR', fields: [] }]
    ];
    for (const [label, options, status, body] of cases) {
        for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
            const response = await send(alice, method, '/api/groups/some-group', options);
            assert.deepEqual([response.status, response.body], [status, body], `${method}: ${label}`);
            assertSecurityHeaders(response, `${method}: ${label}`);
        }
    }
    assert.equal(snapshot(db).total, before, 'none of them changed a table');
});

test('switch on: a chunked body is bounded by the parser, and a gate or CSRF refusal never reads it', async t => {
    const { actors, application: app } = await application(t, { features: ON, users: ['grp-http-alice'] });
    const alice = actors['grp-http-alice'];
    const piece = Buffer.from('x'.repeat(1024));
    const small = await chunked(app, alice, '/api/groups/some-group', ['{"a":1}']);
    assert.deepEqual([small.status, small.body], [404, error404]);
    const big = await chunked(app, alice, '/api/groups/some-group', ['{"filler":"', ...Array.from({ length: 12 }, () => piece), '"}']);
    assert.deepEqual([big.status, big.body], [413, { code: 'PAYLOAD_TOO_LARGE', fields: [] }]);
    const text = await chunked(app, alice, '/api/groups/some-group', ['hello'], { 'Content-Type': 'text/plain' });
    assert.deepEqual([text.status, text.body], [400, { code: 'VALIDATION_ERROR', fields: [] }]);
    const noProof = await chunked(app, alice, '/api/groups/some-group', ['{}'], { 'X-CSRF-Token': 'a'.repeat(64) });
    assert.deepEqual([noProof.status, noProof.body], [403, { code: 'CSRF_INVALID', fields: [] }]);
});

// ---------------------------------------------------------------------------------------------------------------
// Existing routes keep their answers (COMP-02), and the router cannot be reached any other way.
// ---------------------------------------------------------------------------------------------------------------
test('existing routes and prefixes keep their answers, with the group router mounted', async t => {
    const { actors, application: app, f } = await application(t, { users: ['grp-http-alice'] });
    const alice = actors['grp-http-alice'];
    const anonymous = f.browser();
    assert.deepEqual([(await anonymous.request('/healthz')).status, (await anonymous.request('/healthz')).body], [200, { status: 'ok' }]);
    assert.deepEqual((await anonymous.request('/')).body, { status: 'ok' });
    const me = await send(alice, 'GET', '/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, alice.id);
    const list = await send(alice, 'GET', '/api/conversations');
    assert.equal(list.status, 200);
    assert.deepEqual(Object.keys(list.body).sort(), ['items', 'nextCursor']);
    assert.equal((await send(alice, 'GET', '/api/friends')).status, 200);
    assert.equal((await send(alice, 'GET', '/api/keys/devices')).status, 200);
    for (const url of ['/api/messages', '/api/logs']) {
        assertError(await send(alice, 'GET', url), 503, error503);
        assertError(await send(alice, 'POST', url), 503, error503);
        assert.equal((await anonymous.request(url)).status, 401, `${url} still needs a session`);
    }
    for (const url of ['/api/unknown', '/api/groupsx', '/api/groups-x/members', '/api/group']) assertError(await send(alice, 'GET', url), 404, error404);
    assertError(await anonymous.request('/api/unknown'), 404, error404);
    for (const name of ['app', 'auth', 'social', 'conversations', 'keys', 'messaging', 'adapters', 'middleware']) assert.ok(app[name], `${name} is still returned`);
    assert.equal(typeof app.messaging.rate, 'function');
});

test('a direct conversation id sent to the group routes never reaches a direct record', async t => {
    const { actors, db } = await application(t, { features: ON, users: ['grp-http-alice', 'grp-http-bob'] });
    const alice = actors['grp-http-alice'];
    const bob = actors['grp-http-bob'];
    const befriend = await send(alice, 'POST', '/api/friends/requests', { body: { userId: bob.id } });
    assert.ok([200, 201, 404, 409].includes(befriend.status));
    const created = await send(alice, 'POST', '/api/conversations/dm', { body: { recipientId: bob.id } });
    const id = created.body?.conversation?.id ?? 'no-direct-conversation';
    const after = snapshot(db).total;
    for (const [method, url] of [['GET', `/api/groups/${id}`], ['POST', `/api/groups/${id}/leave`], ['DELETE', `/api/groups/${id}`], ['PATCH', `/api/groups/${id}`]]) {
        assertError(await send(alice, method, url), 404, error404);
    }
    assert.equal(snapshot(db).total, after, 'the group routes changed nothing');
});

// ---------------------------------------------------------------------------------------------------------------
// Source checks: nothing but the router and the mount knows about groups here, and no forbidden input is read.
// ---------------------------------------------------------------------------------------------------------------
const read = relative => fs.readFileSync(path.join(SERVER_ROOT, ...relative.split('/')), 'utf8');
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => (entry.isDirectory()
    ? (entry.name === 'node_modules' ? [] : walk(path.join(directory, entry.name))) : /\.(js|cjs|mjs)$/.test(entry.name) ? [path.join(directory, entry.name)] : []));

test('routes/groups.js reads no environment, header-derived address, SQL, repository or request-supplied identity', () => {
    const source = read('routes/groups.js');
    assert.ok(/^[\x00-\x7F]*$/.test(source), 'ASCII only');
    const forbidden = [['the environment', 'process' + '.env'], ['a forwarded header', /forwarded|x-real-ip|client-ip|\.ips\b|\.ip\b|\.hostname\b|\.headers\.host/i],
        ['the standalone module hook', 'AUTH_MIDDLEWARE' + '_MODULE'], ['SQL', /\bprepare\(|\.exec\(|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE FROM\b/], ['a repository', /Repository|database\//],
        ['a request-supplied identity', /(?:body|query|params|headers)\??\.(?:userId|user_id|actor|role|ownerId|memberId|isOwner|isAdmin)\b/], ['console output', /console\./]];
    for (const [label, pattern] of forbidden) {
        assert.ok(typeof pattern === 'string' ? !source.includes(pattern) : !pattern.test(source), `routes/groups.js reads ${label}`);
    }
    assert.ok(source.includes('request.socket.remoteAddress'), 'the source is the socket peer');
    const requires = (source.match(/require\(\s*['"][^'"]+['"]\s*\)/g) || []).map(text => text.replace(/\s/g, ''));
    assert.deepEqual(requires, ["require('express')", "require('../auth/errors')", "require('../features/gate')"]);
});

test('no runtime file of DATA names the standalone module hook, and only app.js builds the group router', () => {
    const hook = 'AUTH_MIDDLEWARE' + '_MODULE';
    const root = path.join(__dirname, '..');
    const files = [...walk(SERVER_ROOT), path.join(root, 'server.js')];
    assert.ok(files.length > 30);
    for (const file of files) assert.ok(!fs.readFileSync(file, 'utf8').includes(hook), `${path.relative(root, file)} names ${hook}`);
    const builders = files.filter(file => /createGroupRouter\s*\(/.test(fs.readFileSync(file, 'utf8')) && !file.endsWith(path.join('routes', 'groups.js')));
    assert.deepEqual(builders.map(file => path.relative(root, file)), [path.join('server', 'app.js')]);
});

test('app.js mounts the group router after /api/messages and before the legacy stub, with the features default of the spec', () => {
    const source = read('app.js');
    const at = text => { const i = source.indexOf(text); assert.ok(i >= 0, text); assert.equal(source.indexOf(text, i + 1), -1, `${text} appears once`); return i; };
    const lifecycle = at("app.use('/api/messages',messageRouters.lifecycle);");
    const mount = at("app.use('/api/groups',createGroupRouter(");
    const legacy = at("app.use(['/api/messages','/api/logs'],middleware.requireAuth");
    const notFound = at("app.use((req,res)=>sendError(res,'NOT_FOUND',404));");
    assert.ok(lifecycle < mount && mount < legacy && legacy < notFound, 'mount order');
    assert.ok(source.includes('features=DISABLED_FEATURES'), 'features default to everything disabled');
    assert.ok(source.includes('groups,features:groups.features'), 'groups and features are returned');
    assert.ok(!/require\('\.\/routes\/attachments'\)/.test(source), 'no attachment router yet');
});

// ===============================================================================================================
// T-5C-07: G01 POST /api/groups (DB5-R01). The real application, switch on, real sessions and CSRF proofs.
// ===============================================================================================================
const { createHash } = require('node:crypto');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SINCE = '2027-03-01T00:00:00.000Z'; // after every wall-clock time a fixture row can carry, so updated_at moves forward only
const GROUP_KEYS = ['archived', 'createdAt', 'description', 'historyPolicy', 'id', 'memberCount', 'membershipRevision', 'name', 'role', 'updatedAt'];
const error400 = fields => ({ code: 'VALIDATION_ERROR', fields });
const create = (actor, body, headers = {}) => send(actor, 'POST', '/api/groups', { body, headers });
const tableCount = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const groupTables = ['Conversations', 'ConversationMembers', 'GroupExtensions', 'GroupMembershipIntervals', 'GroupCreationKeys', 'AuditLogs'];
const rowCounts = db => Object.fromEntries(groupTables.map(table => [table, tableCount(db, table)]));
const auditOf = (db, id) => db.prepare("SELECT * FROM AuditLogs WHERE source = 'groups' AND subject_id = ? ORDER BY audit_id").all(id);
// The fingerprint of DB5-R01.10 as the requirement states it, so a change of the label or the order is caught.
const fingerprintOf = (name, description, policy) => createHash('sha256').update(JSON.stringify(['secubuzz-group-create-v2', name, description, policy]), 'utf8').digest('hex');

test('G01: one request writes the conversation, the owner, the extension, the first interval and one audit row, and answers 201', async t => {
    const { actors, db } = await application(t, { features: ON, users: ['grp-http-alice'], clock: createClock(SINCE) });
    const alice = actors['grp-http-alice'];
    const before = rowCounts(db);
    const response = await create(alice, { name: '  Weekend plans  ', description: 'Where and when', historyPolicy: 'all' });
    assert.equal(response.status, 201);
    assertSecurityHeaders(response, 'G01');
    assert.deepEqual(Object.keys(response.body), ['group']);
    const { group } = response.body;
    assert.deepEqual(Object.keys(group).sort(), GROUP_KEYS);
    assert.deepEqual({ ...group, id: 'x', createdAt: 'x', updatedAt: 'x' }, { id: 'x', name: 'Weekend plans', description: 'Where and when', historyPolicy: 'all',
        membershipRevision: 1, archived: false, createdAt: 'x', updatedAt: 'x', memberCount: 1, role: 'owner' });
    const after = rowCounts(db);
    for (const table of groupTables) assert.equal(after[table], before[table] + (table === 'GroupCreationKeys' ? 0 : 1), `${table} gained ${table === 'GroupCreationKeys' ? 'no' : 'one'} row`);
    const conversation = db.prepare('SELECT * FROM Conversations WHERE conversation_id = ?').get(group.id);
    assert.deepEqual([conversation.kind, conversation.origin, conversation.title, conversation.created_by, conversation.archived_at], ['group', 'authenticated', 'Weekend plans', alice.id, null]);
    assert.equal(conversation.dm_user_low, null);
    const members = db.prepare('SELECT * FROM ConversationMembers WHERE conversation_id = ?').all(group.id);
    assert.deepEqual(members.map(row => [row.user_id, row.role, row.left_at]), [[alice.id, 'owner', null]]);
    const extension = db.prepare('SELECT * FROM GroupExtensions WHERE conversation_id = ?').get(group.id);
    assert.deepEqual([extension.description, extension.history_policy, extension.membership_revision], ['Where and when', 'all', 1]);
    const intervals = db.prepare('SELECT * FROM GroupMembershipIntervals WHERE conversation_id = ?').all(group.id);
    assert.deepEqual(intervals.map(row => [row.user_id, row.interval_no, row.left_at]), [[alice.id, 1, null]]);
    const audit = auditOf(db, group.id);
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0].event_type, audit[0].actor_user_id, audit[0].source], ['group.created', alice.id, 'groups']);
    assert.deepEqual(Object.keys(JSON.parse(audit[0].metadata_json)).sort(), ['operation', 'outcome']);
    for (const secret of ['Weekend plans', 'Where and when', 'all']) assert.ok(!audit[0].metadata_json.includes(secret), `the audit row never holds "${secret}"`);
    const listed = await send(alice, 'GET', '/api/conversations');
    assert.ok(!JSON.stringify(listed.body).includes(group.id), 'a group is never listed with the direct conversations');
});

test('G01: the defaults are from_joined, a null description and a trimmed name; the policy is stored in the extension record only', async t => {
    const { actors, db } = await application(t, { features: ON, users: ['grp-http-alice'], clock: createClock(SINCE) });
    const alice = actors['grp-http-alice'];
    const response = await create(alice, { name: '\t Plain \n' });
    assert.equal(response.status, 201);
    assert.deepEqual([response.body.group.name, response.body.group.description, response.body.group.historyPolicy, response.body.group.membershipRevision], ['Plain', null, 'from_joined', 1]);
    const explicit = await create(alice, { name: 'Explicit', historyPolicy: 'from_joined', description: null });
    assert.deepEqual([explicit.status, explicit.body.group.historyPolicy, explicit.body.group.description], [201, 'from_joined', null]);
    const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
    for (const column of ['description', 'history_policy', 'membership_revision']) {
        assert.ok(!columns('Conversations').includes(column), `Conversations has no ${column}`);
        assert.ok(columns('GroupExtensions').includes(column), `GroupExtensions holds ${column}`);
    }
    const hundred = '\u{1F600}'.repeat(100);
    assert.equal((await create(alice, { name: hundred })).status, 201, '100 code points are accepted, counted as code points and not as UTF-16 units');
    assert.equal((await create(alice, { name: hundred + 'x' })).status, 400);
    assert.equal((await create(alice, { name: 'd', description: 'z'.repeat(1000) })).status, 201);
    assert.equal((await create(alice, { name: 'd', description: 'a\tb\nc\rd' })).status, 201, 'tab, line feed and carriage return are allowed in a description');
});

test('G01: a bad body, name, description, policy or key is a 400 that names the fields, never a 500, and creates nothing', async t => {
    const { actors, db } = await application(t, { features: ON, users: ['grp-http-alice', 'grp-http-bob'], clock: createClock(SINCE) });
    const alice = actors['grp-http-alice'];
    const bob = actors['grp-http-bob'];
    const before = rowCounts(db);
    const json = { 'Content-Type': 'application/json' };
    const cases = [
        ['no body', {}, []], ['empty object', { rawBody: '{}', headers: json }, ['name']], ['an array', { rawBody: '[]', headers: json }, []],
        ['a string', { rawBody: '"name"', headers: json }, []], ['null', { rawBody: 'null', headers: json }, []], ['a number', { rawBody: '7', headers: json }, []],
        ['a name that is a number', { body: { name: 7 } }, ['name']], ['a null name', { body: { name: null } }, ['name']], ['an object name', { body: { name: { a: 1 } } }, ['name']],
        ['an array name', { body: { name: ['a'] } }, ['name']], ['an empty name', { body: { name: '' } }, ['name']], ['a blank name', { body: { name: ' \t\n ' } }, ['name']],
        ['a long name', { body: { name: 'n'.repeat(101) } }, ['name']], ['a control in the name', { body: { name: 'a\u0000b' } }, ['name']],
        ['a newline in the name', { body: { name: 'a\nb' } }, ['name']], ['a C1 control in the name', { body: { name: 'a\u0085b' } }, ['name']],
        ['a description that is a number', { body: { name: 'n', description: 5 } }, ['description']], ['a description that is too long', { body: { name: 'n', description: 'd'.repeat(1001) } }, ['description']],
        ['a control in the description', { body: { name: 'n', description: 'a\u0000b' } }, ['description']],
        ['an unknown field', { body: { name: 'n', owner: 'x' } }, ['owner']], ['an identity claim', { body: { name: 'n', userId: bob.id, role: 'owner', createdBy: bob.id } }, ['userId', 'role', 'createdBy']],
        ['an unknown field with a bad name', { body: { name: '', extra: 1 } }, ['name', 'extra']],
        ['an empty key', { body: { name: 'n', idempotencyKey: '' } }, ['idempotencyKey']], ['a long key', { body: { name: 'n', idempotencyKey: 'k'.repeat(257) } }, ['idempotencyKey']],
        ['a number key', { body: { name: 'n', idempotencyKey: 5 } }, ['idempotencyKey']], ['a null key', { body: { name: 'n', idempotencyKey: null } }, ['idempotencyKey']]
    ];
    for (const [label, options, fields] of cases) {
        const response = await send(alice, 'POST', '/api/groups', options);
        assert.deepEqual([response.status, response.body], [400, error400(fields)], label);
        assertSecurityHeaders(response, label);
    }
    for (const policy of ['ALL', 'All', 'From_Joined', 'from-joined', 'fromJoined', '', ' all', 'all ', 'none', null, 1, true, false, [], ['all'], {}]) {
        const response = await create(alice, { name: 'n', historyPolicy: policy });
        assert.deepEqual([response.status, response.body], [400, error400(['historyPolicy'])], JSON.stringify(policy));
    }
    const several = await create(alice, { name: '', historyPolicy: 'x', description: 5 });
    assert.deepEqual(several.body.fields, ['name', 'description', 'historyPolicy'], 'every offending field is named, in the documented order');
    assert.deepEqual(rowCounts(db), before, 'no refusal created a record');
});

test('G01: a missing session answers 401 before the body is read, and a missing or foreign CSRF proof answers 403 and creates nothing', async t => {
    const { actors, db, f } = await application(t, { features: ON, users: ['grp-http-alice', 'grp-http-bob'], clock: createClock(SINCE) });
    const alice = actors['grp-http-alice'];
    const bob = actors['grp-http-bob'];
    const before = rowCounts(db);
    const anonymous = f.browser();
    for (const body of [{ name: 'valid' }, { name: '' }, undefined]) {
        const response = await anonymous.request('/api/groups', { method: 'POST', body });
        assert.deepEqual([response.status, response.body.code], [401, 'UNAUTHENTICATED'], JSON.stringify(body));
    }
    assertError(await send(alice, 'POST', '/api/groups', { body: { name: 'valid' }, csrf: false }), 403, { code: 'CSRF_INVALID', fields: [] });
    assertError(await send(alice, 'POST', '/api/groups', { body: { name: '' }, csrf: false }), 403, { code: 'CSRF_INVALID', fields: [] });
    assertError(await send(alice, 'POST', '/api/groups', { body: { name: 'valid' }, csrf: false, headers: { 'X-CSRF-Token': bob.token } }), 403, { code: 'CSRF_INVALID', fields: [] });
    assertError(await send(alice, 'POST', '/api/groups', { body: { name: 'valid' }, csrf: false, headers: { 'X-CSRF-Token': 'a'.repeat(64) } }), 403, { code: 'CSRF_INVALID', fields: [] });
    assert.deepEqual(rowCounts(db), before);
});

test('G01: the owner is the session user whatever a header, a cookie or the body claims', async t => {
    const { actors, db } = await application(t, { features: ON, users: ['grp-http-alice', 'grp-http-bob'], clock: createClock(SINCE) });
    const alice = actors['grp-http-alice'];
    const bob = actors['grp-http-bob'];
    const response = await create(alice, { name: 'Mine' }, { 'X-User-Id': bob.id, 'X-Actor': bob.id, 'X-Role': 'owner', 'X-Forwarded-User': bob.id, 'X-Owner-Id': bob.id });
    assert.equal(response.status, 201);
    const owner = db.prepare("SELECT user_id, role FROM ConversationMembers WHERE conversation_id = ?").all(response.body.group.id);
    assert.deepEqual(owner.map(row => [row.user_id, row.role]), [[alice.id, 'owner']]);
    assert.equal(db.prepare('SELECT created_by FROM Conversations WHERE conversation_id = ?').get(response.body.group.id).created_by, alice.id);
    assert.equal(auditOf(db, response.body.group.id)[0].actor_user_id, alice.id);
    assert.equal((await send(bob, 'GET', `/api/groups/${response.body.group.id}`)).status, 404, 'bob sees nothing of it');
});

test('G01: an idempotency key replays the original group within 24 hours, conflicts with another payload and is replaced after 24 hours', async t => {
    const clock = createClock(SINCE);
    const { actors, db, f } = await application(t, { features: ON, users: ['grp-http-alice', 'grp-http-bob'], clock });
    const alice = actors['grp-http-alice'];
    const bob = actors['grp-http-bob'];
    const payload = { name: 'Idempotent', description: 'once', historyPolicy: 'all', idempotencyKey: 'key-1' };
    const first = await create(alice, payload);
    assert.equal(first.status, 201);
    const groupsBefore = tableCount(db, 'Conversations');
    const replay = await create(alice, payload);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body, 'the original group, unchanged');
    assert.equal(tableCount(db, 'Conversations'), groupsBefore, 'no second group');
    assert.equal(auditOf(db, first.body.group.id).length, 1, 'no second audit row');
    // The same payload in another spelling: an omitted policy counts as from_joined, and the name is compared trimmed.
    const key2 = { name: 'Spelling', historyPolicy: 'from_joined', idempotencyKey: 'key-2' };
    const created = await create(alice, key2);
    const sameMeaning = await create(alice, { name: '  Spelling  ', idempotencyKey: 'key-2', description: null });
    assert.deepEqual([created.status, sameMeaning.status, sameMeaning.body.group.id], [201, 200, created.body.group.id]);
    // Any different part of the payload, the policy included, is a conflict that changes nothing.
    const counts = rowCounts(db);
    for (const changed of [{ ...payload, name: 'Other' }, { ...payload, description: 'twice' }, { ...payload, description: null }, { ...payload, historyPolicy: 'from_joined' },
        { name: payload.name, description: 'once', idempotencyKey: 'key-1' }]) {
        const response = await create(alice, changed);
        assert.deepEqual([response.status, response.body], [409, { code: 'IDEMPOTENCY_CONFLICT', fields: [] }], JSON.stringify(changed));
    }
    assert.deepEqual(rowCounts(db), counts);
    // A key belongs to its user.
    const other = await create(bob, payload);
    assert.deepEqual([other.status, other.body.group.id === first.body.group.id], [201, false]);
    // The key of a request without it is not claimed.
    assert.equal((await create(alice, { name: 'No key' })).status, 201);
    assert.equal((await create(alice, { name: 'No key' })).status, 201, 'two requests without a key create two groups');
    // After 24 hours the key is replaced, with the same or another payload. The user logs in again because the session ages too.
    clock.advance(DAY_MS + 1000);
    const alice2 = { browser: f.browser() };
    assert.equal((await alice2.browser.login('grp-http-alice')).status, 200);
    alice2.token = await alice2.browser.csrf();
    const replaced = await create(alice2, payload);
    assert.deepEqual([replaced.status, replaced.body.group.id === first.body.group.id], [201, false], 'an old key is replaced by a new group');
    const again = await create(alice2, payload);
    assert.deepEqual([again.status, again.body.group.id], [200, replaced.body.group.id], 'and the new claim is a replay again');
    const differentNow = await create(alice2, { ...key2, name: 'Spelling changed' });
    assert.equal(differentNow.status, 201, 'a key older than 24 hours accepts another payload');
    assert.equal(db.prepare('SELECT count(*) AS n FROM GroupCreationKeys WHERE user_id = ? AND idempotency_key = ?').get(alice.id, 'key-1').n, 1);
});

test('G01: a key claimed before the v2 fingerprint never matches, and the fingerprint is the documented one', async t => {
    const clock = createClock(SINCE);
    const { actors, db } = await application(t, { features: ON, users: ['grp-http-alice', 'grp-http-bob'], clock });
    const alice = actors['grp-http-alice'];
    const bob = actors['grp-http-bob'];
    const builder = createGroupBuilder({ db, clock });
    // The fixture claims its key with the v1 shape (no label): the same payload must not replay it.
    builder.createGroup({ ownerId: alice.id, title: 'Old', idempotencyKey: 'old-key' });
    const stale = await create(alice, { name: 'Old', idempotencyKey: 'old-key' });
    assert.deepEqual([stale.status, stale.body], [409, { code: 'IDEMPOTENCY_CONFLICT', fields: [] }]);
    const made = await create(alice, { name: 'Fresh', description: 'd', historyPolicy: 'all', idempotencyKey: 'fresh-key' });
    const stored = db.prepare('SELECT * FROM GroupCreationKeys WHERE user_id = ? AND idempotency_key = ?').get(alice.id, 'fresh-key');
    assert.equal(stored.fingerprint, fingerprintOf('Fresh', 'd', 'all'));
    assert.equal(stored.conversation_id, made.body.group.id);
    assert.equal(stored.created_at, clock.iso(), 'the claim time is the injected clock');
    const absent = await create(alice, { name: 'Absent', idempotencyKey: 'absent-key' });
    assert.equal(db.prepare('SELECT fingerprint FROM GroupCreationKeys WHERE idempotency_key = ?').get('absent-key').fingerprint, fingerprintOf('Absent', null, 'from_joined'));
    assert.equal(absent.status, 201);
    // A key whose group the user can no longer see answers as a conflict and shows nothing of that group.
    db.prepare('INSERT INTO GroupCreationKeys(user_id, idempotency_key, fingerprint, conversation_id, created_at) VALUES(?, ?, ?, ?, ?)')
        .run(bob.id, 'borrowed', fingerprintOf('Fresh', 'd', 'all'), made.body.group.id, clock.iso());
    const borrowed = await create(bob, { name: 'Fresh', description: 'd', historyPolicy: 'all', idempotencyKey: 'borrowed' });
    assert.deepEqual([borrowed.status, borrowed.body], [409, { code: 'IDEMPOTENCY_CONFLICT', fields: [] }]);
    assert.ok(!borrowed.text.includes(made.body.group.id) && !borrowed.text.includes('Fresh'));
});

test('G01: concurrent requests with one key create exactly one group', async t => {
    const { actors, db } = await application(t, { features: ON, users: ['grp-http-alice'], clock: createClock(SINCE) });
    const alice = actors['grp-http-alice'];
    const before = tableCount(db, 'Conversations');
    const same = await Promise.all(Array.from({ length: 6 }, () => create(alice, { name: 'Race', idempotencyKey: 'race-key' })));
    assert.deepEqual(same.map(response => response.status).sort(), [200, 200, 200, 200, 200, 201]);
    assert.equal(new Set(same.map(response => response.body.group.id)).size, 1);
    assert.equal(tableCount(db, 'Conversations'), before + 1);
    const different = await Promise.all(['a', 'b', 'c', 'd'].map(name => create(alice, { name, idempotencyKey: 'race-key-2' })));
    assert.deepEqual(different.map(response => response.status).sort(), [201, 409, 409, 409]);
    assert.equal(tableCount(db, 'Conversations'), before + 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM GroupCreationKeys WHERE idempotency_key = 'race-key-2'").get().n, 1);
});

test('G01: a failed audit write rolls back the group, the owner, the extension, the interval and the key', async t => {
    const { actors, db } = await application(t, { features: ON, users: ['grp-http-alice'], clock: createClock(SINCE) });
    const alice = actors['grp-http-alice'];
    const before = rowCounts(db);
    db.exec("CREATE TRIGGER test_refuse_group_audit BEFORE INSERT ON AuditLogs WHEN NEW.source = 'groups' BEGIN SELECT RAISE(ABORT, 'refused by the test'); END");
    try {
        const response = await create(alice, { name: 'Doomed', idempotencyKey: 'doomed-key' });
        assert.deepEqual([response.status, response.body], [500, { code: 'INTERNAL_ERROR', fields: [] }]);
        assert.ok(!response.text.includes('refused by the test'));
    } finally { db.exec('DROP TRIGGER test_refuse_group_audit'); }
    assert.deepEqual(rowCounts(db), before, 'none of the six tables changed');
    assert.equal((await create(alice, { name: 'Doomed', idempotencyKey: 'doomed-key' })).status, 201, 'the key was not claimed by the failed attempt');
});

// A limiter that counts like the real one: a bucket is refused once its limit is used up inside its window.
function countingLimiter() {
    const used = new Map();
    return { calls: [], deny: false, consume(buckets, at) {
        this.calls.push({ buckets: buckets.map(bucket => ({ ...bucket })), at });
        for (const bucket of buckets) if ((used.get(bucket.key) ?? 0) + 1 > bucket.limit) return { allowed: false, retryAfterSeconds: Math.ceil(bucket.windowMs / 1000) };
        for (const bucket of buckets) used.set(bucket.key, (used.get(bucket.key) ?? 0) + 1);
        return { allowed: true };
    } };
}

test('G01: creation is limited to 20 per hour per user and 60 per hour per source, with Retry-After, and a refusal creates nothing', async t => {
    const limiter = countingLimiter();
    const names = ['grp-http-alice', 'grp-http-bob', 'grp-http-carol', 'grp-http-dave'];
    const { actors, db } = await application(t, { features: ON, limiter, users: names, clock: createClock(SINCE) });
    const [alice, bob, carol, dave] = names.map(name => actors[name]);
    limiter.calls.length = 0;
    const first = await create(alice, { name: 'n0' });
    assert.equal(first.status, 201);
    const creation = limiter.calls.flatMap(call => call.buckets).filter(bucket => bucket.key.startsWith('groups:create'));
    assert.deepEqual(creation.map(bucket => [bucket.key, bucket.limit, bucket.windowMs]), [[`groups:create:${alice.id}`, 20, HOUR_MS], ['groups:create-source:127.0.0.1', 60, HOUR_MS]]);
    for (let index = 1; index < 20; index++) assert.equal((await create(alice, { name: `n${index}` })).status, 201);
    const before = rowCounts(db);
    const refused = await create(alice, { name: 'one too many' });
    assert.deepEqual([refused.status, refused.body], [429, { code: 'RATE_LIMITED', fields: [] }]);
    assert.equal(refused.headers.get('retry-after'), String(HOUR_MS / 1000));
    assertSecurityHeaders(refused, 'create limit');
    assert.deepEqual(rowCounts(db), before);
    assert.equal((await create(bob, { name: 'bob can still create' })).status, 201, 'the user bucket belongs to the user');
    for (let index = 1; index < 20; index++) assert.equal((await create(bob, { name: `b${index}` })).status, 201);
    for (let index = 0; index < 20; index++) assert.equal((await create(carol, { name: `c${index}` })).status, 201);
    const bySource = await create(dave, { name: 'sixty-first' });
    assert.deepEqual([bySource.status, bySource.body.code], [429, 'RATE_LIMITED'], 'the 61st creation of the source is refused although dave used none');
    assert.ok(bySource.headers.get('retry-after'));
    assert.equal(tableCount(db, 'Conversations'), before.Conversations + 40);
});

test('G01: a malformed limiter answer is a bare 500 and creates nothing', async t => {
    const limiter = recordingLimiter();
    const { actors, db } = await application(t, { features: ON, limiter, users: ['grp-http-alice'], clock: createClock(SINCE) });
    const alice = actors['grp-http-alice'];
    const before = rowCounts(db);
    for (const answer of [undefined, null, 'allowed']) {
        limiter.consume = () => answer;
        const response = await create(alice, { name: 'x' });
        assert.deepEqual([response.status, response.body], [500, { code: 'INTERNAL_ERROR', fields: [] }], String(answer));
    }
    limiter.consume = () => ({ allowed: 'yes' });
    assert.equal((await create(alice, { name: 'x' })).status, 429, 'only allowed === true passes');
    assert.deepEqual(rowCounts(db), before);
});
// ===============================================================================================================
// T-5C-08: G02 GET /api/groups and G03 GET /api/groups/:id (DB5-R02.1 to R02.8, R10.5, R14.18).
// ===============================================================================================================
const codec = require('../server/groups/cursor');
const { createRepositories } = require('../server/database/repositories');
const USERS3 = ['grp-http-alice', 'grp-http-bob', 'grp-http-carol'];
const stamp = (db, id, at) => db.prepare('UPDATE Conversations SET updated_at = ? WHERE conversation_id = ?').run(at, id);
const headersOf = response => [...response.headers.entries()].filter(([name]) => name !== 'date').sort();
const orderOf = rows => [...rows].sort((a, b) => (a.updated_at === b.updated_at ? (a.id < b.id ? 1 : -1) : (a.updated_at < b.updated_at ? 1 : -1)));
const pageOf = async (actor, query) => send(actor, 'GET', `/api/groups${query}`);

// alice owns three (one archived), is a member of carol's, was removed from another of carol's; bob owns one; there is a direct
// conversation of alice and bob and a group of legacy origin that alice belongs to.
function seed(db, clock, alice, bob, carol) {
    const builder = createGroupBuilder({ db, clock });
    const make = (ownerId, title, at) => { const id = builder.createGroup({ ownerId, title, idempotencyKey: null }); stamp(db, id, at); return id; };
    const ids = {
        a1: make(alice.id, 'A one', '2027-02-01T00:00:00.000Z'),
        a2: make(alice.id, 'A two', '2027-02-01T00:00:00.000Z'),
        a3: make(alice.id, 'A three archived', '2027-02-03T00:00:00.000Z'),
        c1: make(carol.id, 'C one', '2027-02-02T00:00:00.000Z'),
        c2: make(carol.id, 'C removed', '2027-02-05T00:00:00.000Z'),
        b1: make(bob.id, 'B one', '2027-02-06T00:00:00.000Z')
    };
    db.prepare("UPDATE Conversations SET archived_at = '2027-02-03T00:00:00.000Z' WHERE conversation_id = ?").run(ids.a3);
    builder.addMember(ids.c1, alice.id);
    builder.addMember(ids.c2, alice.id, { role: 'admin' });
    builder.removeMember(ids.c2, alice.id);
    stamp(db, ids.c1, '2027-02-02T00:00:00.000Z');
    stamp(db, ids.c2, '2027-02-05T00:00:00.000Z');
    const repositories = createRepositories(db);
    const [low, high] = [alice.id, bob.id].sort();
    const direct = repositories.conversations.create({ kind: 'direct', dm_user_low: low, dm_user_high: high, origin: 'authenticated', created_by: alice.id });
    ids.direct = direct.conversation_id;
    db.prepare("INSERT INTO Conversations(conversation_id, kind, title, created_by, origin) VALUES('legacy-group-1', 'group', 'Legacy', ?, 'legacy')").run(alice.id);
    db.prepare("INSERT INTO ConversationMembers(conversation_id, user_id, role) VALUES('legacy-group-1', ?, 'owner')").run(alice.id);
    ids.legacy = 'legacy-group-1';
    db.prepare("INSERT INTO Conversations(conversation_id, kind, title, created_by, origin) VALUES('no-extension-1', 'group', 'No extension', ?, 'authenticated')").run(alice.id);
    db.prepare("INSERT INTO ConversationMembers(conversation_id, user_id, role) VALUES('no-extension-1', ?, 'owner')").run(alice.id);
    ids.bare = 'no-extension-1';
    return { builder, ids };
}

test('G02: lists only the groups of which the requester is an Active_Member, archived included, newest update first, with the id as tie break', async t => {
    const clock = createClock(SINCE);
    const { actors, db } = await application(t, { features: ON, users: USERS3, clock });
    const [alice, bob, carol] = USERS3.map(name => actors[name]);
    const { ids } = seed(db, clock, alice, bob, carol);
    const response = await pageOf(alice, '');
    assert.equal(response.status, 200);
    assertSecurityHeaders(response, 'G02');
    assert.deepEqual(Object.keys(response.body), ['items', 'nextCursor']);
    const expected = orderOf([ids.a1, ids.a2, ids.a3, ids.c1].map(id => ({ id, updated_at: db.prepare('SELECT updated_at FROM Conversations WHERE conversation_id = ?').get(id).updated_at })));
    assert.deepEqual(response.body.items.map(item => item.id), expected.map(row => row.id), 'updated_at DESC, then conversation_id DESC');
    assert.equal(response.body.nextCursor, null, 'the last page has no cursor');
    for (const item of response.body.items) {
        assert.deepEqual(Object.keys(item).sort(), [...GROUP_KEYS, 'unreadCount'].sort());
        assert.ok(Number.isInteger(item.unreadCount) && item.unreadCount >= 0);
    }
    const byId = Object.fromEntries(response.body.items.map(item => [item.id, item]));
    assert.deepEqual([byId[ids.a1].role, byId[ids.c1].role, byId[ids.a3].archived, byId[ids.a1].archived], ['owner', 'member', true, false]);
    assert.deepEqual([byId[ids.a1].memberCount, byId[ids.c1].memberCount, byId[ids.a1].name, byId[ids.c1].updatedAt], [1, 2, 'A one', '2027-02-02T00:00:00.000Z']);
    for (const hidden of [ids.b1, ids.c2, ids.direct, ids.legacy, ids.bare]) assert.ok(!(hidden in byId), `${hidden} is not listed`);
    const bobs = await pageOf(bob, '');
    assert.deepEqual(bobs.body.items.map(item => item.id), [ids.b1], 'bob sees his own group only (the direct conversation is not a group)');
    assert.equal((await send(alice, 'HEAD', '/api/groups')).status, 200);
    const conversations = await send(alice, 'GET', '/api/conversations');
    for (const id of Object.values(ids)) if (id !== ids.direct) assert.ok(!conversations.text.includes(id), 'GET /api/conversations lists no group');
});

test('G02: pages by limit and an opaque cursor that covers every group once, and the last page has no cursor', async t => {
    const clock = createClock(SINCE);
    const { actors, db } = await application(t, { features: ON, users: USERS3, clock });
    const [alice, bob, carol] = USERS3.map(name => actors[name]);
    const { ids } = seed(db, clock, alice, bob, carol);
    const everything = (await pageOf(alice, '')).body.items.map(item => item.id);
    for (const limit of [1, 2, 3, 4, 5, 50]) {
        const seen = [];
        let cursor = null;
        let pages = 0;
        do {
            const response = await pageOf(alice, `?limit=${limit}${cursor === null ? '' : `&cursor=${cursor}`}`);
            assert.equal(response.status, 200, `limit ${limit}`);
            assert.ok(response.body.items.length <= limit);
            seen.push(...response.body.items.map(item => item.id));
            cursor = response.body.nextCursor;
            pages += 1;
            assert.ok(pages < 20);
        } while (cursor !== null);
        assert.deepEqual(seen, everything, `limit ${limit} returns every group once, in order`);
        assert.equal(pages, Math.ceil(everything.length / limit), `limit ${limit}: the page count`);
    }
    assert.equal((await pageOf(alice, `?limit=${everything.length}`)).body.nextCursor, null, 'a page that ends exactly at the last group has no cursor');
    const first = await pageOf(alice, '?limit=2');
    assert.equal(typeof first.body.nextCursor, 'string');
    assert.ok(first.body.nextCursor.length <= 2048 && /^[A-Za-z0-9_-]+$/.test(first.body.nextCursor));
    assert.equal((await pageOf(alice, `?limit=2&cursor=${first.body.nextCursor}`)).status, 200, 'a later page may use another limit and the cursor stays valid');
    const changed = await pageOf(alice, `?limit=3&cursor=${first.body.nextCursor}`);
    assert.equal(changed.status, 200);
});

test('G02: a bad limit, an unknown parameter or a bad cursor is a 400 that names it, and nothing leaks through a crafted cursor', async t => {
    const clock = createClock(SINCE);
    const { actors, db } = await application(t, { features: ON, users: USERS3, clock });
    const [alice, bob, carol] = USERS3.map(name => actors[name]);
    const { ids } = seed(db, clock, alice, bob, carol);
    for (const index of [0, 1, 2]) builderGroups(db, clock, bob, `bob extra ${index}`);
    const before = snapshot(db).total;
    for (const query of ['limit=0', 'limit=51', 'limit=abc', 'limit=1.5', 'limit=01', 'limit=-1', 'limit=1e1', 'limit=%201', 'limit=', 'limit=1&limit=2', 'limit=%2B5', 'limit=0x10', 'limit=1000000']) {
        const response = await pageOf(alice, `?${query}`);
        assert.deepEqual([response.status, response.body], [400, error400(['limit'])], query);
    }
    assert.deepEqual((await pageOf(alice, '?foo=1')).body, error400(['foo']));
    assert.deepEqual((await pageOf(alice, '?limit=0&foo=1&bar=2')).body, error400(['limit', 'foo', 'bar']));
    assert.deepEqual((await pageOf(alice, '?userId=x&role=owner')).body, error400(['userId', 'role']), 'an identity claim in the query is an unknown parameter');
    for (const cursor of ['zzz', '!!!!', 'a'.repeat(2049), 'a'.repeat(2048), '', 'e30', 'bm90IGpzb24', encodeURIComponent('a b')]) {
        const response = await pageOf(alice, `?cursor=${cursor}`);
        assert.deepEqual([response.status, response.body], [400, error400(['cursor'])], cursor.slice(0, 20));
    }
    assert.deepEqual((await pageOf(alice, '?limit=0&cursor=zzz')).body, error400(['limit', 'cursor']));
    // Another user's cursor, another route's cursor, and a well-formed cursor of the wrong shape.
    const bobsCursor = (await pageOf(bob, '?limit=1')).body.nextCursor;
    assert.equal(typeof bobsCursor, 'string');
    assert.deepEqual((await pageOf(alice, `?cursor=${bobsCursor}`)).body, error400(['cursor']), 'a cursor issued to another user');
    const membersRoute = codec.encode({ last: ['2027-02-01T00:00:00.000Z', 'x'] }, { route: 'group-members', userId: alice.id, conversationId: ids.a1 });
    assert.deepEqual((await pageOf(alice, `?cursor=${membersRoute}`)).body, error400(['cursor']), 'a cursor of another route');
    for (const payload of [{ last: ['x'] }, { last: ['not-a-time', 'id'] }, { last: ['2027-02-01T00:00:00.000Z', 'id', 'extra'] }, { last: ['2027-02-01T00:00:00.000Z', 5] },
        { last: ['2027-02-01T00:00:00.000Z', 'id'], highWater: 4 }]) {
        const crafted = codec.encode(payload, { route: 'groups', userId: alice.id });
        assert.deepEqual((await pageOf(alice, `?cursor=${crafted}`)).body, error400(['cursor']), JSON.stringify(payload));
    }
    // A well-formed cursor can only move inside the groups the requester may see.
    const wide = codec.encode({ last: ['2999-01-01T00:00:00.000Z', 'zzzz'] }, { route: 'groups', userId: alice.id });
    const wideResponse = await pageOf(alice, `?cursor=${wide}`);
    assert.equal(wideResponse.status, 200);
    assert.ok(wideResponse.body.items.every(item => [ids.a1, ids.a2, ids.a3, ids.c1].includes(item.id)));
    const narrow = codec.encode({ last: ['2000-01-01T00:00:00.000Z', 'a'] }, { route: 'groups', userId: alice.id });
    assert.deepEqual((await pageOf(alice, `?cursor=${narrow}`)).body.items, []);
    assert.equal(snapshot(db).total, before, 'no read changed a table');
});
function builderGroups(db, clock, owner, title) {
    const id = createGroupBuilder({ db, clock }).createGroup({ ownerId: owner.id, title, idempotencyKey: null });
    stamp(db, id, '2027-02-07T00:00:00.000Z');
    return id;
}

test('G02: a session is needed, and a read changes no table', async t => {
    const clock = createClock(SINCE);
    const { actors, db, f } = await application(t, { features: ON, users: USERS3, clock });
    const [alice, bob, carol] = USERS3.map(name => actors[name]);
    seed(db, clock, alice, bob, carol);
    const before = snapshot(db).total;
    assertError(await f.browser().request('/api/groups'), 401, { code: 'UNAUTHENTICATED', fields: [] });
    await pageOf(alice, '?limit=2');
    assert.equal(snapshot(db).total, before);
});

test('G03: returns the projection with the name from Conversations.title and the other fields only from the extension record', async t => {
    const clock = createClock(SINCE);
    const { actors, db } = await application(t, { features: ON, users: USERS3, clock });
    const [alice, bob, carol] = USERS3.map(name => actors[name]);
    const { builder, ids } = seed(db, clock, alice, bob, carol);
    builder.addMember(ids.a1, bob.id);
    const detail = await send(alice, 'GET', `/api/groups/${ids.a1}`);
    assert.equal(detail.status, 200);
    assertSecurityHeaders(detail, 'G03');
    assert.deepEqual(Object.keys(detail.body), ['group']);
    assert.deepEqual(Object.keys(detail.body.group).sort(), GROUP_KEYS, 'no unreadCount in the detail');
    const row = db.prepare('SELECT * FROM Conversations WHERE conversation_id = ?').get(ids.a1);
    assert.deepEqual(detail.body.group, { id: ids.a1, name: 'A one', description: null, historyPolicy: 'from_joined', membershipRevision: 2, archived: false,
        createdAt: row.created_at, updatedAt: row.updated_at, memberCount: 2, role: 'owner' });
    // Each field follows its one source: change the source and only that field follows.
    db.prepare("UPDATE Conversations SET title = 'Renamed in Conversations' WHERE conversation_id = ?").run(ids.a1);
    db.prepare("UPDATE GroupExtensions SET description = 'Described in the extension', membership_revision = membership_revision + 1 WHERE conversation_id = ?").run(ids.a1);
    stamp(db, ids.a1, '2027-05-05T05:05:05.000Z');
    const changed = (await send(alice, 'GET', `/api/groups/${ids.a1}`)).body.group;
    assert.deepEqual([changed.name, changed.description, changed.membershipRevision, changed.updatedAt, changed.historyPolicy], ['Renamed in Conversations', 'Described in the extension', 3, '2027-05-05T05:05:05.000Z', 'from_joined']);
    const asMember = (await send(bob, 'GET', `/api/groups/${ids.a1}`)).body.group;
    assert.deepEqual([asMember.role, asMember.memberCount], ['member', 2]);
    const archived = (await send(alice, 'GET', `/api/groups/${ids.a3}`)).body.group;
    assert.deepEqual([archived.archived, archived.role], [true, 'owner']);
    const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
    assert.ok(!columns('Conversations').some(name => /description|history|revision/.test(name)), 'Conversations holds none of the extension fields');
    const source = fs.readFileSync(path.join(SERVER_ROOT, 'groups', 'service.js'), 'utf8');
    assert.ok(/name: row\.title/.test(source) && /description: row\.description/.test(source) && /historyPolicy: row\.history_policy/.test(source) && /membershipRevision: row\.membership_revision/.test(source));
});

test('G03: an unknown id, a direct conversation, a legacy group, a group without an extension record and a non-member get the identical 404', async t => {
    const clock = createClock(SINCE);
    const { actors, db, f } = await application(t, { features: ON, users: USERS3, clock });
    const [alice, bob, carol] = USERS3.map(name => actors[name]);
    const { builder, ids } = seed(db, clock, alice, bob, carol);
    const pending = builder.invite(ids.b1, bob.id, carol.id);
    assert.ok(pending);
    const cases = [['unknown id', alice, 'no-such-group'], ['malformed id', alice, 'a%20b'], ['dot segments', alice, '..%2Fx'], ['overlong id', alice, 'x'.repeat(2000)],
        ['direct conversation', alice, ids.direct], ['legacy group', alice, ids.legacy], ['group without an extension', alice, ids.bare],
        ['non-member', alice, ids.b1], ['removed member', alice, ids.c2], ['pending invitee', carol, ids.b1], ['control character', alice, 'a%00b'], ['unicode id', alice, '%E2%82%AC']];
    const answers = [];
    for (const [label, actor, id] of cases) {
        const response = await send(actor, 'GET', `/api/groups/${id}`);
        assert.equal(response.status, 404, label);
        answers.push([label, response.text, JSON.stringify(headersOf(response))]);
    }
    assert.equal(answers[0][1], JSON.stringify(error404));
    for (const answer of answers) assert.deepEqual([answer[1], answer[2]], [answers[0][1], answers[0][2]], `${answer[0]} is identical to the unknown id`);
    assert.equal((await f.browser().request(`/api/groups/${ids.a1}`)).status, 401);
    // A visible group still answers for its members, so the 404 above is not a blanket refusal.
    assert.equal((await send(alice, 'GET', `/api/groups/${ids.a1}`)).status, 200);
    assert.equal((await send(carol, 'GET', `/api/groups/${ids.c1}`)).status, 200);
    // The direct routes keep refusing a group id.
    assert.equal((await send(alice, 'GET', `/api/conversations/${ids.a1}`)).status, 404);
});
// ===============================================================================================================
// T-5C-09: G04 PATCH /api/groups/:id (DB5-R02.9 to R02.15, R07.2).
// ===============================================================================================================
const USERS4 = [...USERS3, 'grp-http-dave'];
const patchGroup = (actor, id, body, headers = {}) => send(actor, 'PATCH', `/api/groups/${id}`, { body, headers });
const stateOf = (db, id) => ({ conversation: db.prepare('SELECT * FROM Conversations WHERE conversation_id = ?').get(id),
    extension: db.prepare('SELECT * FROM GroupExtensions WHERE conversation_id = ?').get(id), audit: auditOf(db, id).length });

// alice owns the group, bob is an admin, carol a member, dave belongs to no group.
async function ownedGroup(t, { archived = false } = {}) {
    const clock = createClock(SINCE);
    const app = await application(t, { features: ON, users: USERS4, clock });
    const [alice, bob, carol, dave] = USERS4.map(name => app.actors[name]);
    const builder = createGroupBuilder({ db: app.db, clock });
    const id = builder.createGroup({ ownerId: alice.id, title: 'Original', description: 'Original description', idempotencyKey: null });
    builder.addMember(id, bob.id, { role: 'admin' });
    builder.addMember(id, carol.id);
    stamp(app.db, id, '2027-02-01T00:00:00.000Z');
    if (archived) app.db.prepare("UPDATE Conversations SET archived_at = '2027-02-01T00:00:00.000Z' WHERE conversation_id = ?").run(id);
    return { ...app, clock, builder, alice, bob, carol, dave, id };
}

test('G04: the owner updates name and description in one transaction with one audit row and gets the updated group', async t => {
    const { db, clock, alice, id } = await ownedGroup(t);
    const before = stateOf(db, id);
    const response = await patchGroup(alice, id, { name: '  Renamed  ', description: 'New description' });
    assert.equal(response.status, 200);
    assertSecurityHeaders(response, 'G04');
    assert.deepEqual(Object.keys(response.body), ['group']);
    assert.deepEqual(response.body.group, { id, name: 'Renamed', description: 'New description', historyPolicy: 'from_joined', membershipRevision: 4, archived: false,
        createdAt: before.conversation.created_at, updatedAt: clock.iso(), memberCount: 3, role: 'owner' });
    const after = stateOf(db, id);
    assert.deepEqual([after.conversation.title, after.extension.description, after.conversation.updated_at], ['Renamed', 'New description', clock.iso()]);
    assert.deepEqual([after.extension.history_policy, after.extension.membership_revision, after.conversation.archived_at], [before.extension.history_policy, before.extension.membership_revision, null]);
    assert.equal(after.audit, before.audit + 1);
    const audit = auditOf(db, id).at(-1);
    assert.deepEqual([audit.event_type, audit.actor_user_id, audit.source], ['group.updated', alice.id, 'groups']);
    assert.deepEqual(Object.keys(JSON.parse(audit.metadata_json)).sort(), ['operation', 'outcome']);
    assert.ok(!audit.metadata_json.includes('Renamed') && !audit.metadata_json.includes('New description'));
    // One field at a time, and null clears the description.
    clock.advance(1000);
    assert.equal((await patchGroup(alice, id, { name: 'Only the name' })).body.group.description, 'New description');
    assert.equal((await patchGroup(alice, id, { description: 'Only the description' })).body.group.name, 'Only the name');
    const cleared = await patchGroup(alice, id, { description: null });
    assert.deepEqual([cleared.status, cleared.body.group.description, cleared.body.group.name], [200, null, 'Only the name']);
    assert.equal(stateOf(db, id).extension.description, null);
    assert.equal((await send(alice, 'GET', `/api/groups/${id}/`)).body.group.description, null, 'a later read shows the stored value');
});

test('G04: a repeated patch with the same values changes nothing, writes no audit row and bumps no revision', async t => {
    const { db, clock, alice, id } = await ownedGroup(t);
    const first = await patchGroup(alice, id, { name: 'Same', description: 'Same description' });
    clock.advance(5000);
    const state = stateOf(db, id);
    for (const body of [{ name: 'Same', description: 'Same description' }, { name: ' Same ' }, { description: 'Same description' }, { name: 'Same', membershipRevision: 4 }]) {
        const repeated = await patchGroup(alice, id, body);
        assert.deepEqual([repeated.status, repeated.body], [200, first.body], JSON.stringify(body));
    }
    assert.deepEqual(stateOf(db, id), state, 'no column, no audit row and no revision moved');
});

test('G04: refusals come in the order 404, 403, archived 409, body 400, historyPolicy 400, stale 409, and each leaves every record unchanged', async t => {
    const { db, alice, bob, carol, dave, id, builder } = await ownedGroup(t);
    const state = stateOf(db, id);
    const invalid = { name: '' };
    assertError(await patchGroup(carol, id, { name: 'x' }), 403, { code: 'FORBIDDEN', fields: [] });
    assertError(await patchGroup(bob, id, { name: 'x' }), 403, { code: 'FORBIDDEN', fields: [] });
    assertError(await patchGroup(dave, id, { name: 'x' }), 404, error404);
    assertError(await patchGroup(carol, id, invalid), 403, { code: 'FORBIDDEN', fields: [] });
    assertError(await patchGroup(dave, id, invalid), 404, error404);
    assertError(await patchGroup(carol, id, { historyPolicy: 'all' }), 403, { code: 'FORBIDDEN', fields: [] });
    assertError(await patchGroup(dave, id, { historyPolicy: 'all' }), 404, error404);
    assertError(await patchGroup(bob, id, { name: 'x', historyPolicy: 'all', membershipRevision: 99 }), 403, { code: 'FORBIDDEN', fields: [] });
    assertError(await patchGroup(alice, 'no-such-group', { name: 'x' }), 404, error404);
    builder.removeMember(id, carol.id);
    assertError(await patchGroup(carol, id, { name: 'x' }), 404, error404);
    assert.deepEqual(stateOf(db, id).conversation, state.conversation);
    assert.equal(stateOf(db, id).audit, state.audit);
    // Archived: the owner meets 409 before any body check; a member still meets 403 and a non-member 404.
    const archived = await ownedGroup(t, { archived: true });
    const before = stateOf(archived.db, archived.id);
    for (const body of [{ name: 'x' }, { name: '' }, undefined, { historyPolicy: 'all' }, { name: 'x', membershipRevision: 99 }]) {
        assertError(await patchGroup(archived.alice, archived.id, body), 409, { code: 'CONFLICT', fields: [] });
    }
    assertError(await patchGroup(archived.carol, archived.id, { name: 'x' }), 403, { code: 'FORBIDDEN', fields: [] });
    assertError(await patchGroup(archived.dave, archived.id, { name: 'x' }), 404, error404);
    assert.deepEqual(stateOf(archived.db, archived.id), before);
});

test('G04: a body that is missing, not an object, empty, or holds a bad or unknown field is a 400 that names the fields', async t => {
    const { db, alice, id } = await ownedGroup(t);
    const state = stateOf(db, id);
    const json = { 'Content-Type': 'application/json' };
    const raw = rawBody => send(alice, 'PATCH', `/api/groups/${id}`, { rawBody, headers: json });
    assert.deepEqual((await send(alice, 'PATCH', `/api/groups/${id}`)).body, error400([]), 'no body');
    for (const rawBody of ['{}', '[]', '"x"', 'null', '7', 'true']) assert.deepEqual((await raw(rawBody)).body, error400([]), rawBody);
    const cases = [[{ name: '' }, ['name']], [{ name: ' ' }, ['name']], [{ name: 5 }, ['name']], [{ name: null }, ['name']], [{ name: 'n'.repeat(101) }, ['name']],
        [{ name: 'a\u0000b' }, ['name']], [{ description: 5 }, ['description']], [{ description: 'd'.repeat(1001) }, ['description']], [{ description: ['x'] }, ['description']],
        [{ name: 'ok', foo: 1 }, ['foo']], [{ foo: 1 }, ['foo']], [{ name: '', description: 5, foo: 1 }, ['name', 'description', 'foo']],
        [{ name: 'ok', userId: 'someone', role: 'owner', ownerId: 'x' }, ['userId', 'role', 'ownerId']],
        [{ name: 'ok', membershipRevision: 0 }, ['membershipRevision']], [{ name: 'ok', membershipRevision: '3' }, ['membershipRevision']],
        [{ name: 'ok', membershipRevision: null }, ['membershipRevision']], [{ name: 'ok', membershipRevision: 1.5 }, ['membershipRevision']],
        [{ name: 'ok', membershipRevision: -1 }, ['membershipRevision']], [{ membershipRevision: 3 }, []]];
    for (const [body, fields] of cases) {
        const response = await patchGroup(alice, id, body);
        assert.deepEqual([response.status, response.body], [400, error400(fields)], JSON.stringify(body));
        assertSecurityHeaders(response, JSON.stringify(body));
    }
    assert.deepEqual(stateOf(db, id), state);
});

test('G04: historyPolicy is never accepted, whatever its value, and a body fault is reported before it', async t => {
    const { db, alice, id } = await ownedGroup(t);
    const state = stateOf(db, id);
    for (const policy of ['all', 'from_joined', 'bogus', '', null, 1, true, [], {}, 'ALL']) {
        const alone = await patchGroup(alice, id, { historyPolicy: policy });
        assert.deepEqual([alone.status, alone.body], [400, error400(['historyPolicy'])], JSON.stringify(policy));
        const beside = await patchGroup(alice, id, { name: 'A valid new name', description: 'and description', historyPolicy: policy });
        assert.deepEqual([beside.status, beside.body], [400, error400(['historyPolicy'])], `beside a valid body: ${JSON.stringify(policy)}`);
    }
    assert.deepEqual((await patchGroup(alice, id, { name: '', historyPolicy: 'all' })).body, error400(['name']), 'a bad name is reported first');
    assert.deepEqual((await patchGroup(alice, id, { name: 'ok', historyPolicy: 'all', extra: 1 })).body, error400(['extra']), 'an unknown field is reported first');
    assert.deepEqual((await patchGroup(alice, id, { historyPolicy: 'all', membershipRevision: 99 })).body, error400(['historyPolicy']), 'the policy is reported before a stale revision');
    assert.deepEqual((await patchGroup(alice, id, { historyPolicy: 'all', membershipRevision: 0 })).body, error400(['membershipRevision']));
    assert.deepEqual(stateOf(db, id), state, 'no record changed');
    assert.equal(stateOf(db, id).extension.history_policy, 'from_joined');
});

test('G04: a stale Membership_Revision is a 409 STALE_STATE that changes nothing, and a matching one is applied', async t => {
    const { db, alice, id } = await ownedGroup(t);
    const state = stateOf(db, id);
    for (const revision of [1, 2, 3, 5, 99]) assertError(await patchGroup(alice, id, { name: 'Stale', membershipRevision: revision }), 409, { code: 'STALE_STATE', fields: [] });
    assert.deepEqual(stateOf(db, id), state);
    assert.deepEqual((await patchGroup(alice, id, { name: '', membershipRevision: 99 })).body, error400(['name']), 'the body is checked before the revision');
    const applied = await patchGroup(alice, id, { name: 'Fresh', membershipRevision: 4 });
    assert.deepEqual([applied.status, applied.body.group.name, applied.body.group.membershipRevision], [200, 'Fresh', 4]);
});

test('G04: a failed audit write rolls back the update', async t => {
    const { db, alice, id } = await ownedGroup(t);
    const state = stateOf(db, id);
    db.exec("CREATE TRIGGER test_refuse_group_audit BEFORE INSERT ON AuditLogs WHEN NEW.source = 'groups' BEGIN SELECT RAISE(ABORT, 'refused by the test'); END");
    try {
        const response = await patchGroup(alice, id, { name: 'Doomed', description: 'Doomed too' });
        assert.deepEqual([response.status, response.body], [500, { code: 'INTERNAL_ERROR', fields: [] }]);
        assert.ok(!response.text.includes('refused by the test'));
    } finally { db.exec('DROP TRIGGER test_refuse_group_audit'); }
    assert.deepEqual(stateOf(db, id), state);
});

test('G04: a session and a CSRF proof of the same session are required, and the actor is the session user', async t => {
    const { db, f, alice, bob, carol, id } = await ownedGroup(t);
    const state = stateOf(db, id);
    assert.equal((await f.browser().request(`/api/groups/${id}`, { method: 'PATCH', body: { name: 'x' } })).status, 401);
    assertError(await send(alice, 'PATCH', `/api/groups/${id}`, { body: { name: 'x' }, csrf: false }), 403, { code: 'CSRF_INVALID', fields: [] });
    assertError(await send(alice, 'PATCH', `/api/groups/${id}`, { body: { name: 'x' }, csrf: false, headers: { 'X-CSRF-Token': bob.token } }), 403, { code: 'CSRF_INVALID', fields: [] });
    // A member who claims to be the owner by header or body stays a member.
    assertError(await patchGroup(carol, id, { name: 'x' }, { 'X-User-Id': alice.id, 'X-Actor': alice.id, 'X-Role': 'owner', 'X-Owner-Id': alice.id }), 403, { code: 'FORBIDDEN', fields: [] });
    assert.deepEqual((await patchGroup(carol, id, { name: 'x', userId: alice.id, role: 'owner' })).body, { code: 'FORBIDDEN', fields: [] }, 'the role check comes before the body check');
    assert.deepEqual(stateOf(db, id), state);
});

test('G04: no route deletes, unarchives or restores a group, and the owner meets the final 404', async t => {
    const { db, alice, id } = await ownedGroup(t);
    const state = stateOf(db, id);
    for (const [method, url] of [['DELETE', `/api/groups/${id}`], ['DELETE', `/api/groups/${id}/`], ['PUT', `/api/groups/${id}`], ['POST', `/api/groups/${id}`],
        ['POST', `/api/groups/${id}/unarchive`], ['POST', `/api/groups/${id}/restore`], ['PATCH', `/api/groups/${id}/archive`], ['DELETE', '/api/groups']]) {
        assertError(await send(alice, method, url, { body: { name: 'x' } }), 404, error404);
    }
    assert.deepEqual(stateOf(db, id), state);
    assert.equal((await send(alice, 'GET', `/api/groups/${id}`)).status, 200, 'the group is still there');
});

// ===============================================================================================================
// T-5C-10: G05 GET /api/groups/:id/members (DB5-R03.1 to R03.4, R03.15).
// ===============================================================================================================
const USERS6 = [...USERS4, 'grp-http-erin', 'grp-http-frank'];
const membersOf = (actor, id, query = '') => send(actor, 'GET', `/api/groups/${id}/members${query}`);

// alice owns, bob is admin, carol a member; dave and erin were members and were removed (dave first); frank belongs to nothing.
async function memberGroup(t) {
    const clock = createClock(SINCE);
    const app = await application(t, { features: ON, users: USERS6, clock });
    const [alice, bob, carol, dave, erin, frank] = USERS6.map(name => app.actors[name]);
    const builder = createGroupBuilder({ db: app.db, clock });
    const id = builder.createGroup({ ownerId: alice.id, title: 'Members', idempotencyKey: null });
    for (const [user, role] of [[bob, 'admin'], [carol, 'member'], [dave, 'member'], [erin, 'member']]) builder.addMember(id, user.id, { role });
    builder.removeMember(id, dave.id);
    clock.advance(1000);
    builder.removeMember(id, erin.id);
    return { ...app, clock, builder, alice, bob, carol, dave, erin, frank, id };
}

test('G05: lists the Active_Members with the documented fields, in joined order, and no private data', async t => {
    const { db, alice, bob, carol, dave, id } = await memberGroup(t);
    const expected = db.prepare('SELECT user_id, joined_at FROM GroupMembershipIntervals WHERE conversation_id = ? AND left_at IS NULL ORDER BY joined_at, user_id').all(id);
    assert.equal(expected.length, 3);
    for (const actor of [alice, bob, carol]) {
        const response = await membersOf(actor, id);
        assert.equal(response.status, 200);
        assertSecurityHeaders(response, 'G05');
        assert.deepEqual(Object.keys(response.body), ['items', 'nextCursor']);
        assert.equal(response.body.nextCursor, null);
        assert.deepEqual(response.body.items.map(item => item.id), expected.map(row => row.user_id), 'joined time, then user id, ascending');
        assert.deepEqual(response.body.items.map(item => item.joinedAt), expected.map(row => row.joined_at));
        for (const item of response.body.items) {
            assert.deepEqual(Object.keys(item).sort(), ['avatar', 'displayName', 'id', 'joinedAt', 'role', 'username']);
            assert.ok(typeof item.username === 'string' && typeof item.displayName === 'string' && (item.avatar === null || typeof item.avatar === 'string'));
        }
        assert.ok(!/email|@example|password|passphrase|session|csrf|device|credential|hash|secret|"left/i.test(response.text), 'no private data');
        assert.ok(!response.text.includes(dave.id), 'a removed member is not listed');
    }
    const roles = Object.fromEntries((await membersOf(alice, id)).body.items.map(item => [item.id, item.role]));
    assert.deepEqual(roles, { [alice.id]: 'owner', [bob.id]: 'admin', [carol.id]: 'member' });
    assert.equal((await send(alice, 'HEAD', `/api/groups/${id}/members`)).status, 200);
});

test('G05: pages with a cursor bound to the user, the group and the list kind, and refuses a bad query by name', async t => {
    const { alice, bob, id, builder } = await memberGroup(t);
    const everything = (await membersOf(alice, id)).body.items.map(item => item.id);
    for (const limit of [1, 2, 3, 50]) {
        const seen = [];
        let cursor = null;
        let pages = 0;
        do {
            const response = await membersOf(alice, id, `?limit=${limit}${cursor === null ? '' : `&cursor=${cursor}`}`);
            assert.equal(response.status, 200, `limit ${limit}`);
            seen.push(...response.body.items.map(item => item.id));
            cursor = response.body.nextCursor;
            pages += 1;
            assert.ok(pages < 10);
        } while (cursor !== null);
        assert.deepEqual(seen, everything, `limit ${limit}`);
        assert.equal(pages, Math.ceil(everything.length / limit));
    }
    for (const query of ['limit=0', 'limit=51', 'limit=x', 'limit=1&limit=2', 'limit=']) assert.deepEqual((await membersOf(alice, id, `?${query}`)).body, error400(['limit']), query);
    assert.deepEqual((await membersOf(alice, id, '?foo=1')).body, error400(['foo']));
    assert.deepEqual((await membersOf(alice, id, '?former=maybe')).body, error400(['former']));
    assert.deepEqual((await membersOf(alice, id, '?former=TRUE')).body, error400(['former']));
    assert.deepEqual((await membersOf(alice, id, '?former=true&former=true')).body, error400(['former']));
    assert.deepEqual((await membersOf(alice, id, '?userId=x')).body, error400(['userId']));
    assert.deepEqual((await membersOf(alice, id, '?cursor=zzz')).body, error400(['cursor']));
    const first = (await membersOf(alice, id, '?limit=1')).body.nextCursor;
    assert.equal(typeof first, 'string');
    assert.deepEqual((await membersOf(bob, id, `?cursor=${first}`)).body, error400(['cursor']), 'a cursor of another user');
    const other = builder.createGroup({ ownerId: alice.id, title: 'Other', idempotencyKey: null });
    builder.addMember(other, bob.id);
    assert.deepEqual((await membersOf(alice, other, `?cursor=${first}`)).body, error400(['cursor']), 'a cursor of another group');
    assert.deepEqual((await membersOf(alice, id, `?former=true&cursor=${first}`)).body, error400(['cursor']), 'a cursor of the other list kind');
    assert.deepEqual((await send(alice, 'GET', `/api/groups?cursor=${first}`)).body, error400(['cursor']), 'a cursor of another route');
    for (const last of [['x'], ['2027-02-01T00:00:00.000Z'], [5, 'x'], ['2027-02-01T00:00:00.000Z', 'x', 'y']]) {
        const crafted = codec.encode({ last }, { route: 'group-members', userId: alice.id, conversationId: id });
        assert.equal((await membersOf(alice, id, `?cursor=${crafted}`)).status, 400, JSON.stringify(last));
    }
    const wide = codec.encode({ last: ['2000-01-01T00:00:00.000Z', 'a'] }, { route: 'group-members', userId: alice.id, conversationId: id });
    assert.deepEqual((await membersOf(alice, id, `?cursor=${wide}`)).body.items.map(item => item.id), everything, 'a crafted position can only move inside the visible members');
});

test('G05: former=true gives the former members with leftAt to an owner or admin only; a member gets 403 and no member data', async t => {
    const { db, alice, bob, carol, dave, erin, id } = await memberGroup(t);
    const expected = db.prepare('SELECT user_id, left_at FROM ConversationMembers WHERE conversation_id = ? AND left_at IS NOT NULL ORDER BY left_at, user_id').all(id);
    assert.deepEqual(expected.map(row => row.user_id), [dave.id, erin.id]);
    for (const actor of [alice, bob]) {
        const response = await membersOf(actor, id, '?former=true');
        assert.equal(response.status, 200);
        assert.deepEqual(response.body.items.map(item => item.id), [dave.id, erin.id]);
        assert.deepEqual(response.body.items.map(item => item.leftAt), expected.map(row => row.left_at));
        for (const item of response.body.items) {
            assert.deepEqual(Object.keys(item).sort(), ['avatar', 'displayName', 'id', 'joinedAt', 'leftAt', 'role', 'username']);
            assert.ok(typeof item.leftAt === 'string' && typeof item.joinedAt === 'string');
        }
        assert.ok(!/email|@example|password|session|csrf|device|credential/i.test(response.text));
        assert.ok(!response.text.includes(carol.id) && !response.text.includes(alice.id), 'only former members');
    }
    const paged = [];
    let cursor = null;
    do {
        const response = await membersOf(alice, id, `?former=true&limit=1${cursor === null ? '' : `&cursor=${cursor}`}`);
        assert.equal(response.status, 200);
        paged.push(...response.body.items.map(item => item.id));
        cursor = response.body.nextCursor;
    } while (cursor !== null);
    assert.deepEqual(paged, [dave.id, erin.id]);
    const refused = await membersOf(carol, id, '?former=true');
    assert.deepEqual([refused.status, refused.body, refused.text], [403, { code: 'FORBIDDEN', fields: [] }, JSON.stringify({ code: 'FORBIDDEN', fields: [] })]);
    assert.ok(!refused.text.includes(dave.id) && !refused.text.includes('items'));
    assert.deepEqual((await membersOf(carol, id, '?former=true&limit=0')).body, { code: 'FORBIDDEN', fields: [] }, 'the role check comes before the query check');
    assert.equal((await membersOf(carol, id, '?former=false')).status, 200, 'a member may ask for the active list explicitly');
    assert.deepEqual((await membersOf(carol, id, '?former=maybe')).body, error400(['former']));
});

test('G05: a non-member, a removed member, a pending invitee, a direct id and an unknown id get the identical 404', async t => {
    const { db, alice, carol, dave, frank, id, builder, f } = await memberGroup(t);
    const direct = createRepositories(db).conversations.create({ kind: 'direct', dm_user_low: [alice.id, frank.id].sort()[0], dm_user_high: [alice.id, frank.id].sort()[1], origin: 'authenticated', created_by: alice.id });
    const invited = builder.invite(id, alice.id, frank.id);
    assert.ok(invited);
    const cases = [['non-member', frank, id, ''], ['non-member asking for former', frank, id, '?former=true'], ['removed member', dave, id, ''], ['removed member asking for former', dave, id, '?former=true'],
        ['pending invitee', frank, id, '?limit=1'], ['bad query by a non-member', frank, id, '?limit=0&foo=1'], ['direct conversation', alice, direct.conversation_id, ''],
        ['unknown id', alice, 'no-such-group', ''], ['malformed id', alice, 'a%20b', '']];
    const answers = [];
    for (const [label, actor, target, query] of cases) {
        const response = await membersOf(actor, target, query);
        assert.equal(response.status, 404, label);
        answers.push([label, response.text, JSON.stringify(headersOf(response))]);
    }
    for (const answer of answers) assert.deepEqual([answer[1], answer[2]], [JSON.stringify(error404), answers[0][2]], answer[0]);
    assert.equal((await f.browser().request(`/api/groups/${id}/members`)).status, 401);
    assert.equal((await membersOf(carol, id)).status, 200);
});

// T-5C-11/12 HTTP integration. Real sessions, CSRF, the existing service and guarded synthetic databases only.
const INVITATION_FEATURES = Object.freeze({ groupApi: true, groups: Object.freeze({ maxMembers: 50,
    maxPendingInvitationsPerGroup: 50, maxPendingInvitationsPerInvitee: 50 }) });
async function invitationHttp(t, features = INVITATION_FEATURES, limiter = recordingLimiter()) {
    const { httpGroupFixture } = require('./support/groups');
    return httpGroupFixture(t, { features, limiter, clock: createClock('2030-01-01T00:00:00.000Z') });
}
const invitationPath = f => `/api/groups/${f.groupId}/invitations`;
const managerFields = ['createdAt', 'expiresAt', 'groupId', 'id', 'invitee', 'inviterId', 'state'];
const ownFields = ['createdAt', 'expiresAt', 'groupId', 'groupName', 'id', 'inviterDisplayName'];
const membershipState = db => ['ConversationMembers', 'GroupMembershipIntervals', 'GroupExtensions']
    .map(table => snapshot(db).tables[table]);

test('Batch 2A G12: 201 manager projection, fixed expiry, session actor, audit and duplicate 409; membership unchanged', async t => {
    const f = await invitationHttp(t), { owner, nonMember } = f.actors;
    const before = membershipState(f.db);
    const response = await send(owner, 'POST', invitationPath(f), { body: { userId: nonMember.id } });
    assert.equal(response.status, 201); assertSecurityHeaders(response, 'G12');
    assert.deepEqual(Object.keys(response.body), ['invitation']);
    const value = response.body.invitation;
    assert.deepEqual(Object.keys(value).sort(), managerFields);
    assert.deepEqual(Object.keys(value.invitee).sort(), ['avatar', 'displayName', 'id', 'username']);
    assert.equal(value.invitee.id, nonMember.id); assert.equal(value.inviterId, owner.id);
    assert.equal(value.groupId, f.groupId); assert.equal(value.state, 'pending');
    assert.equal(Date.parse(value.expiresAt) - Date.parse(value.createdAt), 604800000);
    assert.equal(f.db.prepare('SELECT inviter_id FROM ConversationInvitations WHERE invitation_id=?').get(value.id).inviter_id, owner.id);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM AuditLogs WHERE event_type='group.invitation.created' AND actor_user_id=? AND subject_id=?").get(owner.id, f.groupId).n, 1);
    assert.deepEqual(membershipState(f.db), before);
    assertError(await send(owner, 'POST', invitationPath(f), { body: { userId: nonMember.id } }), 409, { code: 'CONFLICT', fields: [] });
    assertError(await send(owner, 'POST', invitationPath(f), { body: { userId: f.actors.removedMember.id, actorId: nonMember.id } }), 400, { code: 'VALIDATION_ERROR', fields: ['actorId'] });
});

test('Batch 2A G13/G15: manager and own projections, fixed route, private pages and user/route-bound cursors', async t => {
    const f = await invitationHttp(t), { owner, admin, member, nonMember, pendingInvitee, removedMember } = f.actors;
    for (const target of [nonMember, removedMember]) assert.equal((await send(owner, 'POST', invitationPath(f), { body: { userId: target.id } })).status, 201);
    const other = f.builder.createGroup({ ownerId: owner.id, title: 'Second synthetic group', idempotencyKey: null });
    assert.equal((await send(owner, 'POST', `/api/groups/${other}/invitations`, { body: { userId: nonMember.id } })).status, 201);
    const before = snapshot(f.db).total;
    const manager = await send(owner, 'GET', invitationPath(f) + '?limit=1');
    assert.equal(manager.status, 200); assert.deepEqual(Object.keys(manager.body).sort(), ['items', 'nextCursor']);
    assert.equal(manager.body.items.length, 1); assert.ok(manager.body.nextCursor);
    assert.deepEqual(Object.keys(manager.body.items[0]).sort(), managerFields);
    assert.equal((await send(admin, 'GET', invitationPath(f))).body.items.length, 3);
    assertError(await send(member, 'GET', invitationPath(f)), 403, { code: 'FORBIDDEN', fields: [] });
    assertError(await send(pendingInvitee, 'GET', invitationPath(f)), 404, error404);
    const own = await send(nonMember, 'GET', '/api/groups/invitations?limit=1');
    assert.equal(own.status, 200); assert.equal(own.body.items.length, 1); assert.ok(own.body.nextCursor);
    assert.deepEqual(Object.keys(own.body.items[0]).sort(), ownFields);
    assert.ok(own.body.items[0].groupName && own.body.items[0].inviterDisplayName);
    const second = await send(nonMember, 'GET', '/api/groups/invitations?limit=1&cursor=' + encodeURIComponent(own.body.nextCursor));
    assert.equal(second.status, 200); assert.equal(second.body.nextCursor, null);
    assert.notEqual(second.body.items[0].id, own.body.items[0].id);
    assert.deepEqual((await send(member, 'GET', '/api/groups/invitations')).body, { items: [], nextCursor: null });
    const pending = await send(pendingInvitee, 'GET', '/api/groups/invitations');
    assert.deepEqual(pending.body.items.map(row => row.id), [f.invitationId]);
    assert.ok(!/email|password|credential|session|csrf|device|message|members/i.test(own.text));
    for (const url of [invitationPath(f) + '?foo=1', invitationPath(f) + '?limit=0', '/api/groups/invitations?limit=51', '/api/groups/invitations?cursor=bad']) {
        const response = await send(owner, 'GET', url); assert.equal(response.status, 400); assert.equal(response.body.code, 'VALIDATION_ERROR'); assert.ok(response.body.fields.length);
    }
    assertError(await send(admin, 'GET', invitationPath(f) + '?cursor=' + encodeURIComponent(manager.body.nextCursor)), 400, error400(['cursor']));
    assertError(await send(nonMember, 'GET', '/api/groups/invitations?cursor=' + encodeURIComponent(manager.body.nextCursor)), 400, error400(['cursor']));
    assertError(await send(pendingInvitee, 'GET', '/api/groups/invitations?cursor=' + encodeURIComponent(own.body.nextCursor)), 400, error400(['cursor']));
    assert.equal(snapshot(f.db).total, before, 'all list and refused query requests are read-only');
});

test('Batch 2A G14/G17: empty 204 bodies, terminal-state conflicts, audit atomicity and immediate re-invitation', async t => {
    const f = await invitationHttp(t), { owner, admin, pendingInvitee } = f.actors;
    const before = membershipState(f.db);
    const cancelled = await send(admin, 'DELETE', invitationPath(f) + '/' + f.invitationId);
    assert.equal(cancelled.status, 204); assert.equal(cancelled.text, ''); assert.equal(cancelled.body, null); assertSecurityHeaders(cancelled, 'G14');
    assert.equal(f.db.prepare('SELECT state FROM ConversationInvitations WHERE invitation_id=?').get(f.invitationId).state, 'cancelled');
    assertError(await send(owner, 'DELETE', invitationPath(f) + '/' + f.invitationId), 409, { code: 'CONFLICT', fields: [] });
    const created = await send(owner, 'POST', invitationPath(f), { body: { userId: pendingInvitee.id } });
    assert.equal(created.status, 201);
    const path = '/api/groups/invitations/' + created.body.invitation.id + '/decline';
    const declined = await send(pendingInvitee, 'POST', path);
    assert.equal(declined.status, 204); assert.equal(declined.text, ''); assert.equal(declined.body, null); assertSecurityHeaders(declined, 'G17');
    assert.equal(f.db.prepare('SELECT state FROM ConversationInvitations WHERE invitation_id=?').get(created.body.invitation.id).state, 'declined');
    assertError(await send(pendingInvitee, 'POST', path), 409, { code: 'CONFLICT', fields: [] });
    assert.equal((await send(owner, 'POST', invitationPath(f), { body: { userId: pendingInvitee.id } })).status, 201, 'no re-invite delay was introduced');
    for (const type of ['group.invitation.cancelled', 'group.invitation.declined']) assert.equal(f.db.prepare('SELECT count(*) AS n FROM AuditLogs WHERE event_type=? AND subject_id=?').get(type, f.groupId).n, 1);
    assert.deepEqual(membershipState(f.db), before);
});

test('Batch 2A privacy: uniform 404s and unauthorized cancellation never reveal an invitation identifier', async t => {
    const f = await invitationHttp(t), { owner, member, nonMember, pendingInvitee } = f.actors;
    const before = snapshot(f.db).total;
    for (const actor of [member, nonMember]) {
        const expected = actor === member ? [403, { code: 'FORBIDDEN', fields: [] }] : [404, error404];
        const answers = [];
        for (const id of [f.invitationId, 'unknown-invitation', 'invalid%20id']) {
            const response = await send(actor, 'DELETE', invitationPath(f) + '/' + id);
            assert.deepEqual([response.status, response.body], expected); answers.push(response.text);
        }
        assert.equal(new Set(answers).size, 1);
    }
    for (const actor of [owner, member, nonMember]) for (const id of [f.invitationId, 'unknown-invitation']) {
        assertError(await send(actor, 'POST', '/api/groups/invitations/' + id + '/decline'), 404, error404);
    }
    assertError(await send(owner, 'DELETE', '/api/groups/unknown-group/invitations/' + f.invitationId), 404, error404);
    assertError(await send(owner, 'DELETE', invitationPath(f) + '/unknown-invitation'), 404, error404);
    for (const actor of [owner, member, nonMember]) for (const id of [f.invitationId, 'unknown-invitation']) {
        assertError(await send(actor, 'POST', '/api/groups/invitations/' + id + '/accept'), 404, error404);
    }
    assertError(await send(pendingInvitee, 'POST', '/api/groups/invitations/unknown-invitation/accept'), 404, error404);
    assert.equal(snapshot(f.db).total, before, 'no unauthorized request changes state');
});

test('Batch 2A protection: real authentication, session-bound CSRF and gate-before-body on all five endpoints', async t => {
    for (const features of [INVITATION_FEATURES, DISABLED_FEATURES]) {
        const f = await invitationHttp(t, features), { owner, admin } = f.actors;
        const cases = [['POST', invitationPath(f)], ['GET', invitationPath(f)], ['DELETE', invitationPath(f) + '/' + f.invitationId],
            ['GET', '/api/groups/invitations'], ['POST', '/api/groups/invitations/' + f.invitationId + '/decline']];
        const before = snapshot(f.db).total; f.limiter.calls.length = 0;
        for (const [method, path] of cases) {
            const write = !['GET', 'HEAD'].includes(method);
            assertError(await f.browser().request(path, { method }), 401, { code: 'UNAUTHENTICATED', fields: [] });
            if (write) {
                assertError(await send(owner, method, path, { csrf: false }), 403, { code: 'CSRF_INVALID', fields: [] });
                assertError(await send(owner, method, path, { headers: { 'X-CSRF-Token': admin.token } }), 403, { code: 'CSRF_INVALID', fields: [] });
            }
            if (!features.groupApi) {
                const response = await send(owner, method, path, write ? { rawBody: '{invalid', headers: { 'Content-Type': 'application/json' } } : {});
                assertError(response, 503, error503); assertSecurityHeaders(response, 'disabled invitation');
            }
        }
        assert.equal(snapshot(f.db).total, before); assert.equal(f.limiter.calls.length, 0, 'authentication, CSRF and the disabled gate stop before rate writes');
    }
});

test('Batch 2A G12 rate limits: one invitation bucket set, actual socket source and Retry-After without a write', async t => {
    const limiter = { calls: [], denyInvitation: false, consume(buckets, at) {
        this.calls.push({ buckets, at });
        return this.denyInvitation && buckets.some(bucket => bucket.key.startsWith('groups:invite:'))
            ? { allowed: false, retryAfterSeconds: 37 } : { allowed: true };
    } };
    const f = await invitationHttp(t, INVITATION_FEATURES, limiter), { owner, nonMember, removedMember } = f.actors;
    limiter.calls.length = 0;
    assert.equal((await send(owner, 'POST', invitationPath(f), { body: { userId: nonMember.id }, headers: { 'X-Forwarded-For': '203.0.113.99' } })).status, 201);
    assert.equal(limiter.calls.length, 2, 'generic and invitation rate buckets, with no router duplication');
    assert.equal(limiter.calls[0].buckets.length, 2); assert.equal(limiter.calls[1].buckets.length, 3);
    assert.deepEqual(limiter.calls[1].buckets.map(bucket => [bucket.limit, bucket.windowMs]), [[20, 3600000], [5, 3600000], [60, 3600000]]);
    assert.ok(limiter.calls[1].buckets.some(bucket => bucket.key === 'groups:invite-source:127.0.0.1'));
    assert.ok(limiter.calls[1].buckets.some(bucket => bucket.key === 'groups:invite:' + owner.id));
    limiter.denyInvitation = true;
    const before = snapshot(f.db).total;
    const limited = await send(owner, 'POST', invitationPath(f), { body: { userId: removedMember.id } });
    assertError(limited, 429, { code: 'RATE_LIMITED', fields: [] }); assert.equal(limited.headers.get('retry-after'), '37');
    assert.equal(snapshot(f.db).total, before);
});

test('Batch 2A G12: missing maxima fail closed and private target failures have the identical HTTP 404', async t => {
    const missing = await invitationHttp(t, ON);
    assertError(await send(missing.actors.owner, 'POST', invitationPath(missing), { body: { userId: missing.actors.nonMember.id } }), 503, error503);
    const f = await invitationHttp(t), { owner, nonMember, pendingInvitee, removedMember } = f.actors;
    const legacy = f.repositories.users.create({ user_id: 'batch2a-legacy', username: 'batch2alegacy', display_name: 'Synthetic legacy' });
    f.db.prepare("UPDATE AccountCredentials SET status='disabled' WHERE user_id=?").run(removedMember.id);
    f.db.prepare("INSERT INTO Blocks(blocker_id,blocked_id,origin,created_at) VALUES(?,?,'authenticated',?)").run(nonMember.id, owner.id, f.clock.iso());
    const before = snapshot(f.db).total, answers = [];
    for (const id of ['unknown-target', legacy.user_id, removedMember.id, nonMember.id]) {
        const response = await send(owner, 'POST', invitationPath(f), { body: { userId: id } });
        assertError(response, 404, error404); answers.push(response.text);
    }
    assert.equal(new Set(answers).size, 1);
    assertError(await send(pendingInvitee, 'POST', invitationPath(f), { body: { userId: owner.id } }), 404, error404);
    assert.equal(snapshot(f.db).total, before);
});

test('Batch 2A audit failures: G12, G14 and G17 return sanitized 500 and roll back the complete write', async t => {
    const f = await invitationHttp(t), { owner, pendingInvitee, nonMember } = f.actors;
    f.db.exec(`CREATE TRIGGER batch2a_audit_failure BEFORE INSERT ON AuditLogs WHEN NEW.event_type LIKE 'group.invitation.%'
        BEGIN SELECT RAISE(ABORT, 'SENTINEL-BATCH2A-AUDIT'); END;`);
    const before = snapshot(f.db).total;
    for (const [actor, method, path, options] of [[owner, 'POST', invitationPath(f), { body: { userId: nonMember.id } }],
        [owner, 'DELETE', invitationPath(f) + '/' + f.invitationId, {}],
        [pendingInvitee, 'POST', '/api/groups/invitations/' + f.invitationId + '/decline', {}]]) {
        const response = await send(actor, method, path, options);
        assertError(response, 500, { code: 'INTERNAL_ERROR', fields: [] });
        assert.ok(!response.text.includes('SENTINEL')); assert.equal(snapshot(f.db).total, before);
    }
});
