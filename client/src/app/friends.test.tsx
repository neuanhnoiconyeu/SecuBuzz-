import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MessengerHarness as Home } from '@/test-support/MessengerHarness';
// The cases render the whole messenger; the 5 s Jest default is too tight on Linux containers.
jest.setTimeout(20000);

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); },
  });
});
afterAll(() => {
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});

async function openFriends() {
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('button', { name: /^Friends/ }));
  const region = await screen.findByRole('region', { name: 'Friends' }, { timeout: 1000 });
  const friends = within(region);
  await friends.findByRole('list', { name: 'Your friends' }, { timeout: 1000 });
  return friends;
}

test('Friends navigation opens the same existing DM and preserves drafts and message history', async () => {
  render(<Home />);
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message to SecureBot' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /Ava Morgan, Direct/ }));
  const input = screen.getByRole('textbox', { name: 'Message to Ava Morgan' });
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: 'Existing Ava history' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await within(screen.getByRole('log')).findByText('Existing Ava history')).toBeInTheDocument();
  fireEvent.change(input, { target: { value: 'Keep this Ava draft' } });
  await openFriends();
  fireEvent.click(screen.getByRole('button', { name: 'Message Ava Morgan' }));
  expect(await screen.findByRole('heading', { name: 'Chat with Ava Morgan' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Message to Ava Morgan' })).toHaveValue('Keep this Ava draft');
  expect(within(screen.getByRole('log')).getByText('Existing Ava history')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /Ava Morgan, Direct/ })).toHaveLength(1);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Chat with Ava Morgan' })).toHaveFocus());
});

test('confirmed blocking disables local chat actions without deleting history, and unblock restores them', async () => {
  render(<Home />);
  const navigation = within(screen.getByRole('navigation', { name: 'Main navigation' }));
  const chat = within(screen.getByRole('region', { name: 'Chats' }));
  fireEvent.click(chat.getByRole('button', { name: /Ava Morgan, Direct/ }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message to Ava Morgan' })).toBeEnabled());
  fireEvent.change(chat.getByRole('textbox', { name: 'Message to Ava Morgan' }), { target: { value: 'History survives blocking' } });
  fireEvent.click(chat.getByRole('button', { name: 'Send' }));
  expect(await within(screen.getByRole('log')).findByText('History survives blocking')).toBeInTheDocument();
  const friends = await openFriends();
  fireEvent.click(friends.getByRole('button', { name: 'More actions for Ava Morgan' }));
  fireEvent.click(friends.getByRole('menuitem', { name: 'Block user' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Block user?' }));
  expect(dialog.getByText(/does not enforce server messaging permissions/)).toBeInTheDocument();
  fireEvent.click(dialog.getByRole('button', { name: 'Block user' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Block user?' })).not.toBeInTheDocument());
  fireEvent.click(navigation.getByRole('button', { name: 'Chats' }));
  expect(screen.getByText('Blocked in this local demo', { exact: false })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Message to Ava Morgan' })).toBeDisabled();
  expect(screen.getByRole('button', { name: /BUZZ/ })).toBeDisabled();
  expect(within(screen.getByRole('log')).getByText('History survives blocking')).toBeInTheDocument();
  fireEvent.click(chat.getByRole('button', { name: 'Manage friends' }));
  fireEvent.click(await friends.findByRole('tab', { name: /^Blocked Users/ }, { timeout: 1000 }));
  fireEvent.click(await friends.findByRole('button', { name: 'Unblock Ava Morgan' }, { timeout: 1000 }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Unblock Ava Morgan' })).not.toBeInTheDocument());
  fireEvent.click(navigation.getByRole('button', { name: 'Chats' }));
  expect(screen.getByText('Not friends · local demo')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Message to Ava Morgan' })).toBeEnabled();
  fireEvent.change(chat.getByRole('textbox', { name: 'Message to Ava Morgan' }), { target: { value: 'Unblocked draft' } });
  expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  expect(within(screen.getByRole('log')).getByText('History survives blocking')).toBeInTheDocument();
});

test('incoming badge and accepted profiles use shared state without inventing a new DM', async () => {
  render(<Home />);
  const friends = await openFriends();
  expect(screen.getByRole('button', { name: 'Friends, 1 incoming request' })).toBeInTheDocument();
  fireEvent.click(await friends.findByRole('tab', { name: /^Pending Requests/ }, { timeout: 1000 }));
  fireEvent.click(await friends.findByRole('button', { name: 'Accept request from Jules Park' }, { timeout: 1000 }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Friends' })).toBeInTheDocument());
  fireEvent.click(await friends.findByRole('tab', { name: /^All Friends/ }, { timeout: 1000 }));
  expect(screen.getByRole('button', { name: 'Message Jules Park' })).toBeDisabled();
  expect(screen.getByText(/No direct chat is connected/)).toBeInTheDocument();
  fireEvent.click(friends.getByRole('button', { name: 'View profile for Jules Park' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Public profile' }));
  expect(dialog.getByText('Friends')).toBeInTheDocument();
  expect(dialog.getByText('Unknown')).toBeInTheDocument();
});
