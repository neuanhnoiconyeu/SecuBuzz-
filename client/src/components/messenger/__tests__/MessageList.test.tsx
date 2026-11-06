import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { MessageList } from '../MessageList';
import type { ChatMessage } from '@/messaging/messageModel';

const makeMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'message-1',
  conversationId: 'conversation-a',
  senderId: 'securebot',
  senderName: 'SecureBot',
  content: 'Hello from the bot',
  timestamp: '2026-01-01T12:00:00.000Z',
  type: 'text',
  deliveryStatus: 'delivered',
  ...overrides,
});

describe('MessageList entry motion', () => {
  let originalMatchMedia: PropertyDescriptor | undefined;
  let reducedMotion: boolean;
  let mediaListeners: Set<(event: MediaQueryListEvent) => void>;

  beforeEach(() => {
    jest.useFakeTimers();
    originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    reducedMotion = false;
    mediaListeners = new Set();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn(() => ({
        get matches() { return reducedMotion; },
        media: '(prefers-reduced-motion: reduce)',
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.add(listener),
        removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.delete(listener),
      })),
    });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    else Reflect.deleteProperty(window, 'matchMedia');
  });

  const changeReducedMotion = (matches: boolean) => {
    reducedMotion = matches;
    act(() => mediaListeners.forEach((listener) => listener({ matches } as MediaQueryListEvent)));
  };

  test('shows initial history immediately without motion, then animates each appended text batch once', () => {
    const first = makeMessage();
    const { container, rerender } = render(<MessageList messages={[first]} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    expect(screen.getByText(first.content)).toBeInTheDocument();
    expect(container.querySelector('[data-message-enter]')).not.toBeInTheDocument();

    const incoming = makeMessage({ id: 'new-incoming', content: 'Incoming now' });
    const outgoing = makeMessage({ id: 'new-outgoing', senderId: 'local-user', content: 'Outgoing now', deliveryStatus: 'sending' });
    rerender(<MessageList messages={[first, incoming, outgoing]} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    expect(screen.getByText('Incoming now')).toBeInTheDocument();
    expect(screen.getByText('Outgoing now')).toBeInTheDocument();
    const incomingRow = container.querySelector('[data-message-id="new-incoming"]')!;
    const outgoingRow = container.querySelector('[data-message-id="new-outgoing"]')!;
    expect(incomingRow).toHaveAttribute('data-message-enter', 'true');
    expect(outgoingRow).toHaveAttribute('data-message-enter', 'true');
    expect(jest.getTimerCount()).toBe(1);

    // A child animation cannot end the row's entrance early.
    fireEvent.animationEnd(incomingRow.querySelector('.message-bubble')!);
    expect(incomingRow).toHaveAttribute('data-message-enter', 'true');
    fireEvent.animationEnd(incomingRow);
    expect(incomingRow).not.toHaveAttribute('data-message-enter');
    expect(outgoingRow).toHaveAttribute('data-message-enter', 'true');
    act(() => jest.advanceTimersByTime(300));
    expect(outgoingRow).not.toHaveAttribute('data-message-enter');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('does not replay for delivery changes, retry, identity labels or a previously seen message ID', () => {
    const first = makeMessage();
    const pending = makeMessage({ id: 'retry-id', senderId: 'local-user', content: 'Keep the same envelope', deliveryStatus: 'failed' });
    const onRetry = jest.fn();
    const { container, rerender } = render(<MessageList messages={[first]} currentUserId="local-user" onRetryMessage={onRetry} />);
    rerender(<MessageList messages={[first, pending]} currentUserId="local-user" onRetryMessage={onRetry} />);
    act(() => jest.advanceTimersByTime(300));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledWith('retry-id');

    rerender(<MessageList messages={[first, { ...pending, deliveryStatus: 'sent' }]} currentUserId="local-user" currentUserName="New Name" onRetryMessage={onRetry} />);
    expect(screen.getByText('New Name (You)')).toBeInTheDocument();
    expect(container.querySelector('[data-message-enter]')).not.toBeInTheDocument();
    rerender(<MessageList messages={[first]} currentUserId="local-user" onRetryMessage={onRetry} />);
    rerender(<MessageList messages={[first, pending]} currentUserId="local-user" onRetryMessage={onRetry} />);
    expect(container.querySelector('[data-message-enter]')).not.toBeInTheDocument();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('consumes prepended history and notices without motion and never replays history across conversation remounts', () => {
    const current = makeMessage();
    const older = makeMessage({ id: 'older', content: 'Historical message' });
    const notice = makeMessage({ id: 'notice', type: 'system', content: 'Local notice' });
    const alert = makeMessage({ id: 'alert', type: 'security_alert', content: 'Local warning' });
    const { container, rerender } = render(<MessageList key="a" messages={[current]} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    rerender(<MessageList key="a" messages={[older, current, notice, alert]} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    expect(container.querySelector('[data-message-enter]')).not.toBeInTheDocument();
    const next = makeMessage({ id: 'next', content: 'New active message' });
    rerender(<MessageList key="a" messages={[older, current, notice, alert, next]} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    expect(container.querySelector('[data-message-id="next"]')).toHaveAttribute('data-message-enter', 'true');
    rerender(<MessageList key="b" messages={[makeMessage({ id: 'b-message', conversationId: 'conversation-b' })]} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    expect(container.querySelector('[data-message-enter]')).not.toBeInTheDocument();
    expect(jest.getTimerCount()).toBe(0);
    rerender(<MessageList key="a" messages={[older, current, next]} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    expect(container.querySelector('[data-message-enter]')).not.toBeInTheDocument();
  });

  test('suppresses hidden arrivals and cancels an ongoing entrance when the conversation UI is hidden', () => {
    const first = makeMessage();
    const second = makeMessage({ id: 'hidden', content: 'Arrived offscreen' });
    const third = makeMessage({ id: 'active', content: 'Arrived in active chat' });
    const { container, rerender } = render(<MessageList messages={[first]} active={false} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    rerender(<MessageList messages={[first, second]} active={false} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    rerender(<MessageList messages={[first, second]} active currentUserId="local-user" onRetryMessage={jest.fn()} />);
    expect(screen.getByText(second.content)).toBeInTheDocument();
    expect(container.querySelector('[data-message-enter]')).not.toBeInTheDocument();
    rerender(<MessageList messages={[first, second, third]} active currentUserId="local-user" onRetryMessage={jest.fn()} />);
    expect(container.querySelector('[data-message-id="active"]')).toHaveAttribute('data-message-enter', 'true');
    rerender(<MessageList messages={[first, second, third]} active={false} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    expect(container.querySelector('[data-message-enter]')).not.toBeInTheDocument();
    expect(jest.getTimerCount()).toBe(0);
    rerender(<MessageList messages={[first, second, third]} active currentUserId="local-user" onRetryMessage={jest.fn()} />);
    expect(container.querySelector('[data-message-enter]')).not.toBeInTheDocument();
  });

  test('cleans overlapping append batches independently and never replays a removed and restored identity', () => {
    const first = makeMessage();
    const second = makeMessage({ id: 'batch-one', content: 'First batch' });
    const third = makeMessage({ id: 'batch-two', content: 'Second batch' });
    const { container, rerender, unmount } = render(<MessageList messages={[first]} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    rerender(<MessageList messages={[first, second]} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    act(() => jest.advanceTimersByTime(100));
    rerender(<MessageList messages={[first, second, third]} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    expect(jest.getTimerCount()).toBe(2);
    act(() => jest.advanceTimersByTime(200));
    expect(container.querySelector('[data-message-id="batch-one"]')).not.toHaveAttribute('data-message-enter');
    expect(container.querySelector('[data-message-id="batch-two"]')).toHaveAttribute('data-message-enter', 'true');

    rerender(<MessageList messages={[first, second]} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    rerender(<MessageList messages={[first, second, third]} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    expect(container.querySelector('[data-message-enter]')).not.toBeInTheDocument();
    expect(jest.getTimerCount()).toBe(0);
    rerender(<MessageList messages={[first, second, third, makeMessage({ id: 'last', content: 'Before unmount' })]} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    expect(jest.getTimerCount()).toBe(1);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
    expect(mediaListeners.size).toBe(0);
  });

  test('honors initial reduced motion and preference changes without deferring entrances or leaking timers', () => {
    reducedMotion = true;
    const first = makeMessage();
    const second = makeMessage({ id: 'reduced', content: 'No motion requested' });
    const third = makeMessage({ id: 'motion', content: 'Motion enabled now' });
    const fourth = makeMessage({ id: 'reduced-again', content: 'Suppressed again' });
    const { container, rerender, unmount } = render(<MessageList messages={[first]} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    rerender(<MessageList messages={[first, second]} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    expect(container.querySelector('[data-message-enter]')).not.toBeInTheDocument();
    changeReducedMotion(false);
    rerender(<MessageList messages={[first, second]} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    expect(container.querySelector('[data-message-enter]')).not.toBeInTheDocument();
    rerender(<MessageList messages={[first, second, third]} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    expect(container.querySelector('[data-message-id="motion"]')).toHaveAttribute('data-message-enter', 'true');
    changeReducedMotion(true);
    expect(container.querySelector('[data-message-enter]')).not.toBeInTheDocument();
    expect(jest.getTimerCount()).toBe(0);
    rerender(<MessageList messages={[first, second, third, fourth]} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    changeReducedMotion(false);
    rerender(<MessageList messages={[first, second, third, fourth]} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    expect(container.querySelector('[data-message-enter]')).not.toBeInTheDocument();
    expect(jest.getTimerCount()).toBe(0);
    unmount();
    expect(mediaListeners.size).toBe(0);
  });
});

describe('MessageList', () => {
  test('uses a full-width flex parent and content-sized bubble with safe wrapping', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');
    const stylesheet = postcss.parse(source);
    const declarationsFor = (selector: string) => {
      const declarations: Record<string, string> = {};
      stylesheet.walkRules(selector, (rule) => {
        rule.walkDecls((declaration) => {
          declarations[declaration.prop] = declaration.value;
        });
      });
      return declarations;
    };
    const row = declarationsFor('.message-content-row');
    const bubble = declarationsFor('.message-bubble');

    expect(row).toMatchObject({ display: 'flex', width: '100%', 'min-width': '0' });
    expect(bubble).toMatchObject({
      width: 'fit-content',
      'max-width': 'min(72%, 38rem)',
      'min-width': '0',
      'white-space': 'pre-wrap',
      'overflow-wrap': 'anywhere',
      'word-break': 'normal',
    });
  });

  test('renders sender, timestamp, and encrypted state only when metadata exists', () => {
    const incoming = makeMessage();
    const outgoing = makeMessage({
      id: 'message-2',
      senderId: 'local-user',
      senderName: 'You',
      content: 'An encrypted reply',
      deliveryStatus: 'sent',
      encryption: {
        version: 1,
        algorithm: 'AES-256-GCM',
        encoding: 'base64',
        iv: 'iv',
        ciphertext: 'ciphertext',
        scope: 'browser-demo',
      },
    });
    const { container } = render(
      <MessageList messages={[incoming, outgoing]} currentUserId="local-user" onRetryMessage={jest.fn()} />
    );

    expect(screen.getByText('SecureBot')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('Hello from the bot')).toBeInTheDocument();
    expect(screen.getByText('An encrypted reply')).toBeInTheDocument();
    expect(screen.getByText('Encrypted locally')).toBeInTheDocument();
    expect(screen.getByText('Accepted by local demo')).toBeInTheDocument();
    expect(container.querySelectorAll('time')).toHaveLength(2);
  });

  test('renders system and security alert messages with distinct semantics', () => {
    const system = makeMessage({
      id: 'system-1',
      senderId: 'system',
      senderName: 'System',
      type: 'system',
      content: 'Secure channel initialized in this browser.',
    });
    const alert = makeMessage({
      id: 'alert-1',
      senderId: 'security',
      senderName: 'Security notice',
      type: 'security_alert',
      content: 'A demo security event was received.',
    });
    render(<MessageList messages={[system, alert]} currentUserId="local-user" onRetryMessage={jest.fn()} />);

    expect(screen.getByRole('note')).toHaveTextContent('Secure channel initialized in this browser.');
    expect(screen.getByRole('alert')).toHaveTextContent('A demo security event was received.');
    expect(screen.queryByText('You')).not.toBeInTheDocument();
  });

  test('shows an empty state without inserting placeholder messages', () => {
    render(<MessageList messages={[]} currentUserId="local-user" onRetryMessage={jest.fn()} />);
    expect(screen.getByText('No messages yet')).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  test('offers a jump-to-latest control when new messages arrive while scrolled up', () => {
    const first = makeMessage();
    const second = makeMessage({ id: 'message-2', content: 'Second' });
    const { rerender } = render(
      <MessageList messages={[first, second]} currentUserId="local-user" onRetryMessage={jest.fn()} />
    );
    const history = screen.getByRole('log');
    Object.defineProperty(history, 'scrollHeight', { configurable: true, value: 600 });
    Object.defineProperty(history, 'clientHeight', { configurable: true, value: 200 });
    history.scrollTop = 0;
    fireEvent.scroll(history);

    rerender(
      <MessageList
        messages={[first, second, makeMessage({ id: 'message-3', content: 'New message' })]}
        currentUserId="local-user"
        onRetryMessage={jest.fn()}
      />
    );

    expect(history.scrollTop).toBe(0);
    const jumpButton = screen.getByRole('button', { name: '1 new message — latest' });
    fireEvent.click(jumpButton);
    expect(history.scrollTop).toBeGreaterThanOrEqual(400);
    expect(screen.queryByRole('button', { name: '1 new message — latest' })).not.toBeInTheDocument();
  });

  test('initial conversation load starts at the latest message', () => {
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 900 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 300 });

    try {
      render(
        <MessageList
          messages={[
            makeMessage(),
            makeMessage({ id: 'initial-2', content: 'Older message' }),
            makeMessage({ id: 'initial-3', content: 'Latest message' }),
          ]}
          currentUserId="local-user"
          onRetryMessage={jest.fn()}
        />
      );

      expect(screen.getByRole('log').scrollTop).toBeGreaterThanOrEqual(600);
      expect(screen.getByText('Latest message')).toBeInTheDocument();
    } finally {
      if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
      if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
    }
  });

  test('follows new messages only while the reader is near the bottom', () => {
    const first = makeMessage();
    const { rerender } = render(
      <MessageList messages={[first]} currentUserId="local-user" onRetryMessage={jest.fn()} />
    );
    const history = screen.getByRole('log');
    Object.defineProperty(history, 'scrollHeight', { configurable: true, value: 600 });
    Object.defineProperty(history, 'clientHeight', { configurable: true, value: 200 });
    history.scrollTop = 390;
    fireEvent.scroll(history);

    rerender(
      <MessageList
        messages={[first, makeMessage({ id: 'message-2', content: 'Follow me' })]}
        currentUserId="local-user"
        onRetryMessage={jest.fn()}
      />
    );

    expect(history.scrollTop).toBe(600);
    expect(screen.queryByRole('button', { name: /new message/ })).not.toBeInTheDocument();
  });

  test('groups nearby consecutive messages from the same sender', () => {
    const first = makeMessage();
    const second = makeMessage({
      id: 'message-2',
      content: 'A second bubble',
      timestamp: '2026-01-01T12:01:00.000Z',
    });
    const { container } = render(
      <MessageList messages={[first, second]} currentUserId="local-user" onRetryMessage={jest.fn()} />
    );

    expect(container.querySelectorAll('.message-row')).toHaveLength(2);
    expect(container.querySelectorAll('.message-row-grouped')).toHaveLength(1);
    expect(screen.getAllByText('SecureBot')).toHaveLength(1);
  });

  test.each([
    ['short greeting', 'hi'],
    ['short word', 'hello'],
    ['welcome sentence', 'Hello! Welcome to Yahoo Messenger.'],
    ['long paragraph', 'This is a longer paragraph with normal word boundaries. '.repeat(18)],
    ['intentional newlines', 'First line\nSecond line\n\nFourth line'],
    ['long URL', 'https://example.test/a-very-long-path-without-natural-breaks/'.repeat(3)],
    ['unbroken string', 'S'.repeat(220)],
  ])('preserves %s content in naturally sized incoming and outgoing bubbles', (_name, content) => {
    const incomingId = 'incoming-wrap-case';
    const outgoingId = 'outgoing-wrap-case';
    const { container } = render(
      <MessageList
        messages={[
          makeMessage({ id: incomingId, content }),
          makeMessage({ id: outgoingId, senderId: 'local-user', senderName: 'You', content }),
        ]}
        currentUserId="local-user"
        onRetryMessage={jest.fn()}
      />
    );

    const incomingRow = container.querySelector(`[data-message-id="${incomingId}"]`);
    const outgoingRow = container.querySelector(`[data-message-id="${outgoingId}"]`);
    const incomingBubble = incomingRow?.querySelector('.message-bubble');
    const outgoingBubble = outgoingRow?.querySelector('.message-bubble');

    expect(incomingBubble?.textContent).toBe(content);
    expect(outgoingBubble?.textContent).toBe(content);
    expect(incomingBubble).toHaveClass('message-bubble');
    expect(outgoingBubble).toHaveClass('message-bubble');
    expect(outgoingRow).toHaveClass('message-row-outgoing');
  });

  test('provides a retry action for failed outgoing messages', () => {
    const onRetryMessage = jest.fn();
    render(
      <MessageList
        messages={[makeMessage({ senderId: 'local-user', senderName: 'You', deliveryStatus: 'failed' })]}
        currentUserId="local-user"
        onRetryMessage={onRetryMessage}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetryMessage).toHaveBeenCalledWith('message-1');
    expect(screen.getByText('Not sent')).toBeInTheDocument();
  });
});
