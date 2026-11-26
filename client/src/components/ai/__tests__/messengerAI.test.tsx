import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Home from '@/app/page';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { DevelopmentAuthService } from '@/auth/developmentAuthService';
import { createDemoMessengerSession, type DemoMessengerSession } from '@/auth/messengerSession';
import { createDemoProfile } from '@/profiles/profileModel';
import { MessengerApp } from '@/components/messenger/MessengerApp';
import { AI_TOOLS, type AIProvider, type AIResponse } from '@/ai/aiModel';
import * as providers from '@/ai/demoAIProvider';

// Timing budget: multi-step Messenger + AI renders exceed 5s default under full-suite concurrency (see jest.setup.js).
jest.setTimeout(20000);

jest.mock('@/ai/demoAIProvider', () => ({ ...jest.requireActual('@/ai/demoAIProvider'), createAIProvider: jest.fn() }));
const providerFactory = jest.mocked(providers.createAIProvider);

const replace = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
const sessions: DemoMessengerSession[] = [];
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); } });
});
afterAll(() => {
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow); else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose); else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});
beforeEach(() => { window.history.replaceState({}, '', '/'); replace.mockClear(); providerFactory.mockReset().mockReturnValue(new providers.DemoAIProvider(0)); });
afterEach(() => { cleanup(); sessions.splice(0).forEach(session => session.dispose()); jest.restoreAllMocks(); });

async function mount() {
  const session = createDemoMessengerSession(createDemoProfile()); sessions.push(session);
  const view = render(<MessengerApp session={session} />);
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message to SecureBot' })).toBeEnabled());
  return { session, ...view };
}
function nav(label: 'AI Hub' | 'Chats' | 'Friends') {
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('button', { name: label === 'Friends' ? /^Friends/ : label }));
}
async function chooseConversation(name: string) {
  nav('Chats');
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name},`) }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: `Message to ${name}` })).toBeEnabled());
}

test('AI Hub navigation preserves Messenger drafts and is idle until the user submits supplied text', async () => {
  const service = new providers.DemoAIProvider(0); const run = jest.spyOn(service, 'run');
  providerFactory.mockReturnValue(service);
  const { session } = await mount(); const send = jest.spyOn(session.transport, 'sendMessage');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep my Messenger draft' } });
  nav('AI Hub');
  expect(screen.getByRole('heading', { name: 'AI Hub', level: 1 })).toBeInTheDocument();
  expect(run).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  nav('Chats'); expect(screen.getByRole('textbox')).toHaveValue('Keep my Messenger draft');
});

test('message AI actions share just the selected message after explicit review and submission', async () => {
  const service = new providers.DemoAIProvider(0); const run = jest.spyOn(service, 'run');
  providerFactory.mockReturnValue(service);
  const { session } = await mount(); const send = jest.spyOn(session.transport, 'sendMessage');
  for (const content of ['Only this chosen message', 'Unrelated private message']) {
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to SecureBot' }), { target: { value: content } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message to SecureBot' })).toHaveValue(''));
  }
  const calls = send.mock.calls.length;
  const row = within(screen.getByRole('log')).getByText('Only this chosen message').closest('article')!;
  fireEvent.click(within(row).getByRole('button', { name: 'More actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Summarize selected message' }));
  expect(screen.getByRole('textbox', { name: 'Text to work with' })).toHaveValue('Only this chosen message');
  expect(run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Run Summarize' }));
  await screen.findByRole('region', { name: 'Tool output' });
  expect(run.mock.calls[0]![0]).toEqual({ task: 'summarize', input: 'Only this chosen message', conversationId: 'securebot-demo' });
  expect(JSON.stringify(run.mock.calls)).not.toContain('Unrelated private message');
  expect(JSON.stringify(run.mock.calls)).not.toContain('ciphertext');
  expect(send).toHaveBeenCalledTimes(calls);
});

test('a prepared rewrite replaces a draft only after review and confirmation, never sends it', async () => {
  providerFactory.mockReturnValue(new providers.DemoAIProvider(0));
  const { session } = await mount(); const send = jest.spyOn(session.transport, 'sendMessage');
  const original = AI_TOOLS.find(tool => tool.task === 'rewrite')!.example;
  fireEvent.change(screen.getByRole('textbox'), { target: { value: original } });
  fireEvent.click(screen.getByRole('button', { name: 'Rewrite draft with @Secu' }));
  expect(screen.getByRole('textbox', { name: 'Text to work with' })).toHaveValue(original);
  fireEvent.click(screen.getByRole('button', { name: 'Run Rewrite' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Review for draft' }));
  const dialog = screen.getByRole('dialog', { name: 'Review your draft' });
  expect(within(dialog).getByText(original)).toBeInTheDocument();
  expect(screen.getByLabelText('Message to SecureBot')).toHaveValue(original);
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep original' }));
  expect(screen.getByLabelText('Message to SecureBot')).toHaveValue(original);
  fireEvent.click(screen.getByRole('button', { name: 'Review for draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Replace draft' }));
  expect(screen.getByRole('textbox', { name: 'Message to SecureBot' })).toHaveValue('Could you send me the notes when you get a chance? Thanks!');
  expect(send).not.toHaveBeenCalled();
});

test('draft changes invalidate a pending replacement instead of overwriting newer text', async () => {
  providerFactory.mockReturnValue(new providers.DemoAIProvider(0));
  await mount();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: AI_TOOLS.find(tool => tool.task === 'rewrite')!.example } });
  fireEvent.click(screen.getByRole('button', { name: 'Rewrite draft with @Secu' }));
  fireEvent.click(screen.getByRole('button', { name: 'Run Rewrite' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Review for draft' }));
  fireEvent.change(screen.getByLabelText('Message to SecureBot'), { target: { value: 'A newer draft to preserve' } });
  expect(screen.getByRole('button', { name: 'Replace draft' })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('Nothing will be replaced');
  fireEvent.click(screen.getByRole('button', { name: 'Keep original' }));
  nav('Chats'); expect(screen.getByRole('textbox')).toHaveValue('A newer draft to preserve');
});

test('switching Messenger conversations clears AI context and does not share unrelated drafts', async () => {
  providerFactory.mockReturnValue(new providers.DemoAIProvider(0));
  await mount();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Original conversation private draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Rewrite draft with @Secu' }));
  fireEvent.click(screen.getByRole('button', { name: 'Run Rewrite' }));
  await screen.findByRole('region', { name: 'Tool output' });
  await chooseConversation('Ava Morgan');
  nav('AI Hub');
  expect(screen.getByText('A fresh start.')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Tool output' })).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue('Original conversation private draft')).not.toBeInTheDocument();
  await chooseConversation('SecureBot'); expect(screen.getByRole('textbox')).toHaveValue('Original conversation private draft');
});

test('logout and identity replacement abort old AI work and discard its late result', async () => {
  let release!: (response: AIResponse) => void;
  const run = jest.fn<Promise<AIResponse>, Parameters<AIProvider['run']>>(() => new Promise(resolve => { release = resolve; }));
  providerFactory.mockReturnValue({ mode: 'demo', available: true, supportsStreaming: false, run });
  function Controls() { const auth = useAuth(); return <><button onClick={() => void auth.continueAsDemo('explorer')}>Enter Explorer</button><button onClick={() => void auth.continueAsDemo('nova')}>Enter Nova</button></>; }
  render(<AuthProvider service={new DevelopmentAuthService()}><Controls /><Home /></AuthProvider>);
  await waitFor(() => expect(replace).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Enter Explorer' }));
  await screen.findByRole('navigation', { name: 'Main navigation' });
  nav('AI Hub'); fireEvent.click(screen.getByRole('button', { name: 'Open @Secu' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Message @Secu' }), { target: { value: 'First identity private prompt' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send to @Secu' }));
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: /Open profile/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }));
  await waitFor(() => expect(screen.queryByRole('navigation')).not.toBeInTheDocument());
  expect(run.mock.calls[0]![1].signal.aborted).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Enter Nova' }));
  await screen.findByRole('navigation');
  nav('AI Hub'); fireEvent.click(screen.getByRole('button', { name: 'Open @Secu' }));
  await act(async () => { release({ provider: 'demo', kind: 'example', output: 'Old identity private answer' }); });
  expect(screen.queryByText('Old identity private answer')).not.toBeInTheDocument();
  expect(screen.queryByText('First identity private prompt')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Message @Secu' })).toHaveValue('');
});
