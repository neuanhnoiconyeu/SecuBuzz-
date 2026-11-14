import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createDemoMessengerSession, type DemoMessengerSession } from '@/auth/messengerSession';
import { createDemoProfile } from '@/profiles/profileModel';
import { MessengerApp } from '@/components/messenger/MessengerApp';
import { AI_REMOTE_DISCLOSURE, RemoteAIProvider } from '@/ai/remoteAIProvider';
import * as providers from '@/ai/demoAIProvider';

jest.mock('@/ai/demoAIProvider', () => ({ ...jest.requireActual('@/ai/demoAIProvider'), createAIProvider: jest.fn() }));
const providerFactory = jest.mocked(providers.createAIProvider);

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
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); jest.restoreAllMocks(); });

async function mount() {
  const session = createDemoMessengerSession(createDemoProfile()); sessions.push(session);
  render(<MessengerApp session={session} />);
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message to SecureBot' })).toBeEnabled());
  return session;
}

test('Messenger offers no AI handoffs while the provider refuses Messenger content', async () => {
  const fetch = jest.fn();
  providerFactory.mockReturnValue(new RemoteAIProvider({ getCsrfToken: () => 'csrf-test-token', fetch }));
  await mount();
  const composer = screen.getByRole('textbox', { name: 'Message to SecureBot' });
  fireEvent.change(composer, { target: { value: 'A private message for SecureBot' } });
  expect(screen.queryByRole('button', { name: 'Rewrite draft with @Secu' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(composer).toHaveValue(''));
  const row = within(screen.getByRole('log')).getByText('A private message for SecureBot').closest('article')!;
  fireEvent.click(within(row).getByRole('button', { name: 'More actions' }));
  expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(0);
  expect(screen.queryByRole('menuitem', { name: /Ask @Secu|selected message/ })).not.toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('button', { name: 'AI Hub' }));
  fireEvent.click(screen.getByRole('button', { name: /^Explain/ }));
  expect(screen.getByText(AI_REMOTE_DISCLOSURE.text)).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Text to work with' })).toHaveValue('');
  expect(fetch).not.toHaveBeenCalled();
});

test('the demo provider keeps the Phase 9A Messenger handoffs', async () => {
  providerFactory.mockReturnValue(new providers.DemoAIProvider(0));
  await mount();
  fireEvent.change(screen.getByRole('textbox', { name: 'Message to SecureBot' }), { target: { value: 'Draft text' } });
  expect(screen.getByRole('button', { name: 'Rewrite draft with @Secu' })).toBeInTheDocument();
});
