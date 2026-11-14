import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AIHub } from '../AIHub';
import { AI_REMOTE_DISCLOSURE, RemoteAIProvider } from '@/ai/remoteAIProvider';

type Reply = { status: number; body: unknown } | 'hang';

/** Mocked SecuBuzz AI API behind the real remote provider. Nothing leaves the test. */
function remote(...replies: Reply[]) {
  const queue = [...replies];
  const fetch = jest.fn(async (_url: string, init: RequestInit) => {
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (reply === 'hang') {
      return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    return { status: reply.status, text: async () => JSON.stringify(reply.body) } as unknown as Response;
  });
  return { fetch, provider: new RemoteAIProvider({ getCsrfToken: () => 'csrf-test-token', fetch: fetch as unknown as typeof globalThis.fetch }) };
}
const consentOk: Reply = { status: 200, body: { consentToken: 'v1.payload.mac' } };
const answer = (output: string): Reply => ({ status: 200, body: { output, kind: 'answer' } });
const failure = (status: number, code: string): Reply => ({ status, body: { error: { code, message: 'Server detail that is never shown' } } });

function mount(provider: RemoteAIProvider) {
  return render(<AIHub active provider={provider} conversationId="conversation-a" entry={null} onReviewDraft={jest.fn()} />);
}
function openSummarize(text = 'Maya will share the test results by Thursday.') {
  fireEvent.click(screen.getByRole('button', { name: /^Summarize/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Text to work with' }), { target: { value: text } });
}
const consentBox = () => screen.getByRole('checkbox', { name: /Allow this text/ });

afterEach(() => jest.restoreAllMocks());

test('shows the Gemini disclosure, requires consent for each request and labels the result', async () => {
  const { fetch, provider } = remote(consentOk, answer('• Maya: share the test results by Thursday.'));
  mount(provider);
  expect(screen.getByText('Connected AI service')).toBeInTheDocument();
  openSummarize();
  const disclosure = screen.getByText(AI_REMOTE_DISCLOSURE.text);
  expect(disclosure).toHaveAttribute('id', 'ai-remote-disclosure');
  expect(consentBox()).toHaveAttribute('aria-describedby', 'ai-remote-disclosure');
  expect(consentBox()).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Run Summarize' })).toBeDisabled();
  fireEvent.click(consentBox());
  fireEvent.click(screen.getByRole('button', { name: 'Run Summarize' }));
  const output = await screen.findByRole('region', { name: 'Tool output' });
  expect(within(output).getByText('AI result')).toBeInTheDocument();
  expect(within(output).getByText('• Maya: share the test results by Thursday.')).toBeInTheDocument();
  expect(screen.queryByText(/Prepared demo example/)).not.toBeInTheDocument();
  expect(consentBox()).not.toBeChecked();
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/ai/consent', '/api/ai/requests']);
  expect(JSON.parse(fetch.mock.calls[1]![1].body as string).request).toEqual({ task: 'summarize', input: 'Maya will share the test results by Thursday.' });
});

test('@Secu chat sends only the latest message and labels the reply as an AI response', async () => {
  const { fetch, provider } = remote(consentOk, answer('I can summarize, rewrite, translate, list action items and explain text.'));
  mount(provider);
  fireEvent.click(screen.getByRole('button', { name: 'Open @Secu' }));
  expect(screen.getByText(AI_REMOTE_DISCLOSURE.text)).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'Message @Secu' }), { target: { value: 'What can @Secu do?' } });
  expect(screen.getByRole('button', { name: 'Send to @Secu' })).toBeDisabled();
  fireEvent.click(consentBox());
  fireEvent.click(screen.getByRole('button', { name: 'Send to @Secu' }));
  const log = screen.getByRole('log');
  await within(log).findByText('I can summarize, rewrite, translate, list action items and explain text.');
  expect(within(log).getByText('AI response')).toBeInTheDocument();
  expect(JSON.parse(fetch.mock.calls[1]![1].body as string).request).toEqual({ task: 'chat', input: 'What can @Secu do?' });
});

test.each([
  ['AI_DAILY_QUOTA_EXHAUSTED', 429, '@Secu has reached its free AI usage limit.', false],
  ['AI_RATE_LIMITED', 429, '@Secu is receiving too many requests. Wait a moment, then try again.', true],
  ['AI_PROVIDER_UNAVAILABLE', 503, '@Secu is temporarily unavailable.', true],
  ['AI_PRIVACY_RESTRICTED', 403, "This content cannot be sent to the current AI provider because of SecuBuzz's privacy restrictions.", false],
  ['AI_AUTH_REQUIRED', 401, 'Sign in again to use @Secu.', false],
  ['AI_DISABLED', 503, '@Secu is not connected yet. AI tools are unavailable in this session.', false],
  ['AI_PROVIDER_REJECTED', 422, '@Secu couldn’t process this text. Try rephrasing it.', false],
  ['AI_TIMEOUT', 504, 'This request took too long. You can try again.', true],
] as const)('shows %s as a fixed, safe message', async (code, status, message, canRetry) => {
  const { provider } = remote(consentOk, failure(status, code));
  mount(provider);
  openSummarize();
  fireEvent.click(consentBox());
  fireEvent.click(screen.getByRole('button', { name: 'Run Summarize' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(message);
  expect(alert).not.toHaveTextContent('Server detail');
  expect(within(alert).queryByRole('button', { name: 'Retry request' }) !== null).toBe(canRetry);
  expect(screen.queryByRole('region', { name: 'Tool output' })).not.toBeInTheDocument();
});

test('retry needs a fresh consent tick and a fresh consent token', async () => {
  const { fetch, provider } = remote(consentOk, failure(503, 'AI_PROVIDER_UNAVAILABLE'), consentOk, answer('Recovered result.'));
  mount(provider);
  openSummarize();
  fireEvent.click(consentBox());
  fireEvent.click(screen.getByRole('button', { name: 'Run Summarize' }));
  const retry = await within(await screen.findByRole('alert')).findByRole('button', { name: 'Retry request' });
  expect(retry).toBeDisabled();
  fireEvent.click(consentBox());
  fireEvent.click(retry);
  await screen.findByText('Recovered result.');
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/ai/consent', '/api/ai/requests', '/api/ai/consent', '/api/ai/requests']);
});

test('cancelling aborts the backend request and keeps the text', async () => {
  const { fetch, provider } = remote(consentOk, 'hang');
  mount(provider);
  openSummarize('Keep this text.');
  fireEvent.click(consentBox());
  fireEvent.click(screen.getByRole('button', { name: 'Run Summarize' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
  expect(fetch.mock.calls[1]![1].signal!.aborted).toBe(true);
  expect(screen.getByText('Request cancelled. Your text is still here.')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Text to work with' })).toHaveValue('Keep this text.');
});
