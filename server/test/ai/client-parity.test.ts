/**
 * Loads the real Phase 9B client adapter (`client/src/ai/remoteAIProvider.ts`) and the Phase 9A
 * execution boundary (`executeAIRequest.ts`) and runs them against the real AI handler with a
 * mocked Gemini `fetch`. This is a mocked end-to-end test, not a live Gemini integration.
 * The client sources use extensionless imports, so they are loaded through tsx's `tsImport`.
 */
import './support/noNetwork.ts';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { AI_DISCLOSURE, computePayloadDigest } from '../../src/ai/consent.ts';
import { loadAiConfig } from '../../src/ai/config.ts';
import { AI_ERROR_CODES, DEFAULT_AI_BASE_PATH } from '../../src/ai/protocol.ts';
import type { AiGenerationRequest } from '../../src/ai/validation.ts';
import {
  geminiError,
  geminiText,
  quotaFailure,
  startAiServer,
  TEST_ORIGIN,
  type AiTestServer,
  type AiTestServerOptions,
  type TestAiUser,
} from './support/aiFixtures.ts';

interface ClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;
}

interface RemoteProvider {
  readonly mode: string;
  readonly acceptsMessengerContent: boolean;
  readonly disclosure: string;
}

interface RemoteModule {
  readonly AI_REMOTE_DISCLOSURE: { readonly version: string; readonly text: string };
  readonly AI_REMOTE_ENDPOINTS: { readonly consent: string; readonly requests: string };
  readonly AI_REMOTE_ERROR_MAP: Readonly<Record<string, string>>;
  aiPayloadDigest(request: AiGenerationRequest): Promise<string>;
  readonly RemoteAIProvider: new (options: { getCsrfToken: () => string | null; fetch?: typeof fetch }) => RemoteProvider;
}

interface ExecuteModule {
  executeAIRequest(provider: RemoteProvider, request: AiGenerationRequest, options: { signal: AbortSignal; remoteConsent?: boolean }):
    Promise<{ output: string; provider: string; kind: string }>;
}

let remote: RemoteModule;
let execute: ExecuteModule;
const servers: AiTestServer[] = [];

before(async () => {
  remote = await tsImport('../../../client/src/ai/remoteAIProvider.ts', import.meta.url) as RemoteModule;
  execute = await tsImport('../../../client/src/ai/executeAIRequest.ts', import.meta.url) as ExecuteModule;
});
after(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function server(options: AiTestServerOptions = {}): Promise<AiTestServer> {
  const started = await startAiServer(options);
  servers.push(started);
  return started;
}

/**
 * What a browser adds to a same-origin request: the page Origin and the session cookie. The
 * client's `mode`, `credentials` and `cache` settings are recorded for assertions; Node's fetch
 * has no page context for them.
 */
function browserFetch(ai: AiTestServer, user: TestAiUser | null, seen: RequestInit[] = []): typeof fetch {
  return ((input: string | URL | Request, init: RequestInit = {}) => {
    seen.push(init);
    const headers = new Headers(init.headers);
    headers.set('origin', TEST_ORIGIN);
    if (user) headers.set('cookie', user.cookie);
    const forwarded: RequestInit = { headers };
    if (init.method !== undefined) forwarded.method = init.method;
    if (init.body !== undefined) forwarded.body = init.body;
    if (init.redirect !== undefined) forwarded.redirect = init.redirect;
    if (init.signal !== undefined) forwarded.signal = init.signal;
    return fetch(new URL(String(input), ai.url), forwarded);
  }) as typeof fetch;
}

function run(provider: RemoteProvider, request: AiGenerationRequest) {
  return execute.executeAIRequest(provider, request, { signal: new AbortController().signal, remoteConsent: true });
}

async function clientError(provider: RemoteProvider, request: AiGenerationRequest): Promise<ClientError> {
  try {
    await run(provider, request);
  } catch (error) {
    return error as ClientError;
  }
  throw new Error('Expected the client to reject.');
}

const summarize: AiGenerationRequest = { task: 'summarize', input: 'Maya will share the test results by Thursday.' };

describe('client and server agree on the consent contract', () => {
  test('the disclosure text and version are identical', () => {
    assert.deepEqual({ ...remote.AI_REMOTE_DISCLOSURE }, { ...AI_DISCLOSURE });
  });

  test('payload digests are identical for every task, option and text shape', async () => {
    const requests: AiGenerationRequest[] = [
      summarize,
      { task: 'chat', input: 'What can @Secu do?' },
      { task: 'rewrite', input: 'Send me the notes when you can.', tone: 'Concise' },
      { task: 'translate', input: 'Xin chào! Bạn có khỏe không?', targetLanguage: 'Spanish' },
      { task: 'action_items', input: 'Line one\nLine two\twith tab\r\nand "quotes" \\ backslash' },
      { task: 'explain', input: 'Emoji 🙂👍🏽, CJK 日本語, RTL שלום, combining e\u0301' },
      { task: 'explain', input: 'x'.repeat(8_000) },
      { task: 'summarize', input: 'Messenger text', conversationId: 'securebot-demo' },
    ];
    for (const request of requests) assert.equal(await remote.aiPayloadDigest(request), computePayloadDigest(request), request.input.slice(0, 40));
  });

  test('the client calls exactly the server routes and maps every server error code', () => {
    assert.deepEqual({ ...remote.AI_REMOTE_ENDPOINTS }, { consent: `${DEFAULT_AI_BASE_PATH}/consent`, requests: `${DEFAULT_AI_BASE_PATH}/requests` });
    assert.deepEqual(Object.keys(remote.AI_REMOTE_ERROR_MAP).sort(), [...AI_ERROR_CODES].sort());
    assert.equal(remote.AI_REMOTE_ERROR_MAP.AI_DAILY_QUOTA_EXHAUSTED, 'quota_exhausted');
    assert.equal(remote.AI_REMOTE_ERROR_MAP.AI_PRIVACY_RESTRICTED, 'privacy_restricted');
    assert.equal(remote.AI_REMOTE_ERROR_MAP.AI_PROVIDER_UNAVAILABLE, 'provider_unavailable');
  });
});

describe('mocked end-to-end: client adapter → AI handler → mocked Gemini', () => {
  test('a consented summary completes with two same-origin calls and one Gemini call', async () => {
    const ai = await server({ replies: [geminiText('• Maya: share the test results by Thursday.')] });
    const user = ai.addUser('u1');
    const seen: RequestInit[] = [];
    const provider = new remote.RemoteAIProvider({ getCsrfToken: () => user.csrf, fetch: browserFetch(ai, user, seen) });
    assert.deepEqual(await run(provider, summarize), { output: '• Maya: share the test results by Thursday.', provider: 'remote', kind: 'answer' });
    assert.equal(seen.length, 2);
    for (const init of seen) {
      assert.deepEqual([init.method, init.credentials, init.mode, init.redirect, init.cache], ['POST', 'same-origin', 'same-origin', 'error', 'no-store']);
    }
    assert.equal(ai.gemini.calls.length, 1);
    assert.match(ai.gemini.calls[0]!.body.contents[0].parts[0].text, /Maya will share the test results by Thursday\./);
    assert.equal(ai.csrf.inputs.length, 2);
  });

  test('server and provider refusals reach the user as fixed client errors', async () => {
    const quota = await server({ env: { AI_USER_RPD: '1' } });
    const person = quota.addUser('u1');
    const quotaProvider = new remote.RemoteAIProvider({ getCsrfToken: () => person.csrf, fetch: browserFetch(quota, person) });
    await run(quotaProvider, summarize);
    const exhausted = await clientError(quotaProvider, summarize);
    assert.deepEqual([exhausted.code, exhausted.message], ['quota_exhausted', '@Secu has reached its free AI usage limit.']);

    const credential = await clientError(quotaProvider, { task: 'explain', input: 'What does password=hunter2 mean?' });
    assert.deepEqual([credential.code, credential.message],
      ['privacy_restricted', "This content cannot be sent to the current AI provider because of SecuBuzz's privacy restrictions."]);

    const providerCases: Array<[Parameters<typeof server>[0], string, string]> = [
      [{ replies: [geminiError(429, 'RESOURCE_EXHAUSTED', quotaFailure('GenerateRequestsPerDayPerProjectPerModel-FreeTier'))] }, 'quota_exhausted', '@Secu has reached its free AI usage limit.'],
      [{ replies: [geminiError(429, 'RESOURCE_EXHAUSTED', quotaFailure('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '20s'))] }, 'rate_limited',
        '@Secu is receiving too many requests. Wait a moment, then try again.'],
      [{ replies: [geminiText('blocked', { finishReason: 'SAFETY' })] }, 'declined', '@Secu couldn’t process this text. Try rephrasing it.'],
      [{ replies: [geminiError(500, 'INTERNAL')] }, 'provider_unavailable', '@Secu is temporarily unavailable.'],
      [{ replies: [geminiText('cut off', { finishReason: 'MAX_TOKENS' })] }, 'invalid_response', 'The response could not be safely displayed.'],
      [{ config: loadAiConfig({ AI_REMOTE_ENABLED: 'false', AI_PROVIDER: 'gemini', GEMINI_MODEL: 'gemini-3.5-flash-lite' }) }, 'unavailable',
        '@Secu is not connected yet. AI tools are unavailable in this session.'],
    ];
    for (const [options, code, message] of providerCases) {
      const ai = await server(options);
      const user = ai.addUser('u1');
      const error = await clientError(new remote.RemoteAIProvider({ getCsrfToken: () => user.csrf, fetch: browserFetch(ai, user) }), summarize);
      assert.deepEqual([error.code, error.message], [code, message]);
      assert.ok(ai.gemini.calls.length <= 1, 'never retried');
    }
  });

  test('missing sessions and foreign CSRF tokens are refused', async () => {
    const ai = await server();
    const user = ai.addUser('u1');
    const other = ai.addUser('u2');
    const signedOut = await clientError(new remote.RemoteAIProvider({ getCsrfToken: () => user.csrf, fetch: browserFetch(ai, null) }), summarize);
    assert.equal(signedOut.code, 'auth_required');
    const forged = await clientError(new remote.RemoteAIProvider({ getCsrfToken: () => other.csrf, fetch: browserFetch(ai, user) }), summarize);
    assert.equal(forged.code, 'auth_required');
    assert.equal(ai.gemini.calls.length, 0);
  });

  test('Messenger context is refused in the client before any request', async () => {
    const ai = await server();
    const user = ai.addUser('u1');
    const seen: RequestInit[] = [];
    const provider = new remote.RemoteAIProvider({ getCsrfToken: () => user.csrf, fetch: browserFetch(ai, user, seen) });
    assert.equal(provider.acceptsMessengerContent, false);
    assert.equal(provider.disclosure, AI_DISCLOSURE.text);
    const error = await clientError(provider, { task: 'summarize', input: 'Only this chosen message', conversationId: 'securebot-demo' });
    assert.equal(error.code, 'privacy_restricted');
    assert.equal(seen.length, 0);
    assert.equal(ai.sessions.contexts.length, 0);
    assert.equal(ai.gemini.calls.length, 0);
  });
});
