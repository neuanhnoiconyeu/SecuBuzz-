import { createHash } from 'crypto';
import { AIError, type AIRequest } from '../aiModel';
import { createAIProvider, DemoAIProvider } from '../demoAIProvider';
import { executeAIRequest } from '../executeAIRequest';
import { AI_REMOTE_DISCLOSURE, aiPayloadDigest, RemoteAIProvider } from '../remoteAIProvider';

type Reply = { status: number; body?: unknown; text?: string } | Error | 'hang';

/** Mock SecuBuzz AI API. No request leaves the test. */
function backend(...replies: Reply[]) {
  const queue = [...replies];
  const fetch = jest.fn(async (_url: string, init: RequestInit) => {
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (reply instanceof Error) throw reply;
    if (reply === 'hang') {
      return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    return { status: reply.status, text: async () => reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body)) } as unknown as Response;
  });
  return { fetch, provider: new RemoteAIProvider({ getCsrfToken: () => 'csrf-test-token', fetch: fetch as unknown as typeof globalThis.fetch }) };
}

const consentOk = { status: 200, body: { consentToken: 'v1.payload.mac' } };
const answer = (output: string) => ({ status: 200, body: { output, kind: 'answer' } });
const failure = (status: number, code: string) => ({ status, body: { error: { code, message: 'Server message that is never displayed' } } });
const request: AIRequest = { task: 'rewrite', input: 'Send me the notes when you can.', tone: 'Professional' };
const options = () => ({ signal: new AbortController().signal, remoteConsent: true });
const nodeDigest = (value: AIRequest) => createHash('sha256')
  .update(JSON.stringify(['secubuzz-ai-consent-v1', value.task, value.input, value.tone ?? null, value.targetLanguage ?? null, value.conversationId ?? null]), 'utf8')
  .digest('base64url');

afterEach(() => jest.restoreAllMocks());

test('asks for consent, then sends the request with same-origin, credentialed, no-store fetches and CSRF', async () => {
  const { fetch, provider } = backend(consentOk, answer('Please share the notes at your earliest convenience.'));
  await expect(executeAIRequest(provider, request, options())).resolves.toEqual({
    output: 'Please share the notes at your earliest convenience.', provider: 'remote', kind: 'answer',
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  const [consentCall, requestCall] = fetch.mock.calls;
  for (const [url, init] of [consentCall!, requestCall!]) {
    expect(url.startsWith('/api/ai/')).toBe(true);
    expect(init).toMatchObject({
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-test-token' },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  }
  expect(consentCall![0]).toBe('/api/ai/consent');
  expect(JSON.parse(consentCall![1].body as string)).toEqual({ disclosureVersion: 'gemini-free-tier-2026-11-v1', payloadDigest: nodeDigest(request) });
  expect(requestCall![0]).toBe('/api/ai/requests');
  expect(JSON.parse(requestCall![1].body as string)).toEqual({ request, consentToken: 'v1.payload.mac' });
});

test('computes the same digest as the server and sends only the fields of the chosen task', async () => {
  for (const value of [{ task: 'chat', input: 'Hello 🙂\nline two' }, { task: 'translate', input: 'Xin chào', targetLanguage: 'French' }, request] as AIRequest[]) {
    expect(await aiPayloadDigest(value)).toBe(nodeDigest(value));
  }
  const { fetch, provider } = backend(consentOk, answer('Bonjour !'));
  await executeAIRequest(provider, { task: 'translate', input: 'Hello!', targetLanguage: 'French', tone: 'Friendly' }, options());
  expect(JSON.parse(fetch.mock.calls[1]![1].body as string).request).toEqual({ task: 'translate', input: 'Hello!', targetLanguage: 'French' });
});

test('discloses the free tier and refuses Messenger content before any network call', async () => {
  const { fetch, provider } = backend(consentOk, answer('never'));
  expect(provider.disclosure).toBe(AI_REMOTE_DISCLOSURE.text);
  expect(AI_REMOTE_DISCLOSURE.text).toBe('This request sends the submitted text to Google Gemini for processing. Free-tier data may be used by Google to improve its products, and human reviewers may read it. Do not submit private messages, passwords, or confidential information.');
  expect(provider.acceptsMessengerContent).toBe(false);
  const refused = await executeAIRequest(provider, { task: 'summarize', input: 'Private message', conversationId: 'securebot-demo' }, options()).catch(error => error);
  expect(refused).toMatchObject({ code: 'privacy_restricted', retryable: false });
  expect(refused.message).toBe("This content cannot be sent to the current AI provider because of SecuBuzz's privacy restrictions.");
  expect(fetch).not.toHaveBeenCalled();
});

test.each([null, '', '  ', 'line\r\nbreak'])('a missing or invalid CSRF token fails closed without a request: %p', async token => {
  const fetch = jest.fn();
  const provider = new RemoteAIProvider({ getCsrfToken: () => token, fetch });
  await expect(executeAIRequest(provider, request, options())).rejects.toMatchObject({ code: 'unavailable' });
  const throwing = new RemoteAIProvider({ getCsrfToken: () => { throw new Error('bootstrap detail'); }, fetch });
  await expect(executeAIRequest(throwing, request, options())).rejects.toMatchObject({ code: 'unavailable' });
  expect(fetch).not.toHaveBeenCalled();
});

test('still requires the per-request consent tick before contacting the backend', async () => {
  const { fetch, provider } = backend(consentOk, answer('never'));
  await expect(executeAIRequest(provider, request, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'consent_required' });
  expect(fetch).not.toHaveBeenCalled();
});

test.each<[string, number, string, boolean]>([
  ['AI_DISABLED', 503, 'unavailable', false],
  ['AI_NOT_CONFIGURED', 503, 'unavailable', false],
  ['AI_AUTH_REQUIRED', 401, 'auth_required', false],
  ['AI_FORBIDDEN', 403, 'auth_required', false],
  ['AI_CONSENT_REQUIRED', 403, 'consent_required', false],
  ['AI_PRIVACY_RESTRICTED', 403, 'privacy_restricted', false],
  ['AI_INVALID_REQUEST', 400, 'invalid_input', false],
  ['AI_INPUT_TOO_LARGE', 413, 'invalid_input', false],
  ['AI_RATE_LIMITED', 429, 'rate_limited', true],
  ['AI_DAILY_QUOTA_EXHAUSTED', 429, 'quota_exhausted', false],
  ['AI_TIMEOUT', 504, 'timeout', true],
  ['AI_SERVICE_UNAVAILABLE', 503, 'provider_unavailable', true],
  ['AI_PROVIDER_UNAVAILABLE', 503, 'provider_unavailable', true],
  ['AI_PROVIDER_REJECTED', 422, 'declined', false],
  ['AI_INVALID_RESPONSE', 502, 'invalid_response', false],
  ['AI_INTERNAL_ERROR', 500, 'request_failed', true],
])('maps %s to the %s client error', async (serverCode, status, clientCode, retryable) => {
  for (const stage of ['consent', 'request'] as const) {
    const { provider } = stage === 'consent' ? backend(failure(status, serverCode)) : backend(consentOk, failure(status, serverCode));
    const error = await executeAIRequest(provider, request, options()).catch(caught => caught);
    expect(error).toBeInstanceOf(AIError);
    expect(error).toMatchObject({ code: clientCode, retryable });
    expect(error.message).not.toContain('Server message');
  }
});

test('uses fixed messages for the new remote states', async () => {
  const messages: Record<string, string> = {
    AI_DAILY_QUOTA_EXHAUSTED: '@Secu has reached its free AI usage limit.',
    AI_PROVIDER_UNAVAILABLE: '@Secu is temporarily unavailable.',
    AI_RATE_LIMITED: '@Secu is receiving too many requests. Wait a moment, then try again.',
    AI_AUTH_REQUIRED: 'Sign in again to use @Secu.',
    AI_PROVIDER_REJECTED: '@Secu couldn’t process this text. Try rephrasing it.',
  };
  for (const [code, message] of Object.entries(messages)) {
    const { provider } = backend(consentOk, failure(code === 'AI_AUTH_REQUIRED' ? 401 : 429, code));
    await expect(executeAIRequest(provider, request, options())).rejects.toMatchObject({ message });
  }
});

test.each<[number, string]>([
  [401, 'auth_required'], [429, 'rate_limited'], [503, 'provider_unavailable'], [500, 'request_failed'], [404, 'request_failed'],
])('falls back to the HTTP status %s when the error body is unusable', async (status, code) => {
  const { provider } = backend({ status, text: '<html>proxy error</html>' });
  await expect(executeAIRequest(provider, request, options())).rejects.toMatchObject({ code });
  const unknown = backend({ status, body: { error: { code: 'AI_SOMETHING_NEW' } } });
  await expect(executeAIRequest(unknown.provider, request, options())).rejects.toMatchObject({ code });
});

test.each<[Reply, Reply]>([
  [{ status: 200, text: 'not json' }, answer('x')],
  [{ status: 200, body: { consentToken: 'bad token with spaces' } }, answer('x')],
  [{ status: 200, body: { consentToken: 'v1.a.b', extra: true } }, answer('x')],
  [consentOk, { status: 200, body: { output: 'x', kind: 'answer', model: 'gemini-3.5-pro' } }],
  [consentOk, { status: 200, body: { output: 'x', kind: 'example' } }],
  [consentOk, { status: 200, body: { output: 42, kind: 'answer' } }],
  [consentOk, { status: 200, body: [] }],
  [consentOk, { status: 200, text: `{"output":"${'x'.repeat(70_000)}","kind":"answer"}` }],
])('rejects malformed backend responses %#', async (consentReply, requestReply) => {
  const { provider } = backend(consentReply, requestReply);
  await expect(executeAIRequest(provider, request, options())).rejects.toMatchObject({ code: 'invalid_response' });
});

test('network failures are retryable and cancellation aborts the request', async () => {
  const offline = backend(new TypeError('Failed to fetch'));
  await expect(executeAIRequest(offline.provider, request, options())).rejects.toMatchObject({ code: 'request_failed', retryable: true });
  const pending = backend(consentOk, 'hang');
  const controller = new AbortController();
  const running = executeAIRequest(pending.provider, request, { signal: controller.signal, remoteConsent: true });
  const rejected = expect(running).rejects.toMatchObject({ code: 'cancelled' });
  for (let waited = 0; pending.fetch.mock.calls.length < 2 && waited < 2_000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  await rejected;
  expect(pending.fetch.mock.calls[1]![1].signal!.aborted).toBe(true);
});

test('creates the remote provider only for real API sessions with every readiness flag', () => {
  const base = { ...process.env, NEXT_PUBLIC_AUTH_MODE: 'api', NEXT_PUBLIC_AUTH_API_READY: 'true', NEXT_PUBLIC_AI_REMOTE_READY: 'true' };
  const select = (env: Record<string, string | undefined>, demo: boolean) => {
    const environment = jest.replaceProperty(process, 'env', env as NodeJS.ProcessEnv);
    try { return createAIProvider(demo); } finally { environment.restore(); }
  };
  expect(select(base, false)).toBeInstanceOf(RemoteAIProvider);
  expect(select({ ...base, NODE_ENV: 'production' }, false)).toBeInstanceOf(RemoteAIProvider);
  for (const env of [
    { ...base, NEXT_PUBLIC_AI_REMOTE_READY: 'false' }, { ...base, NEXT_PUBLIC_AI_REMOTE_READY: 'TRUE' }, { ...base, NEXT_PUBLIC_AI_REMOTE_READY: undefined },
    { ...base, NEXT_PUBLIC_AUTH_MODE: 'demo' }, { ...base, NEXT_PUBLIC_AUTH_API_READY: 'false' },
  ]) {
    const provider = select(env, false);
    expect(provider.mode).toBe('unavailable');
  }
  expect(select(base, true)).toBeInstanceOf(DemoAIProvider);
  expect(select({ ...base, NODE_ENV: 'production' }, true).mode).toBe('unavailable');
});

test('a remote failure never falls back to the demo provider', async () => {
  const { provider } = backend(consentOk, failure(503, 'AI_PROVIDER_UNAVAILABLE'), answer('later'));
  await expect(executeAIRequest(provider, { task: 'chat', input: 'What can @Secu do?' }, options())).rejects.toMatchObject({ code: 'provider_unavailable' });
  expect(provider.mode).toBe('remote');
});
