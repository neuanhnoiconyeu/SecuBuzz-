import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Home from '@/app/page';
import { AuthProvider, useAuth } from '../AuthProvider';
import { DevelopmentAuthService } from '../developmentAuthService';
import type { AuthService } from '../authService';
import { AuthError } from '../authModel';

const replace = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true,
    value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true,
    value(this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); } });
});
afterAll(() => {
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});
beforeEach(() => { replace.mockClear(); window.history.replaceState({}, '', '/'); });

function Controls() {
  const auth = useAuth();
  return <div>
    <button onClick={() => void auth.continueAsDemo('explorer')}>Test Explorer</button>
    <button onClick={() => void auth.continueAsDemo('nova')}>Test Nova</button>
  </div>;
}
function TestApp({ service }: { service: AuthService }) {
  return <AuthProvider service={service}><Controls /><Home /></AuthProvider>;
}

async function enter(persona: 'Explorer' | 'Nova') {
  fireEvent.click(screen.getByRole('button', { name: `Test ${persona}` }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message to SecureBot' })).toBeEnabled());
}

test('logout and identity replacement isolate profiles, friends, messages, drafts, and canonical DMs/groups', async () => {
  render(<TestApp service={new DevelopmentAuthService()} />);
  await waitFor(() => expect(replace).toHaveBeenCalledWith('/login?next=%2F'));
  expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument();
  await enter('Explorer');
  fireEvent.change(screen.getByRole('textbox', { name: 'Message to SecureBot' }), { target: { value: 'Explorer private local message' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await within(screen.getByRole('log')).findByText('Explorer private local message')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'Message to SecureBot' }), { target: { value: 'Explorer unsent draft' } });
  fireEvent.click(screen.getByRole('button', { name: /^Friends,/ }));
  fireEvent.click(screen.getByRole('tab', { name: 'Find Friends' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search by username' }), { target: { value: 'mina.patel' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Add Mina Patel as a friend' }));
  await screen.findByText('Friend request sent.');
  fireEvent.click(screen.getByRole('button', { name: /Open profile for Demo Explorer/ }));
  let dialog = within(screen.getByRole('dialog', { name: 'Your profile' }));
  fireEvent.click(dialog.getByRole('button', { name: 'Edit profile' }));
  fireEvent.change(dialog.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Explorer edited name' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));
  await dialog.findByRole('heading', { name: 'Explorer edited name' });
  fireEvent.click(dialog.getByRole('button', { name: 'Sign Out' }));
  await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument());
  expect(screen.queryByText('Explorer private local message')).not.toBeInTheDocument();
  await enter('Nova');
  expect(screen.getByRole('textbox', { name: 'Message to SecureBot' })).toHaveValue('');
  expect(screen.queryByText('Explorer private local message')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Open profile for Nova Explorer/ }));
  dialog = within(screen.getByRole('dialog', { name: 'Your profile' }));
  expect(dialog.getByText('demo-session-nova')).toBeInTheDocument();
  expect(dialog.getByRole('heading', { name: 'Nova Explorer' })).toBeInTheDocument();
  fireEvent.click(dialog.getByRole('button', { name: 'Close profile' }));
  fireEvent.click(screen.getByRole('button', { name: /^Friends,/ }));
  fireEvent.click(screen.getByRole('tab', { name: /^Pending Requests/ }));
  expect(screen.getByRole('button', { name: 'Cancel request to Kai Chen' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Cancel request to Mina Patel' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: /^All Friends/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Message Ava Morgan' }));
  const input = await screen.findByRole('textbox', { name: 'Message to Ava Morgan' });
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: 'Nova DM identity' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await within(screen.getByRole('log')).findByText('Nova DM identity')).toBeInTheDocument();
  expect(within(screen.getByRole('log')).getByText('Nova Explorer (You)')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Security Study Group, Group/ }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message to Security Study Group' })).toBeEnabled());
  expect(within(screen.getByRole('log')).queryByText('Nova DM identity')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Open profile for Nova Explorer/ }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Your profile' })).getByRole('button', { name: 'Sign Out' }));
  await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument());
  await enter('Explorer');
  expect(screen.getByRole('textbox', { name: 'Message to SecureBot' })).toHaveValue('');
  expect(screen.queryByText('Nova DM identity')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Open profile for Demo Explorer/ })).toBeInTheDocument();
});

test('development StrictMode lifecycle leaves a usable fresh session, including safe intended section', async () => {
  window.history.replaceState({}, '', '/#friends');
  render(<StrictMode><TestApp service={new DevelopmentAuthService()} /></StrictMode>);
  await waitFor(() => expect(replace).toHaveBeenCalledWith('/login?next=%2F%23friends'));
  fireEvent.click(screen.getByRole('button', { name: 'Test Explorer' }));
  expect(await screen.findByRole('heading', { name: 'Friends' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message to SecureBot' })).toBeEnabled());
  fireEvent.change(screen.getByRole('textbox', { name: 'Message to SecureBot' }), { target: { value: 'StrictMode session works' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await within(screen.getByRole('log')).findByText('StrictMode session works')).toBeInTheDocument();
});

test('real sessions never receive demo people; failed server logout preserves identity and reports uncertainty', async () => {
  const service: AuthService = {
    mode: 'api', getCurrentUser: async () => ({ id: 'account-real', username: 'verified', displayName: 'Verified User', avatar: 'cat', isDemo: false }),
    login: jest.fn(), register: jest.fn(), logout: jest.fn().mockRejectedValue(new AuthError('logout_failed')),
  };
  render(<TestApp service={service} />);
  expect(await screen.findByRole('heading', { name: "You're signed in." })).toBeInTheDocument();
  expect(screen.getByText('Verified User · @verified')).toBeInTheDocument();
  expect(screen.queryByText('Ava Morgan')).not.toBeInTheDocument();
  expect(screen.queryByRole('log')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Your server session may still be active');
  expect(screen.getByText('Verified User · @verified')).toBeInTheDocument();
  expect(replace).not.toHaveBeenCalled();
});
