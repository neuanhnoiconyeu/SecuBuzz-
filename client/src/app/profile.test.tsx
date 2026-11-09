import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MessengerHarness as Home } from '@/test-support/MessengerHarness';

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) { this.setAttribute('open', ''); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    },
  });
});

afterAll(() => {
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});

test('profile saves update navigation and own-message labels while contact identity stays intact', async () => {
  render(<Home />);
  const input = screen.getByRole('textbox', { name: 'Message to SecureBot' });
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: 'Message before profile edit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  const history = within(screen.getByRole('log'));
  expect(await history.findByText('Message before profile edit')).toBeInTheDocument();
  expect(history.getByText('Demo Explorer (You)')).toBeInTheDocument();

  const opener = await screen.findByRole('button', { name: /Open profile for Demo Explorer/ });
  opener.focus();
  fireEvent.click(opener);
  const dialog = within(screen.getByRole('dialog', { name: 'Your profile' }));
  expect(dialog.getByText('local-user')).toBeInTheDocument();
  expect(dialog.getAllByText('@demo-explorer')).toHaveLength(2);
  fireEvent.click(dialog.getByRole('button', { name: 'Edit profile' }));
  fireEvent.change(dialog.getByRole('textbox', { name: 'Display name' }), { target: { value: '  Nova 🦉  ' } });
  fireEvent.change(dialog.getByRole('textbox', { name: 'Status message' }), { target: { value: 'Crafting local demos ✨' } });
  fireEvent.click(dialog.getByRole('radio', { name: 'Rocket' }));
  fireEvent.change(dialog.getByRole('combobox', { name: 'Presence preference' }), { target: { value: 'busy' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

  expect(await dialog.findByRole('button', { name: 'Edit profile' })).toBeInTheDocument();
  expect(dialog.getByRole('heading', { name: 'Nova 🦉' })).toBeInTheDocument();
  expect(dialog.getByText('Crafting local demos ✨')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Open profile for Nova 🦉; Busy local preference/ })).toBe(opener);
  fireEvent.click(dialog.getByRole('button', { name: 'Close profile' }));
  expect(opener).toHaveFocus();
  expect(history.getByText('Nova 🦉 (You)')).toBeInTheDocument();
  expect(history.queryByText('Demo Explorer (You)')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Chat with SecureBot' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Ava Morgan, Direct/ })).toBeInTheDocument();

  fireEvent.click(opener);
  const reopened = within(screen.getByRole('dialog', { name: 'Your profile' }));
  fireEvent.click(reopened.getByRole('button', { name: 'Edit profile' }));
  fireEvent.change(reopened.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Unsaved identity' } });
  fireEvent.click(reopened.getByRole('button', { name: 'Cancel' }));
  expect(reopened.getByRole('heading', { name: 'Nova 🦉' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Open profile for Unsaved identity/ })).not.toBeInTheDocument();
});
