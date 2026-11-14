import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/Your draft is still here/);
  });

  test('disables the composer while crypto setup is unavailable', () => {
    renderComposer(jest.fn(async () => true), true);
    expect(screen.getByRole('textbox', { name: 'Message to SecureBot' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  test('leaves Enter available to an active input composition', () => {
    const onSend = jest.fn(async () => true);
    renderComposer(onSend);
    const input = screen.getByRole('textbox', { name: 'Message to SecureBot' });
    fireEvent.change(input, { target: { value: 'Composing a message' } });

    const eventWasNotPrevented = fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(eventWasNotPrevented).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue('Composing a message');
  });

  test('grows for multiline drafts within a bounded height and shrinks for a short draft', () => {
    renderComposer(jest.fn(async () => true));
    const input = screen.getByRole('textbox', { name: 'Message to SecureBot' }) as HTMLTextAreaElement;
    Object.defineProperty(input, 'scrollHeight', {
      configurable: true,
      get: () => input.value.includes('\n') ? 260 : 44,
    });

    fireEvent.change(input, { target: { value: 'Line one\nLine two\nLine three' } });
    expect(input.style.height).toBe('112px');
    expect(input.style.overflowY).toBe('auto');
    expect(input).toHaveValue('Line one\nLine two\nLine three');

    fireEvent.change(input, { target: { value: 'Short draft' } });
    expect(input.style.height).toBe('44px');
    expect(input.style.overflowY).toBe('hidden');
  });

  test('prevents duplicate sends while an accepted send is pending', async () => {
    let acceptSend: (accepted: boolean) => void = () => undefined;
    const onSend = jest.fn(() => new Promise<boolean>((resolve) => { acceptSend = resolve; }));
    renderComposer(onSend);
    const input = screen.getByRole('textbox', { name: 'Message to SecureBot' });
    fireEvent.change(input, { target: { value: 'Send once' } });

    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue('Send once');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    await act(async () => { acceptSend(true); });
    expect(input).toHaveValue('');
    expect(screen.getByRole('status')).toHaveTextContent('Message submitted.');
  });

  test('acknowledges accepted submissions and clears that feedback before a rejected send', async () => {
    const onSend = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    renderComposer(onSend);
    const input = screen.getByRole('textbox', { name: 'Message to SecureBot' });
    const send = screen.getByRole('button', { name: 'Send' });

    fireEvent.change(input, { target: { value: 'Accepted message' } });
    fireEvent.click(send);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Message submitted.'));
    expect(input).toHaveValue('');

    fireEvent.change(input, { target: { value: 'Keep this draft' } });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    fireEvent.click(send);
    expect(await screen.findByRole('alert')).toHaveTextContent('Your draft is still here');
    expect(input).toHaveValue('Keep this draft');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});
