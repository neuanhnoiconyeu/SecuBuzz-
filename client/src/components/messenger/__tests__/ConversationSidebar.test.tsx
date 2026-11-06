import { act, fireEvent, render, screen } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { ConversationSidebar } from '../ConversationSidebar';
import { MainNavigation } from '../MainNavigation';
import { createDemoConversations } from '@/conversations/demoConversations';

describe('ConversationSidebar', () => {
  test('marks the active conversation and unread count accessibly', () => {
    const conversations = createDemoConversations(1_700_000_000_000).map((conversation) =>
      conversation.id === 'demo-direct-ava' ? { ...conversation, unreadCount: 3 } : conversation
    );
    render(
      <ConversationSidebar
        conversations={conversations}
        activeConversationId="demo-direct-ava"
        mobileListOpen={false}
        onSelect={jest.fn()}
      />
    );

    const avaButton = screen.getByRole('button', { name: /Ava Morgan, Direct, 3 unread, Local demo/ });
    expect(avaButton).toHaveAttribute('aria-current', 'page');
    expect(avaButton).toHaveProperty('tabIndex', 0);
    expect(screen.getByLabelText('3 unread messages')).toBeInTheDocument();
  });

  test('conversation buttons select the requested conversation', () => {
    const onSelect = jest.fn();
    render(
      <ConversationSidebar
        conversations={createDemoConversations(1_700_000_000_000)}
        activeConversationId="securebot-demo"
        mobileListOpen
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Security Study Group, Group/ }));
    expect(onSelect).toHaveBeenCalledWith('demo-group-security');
  });

  test('updates unread feedback without replacing the focused row or clearing its search', () => {
    const conversations = createDemoConversations(1_700_000_000_000).map((conversation) =>
      conversation.id === 'demo-direct-ava' ? { ...conversation, unreadCount: 3 } : conversation
    );
    const props = { activeConversationId: 'securebot-demo', mobileListOpen: true, onSelect: jest.fn() };
    const { rerender } = render(<ConversationSidebar {...props} conversations={conversations} />);
    const search = screen.getByRole('searchbox', { name: 'Search conversations' });
    fireEvent.change(search, { target: { value: 'ava' } });
    const row = screen.getByRole('button', { name: /Ava Morgan, Direct, 3 unread/ });
    const badge = screen.getByLabelText('3 unread messages');
    const oldValue = badge.firstElementChild;
    row.focus();

    rerender(<ConversationSidebar {...props} conversations={conversations.map((conversation) =>
      conversation.id === 'demo-direct-ava' ? { ...conversation, unreadCount: 4 } : conversation
    )} />);

    expect(screen.getByRole('button', { name: /Ava Morgan, Direct, 4 unread/ })).toBe(row);
    expect(row).toHaveFocus();
    expect(search).toHaveValue('ava');
    expect(screen.getByLabelText('4 unread messages')).toBe(badge);
    expect(badge).toHaveTextContent('4');
    expect(badge.firstElementChild).not.toBe(oldValue);
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  test('keeps a capped unread value stable while exposing the updated full count', () => {
    const conversations = createDemoConversations(1_700_000_000_000).map((conversation) =>
      conversation.id === 'demo-direct-ava' ? { ...conversation, unreadCount: 100 } : conversation
    );
    const props = { activeConversationId: 'securebot-demo', mobileListOpen: true, onSelect: jest.fn() };
    const { rerender } = render(<ConversationSidebar {...props} conversations={conversations} />);
    const row = screen.getByRole('button', { name: /Ava Morgan, Direct, 100 unread/ });
    const badge = screen.getByLabelText('100 unread messages');
    const visibleValue = badge.firstElementChild;
    row.focus();

    rerender(<ConversationSidebar {...props} conversations={conversations.map((conversation) =>
      conversation.id === 'demo-direct-ava' ? { ...conversation, unreadCount: 101 } : conversation
    )} />);

    expect(screen.getByRole('button', { name: /Ava Morgan, Direct, 101 unread/ })).toBe(row);
    expect(row).toHaveFocus();
    expect(screen.getByLabelText('101 unread messages')).toBe(badge);
    expect(badge).toHaveTextContent('99+');
    expect(badge.firstElementChild).toBe(visibleValue);
  });

  test('shows an understandable empty list state', () => {
    render(<ConversationSidebar conversations={[]} activeConversationId={null} mobileListOpen onSelect={jest.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('No conversations yet');
  });

  test('hydrates differing demo clocks and locales without warnings, then displays the browser activity metadata', async () => {
    const serverSeed = Date.now() - 3 * 86_400_000;
    const serverConversations = createDemoConversations(serverSeed);
    const clientConversations = createDemoConversations(serverSeed + 90_000);
    const dateLabel = jest.spyOn(Date.prototype, 'toLocaleDateString').mockReturnValue('Server date');
    const dateTitle = jest.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('Server timestamp');
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const container = document.createElement('div');
    let root: Root | undefined;
    try {
      container.innerHTML = renderToString(<ConversationSidebar conversations={serverConversations} activeConversationId="securebot-demo" mobileListOpen onSelect={jest.fn()} />);
      const originalTimeNodes = Array.from(container.querySelectorAll('time'));
      expect(originalTimeNodes).toHaveLength(3);
      originalTimeNodes.forEach((time) => {
        expect(time).toHaveTextContent('—');
        expect(time).not.toHaveAttribute('datetime');
        expect(time).not.toHaveAttribute('title');
      });
      expect(dateLabel).not.toHaveBeenCalled();
      expect(dateTitle).not.toHaveBeenCalled();

      dateLabel.mockReturnValue('Browser date');
      dateTitle.mockReturnValue('Browser timestamp');
      document.body.appendChild(container);
      await act(async () => {
        root = hydrateRoot(container, <ConversationSidebar conversations={clientConversations} activeConversationId="securebot-demo" mobileListOpen onSelect={jest.fn()} />);
      });
      const hydratedTimeNodes = Array.from(container.querySelectorAll('time'));
      hydratedTimeNodes.forEach((time, index) => {
        expect(time).toBe(originalTimeNodes[index]);
        expect(time).toHaveTextContent('Browser date');
        expect(time).toHaveAttribute('datetime', clientConversations[index]!.lastActivityAt);
        expect(time).toHaveAttribute('title', 'Browser timestamp');
        expect(time).toHaveClass('conversation-activity-time');
      });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      act(() => root?.unmount());
      container.remove();
      dateLabel.mockRestore();
      dateTitle.mockRestore();
      errors.mockRestore();
    }
  });

  test('filters local conversations by trimmed names and type without changing the active selection', () => {
    const onSelect = jest.fn();
    render(<ConversationSidebar
      conversations={createDemoConversations(1_700_000_000_000)}
      activeConversationId="securebot-demo"
      mobileListOpen
      onSelect={onSelect}
    />);
    const search = screen.getByRole('searchbox', { name: 'Search conversations' });
    fireEvent.change(search, { target: { value: '  aVa  ' } });
    expect(screen.getByRole('button', { name: /Ava Morgan, Direct/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /SecureBot, Bot/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Security Study Group, Group/ })).not.toBeInTheDocument();
    expect(screen.getByText('1 result')).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.change(search, { target: { value: 'GROUP' } });
    fireEvent.click(screen.getByRole('button', { name: /Security Study Group, Group/ }));
    expect(onSelect).toHaveBeenCalledWith('demo-group-security');
  });

  test('distinguishes an unsuccessful search from an empty conversation collection and clears the filter', () => {
    render(<ConversationSidebar
      conversations={createDemoConversations(1_700_000_000_000)}
      activeConversationId="securebot-demo"
      mobileListOpen
      onSelect={jest.fn()}
    />);
    const search = screen.getByRole('searchbox', { name: 'Search conversations' });
    fireEvent.change(search, { target: { value: 'Nobody matches' } });
    expect(screen.getByRole('status')).toHaveTextContent('No matching conversations');
    expect(screen.queryByText('No conversations yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(screen.getByRole('button', { name: /SecureBot, Bot/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('3 conversations')).toBeInTheDocument();
  });

  test('retains the search when hidden and provides keyboard and button clearing', () => {
    const props = {
      conversations: createDemoConversations(1_700_000_000_000),
      activeConversationId: 'securebot-demo',
      mobileListOpen: true,
      onSelect: jest.fn(),
    };
    const { rerender } = render(<div hidden={false}><ConversationSidebar {...props} /></div>);
    const search = screen.getByRole('searchbox', { name: 'Search conversations' });
    fireEvent.change(search, { target: { value: 'ava' } });
    rerender(<div hidden><ConversationSidebar {...props} mobileListOpen={false} /></div>);
    rerender(<div hidden={false}><ConversationSidebar {...props} /></div>);
    expect(screen.getByRole('searchbox', { name: 'Search conversations' })).toHaveValue('ava');
    expect(screen.getByRole('button', { name: /Ava Morgan, Direct/ })).toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
    expect(screen.getByRole('button', { name: /Security Study Group, Group/ })).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'bot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear conversation search' }));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
  });
});

describe('MainNavigation', () => {
  test('exposes labeled destinations and selected state', () => {
    const onSelect = jest.fn();
    render(<MainNavigation activeSection="chats" onSelect={onSelect} />);
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chats' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: 'Security' }));
    expect(onSelect).toHaveBeenCalledWith('security');
  });
});
