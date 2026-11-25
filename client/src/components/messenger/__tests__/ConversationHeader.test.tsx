import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
  test('only direct conversations expose call actions and pass the selected call kind', () => {
    const onStartCall = jest.fn();
    const { rerender } = render(<ConversationHeader {...readyProps} onStartCall={onStartCall} />);
    expect(screen.queryByRole('group', { name: 'Direct call actions' })).not.toBeInTheDocument();
    rerender(<ConversationHeader {...readyProps} name="Ava" type="direct" onStartCall={onStartCall} />);
    fireEvent.click(screen.getByRole('button', { name: 'Voice call Ava' }));
    fireEvent.click(screen.getByRole('button', { name: 'Video call Ava' }));
    expect(onStartCall.mock.calls).toEqual([['voice'], ['video']]);
    rerender(<ConversationHeader {...readyProps} name="Ava" type="direct" callDisabled onStartCall={onStartCall} />);
    expect(screen.getByRole('button', { name: 'Voice call Ava' })).toBeDisabled();
    rerender(<ConversationHeader {...readyProps} type="group" onStartCall={onStartCall} />);
    expect(screen.queryByRole('group', { name: 'Direct call actions' })).not.toBeInTheDocument();
  });

  test('updates conversation identity immediately while preserving the open security disclosure', () => {
    const { rerender } = render(<ConversationHeader {...readyProps} transitionKey="securebot-demo" />);
    const originalHeading = screen.getByRole('heading', { name: 'Chat with SecureBot' });
    const summary = screen.getByRole('button', { name: /^Security details:/ });
    fireEvent.click(summary);
    summary.focus();

    rerender(<ConversationHeader {...readyProps} name="Ava Morgan" type="direct" transitionKey="demo-direct-ava" />);

    expect(screen.getByRole('heading', { name: 'Chat with Ava Morgan' })).not.toBe(originalHeading);
    expect(screen.getByRole('button', { name: /^Security details:/ })).toBe(summary);
    expect(summary).toHaveAttribute('aria-expanded', 'true');
    expect(summary).toHaveFocus();
    expect(screen.getByRole('dialog', { name: 'Conversation security details' })).toHaveTextContent('Recipient key exchange is unavailable');
  });

  test('keeps the E2EE limitation and demo mode visible while exposing full local security details', () => {
    render(<ConversationHeader {...readyProps} />);

    const summary = screen.getByRole('button', { name: /^Security details:/ });
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(summary).toHaveAccessibleDescription(/Local encryption only/);
    expect(summary).toHaveAccessibleDescription(/E2EE not established/);
    expect(screen.getByText('Local demo')).toBeVisible();

    fireEvent.click(summary);
    expect(summary).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByRole('dialog', { name: 'Conversation security details' });
    expect(within(panel).getByText('Local AES-256-GCM available')).toBeInTheDocument();
    expect(within(panel).getByText('Recipient key unavailable')).toBeInTheDocument();
    expect(within(panel).getByText('Authenticated key exchange unavailable')).toBeInTheDocument();
    expect(panel).toHaveTextContent('non-extractable key held in this page\'s memory');
    expect(panel).toHaveTextContent('remote end-to-end encryption is not established');
    expect(panel).toHaveTextContent('No other user receives messages');
    expect(panel).toHaveFocus();
    expect(summary).toHaveAttribute('aria-controls', panel.id);

    fireEvent.click(summary);
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(summary).toHaveFocus();
    expect(summary).toHaveAccessibleDescription(/E2EE not established/);
  });

  test('distinguishes preparing and unavailable local encryption without hiding the E2EE limitation', () => {
    const { rerender } = render(<ConversationHeader {...readyProps} securityStatus={null} />);
    const summary = screen.getByRole('button', { name: /^Security details:/ });
    expect(summary).toHaveAccessibleDescription(/Preparing encryption/);
    expect(summary).toHaveAccessibleDescription(/E2EE not established/);
    fireEvent.click(summary);
    expect(screen.getByText('Preparing local encryption')).toBeInTheDocument();

    rerender(<ConversationHeader {...readyProps} securityStatus={{
      browserCryptoAvailable: false,
      localEncryptionAvailable: false,
      recipientKeyAvailable: false,
      authenticatedKeyExchangeEstablished: false,
    }} />);
    expect(summary).toHaveAccessibleDescription(/Encryption unavailable/);
    expect(summary).toHaveAccessibleDescription(/E2EE not established/);
    expect(screen.getByText('Browser encryption unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Local AES-256-GCM available')).not.toBeInTheDocument();
  });

  test('keeps connection status separate from encryption and labels mock replies only in demo mode', () => {
    render(<ConversationHeader {...readyProps} transportMode="realtime" connectionStatus="connecting" type="direct" name="Ava" />);
    expect(screen.getByText('Connecting')).toBeInTheDocument();
    expect(screen.queryByText('Local demo')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Security details:/ }));
    const panel = screen.getByRole('dialog', { name: 'Conversation security details' });
    expect(panel).toHaveTextContent('Recipient key exchange is unavailable');
    expect(panel).not.toHaveTextContent('Local demo replies');
    expect(screen.getByText('E2EE not established')).toBeInTheDocument();
  });
});

test('Escape and the close button restore trigger focus without changing call controls', () => {
  const onStartCall = jest.fn();
  render(<ConversationHeader {...readyProps} name="Ava" type="direct" onStartCall={onStartCall} />);
  const trigger = screen.getByRole('button', { name: /^Security details:/ });
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog')).toHaveFocus();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('button', { name: 'Close security details' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(onStartCall).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Voice call Ava' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Video call Ava' })).toBeEnabled();
});

test('outside pointer and focus close the nonmodal overlay without stealing focus', () => {
  render(<><ConversationHeader {...readyProps} /><button>Message composer</button></>);
  const trigger = screen.getByRole('button', { name: /^Security details:/ });
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(trigger);
  const outside = screen.getByRole('button', { name: 'Message composer' });
  act(() => outside.focus());
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(outside).toHaveFocus();
});

test('opening another anchored messaging menu dismisses the security overlay', () => {
  render(<ConversationHeader {...readyProps} />);
  fireEvent.click(screen.getByRole('button', { name: /^Security details:/ }));
  fireEvent(document, new CustomEvent('secubuzz:message-popover-open', { detail: 'another-popup' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('hiding a conversation closes its overlay without moving focus back into the hidden chat', () => {
  const { rerender } = render(<ConversationHeader {...readyProps} active />);
  const trigger = screen.getByRole('button', { name: /^Security details:/ });
  fireEvent.click(trigger);
  rerender(<ConversationHeader {...readyProps} active={false} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).not.toHaveFocus();
  rerender(<ConversationHeader {...readyProps} active />);
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('real-account details preserve the safety number, warning text and current key state', () => {
  const details = <><p>Compare your safety number with your contact.</p><code>1234 5678</code><p>This is trust on first use, not independent verification against a malicious server.</p></>;
  const { rerender } = render(<ConversationHeader {...readyProps} type="direct" transportMode="realtime" securityStatus={null}
    securePresentation={{ ready: true, state: 'verified', label: 'End-to-end encrypted', details }} />);
  const trigger = screen.getByRole('button', { name: /^Security details:/ });
  expect(trigger).toHaveAccessibleDescription(/End-to-end encrypted/);
  expect(trigger).toHaveAccessibleDescription(/Conversation keys checked/);
  fireEvent.click(trigger);
  const panel = screen.getByRole('dialog', { name: 'Conversation security details' });
  expect(panel).toHaveAttribute('aria-modal', 'false');
  expect(within(panel).getByText('1234 5678')).toBeInTheDocument();
  expect(panel).toHaveTextContent('not independent verification against a malicious server');
  rerender(<ConversationHeader {...readyProps} type="direct" transportMode="realtime"
    securePresentation={{ ready: false, state: 'warning', label: 'Review contact keys', details: <p>Check with your contact before trusting new device keys.</p> }} />);
  expect(trigger).toHaveAccessibleDescription(/Review contact keys/);
  expect(trigger).toHaveAccessibleDescription(/Sending is locked/);
  expect(panel).not.toHaveTextContent('1234 5678');
  expect(panel).toHaveTextContent('Check with your contact before trusting new device keys.');
});

test('the security trigger is icon-only, labeled with its current state, and keeps full status text in the overlay', () => {
  render(<ConversationHeader {...readyProps} type="direct" transportMode="realtime" securityStatus={null}
    securePresentation={{ ready: true, state: 'verified', label: 'End-to-end encrypted', details: <code>1234 5678</code> }} />);
  const trigger = screen.getByRole('button', { name: 'Security details: Conversation keys checked. End-to-end encrypted' });
  expect(trigger.textContent).toBe('');
  expect(trigger.querySelectorAll('svg')).toHaveLength(1);
  expect(trigger.querySelector('.lucide-shield-check')).toBeInTheDocument();
  expect(trigger).toHaveAttribute('title', trigger.getAttribute('aria-label'));
  expect(trigger).toHaveAttribute('data-security-state', 'verified');
  fireEvent.click(trigger);
  const panel = screen.getByRole('dialog', { name: 'Conversation security details' });
  expect(panel).toHaveTextContent('End-to-end encrypted');
  expect(panel).toHaveTextContent('Conversation keys checked');
  expect(panel).toHaveTextContent('1234 5678');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(trigger).toHaveFocus();
});

test.each([
  ['pending', false, 'unverified', 'realtime', 'unverified', 'shield'],
  ['ready without explicit verification', true, undefined, 'realtime', 'unverified', 'shield'],
  ['incomplete verification with a verified hint', false, 'verified', 'realtime', 'unverified', 'shield'],
  ['ready with warning', true, 'warning', 'realtime', 'warning', 'shield-alert'],
  ['pending with warning', false, 'warning', 'realtime', 'warning', 'shield-alert'],
  ['ready with error', true, 'error', 'realtime', 'error', 'shield-x'],
  ['demo with a verified hint', true, 'verified', 'local-demo', 'unverified', 'shield'],
  ['ready and explicitly verified', true, 'verified', 'realtime', 'verified', 'shield-check'],
] as const)('%s never promotes an inaccurate verified checkmark', (_case, ready, state, transportMode, expected, icon) => {
  render(<ConversationHeader {...readyProps} type="direct" transportMode={transportMode} securityStatus={null}
    securePresentation={{ ready, ...(state ? { state } : {}), label: 'End-to-end encrypted', details: <p>Security information</p> }} />);
  const trigger = screen.getByRole('button', { name: /^Security details:/ });
  expect(trigger).toHaveAttribute('data-security-state', expected);
  expect(trigger.querySelector(`.lucide-${icon}`)).toBeInTheDocument();
  if (expected !== 'verified') expect(trigger.querySelector('.lucide-shield-check')).toBeNull();
});

test('unavailable browser encryption overrides a verified presentation hint', () => {
  render(<ConversationHeader {...readyProps} transportMode="realtime"
    securityStatus={{ browserCryptoAvailable: false, localEncryptionAvailable: false, recipientKeyAvailable: false, authenticatedKeyExchangeEstablished: false }}
    securePresentation={{ ready: true, state: 'verified', label: 'End-to-end encrypted', details: <p>Browser encryption unavailable</p> }} />);
  const trigger = screen.getByRole('button', { name: /^Security details: Security error/ });
  expect(trigger).toHaveAttribute('data-security-state', 'error');
  expect(trigger.querySelector('.lucide-shield-check')).toBeNull();
});

test('incomplete supplied recipient-key status cannot produce a verified checkmark', () => {
  render(<ConversationHeader {...readyProps} transportMode="realtime"
    securePresentation={{ ready: true, state: 'verified', label: 'End-to-end encrypted', details: <p>Security information</p> }} />);
  const trigger = screen.getByRole('button', { name: /^Security details: Verification incomplete/ });
  expect(trigger).toHaveAttribute('data-security-state', 'unverified');
  expect(trigger.querySelector('.lucide-shield-check')).toBeNull();
});

test.each(['online', 'offline'] as const)('direct chats omit redundant Connected while preserving %s contact presence', presence => {
  render(<ConversationHeader {...readyProps} name="Ava" type="direct" presence={presence} transportMode="realtime"
    securePresentation={{ ready: true, state: 'verified', label: 'End-to-end encrypted', details: null }} />);
  expect(screen.queryByText('Connected', { exact: true })).not.toBeInTheDocument();
  expect(screen.getByRole('status', { name: 'Contact presence' })).toHaveTextContent(presence === 'online' ? 'Online' : 'Offline');
});

test.each(['connecting', 'reconnecting', 'disconnected'] as const)('direct chats retain the %s transport warning', connectionStatus => {
  render(<ConversationHeader {...readyProps} type="direct" connectionStatus={connectionStatus} transportMode="realtime" />);
  expect(screen.getByText(connectionStatus === 'connecting' ? 'Connecting' : connectionStatus === 'reconnecting' ? 'Reconnecting…' : 'Offline')).toBeInTheDocument();
});

test('the demo label is preserved without a dangling separator when direct chat is connected', () => {
  const { container } = render(<ConversationHeader {...readyProps} type="direct" />);
  expect(container.querySelector('.conversation-connection')).toHaveTextContent('Local demo');
  expect(container.querySelector('.conversation-connection')).not.toHaveTextContent('·');
  expect(screen.queryByText('Connected', { exact: true })).not.toBeInTheDocument();
});
