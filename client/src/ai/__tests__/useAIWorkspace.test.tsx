import { act, renderHook } from '@testing-library/react';
import { useAIWorkspace } from '../useAIWorkspace';
import type { AIProvider, AIResponse } from '../aiModel';

function provider(): AIProvider & { run: jest.Mock } {
  return { mode: 'demo', available: true, supportsStreaming: false,
    run: jest.fn<Promise<AIResponse>, Parameters<AIProvider['run']>>(async () => ({ provider: 'demo', kind: 'example', output: 'Prepared test output.' })) };
}
const request = { task: 'chat' as const, input: 'Explicitly supplied text' };

test('serializes submissions and retry reuses the user bubble after a recoverable error', async () => {
  const service = provider(); service.run.mockRejectedValueOnce(new Error('private failure'));
  const { result } = renderHook(() => useAIWorkspace(service));
  await act(async () => { await Promise.all([result.current.run(request), result.current.run(request)]); });
  expect(service.run).toHaveBeenCalledTimes(1);
  expect(result.current.failure).toMatchObject({ canRetry: true, error: { code: 'request_failed' } });
  expect(result.current.failure?.error.message).not.toContain('private');
  await act(async () => { await result.current.retry(); });
  expect(result.current.messages.filter(message => message.role === 'user')).toHaveLength(1);
  expect(result.current.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
  expect(result.current.recent).toHaveLength(1);
});

test('bounds recoverable retry attempts and never retries automatically', async () => {
  const service = provider(); service.run.mockRejectedValue(new Error('unavailable'));
  const { result } = renderHook(() => useAIWorkspace(service));
  await act(async () => { await result.current.run(request); });
  expect(service.run).toHaveBeenCalledTimes(1);
  for (let index = 0; index < 3; index++) await act(async () => { await result.current.retry(); });
  expect(service.run).toHaveBeenCalledTimes(3);
  expect(result.current.failure?.canRetry).toBe(false);
});

test('cancellation discards late provider completion and reset removes chat text', async () => {
  const service = provider(); let release!: (response: AIResponse) => void;
  service.run.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const { result } = renderHook(() => useAIWorkspace(service));
  let operation!: Promise<void>;
  await act(async () => { operation = result.current.run(request); await Promise.resolve(); });
  act(() => result.current.cancel());
  await act(async () => { await operation; release({ provider: 'demo', kind: 'example', output: 'Stale private result' }); });
  expect(service.run.mock.calls[0][1].signal.aborted).toBe(true);
  expect(result.current.messages).toHaveLength(1);
  expect(result.current.messages[0]?.status).toBe('cancelled');
  act(() => result.current.resetChat());
  expect(result.current.messages).toEqual([]); expect(result.current.recent).toEqual([]);
});

test('unmount and replacement isolate old operations, messages and results', async () => {
  const first = provider(); let release!: (response: AIResponse) => void;
  first.run.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const view = renderHook(({ service }) => useAIWorkspace(service), { initialProps: { service: first } });
  let operation!: Promise<void>;
  await act(async () => { operation = view.result.current.run(request); await Promise.resolve(); });
  const second = provider(); view.rerender({ service: second });
  await act(async () => { await operation; release({ provider: 'demo', kind: 'example', output: 'Old session only' }); });
  expect(first.run.mock.calls[0][1].signal.aborted).toBe(true);
  expect(view.result.current.messages).toEqual([]); expect(view.result.current.result).toBeNull();
  await act(async () => { await view.result.current.run(request); });
  expect(second.run).toHaveBeenCalledTimes(1);
  view.unmount();
});

test('history and recent work stay bounded in memory', async () => {
  const service = provider(); const { result } = renderHook(() => useAIWorkspace(service));
  for (let index = 0; index < 35; index++) await act(async () => { await result.current.run({ ...request, input: `Supplied ${index}` }); });
  expect(result.current.messages).toHaveLength(60);
  expect(result.current.recent).toHaveLength(20);
  expect(result.current.messages.some(message => message.text === 'Supplied 0')).toBe(false);
  expect(result.current.messages.at(-1)?.text).toBe('Prepared test output.');
});
