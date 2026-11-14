import { AIError, AI_MAX_INPUT, AI_MAX_OUTPUT, AI_TOOLS, validateAIRequest, type AIProvider, type AIRequest, type AIResponse } from '../aiModel';
import { createAIProvider, DemoAIProvider, DEMO_AI_LIMITATION } from '../demoAIProvider';
import { executeAIRequest } from '../executeAIRequest';

const request: AIRequest = { task: 'chat', input: 'What can @Secu do?' };
const options = () => ({ signal: new AbortController().signal });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test.each(AI_TOOLS)('returns an explicitly prepared $title fixture, not inferred analysis', async tool => {
  const provider = new DemoAIProvider(0);
  const result = await executeAIRequest(provider, { task: tool.task, input: tool.example, tone: 'Friendly', targetLanguage: 'Spanish' }, options());
  expect(result).toMatchObject({ provider: 'demo', kind: 'example' });
  expect(result.output.length).toBeGreaterThan(10);
});

test('arbitrary supplied text never receives fabricated analysis or a plaintext echo', async () => {
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const fetch = jest.fn().mockRejectedValue(new Error('network forbidden'));
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetch });
  const log = jest.spyOn(console, 'log');
  const storage = jest.spyOn(Storage.prototype, 'setItem');
  try { for (const task of ['chat', ...AI_TOOLS.map(tool => tool.task)] as const) {
    const result = await executeAIRequest(new DemoAIProvider(0), {
      task, input: 'sensitive-chosen-text', tone: 'Friendly', targetLanguage: 'French',
    }, options());
    expect(result).toEqual({ provider: 'demo', kind: 'limitation', output: DEMO_AI_LIMITATION });
    expect(result.output).not.toContain('sensitive-chosen-text');
  }
  expect(fetch).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
  } finally { if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch); else Reflect.deleteProperty(globalThis, 'fetch'); }
});

test('demo selection requires a development demo session and is denied again during production operations', async () => {
  expect(createAIProvider(true).mode).toBe('demo');
  expect(createAIProvider(false).available).toBe(false);
  const provider = new DemoAIProvider(0);
  const environment = jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production' });
  try {
    expect(createAIProvider(true).available).toBe(false);
    expect(() => new DemoAIProvider()).toThrow(AIError);
    await expect(provider.run(request, options())).rejects.toMatchObject({ code: 'unavailable' });
    await expect(executeAIRequest(createAIProvider(true), request, options())).rejects.toMatchObject({ code: 'unavailable' });
  } finally { environment.restore(); }
});

test.each([
  { ...request, input: '' }, { ...request, input: '  \n' }, { ...request, input: 'x'.repeat(AI_MAX_INPUT + 1) },
  { ...request, input: 'bad\0text' }, { ...request, task: 'unknown' }, { task: 'rewrite', input: 'text', tone: 'unknown' },
  { task: 'translate', input: 'text', targetLanguage: 'unknown' }, { ...request, conversationId: '../ space' },
  { ...request, conversationId: 123 },
])('rejects invalid requests before a provider sees them %#', invalid => {
  expect(() => validateAIRequest(invalid as AIRequest)).toThrow(AIError);
});

function remote(): AIProvider & { run: jest.Mock } {
  return { mode: 'remote', available: true, supportsStreaming: false,
    run: jest.fn<Promise<AIResponse>, Parameters<AIProvider['run']>>(async () => ({ provider: 'remote', kind: 'answer', output: 'Injected test result; no network.' })) };
}
test('a future remote provider requires explicit per-request consent and never falls back to demo', async () => {
  const provider = remote();
  await expect(executeAIRequest(provider, request, options())).rejects.toMatchObject({ code: 'consent_required' });
  expect(provider.run).not.toHaveBeenCalled();
  await expect(executeAIRequest(provider, request, { ...options(), remoteConsent: true })).resolves.toMatchObject({ provider: 'remote' });
  provider.run.mockRejectedValueOnce(new Error('private backend token'));
  const failure = await executeAIRequest(provider, request, { ...options(), remoteConsent: true }).catch(error => error);
  expect(failure).toMatchObject({ code: 'request_failed', retryable: true });
  expect(failure.message).not.toContain('private');
  expect(provider.run).toHaveBeenCalledTimes(2);
});

test.each([
  null, '', { provider: 'remote', kind: 'answer', output: '' },
  { provider: 'demo', kind: 'answer', output: 'provider substitution' },
  { provider: 'remote', kind: 'answer', output: 'x'.repeat(AI_MAX_OUTPUT + 1) },
  { provider: 'remote', kind: 'answer', output: 'text', token: 'secret' },
])('rejects malformed or oversized output %#', async response => {
  const provider = remote(); provider.run.mockResolvedValueOnce(response);
  await expect(executeAIRequest(provider, request, { ...options(), remoteConsent: true })).rejects.toMatchObject({ code: 'invalid_response', retryable: false });
});

test('deadline rejects promptly even if a provider ignores cancellation', async () => {
  jest.useFakeTimers();
  const provider = remote(); provider.run.mockImplementationOnce(() => new Promise(() => undefined));
  const pending = executeAIRequest(provider, request, { ...options(), remoteConsent: true, timeoutMs: 100 });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout', retryable: true });
  await jest.advanceTimersByTimeAsync(100); await rejected;
  expect(provider.run.mock.calls[0][1].signal.aborted).toBe(true);
});

test('abort prevents late results and pre-aborted work never starts', async () => {
  const provider = remote(); provider.run.mockImplementationOnce(() => new Promise(() => undefined));
  const controller = new AbortController();
  const pending = executeAIRequest(provider, request, { signal: controller.signal, remoteConsent: true });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled', retryable: false });
  await Promise.resolve(); controller.abort(); await rejected;
  expect(provider.run.mock.calls[0][1].signal.aborted).toBe(true);
  await expect(executeAIRequest(provider, request, { signal: controller.signal, remoteConsent: true })).rejects.toMatchObject({ code: 'cancelled' });
  expect(provider.run).toHaveBeenCalledTimes(1);
});
