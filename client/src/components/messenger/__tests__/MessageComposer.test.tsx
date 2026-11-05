import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageComposer } from '../MessageComposer';

const renderComposer = (onSend: (content: string) => Promise<boolean>, disabled = false) => render(
  <MessageComposer
    conversationName="SecureBot"
    messageCount={0}
    isSending={false}
    buzzBusy={false}
    disabled={disabled}
    onSend={onSend}
    onBuzz={jest.fn()}
  />
);

describe('MessageComposer', () => {
  test('sends on Enter and clears the input only after acceptance', async () => {
    const onSend = jest.fn(async (_content: string) => true);
    renderComposer(onSend);
    const input = screen.getByRole('textbox', { name: 'Message to SecureBot' });

    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hello'));
    await waitFor(() => expect(input).toHaveValue(''));
  });

  test('keeps Shift+Enter available for a newline without sending', () => {
    const onSend = jest.fn(async () => true);
    renderComposer(onSend);
    const input = screen.getByRole('textbox', { name: 'Message to SecureBot' });
    fireEvent.change(input, { target: { value: 'first line' } });
    const eventWasNotPrevented = fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
    expect(eventWasNotPrevented).toBe(true);
  });

  test('disables sending for empty and whitespace-only drafts', () => {
    renderComposer(jest.fn(async () => true));
    const input = screen.getByRole('textbox', { name: 'Message to SecureBot' });
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    fireEvent.change(input, { target: { value: '   \n  ' } });
    expect(send).toBeDisabled();
  });

  test('preserves the draft and explains a failed send', async () => {
    const onSend = jest.fn(async () => false);
    renderComposer(onSend);
    const input = screen.getByRole('textbox', { name: 'Message to SecureBot' });
    fireEvent.change(input, { target: { value: 'keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Your draft is still here');
    expect(input).toHaveValue('keep this draft');
  });

  test('disables the composer while crypto setup is unavailable', () => {
    renderComposer(jest.fn(async () => true), true);
    expect(screen.getByRole('textbox', { name: 'Message to SecureBot' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});
