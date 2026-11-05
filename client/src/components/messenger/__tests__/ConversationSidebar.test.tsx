import { fireEvent, render, screen } from '@testing-library/react';
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

  test('shows an understandable empty list state', () => {
    render(<ConversationSidebar conversations={[]} activeConversationId={null} mobileListOpen onSelect={jest.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('No conversations yet');
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
