import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Home from './page';

async function selectConversation(label: RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: label }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('messenger application', () => {
  test('switches conversation headers and keeps messages isolated', async () => {
    render(<Home />);
    const secureBotInput = screen.getByRole('textbox', { name: 'Message to SecureBot' });
    await waitFor(() => expect(secureBotInput).toBeEnabled());
    fireEvent.change(secureBotInput, { target: { value: 'SecureBot only' } });
    await selectConversation(/Ava Morgan, Direct/);

    expect(await screen.findByRole('heading', { name: 'Chat with Ava Morgan' })).toBeInTheDocument();
    const avaInput = screen.getByRole('textbox', { name: 'Message to Ava Morgan' });
    await waitFor(() => expect(avaInput).toBeEnabled());
    expect(avaInput).toHaveValue('');
    fireEvent.change(avaInput, { target: { value: 'Ava only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await within(screen.getByRole('log')).findByText('Ava only')).toBeInTheDocument();
    fireEvent.change(avaInput, { target: { value: 'Ava unsent draft' } });

    await selectConversation(/Security Study Group, Group/);
    expect(await screen.findByRole('heading', { name: 'Chat with Security Study Group' })).toBeInTheDocument();
    expect(within(screen.getByRole('log')).queryByText('Ava only')).not.toBeInTheDocument();
    const groupInput = screen.getByRole('textbox', { name: 'Message to Security Study Group' });
    await waitFor(() => expect(groupInput).toBeEnabled());
    expect(groupInput).toHaveValue('');

    await selectConversation(/Ava Morgan, Direct/);
    expect(await within(screen.getByRole('log')).findByText('Ava only')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message to Ava Morgan' })).toHaveValue('Ava unsent draft');

    await selectConversation(/SecureBot, Bot/);
    expect(screen.getByRole('textbox', { name: 'Message to SecureBot' })).toHaveValue('SecureBot only');
  });

  test('navigation preserves the active chat and its draft when opening Security', async () => {
    render(<Home />);
    const input = screen.getByRole('textbox', { name: 'Message to SecureBot' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Security' }));
    expect(screen.getByRole('heading', { name: 'Security' })).toBeInTheDocument();
    expect(screen.getAllByText('Not established')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
    expect(screen.getByRole('textbox', { name: 'Message to SecureBot' })).toHaveValue('Keep this draft');
    fireEvent.click(screen.getByRole('button', { name: 'Security' }));
    fireEvent.click(screen.getByRole('link', { name: 'Yahoo Security Messenger home' }));
    expect(screen.getByRole('textbox', { name: 'Message to SecureBot' })).toHaveValue('Keep this draft');
  });
});
