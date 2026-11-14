import './support/noNetwork.ts';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, test } from 'node:test';
import { AiConfigError, loadAiConfig } from '../../src/ai/config.ts';
import { AI_DISCLOSURE, computePayloadDigest } from '../../src/ai/consent.ts';
import { createAiHttpHandler } from '../../src/ai/http.ts';
import { secondsUntilNextPacificMidnight, type AiUsageStore } from '../../src/ai/usage.ts';
import type { AiGenerationRequest } from '../../src/ai/validation.ts';
import {
  delay,
  geminiError,
  geminiText,
  quotaFailure,
  SharedTestUsageStore,
  SharedUsageBackend,
  startAiServer,
  TEST_GEMINI_KEY,
  testConfig,
  type AiTestServer,
  type AiTestServerOptions,
} from './support/aiFixtures.ts';

const servers: AiTestServer[] = [];
async function server(options: AiTestServerOptions = {}): Promise<AiTestServer> {
  const started = await startAiServer(options);
  servers.push(started);
  return started;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((entry) => entry.close()));
});

const summarize: AiGenerationRequest = { task: 'summarize', input: 'Maya will share the test results by Thursday. Jules reviews the notes by Friday.' };
const templateEnv = { GEMINI_API_KEY: '', GEMINI_MODEL: 'gemini-3.5-flash-lite', AI_PROVIDER: 'gemini', AI_REMOTE_ENABLED: 'false' };

/** Sends headers and some body chunks without ending the request, then waits for the server's answer. */
function partialRequest(url: string, headers: Record<string, string>, writes: string[]): Promise<{ status: number; body: any; connection: unknown }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(url, { method: 'POST', headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        resolve({ status: incoming.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')), connection: incoming.headers.connection });
        outgoing.destroy();
      });
    });
    outgoing.on('error', reject);
    outgoing.flushHeaders();
    for (const chunk of writes) outgoing.write(chunk);
  });
}

function assertError(result: { status: number; body: any; headers: Record<string, unknown> }, status: number, code: string): void {
  assert.equal(result.status, status, JSON.stringify(result.body));
  assert.equal(result.body?.error?.code, code);
  assert.equal(typeof result.body.error.message, 'string');
  assert.deepEqual(Object.keys(result.body), ['error']);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.equal(result.headers['access-control-allow-origin'], undefined);
}

describe('fail-closed boundaries', () => {
  test('disabled AI answers AI_DISABLED without resolving the session or calling Gemini', async () => {
    const ai = await server({ config: loadAiConfig(templateEnv) });
    const user = ai.addUser('u1');
    for (const path of ['/api/ai/consent', '/api/ai/requests']) {
      const result = await ai.post(path, { request: summarize }, { user });
      assertError(result, 503, 'AI_DISABLED');
      assert.equal(result.headers.connection, 'close');
    }
    assert.equal(ai.sessions.contexts.length, 0);
    assert.equal(ai.gemini.calls.length, 0);
  });

  test('missing Database Team adapters answer AI_NOT_CONFIGURED', async () => {
    for (const [options, reason] of [
      [{ withResolver: false }, 'session_resolver_missing'],
      [{ withCsrf: false }, 'csrf_verifier_missing'],
      [{ usageStore: null }, 'usage_store_missing'],
    ] as const) {
      const ai = await server(options);
      const user = ai.addUser('u1');
      assertError(await ai.post('/api/ai/consent', {}, { user }), 503, 'AI_NOT_CONFIGURED');
      assert.ok(ai.logger.entries.some((entry) => entry.fields.reason === reason), reason);
      assert.equal(ai.gemini.calls.length, 0);
    }
  });

  test('the explicit local-development memory store works without an injected store', async () => {
    const ai = await server({ usageStore: null, env: { AI_LOCAL_DEV_MEMORY_QUOTA: 'true' } });
    const result = await ai.ask(ai.addUser('u1'), summarize);
    assert.equal(result.status, 200);
  });

  test('refuses a memory store in production and invalid handler options', () => {
    const production = testConfig({ NODE_ENV: 'production' });
    const memoryLike: AiUsageStore = {
      kind: 'memory', reserve: async () => ({ status: 'reserved' }), release: async () => undefined, consumeConsentNonce: async () => true,
    };
    assert.throws(() => createAiHttpHandler({ config: production, usageStore: memoryLike }), AiConfigError);
    assert.throws(() => createAiHttpHandler({ config: { enabled: true } as never }), /loadAiConfig/);
    assert.throws(() => createAiHttpHandler({ config: testConfig(), basePath: 'api/ai' }), /basePath/);
    assert.throws(() => createAiHttpHandler({ config: testConfig(), sessionResolver: {} as never }), /sessionResolver/);
    assert.throws(() => createAiHttpHandler({ config: testConfig(), usageStore: { kind: 'other' } as never }), /usageStore/);
  });

  test('routes only POST /consent and /requests', async () => {
    const ai = await server();
    const user = ai.addUser('u1');
    const wrongMethod = await ai.post('/api/ai/requests', undefined, { user, method: 'GET', contentType: null });
    assertError(wrongMethod, 405, 'AI_METHOD_NOT_ALLOWED');
    assert.equal(wrongMethod.headers.allow, 'POST');
    assertError(await ai.post('/api/ai/status', {}, { user }), 404, 'AI_NOT_FOUND');
    assertError(await ai.post('/api/ai/requests/', {}, { user }), 404, 'AI_NOT_FOUND');
    assertError(await ai.post('/elsewhere', {}, { user }), 404, 'AI_NOT_FOUND');
  });

  test('mounts like Express middleware and passes other paths to next()', async () => {
    const ai = await server({
      wrap: (handler) => (request, response) => {
        const original = request.url ?? '';
        Object.assign(request, { originalUrl: original });
        if (original.startsWith('/api/ai')) request.url = original.slice('/api/ai'.length) || '/';
        handler(request, response, () => { response.writeHead(418); response.end('next'); });
      },
    });
    const user = ai.addUser('u1');
    assert.equal((await ai.ask(user, summarize)).status, 200);
    const passed = await ai.post('/other/route', {}, { user });
    assert.equal(passed.status, 418);
    assert.equal(passed.text, 'next');
  });

  test('requires an allowlisted Origin before anything else runs', async () => {
    const ai = await server();
    const user = ai.addUser('u1');
    for (const origin of [null, 'https://evil.example', 'null', 'http://localhost:3001', 'http://localhost:3000/']) {
      assertError(await ai.post('/api/ai/requests', { request: summarize }, { user, origin }), 403, 'AI_FORBIDDEN');
    }
    assert.equal(ai.sessions.contexts.length, 0);
  });

  test('accepts only JSON without content encoding', async () => {
    const ai = await server();
    const user = ai.addUser('u1');
    for (const contentType of [null, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/json; charset=latin1']) {
      assertError(await ai.post('/api/ai/consent', {}, { user, contentType }), 415, 'AI_INVALID_REQUEST');
    }
    assertError(await ai.post('/api/ai/consent', {}, { user, headers: { 'content-encoding': 'gzip' } }), 415, 'AI_INVALID_REQUEST');
    assert.equal((await ai.post('/api/ai/consent', { disclosureVersion: AI_DISCLOSURE.version, payloadDigest: computePayloadDigest(summarize) },
      { user, contentType: 'application/json; charset=UTF-8' })).status, 200);
  });

  test('authenticates only from the session cookie and fails closed', async () => {
    const ai = await server();
    const user = ai.addUser('u1');
    const body = { disclosureVersion: AI_DISCLOSURE.version, payloadDigest: computePayloadDigest(summarize) };
    assertError(await ai.post('/api/ai/consent', body, { user, cookie: null }), 401, 'AI_AUTH_REQUIRED');
    assertError(await ai.post('/api/ai/consent', body, { user, cookie: `${user.cookie}; ${user.cookie}` }), 401, 'AI_AUTH_REQUIRED');
    assertError(await ai.post('/api/ai/consent', body, { user, cookie: 'secubuzz_session=unknown-token' }), 401, 'AI_AUTH_REQUIRED');
    assertError(await ai.post('/api/ai/consent', { ...body, userId: 'u1' }, { user, cookie: null }), 401, 'AI_AUTH_REQUIRED');
    const expiring = ai.addUser('u2', { ttlMs: -1_000 });
    assertError(await ai.post('/api/ai/consent', body, { user: expiring }), 401, 'AI_AUTH_REQUIRED');
    const demo = ai.addUser('demo-session-nova');
    assertError(await ai.post('/api/ai/consent', body, { user: demo }), 401, 'AI_AUTH_REQUIRED');
    const context = ai.sessions.contexts.at(-1)!;
    assert.equal(context.origin, 'http://localhost:3000');
    assert.deepEqual(Object.keys(context).sort(), ['origin', 'receivedAt', 'remoteAddress', 'secure', 'sessionToken', 'userAgent']);
    for (const [mode, status, code] of [['throw', 503, 'AI_SERVICE_UNAVAILABLE'], ['hang', 503, 'AI_SERVICE_UNAVAILABLE'], ['malformed', 503, 'AI_SERVICE_UNAVAILABLE']] as const) {
      ai.sessions.mode = mode;
      assertError(await ai.post('/api/ai/consent', body, { user }), status, code);
    }
    ai.sessions.mode = 'normal';
    ai.sessions.markExpired(decodeURIComponent(user.cookie.split('=')[1]!));
    assertError(await ai.post('/api/ai/consent', body, { user }), 401, 'AI_AUTH_REQUIRED');
    assert.ok(!ai.logger.text().includes('hunter2'), 'adapter error detail logged');
  });

  test('verifies the CSRF token for the authenticated session', async () => {
    const ai = await server();
    const user = ai.addUser('u1');
    const other = ai.addUser('u2');
    const body = { disclosureVersion: AI_DISCLOSURE.version, payloadDigest: computePayloadDigest(summarize) };
    assertError(await ai.post('/api/ai/consent', body, { user, csrf: null }), 403, 'AI_FORBIDDEN');
    assertError(await ai.post('/api/ai/consent', body, { user, csrf: 'two words' }), 403, 'AI_FORBIDDEN');
    assertError(await ai.post('/api/ai/consent', body, { user, csrf: other.csrf }), 403, 'AI_FORBIDDEN');
    ai.csrf.mode = 'malformed';
    assertError(await ai.post('/api/ai/consent', body, { user }), 403, 'AI_FORBIDDEN');
    ai.csrf.mode = 'throw';
    assertError(await ai.post('/api/ai/consent', body, { user }), 503, 'AI_SERVICE_UNAVAILABLE');
    ai.csrf.mode = 'normal';
    assert.equal((await ai.post('/api/ai/consent', body, { user })).status, 200);
    assert.deepEqual(ai.csrf.inputs.at(-1), { sessionId: user.sessionId, userId: 'u1', token: user.csrf });
  });

  test('bounds the request body and parses strictly', async () => {
    const ai = await server({ bodyTimeoutMs: 150 });
    const user = ai.addUser('u1');
    const headers = { origin: 'http://localhost:3000', cookie: user.cookie, 'x-csrf-token': user.csrf, 'content-type': 'application/json' };
    // Declared too large: refused before any body byte is read.
    const declared = await partialRequest(`${ai.url}/api/ai/requests`, { ...headers, 'content-length': '70000' }, []);
    assert.deepEqual([declared.status, declared.body.error.code, declared.connection], [413, 'AI_INPUT_TOO_LARGE', 'close']);
    // Streamed without a length: refused as soon as the running total passes 64 KiB.
    const streamed = await partialRequest(`${ai.url}/api/ai/requests`, { ...headers, 'transfer-encoding': 'chunked' }, Array.from({ length: 5 }, () => 'x'.repeat(16_384)));
    assert.deepEqual([streamed.status, streamed.body.error.code], [413, 'AI_INPUT_TOO_LARGE']);
    // A body that stops arriving times out.
    const slow = await partialRequest(`${ai.url}/api/ai/consent`, { ...headers, 'content-length': '100' }, ['{"disclosure']);
    assert.deepEqual([slow.status, slow.body.error.code], [408, 'AI_TIMEOUT']);
    assertError(await ai.post('/api/ai/requests', undefined, { user, raw: '{"request":' }), 400, 'AI_INVALID_REQUEST');
    assertError(await ai.post('/api/ai/requests', undefined, { user, raw: Buffer.from([0x7b, 0xff, 0x7d]) }), 400, 'AI_INVALID_REQUEST');
    assertError(await ai.post('/api/ai/requests', undefined, { user, raw: '[]' }), 400, 'AI_INVALID_REQUEST');
  });

  test('fails loudly when a body parser consumed the request first', async () => {
    const ai = await server({
      wrap: (handler) => (request, response) => {
        request.resume();
        request.once('end', () => handler(request, response));
      },
    });
    assertError(await ai.post('/api/ai/consent', { disclosureVersion: AI_DISCLOSURE.version, payloadDigest: computePayloadDigest(summarize) }, { user: ai.addUser('u1') }),
      500, 'AI_INTERNAL_ERROR');
    assert.ok(ai.logger.entries.some((entry) => entry.fields.reason === 'body_already_consumed'));
  });
});

describe('consent and generation', () => {
  test('consent then generation returns plain output with safe headers', async () => {
    const ai = await server({ replies: [geminiText('• Maya: share the test results — Deadline: Thursday.')] });
    const user = ai.addUser('u1');
    const consent = await ai.consent(user, summarize);
    assert.equal(consent.status, 200);
    assert.deepEqual(Object.keys(consent.body), ['consentToken']);
    assert.equal(ai.gemini.calls.length, 0, 'consent never calls Gemini');
    const result = await ai.generate(user, summarize, consent.body.consentToken);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { output: '• Maya: share the test results — Deadline: Thursday.', kind: 'answer' });
    assert.equal(result.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
    assert.equal(result.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'");
    assert.equal(result.headers['access-control-allow-origin'], undefined);
    assert.equal(ai.gemini.calls.length, 1);
    assert.match(ai.gemini.calls[0]!.body.contents[0].parts[0].text, /Maya will share the test results by Thursday/);
  });

  test('every task and option reaches Gemini through its own instruction', async () => {
    const ai = await server();
    const user = ai.addUser('u1');
    const requests: AiGenerationRequest[] = [
      { task: 'chat', input: 'What can @Secu do?' }, { task: 'summarize', input: 'Notes.' }, { task: 'rewrite', input: 'Send notes.', tone: 'Friendly' },
      { task: 'translate', input: 'Hello!', targetLanguage: 'French' }, { task: 'action_items', input: 'Maya ships Friday.' }, { task: 'explain', input: '2FA.' },
    ];
    for (const request of requests) assert.equal((await ai.ask(user, request)).status, 200, request.task);
    const instructions = ai.gemini.calls.map((call) => call.body.systemInstruction.parts[0].text as string);
    assert.match(instructions[2]!, /Friendly tone/);
    assert.match(instructions[3]!, /into French/);
    assert.equal(new Set(instructions.map((text) => text.split('\n').at(-1))).size, requests.length);
  });

  test('requires a valid, unused consent token for this session, payload and disclosure', async () => {
    let offset = 0;
    const ai = await server({ now: () => Date.now() + offset });
    const user = ai.addUser('u1');
    const other = ai.addUser('u2');
    assertError(await ai.generate(user, summarize), 403, 'AI_CONSENT_REQUIRED');
    assertError(await ai.consent(user, summarize, 'gemini-free-tier-2026-10-v0'), 403, 'AI_CONSENT_REQUIRED');
    const token = await ai.consentToken(user, summarize);
    assertError(await ai.generate(other, summarize, token), 403, 'AI_CONSENT_REQUIRED');
    assertError(await ai.generate(user, { ...summarize, input: `${summarize.input} Also send the budget.` }, token), 403, 'AI_CONSENT_REQUIRED');
    assertError(await ai.generate(user, summarize, `${token.slice(0, -2)}xx`), 403, 'AI_CONSENT_REQUIRED');
    assert.equal((await ai.generate(user, summarize, token)).status, 200);
    assertError(await ai.generate(user, summarize, token), 403, 'AI_CONSENT_REQUIRED');
    const late = await ai.consentToken(user, summarize);
    offset = 61_000;
    assertError(await ai.generate(user, summarize, late), 403, 'AI_CONSENT_REQUIRED');
    assert.equal(ai.gemini.calls.length, 1);
    const reasons = ai.logger.entries.filter((entry) => entry.fields.code === 'AI_CONSENT_REQUIRED').map((entry) => entry.fields.reason);
    assert.deepEqual(reasons, ['consent_missing', 'consent_disclosure', 'consent_session', 'consent_payload_mismatch', 'consent_signature', 'consent_replayed', 'consent_expired']);
  });

  test('never sends Messenger context or credentials to Gemini', async () => {
    const ai = await server();
    const user = ai.addUser('u1');
    const store = ai.usageStore as SharedTestUsageStore;
    for (const request of [
      { task: 'summarize', input: 'Only this chosen message', conversationId: 'securebot-demo' },
      { task: 'rewrite', input: 'My private draft', tone: 'Friendly', conversationId: 'conversation-42' },
      { task: 'explain', input: `What is AIza${'Q'.repeat(35)}?` },
      { task: 'chat', input: 'password=hunter2 is my password' },
    ] as AiGenerationRequest[]) {
      assertError(await ai.ask(user, request), 403, 'AI_PRIVACY_RESTRICTED');
    }
    assert.equal(ai.gemini.calls.length, 0);
    assert.equal(store.backend.nonceCalls, 0);
    assert.equal(store.backend.reserveCalls, 0);
    assert.ok(!ai.logger.text().includes('hunter2') && !ai.logger.text().includes('private draft'));
  });

  test('rejects unknown fields and oversized input before consent or quota', async () => {
    const ai = await server({ env: { AI_MAX_INPUT_CHARS: '100' } });
    const user = ai.addUser('u1');
    assertError(await ai.post('/api/ai/requests', { request: { ...summarize, userId: 'admin' } }, { user }), 400, 'AI_INVALID_REQUEST');
    assertError(await ai.post('/api/ai/requests', { request: summarize, model: 'gemini-3.5-pro' }, { user }), 400, 'AI_INVALID_REQUEST');
    assertError(await ai.post('/api/ai/requests', { request: { task: 'chat', input: 'x', tone: 'Friendly' } }, { user }), 400, 'AI_INVALID_REQUEST');
    assertError(await ai.post('/api/ai/requests', { request: { task: 'chat', input: 'x'.repeat(101) } }, { user }), 413, 'AI_INPUT_TOO_LARGE');
    assert.equal(ai.gemini.calls.length, 0);
  });
});

describe('quota and cost protection', () => {
  test('limits each user per minute and per Pacific day, with Retry-After', async () => {
    const minute = await server({ env: { AI_USER_RPM: '2' } });
    const user = minute.addUser('u1');
    assert.equal((await minute.ask(user, summarize)).status, 200);
    assert.equal((await minute.ask(user, summarize)).status, 200);
    const limited = await minute.ask(user, summarize);
    assertError(limited, 429, 'AI_RATE_LIMITED');
    assert.ok(Number(limited.headers['retry-after']) >= 1 && Number(limited.headers['retry-after']) <= 60);
    assert.equal(minute.gemini.calls.length, 2);

    const daily = await server({ env: { AI_USER_RPD: '2' } });
    const person = daily.addUser('u1');
    await daily.ask(person, summarize);
    await daily.ask(person, summarize);
    const exhausted = await daily.ask(person, summarize);
    assertError(exhausted, 429, 'AI_DAILY_QUOTA_EXHAUSTED');
    assert.ok(Math.abs(Number(exhausted.headers['retry-after']) - secondsUntilNextPacificMidnight(Date.now())) <= 5);
    assert.equal(exhausted.body.error.message, '@Secu has reached its free AI usage limit.');
  });

  test('limits the whole project across users', async () => {
    const ai = await server({ env: { AI_PROJECT_RPM: '2' } });
    assert.equal((await ai.ask(ai.addUser('a'), summarize)).status, 200);
    assert.equal((await ai.ask(ai.addUser('b'), summarize)).status, 200);
    assertError(await ai.ask(ai.addUser('c'), summarize), 429, 'AI_RATE_LIMITED');
    const daily = await server({ env: { AI_PROJECT_RPD: '1' } });
    assert.equal((await daily.ask(daily.addUser('a'), summarize)).status, 200);
    assertError(await daily.ask(daily.addUser('b'), summarize), 429, 'AI_DAILY_QUOTA_EXHAUSTED');
  });

  test('allows one active request per user and bounds project concurrency; timeouts are not refunded', async () => {
    const ai = await server({ env: { AI_MAX_CONCURRENT: '1', AI_TIMEOUT_MS: '1000', AI_USER_RPM: '2' }, replies: [{ hang: 'respect-abort' }, geminiText('Done.')] });
    const first = ai.addUser('a');
    const pending = ai.ask(first, summarize);
    await delay(150);
    assertError(await ai.ask(first, summarize), 429, 'AI_RATE_LIMITED');
    assertError(await ai.ask(ai.addUser('b'), summarize), 429, 'AI_RATE_LIMITED');
    assertError(await pending, 504, 'AI_TIMEOUT');
    assert.equal((await ai.ask(first, summarize)).status, 200);
    assertError(await ai.ask(first, summarize), 429, 'AI_RATE_LIMITED');
    assert.equal(ai.gemini.calls.length, 2);
    const reasons = ai.logger.entries.filter((entry) => entry.fields.code === 'AI_RATE_LIMITED').map((entry) => entry.fields.reason);
    assert.deepEqual(reasons, ['user_busy', 'scope_busy', 'user_minute']);
  });

  test('a provider 429 opens the breaker; later requests are refused without calling Gemini', async () => {
    const ai = await server({ replies: [geminiError(429, 'RESOURCE_EXHAUSTED', quotaFailure('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '30s')), geminiText('never')] });
    const limited = await ai.ask(ai.addUser('a'), summarize);
    assertError(limited, 429, 'AI_RATE_LIMITED');
    assert.equal(limited.headers['retry-after'], '30');
    const blocked = await ai.ask(ai.addUser('b'), summarize);
    assertError(blocked, 429, 'AI_RATE_LIMITED');
    assert.ok(Number(blocked.headers['retry-after']) <= 30);
    assert.equal(ai.gemini.calls.length, 1);
    assert.ok(ai.logger.has('ai.breaker.opened'));

    const daily = await server({ replies: [geminiError(429, 'RESOURCE_EXHAUSTED', quotaFailure('GenerateRequestsPerDayPerProjectPerModel-FreeTier'))] });
    assertError(await daily.ask(daily.addUser('a'), summarize), 429, 'AI_DAILY_QUOTA_EXHAUSTED');
    assertError(await daily.ask(daily.addUser('b'), summarize), 429, 'AI_DAILY_QUOTA_EXHAUSTED');
    assert.equal(daily.gemini.calls.length, 1);

    const misconfigured = await server({ replies: [geminiError(403, 'PERMISSION_DENIED'), geminiText('never')] });
    assertError(await misconfigured.ask(misconfigured.addUser('a'), summarize), 503, 'AI_PROVIDER_UNAVAILABLE');
    const after = await misconfigured.ask(misconfigured.addUser('b'), summarize);
    assertError(after, 503, 'AI_PROVIDER_UNAVAILABLE');
    assert.ok(Number(after.headers['retry-after']) > 250);
    assert.equal(misconfigured.gemini.calls.length, 1);
  });

  test('failed provider calls still count and are never retried or replaced', async () => {
    const ai = await server({ env: { AI_USER_RPM: '2' }, replies: [geminiError(500, 'INTERNAL'), geminiError(503, 'UNAVAILABLE'), geminiText('never')] });
    const user = ai.addUser('u1');
    assertError(await ai.ask(user, summarize), 503, 'AI_PROVIDER_UNAVAILABLE');
    assertError(await ai.ask(user, summarize), 503, 'AI_PROVIDER_UNAVAILABLE');
    assertError(await ai.ask(user, summarize), 429, 'AI_RATE_LIMITED');
    assert.equal(ai.gemini.calls.length, 2);
    assert.ok(ai.gemini.calls.every((call) => call.url.endsWith('/models/gemini-3.5-flash-lite:generateContent')));
  });

  test('a shared durable store keeps counts across a restart and across workers', async () => {
    const backend = new SharedUsageBackend();
    const first = await server({ env: { AI_USER_RPD: '2' }, usageStore: new SharedTestUsageStore(backend) });
    assert.equal((await first.ask(first.addUser('u1'), summarize)).status, 200);
    assert.equal((await first.ask(first.addUser('u1'), summarize)).status, 200);
    await first.close();
    const restarted = await server({ env: { AI_USER_RPD: '2' }, usageStore: new SharedTestUsageStore(backend) });
    assertError(await restarted.ask(restarted.addUser('u1'), summarize), 429, 'AI_DAILY_QUOTA_EXHAUSTED');
    assert.equal(restarted.gemini.calls.length, 0);
  });

  test('workers sharing a store never exceed the project limit together', async () => {
    const backend = new SharedUsageBackend();
    const workers = await Promise.all([0, 1].map(() => server({ env: { AI_PROJECT_RPM: '3' }, usageStore: new SharedTestUsageStore(backend) })));
    const results = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const worker = workers[index % 2]!;
      return (await worker.ask(worker.addUser(`user-${index}`), summarize)).status;
    }));
    assert.equal(results.filter((status) => status === 200).length, 3);
    assert.equal(results.filter((status) => status === 429).length, 5);
    assert.equal(workers[0]!.gemini.calls.length + workers[1]!.gemini.calls.length, 3);
    const user = workers[0]!.addUser('shared');
    workers[1]!.sessions.add(decodeURIComponent(user.cookie.split('=')[1]!), { sessionId: user.sessionId, userId: 'shared', displayName: 'Shared', expiresAt: new Date(Date.now() + 60_000) });
    const csrfOnSecond = workers[1]!.csrf.issue(user.sessionId);
    const token = await workers[0]!.consentToken(user, { task: 'chat', input: 'Hi' });
    const second = { ...user, csrf: csrfOnSecond };
    const outcomes = await Promise.all([workers[0]!.generate(user, { task: 'chat', input: 'Hi' }, token), workers[1]!.generate(second, { task: 'chat', input: 'Hi' }, token)]);
    assert.equal(outcomes.filter((outcome) => outcome.body?.error?.code === 'AI_CONSENT_REQUIRED').length, 1, 'a consent token is single-use across workers');
  });

  test('usage store failures fail closed before Gemini', async () => {
    for (const [mode, field] of [['throw', 'reserveMode'], ['hang', 'reserveMode'], ['malformed', 'reserveMode'], ['throw', 'nonceMode'], ['malformed', 'nonceMode']] as const) {
      const store = new SharedTestUsageStore();
      store[field] = mode;
      const ai = await server({ usageStore: store });
      const result = await ai.ask(ai.addUser('u1'), summarize);
      if (field === 'nonceMode' && mode === 'malformed') assertError(result, 403, 'AI_CONSENT_REQUIRED');
      else assertError(result, 503, 'AI_SERVICE_UNAVAILABLE');
      assert.equal(ai.gemini.calls.length, 0, `${field}=${mode}`);
    }
  });
});

describe('disconnects and logging', () => {
  test('a client that disconnects aborts the Gemini call', async () => {
    const ai = await server({ replies: [{ hang: 'respect-abort' }] });
    const user = ai.addUser('u1');
    const token = await ai.consentToken(user, summarize);
    const body = JSON.stringify({ request: summarize, consentToken: token });
    const outgoing = httpRequest(`${ai.url}/api/ai/requests`, {
      method: 'POST',
      headers: { origin: 'http://localhost:3000', cookie: user.cookie, 'x-csrf-token': user.csrf, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    });
    outgoing.on('error', () => undefined);
    outgoing.end(body);
    const started = Date.now();
    while (ai.gemini.calls.length === 0 && Date.now() - started < 2_000) await delay(10);
    outgoing.destroy();
    while (!ai.logger.has('ai.provider.failed') && Date.now() - started < 3_000) await delay(10);
    assert.equal(ai.gemini.calls[0]!.signal!.aborted, true);
    assert.ok(ai.logger.entries.some((entry) => entry.event === 'ai.provider.failed' && entry.fields.code === 'AI_CANCELLED'));
  });

  test('logs carry codes and counts, never text, output, keys, tokens, cookies or identities', async () => {
    const ai = await server({ replies: [geminiText('UNIQUE-OUTPUT-7731'), geminiError(500, 'INTERNAL')] });
    const user = ai.addUser('private-user-id-5521', { sessionId: 'private-session-id-8814' });
    const request: AiGenerationRequest = { task: 'explain', input: 'UNIQUE-INPUT-4409 needs a simple explanation.' };
    const token = await ai.consentToken(user, request);
    assert.equal((await ai.generate(user, request, token)).status, 200);
    await ai.ask(user, { task: 'chat', input: 'UNIQUE-INPUT-9921' });
    await ai.ask(user, { task: 'chat', input: 'UNIQUE-INPUT-1234', conversationId: 'conversation-777' });
    const text = ai.logger.text();
    for (const secret of ['UNIQUE-OUTPUT-7731', 'UNIQUE-INPUT', TEST_GEMINI_KEY, token, user.csrf, user.cookie.split('=')[1]!, 'private-user-id', 'private-session-id', 'conversation-777', 'AIza']) {
      assert.ok(!text.includes(secret), `logged: ${secret}`);
    }
    const completed = ai.logger.entries.find((entry) => entry.event === 'ai.request.completed')!;
    assert.deepEqual(completed.fields, {
      task: 'explain', durationMs: completed.fields.durationMs, promptTokens: 120, outputTokens: 12, thoughtsTokens: 3, totalTokens: 135, serviceTier: 'standard',
    });
    assert.ok(ai.logger.entries.some((entry) => entry.event === 'ai.provider.failed' && entry.fields.providerStatus === 500 && entry.fields.providerStatusText === 'INTERNAL'));
  });
});
