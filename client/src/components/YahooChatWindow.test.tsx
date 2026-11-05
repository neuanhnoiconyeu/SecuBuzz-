import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { localDemoTransport } from '@/messaging/localDemoTransport';
import type { OutboundMessage } from '@/messaging/messageModel';
import type { MessagingTransport } from '@/messaging/transport';
import YahooChatWindow from './YahooChatWindow';

describe('YahooChatWindow', () => {
  test('keeps the SecureBot conversation empty until a real local action occurs', async () => {
    render(<YahooChatWindow contactName="SecureBot" />);
    await waitFor(() => expect(screen.getByText('Local AES-256-GCM available')).toBeInTheDocument());

    expect(screen.getByText('No messages yet')).toBeInTheDocument();
    expect(screen.getByText('Local demo')).toBeInTheDocument();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Recipient key exchange is unavailable');
    expect(screen.getByText('Recipient key unavailable')).toBeInTheDocument();
    expect(screen.getByText('E2EE not established')).toBeInTheDocument();
    expect(screen.queryByText('Your messages are end-to-end encrypted.')).not.toBeInTheDocument();
  });

  test('sends on Enter through the local encrypted transport and logs only accepted sends', async () => {
    const onSendMessage = jest.fn();
    const sendMessage = jest.fn((message: OutboundMessage) => localDemoTransport.sendMessage(message));
    const transport: MessagingTransport = { ...localDemoTransport, sendMessage };
    render(
      <YahooChatWindow
        conversationId="securebot-demo"
        contactName="SecureBot"
        onSendMessage={onSendMessage}
        transport={transport}
      />
    );
    const input = screen.getByRole('textbox', { name: 'Message to SecureBot' });
    await waitFor(() => expect(input).toBeEnabled());

    const sendStartedAt = Date.now();
    fireEvent.change(input, { target: { value: 'Hello, SecureBot!' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expect(await screen.findByText('Hello, SecureBot!')).toBeInTheDocument();
    expect(await screen.findByText('Encrypted locally')).toBeInTheDocument();
    expect(screen.getByText('Accepted by local demo')).toBeInTheDocument();
    expect(onSendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'securebot-demo' }));
    expect(sendMessage.mock.calls[0]?.[0]).not.toHaveProperty('content');
    expect(sendMessage.mock.calls[0]?.[0].encryption).toMatchObject({
      version: 1,
      algorithm: 'AES-256-GCM',
      encoding: 'base64',
    });

    const demoReply = await screen.findByText(/Demo reply: your message was received locally/);
    const incomingRow = demoReply.closest('article');
    expect(incomingRow).not.toBeNull();
    expect(incomingRow).toHaveClass('message-row');
    expect(incomingRow).not.toHaveClass('message-row-outgoing');
    expect(within(incomingRow as HTMLElement).getByText('Demo reply')).toBeInTheDocument();
    expect(within(incomingRow as HTMLElement).getByText('SecureBot')).toBeInTheDocument();
    expect(screen.getAllByText(/Demo reply: your message was received locally/)).toHaveLength(1);
    const time = incomingRow?.querySelector('time');
    const receivedAt = Date.parse(time?.dateTime ?? '');
    expect(receivedAt).toBeGreaterThanOrEqual(sendStartedAt);
    expect(receivedAt).toBeLessThanOrEqual(Date.now());
    await waitFor(() => expect(input).toHaveValue(''));
  });

  test('marks a failed transport send and preserves the composer draft', async () => {
    const transport: MessagingTransport = {
      mode: 'local-demo',
      async connect() {},
      async sendMessage() {
        throw new Error('offline');
      },
      subscribeToConversation() {
        return () => undefined;
      },
      async disconnect() {},
    };
    render(<YahooChatWindow transport={transport} />);
    const input = screen.getByRole('textbox', { name: 'Message to SecureBot' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Not sent')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Your draft is still here');
    expect(input).toHaveValue('Keep this draft');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('Delivered')).not.toBeInTheDocument();
  });

  test('preserves the BUZZ action and prevents rapid repeated triggers', async () => {
    const onBuzz = jest.fn();
    render(<YahooChatWindow onBuzz={onBuzz} />);
    await waitFor(() => expect(screen.getByText('Local AES-256-GCM available')).toBeInTheDocument());
    const buzzButton = screen.getByRole('button', { name: 'Send BUZZ alert' });
    fireEvent.click(buzzButton);

    expect(onBuzz).toHaveBeenCalledTimes(1);
    expect(buzzButton).toHaveAttribute('data-buzz-active', 'true');
    expect(buzzButton).toBeDisabled();
    fireEvent.click(buzzButton);
    expect(onBuzz).toHaveBeenCalledTimes(1);
  });
});
