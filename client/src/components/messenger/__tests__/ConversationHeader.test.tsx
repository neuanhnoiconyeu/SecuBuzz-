import { fireEvent, render, screen, within } from '@testing-library/react';
import { ConversationHeader } from '../ConversationHeader';
import type { ConversationHeaderProps } from '../ConversationHeader';

const readyProps: ConversationHeaderProps = {
  name: 'SecureBot',
  type: 'bot',
  connectionStatus: 'connected',
  transportMode: 'local-demo',
  securityStatus: {
    browserCryptoAvailable: true,
    localEncryptionAvailable: true,
    recipientKeyAvailable: false,
    authenticatedKeyExchangeEstablished: false,
  },
};

describe('ConversationHeader security disclosure', () => {
  test('updates conversation identity immediately while preserving the open security disclosure', () => {
    const { rerender } = render(<ConversationHeader {...readyProps} transitionKey="securebot-demo" />);
    const originalHeading = screen.getByRole('heading', { name: 'Chat with SecureBot' });
    const summary = screen.getByText('Security details').closest('summary')!;
    const disclosure = summary.closest('details')!;
    fireEvent.click(summary);
    summary.focus();

    rerender(<ConversationHeader {...readyProps} name="Ava Morgan" type="direct" transitionKey="demo-direct-ava" />);

    expect(screen.getByRole('heading', { name: 'Chat with Ava Morgan' })).not.toBe(originalHeading);
    expect(screen.getByText('Security details').closest('details')).toBe(disclosure);
    expect(disclosure).toHaveAttribute('open');
    expect(summary).toHaveFocus();
    expect(screen.getByRole('region', { name: 'Conversation security details' })).toHaveTextContent('Recipient key exchange is unavailable');
  });

  test('keeps the E2EE limitation and demo mode visible while exposing full local security details', () => {
    render(<ConversationHeader {...readyProps} />);

    const summary = screen.getByText('Security details').closest('summary')!;
    const disclosure = summary.closest('details')!;
    expect(disclosure).not.toHaveAttribute('open');
    expect(summary).toHaveTextContent('Local encryption only');
    expect(summary).toHaveTextContent('E2EE not established');
    expect(screen.getByText('Local demo')).toBeVisible();

    fireEvent.click(summary);
    expect(disclosure).toHaveAttribute('open');
    const panel = screen.getByRole('region', { name: 'Conversation security details' });
    expect(within(panel).getByText('Local AES-256-GCM available')).toBeInTheDocument();
    expect(within(panel).getByText('Recipient key unavailable')).toBeInTheDocument();
    expect(within(panel).getByText('Authenticated key exchange unavailable')).toBeInTheDocument();
    expect(panel).toHaveTextContent('non-extractable key held in this page\'s memory');
    expect(panel).toHaveTextContent('remote end-to-end encryption is not established');
    expect(panel).toHaveTextContent('No other user receives messages');
    expect(panel).toHaveAttribute('tabindex', '0');

    fireEvent.click(summary);
    expect(disclosure).not.toHaveAttribute('open');
    expect(summary).toHaveTextContent('E2EE not established');
  });

  test('distinguishes preparing and unavailable local encryption without hiding the E2EE limitation', () => {
    const { rerender } = render(<ConversationHeader {...readyProps} securityStatus={null} />);
    const summary = screen.getByText('Security details').closest('summary')!;
    expect(summary).toHaveTextContent('Preparing encryption');
    expect(summary).toHaveTextContent('E2EE not established');
    fireEvent.click(summary);
    expect(screen.getByText('Preparing local encryption')).toBeInTheDocument();

    rerender(<ConversationHeader {...readyProps} securityStatus={{
      browserCryptoAvailable: false,
      localEncryptionAvailable: false,
      recipientKeyAvailable: false,
      authenticatedKeyExchangeEstablished: false,
    }} />);
    expect(summary).toHaveTextContent('Encryption unavailable');
    expect(summary).toHaveTextContent('E2EE not established');
    expect(screen.getByText('Browser encryption unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Local AES-256-GCM available')).not.toBeInTheDocument();
  });

  test('keeps connection status separate from encryption and labels mock replies only in demo mode', () => {
    render(<ConversationHeader {...readyProps} transportMode="realtime" connectionStatus="connecting" type="direct" name="Ava" />);
    expect(screen.getByText('Connecting')).toBeInTheDocument();
    expect(screen.queryByText('Local demo')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Security details'));
    const panel = screen.getByRole('region', { name: 'Conversation security details' });
    expect(panel).toHaveTextContent('Recipient key exchange is unavailable');
    expect(panel).not.toHaveTextContent('Local demo replies');
    expect(screen.getByText('E2EE not established')).toBeInTheDocument();
  });
});
