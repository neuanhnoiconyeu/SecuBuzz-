'use strict';

// T-5C-04: the group router skeleton (DB5-R12.1 to R12.4, R12.10 to R12.12, R12.14, R13.2, R16.2, R16.13, R07.5, NFR-08).
// Two kinds of test. The real createApp runs on loopback over a temporary database (support/auth.js), with real sessions and
// real CSRF tokens, to show the HTTP behavior. A small express app around createGroupRouter, with fake middleware and a fake
// service that record their calls, shows the exact order of the chain. Only feature-status exists yet, so an enabled switch
// reaches no operation: every other path ends in the final 404.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { setup } = require('./support/auth');
const { snapshot, createClock, assertSecurityHeaders } = require('./support/groups');
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
async function application(t, { features, limiter = recordingLimiter(), users = ['grp-http-alice'] } = {}) {
    const clock = createClock();
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
test('the route table is frozen, and holds only the routes that are mounted', () => {
    assert.ok(Object.isFrozen(GROUP_ROUTES));
    for (const row of GROUP_ROUTES) assert.ok(Object.isFrozen(row));
    assert.deepEqual(GROUP_ROUTES.map(row => ({ ...row })), [{ id: 'G26', method: 'GET', path: '/feature-status', gated: false }]);
    assert.equal(assertRouteTable(GROUP_ROUTES), GROUP_ROUTES);
    assert.equal(MAX_BODY_BYTES, 8192);
    const router = createGroupRouter({ groups: { rate() {} }, features: OFF_SHAPE }, { requireAuth() {}, requireCsrf() {} });
    const mounted = router.stack.filter(layer => layer.route).map(layer => `${Object.keys(layer.route.methods).map(method => method.toUpperCase()).sort().join('+')} ${layer.route.path}`);
    assert.deepEqual(mounted, ['GET /feature-status'], 'the mounted layer stack equals the table');
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
        ['relative path', frozen(row('G03', 'GET', 'a'))], ['root path', frozen(row('G03', 'GET', '/'))], ['trailing slash', frozen(row('G03', 'GET', '/a/'))],
        ['empty segment', frozen(row('G03', 'GET', '/a//b'))], ['bad character', frozen(row('G03', 'GET', '/a*'))], ['unnamed parameter', frozen(row('G03', 'GET', '/:'))],
        ['ungated POST', frozen(row('G01', 'POST', '/a', false))], ['ungated non-boolean', frozen(row('G03', 'GET', '/a', 'no'))],
        ['group deletion', frozen(row('G99', 'DELETE', '/:id'))], ['group deletion with slash name', frozen(row('G99', 'DELETE', '/:groupId'))],
        ['unarchive', frozen(row('G98', 'POST', '/:id/unarchive'))], ['restore', frozen(row('G97', 'POST', '/:id/restore'))],
        ['parameter before a fixed route', frozen(row('G03', 'GET', '/:id'), row('G26', 'GET', '/feature-status', false))],
        ['parameter before a fixed deeper route', frozen(row('G05', 'GET', '/:id/members'), row('G15', 'GET', '/invitations/members'))]
    ];
    for (const [label, table] of bad) assert.ok(thrown(() => assertRouteTable(table)) instanceof TypeError, label);
    assert.doesNotThrow(() => assertRouteTable(frozen(row('G07', 'DELETE', '/:id/members/:userId'))), 'a member removal is not a group deletion');
});

test('createGroupRouter refuses missing dependencies and a handler that does not match the table', () => {
    const middleware = { requireAuth() {}, requireCsrf() {} };
    const groups = { rate() {} };
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
    app.use('/api/groups', createGroupRouter({ groups: { rate() { order.push('rate'); } } }, middleware));
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
    const groups = { rate(operation, context, source) {
        order.push(`rate:${operation}`);
        order.push(`actor:${context.userId}`);
        order.push(`source:${source}`);
        if (isolated.failRate) throw isolated.failRate;
    } };
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

test('switch on: the skeleton exposes no group operation, so every method on every path ends in the one 404', async t => {
    const limiter = recordingLimiter();
    const { actors, db } = await application(t, { features: ON, limiter, users: ['grp-http-alice'] });
    const alice = actors['grp-http-alice'];
    const before = snapshot(db).total;
    for (const method of EVERY_METHOD) {
        for (const url of PATHS) {
            const response = await send(alice, method, url, ['GET', 'HEAD'].includes(method) ? {} : { body: { name: 'Group', userId: alice.id, role: 'owner' } });
            assert.equal(response.status, 404, `${method} ${url}`);
            if (method !== 'HEAD') assert.deepEqual(response.body, error404, `${method} ${url}`);
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
// Body handling (DB5-R12.11, R12.14, R13.4; DC-05). The route table has no operation yet, so a request that passes every
// body rule ends in the 404, and a refusal is the status of its own step.
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
        // Measured with body-parser 2.4.0: it accepts utf-7 (the body is read as UTF-8 JSON) and answers 400 for utf-16. The
        // task text names utf-7 as a 415 example; the router adds no charset rule of its own. This pin fails if an upgrade changes it.
        ['a utf-7 charset is accepted by the installed parser', { rawBody: '{}', headers: { 'Content-Type': 'application/json; charset=utf-7' } }, 404, error404],
        ['a utf-16 charset is a parse failure', { rawBody: '{}', headers: { 'Content-Type': 'application/json; charset=utf-16' } }, 400, { code: 'VALIDATION_ERROR', fields: [] }],
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
