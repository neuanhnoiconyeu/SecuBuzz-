import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AIHub } from '../AIHub';
import { DemoAIProvider, createAIProvider, DEMO_AI_LIMITATION } from '@/ai/demoAIProvider';
import { AI_TOOLS, type AIProvider, type AIResponse } from '@/ai/aiModel';

const review = jest.fn();
function mount(provider: AIProvider = new DemoAIProvider(0)) {
  return render(<AIHub active provider={provider} conversationId="conversation-a" entry={null} onReviewDraft={review} />);
}
afterEach(() => { jest.restoreAllMocks(); review.mockClear(); });

test('home has one assistant entry, five working tool cards and session-only recent work', () => {
  mount();
  expect(screen.getByRole('heading', { name: 'AI Hub', level: 1 })).toBeInTheDocument();
  expect(screen.getByText('Demo · offline')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open @Secu' })).toBeEnabled();
  for (const tool of AI_TOOLS) expect(screen.getByRole('button', { name: new RegExp(`^${tool.title}`) })).toBeEnabled();
  expect(screen.getByText('A fresh start.')).toBeInTheDocument();
});

test.each(AI_TOOLS)('$title accepts an example and displays a labeled output', async tool => {
  const provider = new DemoAIProvider(0); const run = jest.spyOn(provider, 'run');
  mount(provider);
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${tool.title}`) }));
  expect(screen.getByRole('button', { name: `Run ${tool.title}` })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Try an example' }));
  expect(run).not.toHaveBeenCalled();
  if (tool.task === 'rewrite') fireEvent.change(screen.getByRole('combobox', { name: 'Rewrite tone' }), { target: { value: 'Professional' } });
  if (tool.task === 'translate') fireEvent.change(screen.getByRole('combobox', { name: 'Target language' }), { target: { value: 'Vietnamese' } });
  fireEvent.click(screen.getByRole('button', { name: `Run ${tool.title}` }));
  expect(screen.getByRole('button', { name: 'Cancel request' })).toBeEnabled();
  const output = await screen.findByRole('region', { name: 'Tool output' });
  expect(within(output).getByText('Prepared demo example')).toBeInTheDocument();
  expect(screen.getByRole('textbox')).toHaveValue(tool.example);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]![0].conversationId).toBeUndefined();
  expect(review).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'AI Hub' }));
  expect(screen.getByRole('button', { name: `View ${tool.title}` })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: `View ${tool.title}` }));
  expect(screen.getByRole('region', { name: 'Tool output' })).toBeInTheDocument();
});

test('arbitrary tool input receives an honest limitation, without insertion or an AI claim', async () => {
  mount(); fireEvent.click(screen.getByRole('button', { name: /^Summarize/ }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My arbitrary private content.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run Summarize' }));
  expect(await screen.findByText(DEMO_AI_LIMITATION)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Review for draft' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Copy output' })).not.toBeInTheDocument();
});

test('chat supports Enter, Shift+Enter, IME, reset, cancellation and safe text rendering', async () => {
  const provider: AIProvider = { mode: 'demo', available: true, supportsStreaming: false,
    run: jest.fn<Promise<AIResponse>, Parameters<AIProvider['run']>>(async () => ({ provider: 'demo', kind: 'example', output: '<img src=x onerror=alert(1)> literal text' })) };
  mount(provider); fireEvent.click(screen.getByRole('button', { name: 'Open @Secu' }));
  const input = screen.getByRole('textbox', { name: 'Message @Secu' });
  expect(screen.getByRole('button', { name: 'Send to @Secu' })).toBeDisabled();
  fireEvent.change(input, { target: { value: 'Supplied question\nwith newline' } });
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(provider.run).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter' });
  await within(screen.getByRole('log')).findByText('<img src=x onerror=alert(1)> literal text');
  expect(document.querySelector('img')).toBeNull();
  expect(within(screen.getByRole('log')).getByText('Supplied question with newline')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Reset chat' }));
  expect(within(screen.getByRole('log')).queryByText(/literal text/)).not.toBeInTheDocument();
});

test('chat retries a recoverable error without duplicating the submitted message', async () => {
  const run = jest.fn().mockRejectedValueOnce(new Error('private backend detail')).mockResolvedValueOnce({ provider: 'demo', kind: 'example', output: 'Recovered demo result' });
  mount({ mode: 'demo', available: true, supportsStreaming: false, run });
  fireEvent.click(screen.getByRole('button', { name: 'Open @Secu' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'One submitted question' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send to @Secu' }));
  await screen.findByRole('alert');
  expect(screen.queryByText(/private backend detail/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry request' }));
  await screen.findByText('Recovered demo result');
  expect(screen.getAllByText('One submitted question')).toHaveLength(1);
  expect(run).toHaveBeenCalledTimes(2);
});

test('cancellation and navigation abort pending work without displaying late content', async () => {
  let release!: (response: AIResponse) => void;
  const run = jest.fn<Promise<AIResponse>, Parameters<AIProvider['run']>>(() => new Promise<AIResponse>(resolve => { release = resolve; }));
  const provider: AIProvider = { mode: 'demo', available: true, supportsStreaming: false, run };
  const view = mount(provider);
  fireEvent.click(screen.getByRole('button', { name: /^Explain/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Try an example' }));
  fireEvent.click(screen.getByRole('button', { name: 'Run Explain' }));
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
  expect(screen.getByText('Request cancelled. Your text is still here.')).toBeInTheDocument();
  await act(async () => { release({ provider: 'demo', kind: 'example', output: 'late stale text' }); });
  expect(screen.queryByText('late stale text')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Run Explain' }));
  await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  view.rerender(<AIHub active={false} provider={provider} conversationId="conversation-a" entry={null} onReviewDraft={review} />);
  expect(run.mock.calls[1]![1].signal.aborted).toBe(true);
});

test('production is unavailable and never silently runs prepared examples', async () => {
  const environment = jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production' });
  try {
    mount(createAIProvider(true));
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Translate/ }));
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run Translate' })).toBeDisabled();
    expect(screen.queryByText('Prepared demo example')).not.toBeInTheDocument();
  } finally { environment.restore(); }
});

test('a future injected remote provider requires UI consent and retains honest provider labeling', async () => {
  const run = jest.fn<Promise<AIResponse>, Parameters<AIProvider['run']>>(async () => ({ provider: 'remote', kind: 'answer', output: 'Injected response; no network adapter.' }));
  mount({ mode: 'remote', available: true, supportsStreaming: false, run });
  fireEvent.click(screen.getByRole('button', { name: 'Open @Secu' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Chosen request' } });
  expect(screen.getByRole('button', { name: 'Send to @Secu' })).toBeDisabled();
  expect(run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox', { name: /Allow this text/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Send to @Secu' }));
  await screen.findByText('Injected response; no network adapter.');
  expect(screen.getByText('AI response')).toBeInTheDocument();
  expect(screen.queryByText('Demo example')).not.toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: /Allow this text/ })).not.toBeChecked();
});

test('copy output succeeds or reports a safe clipboard failure', async () => {
  const writeText = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('private clipboard failure'));
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  try {
    mount(); fireEvent.click(screen.getByRole('button', { name: /^Translate/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Try an example' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run Translate' }));
    const copy = await screen.findByRole('button', { name: 'Copy output' });
    fireEvent.click(copy); await screen.findByText('Copied.');
    expect(writeText).toHaveBeenCalledWith('¡Hola! ¿Cómo estás?');
    fireEvent.click(copy); await screen.findByText('Copy is unavailable. Select the result text to copy it.');
    expect(screen.queryByText('private clipboard failure')).not.toBeInTheDocument();
  } finally { if (original) Object.defineProperty(navigator, 'clipboard', original); else Reflect.deleteProperty(navigator, 'clipboard'); }
});
