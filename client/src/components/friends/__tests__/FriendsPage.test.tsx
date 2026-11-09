import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FriendsPage } from '../FriendsPage';
import { useFriends } from '@/hooks/useFriends';
import { LocalDemoFriendsService } from '@/friends/friendsService';
import { createDemoProfile } from '@/profiles/profileModel';
import type { FriendUser } from '@/friends/friendsModel';

const currentUser: FriendUser = {
  id: createDemoProfile().id, username: createDemoProfile().username,
  displayName: createDemoProfile().displayName, avatar: 'initials',
};
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true, value: function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true, value: function close(this: HTMLDialogElement) { this.removeAttribute('open'); },
  });
});

afterAll(() => {
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});

function Harness({ service, onMessage = async () => undefined }: {
  service: LocalDemoFriendsService; onMessage?: (user: FriendUser) => Promise<void>;
}) {
  const controller = useFriends(service);
  return <FriendsPage controller={controller} currentUser={currentUser} onMessage={onMessage}
    canMessage={(userId) => userId === 'demo-ava'} />;
}

async function ready(service = new LocalDemoFriendsService(), onMessage?: (user: FriendUser) => Promise<void>) {
  render(<Harness service={service} {...(onMessage ? { onMessage } : {})} />);
  await screen.findByRole('list', { name: 'Your friends' });
  return service;
}

function tab(name: RegExp | string) {
  fireEvent.click(screen.getByRole('tab', { name }));
}

async function search(username: string) {
  tab('Find Friends');
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search by username' }), { target: { value: username } });
  return screen.findByRole('list', { name: 'User search results' });
}

describe('FriendsPage', () => {
  test('shows only public demo fields, neutral presence, friend filtering, and empty results', async () => {
    await ready();
    expect(screen.getByRole('heading', { name: 'Friends' })).toHaveClass('display-heading');
    expect(screen.getByText(/People and requests are fictional/)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Your friends' })).getByText('Presence unknown')).toBeInTheDocument();
    expect(screen.queryByText('Online')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search your friends' }), { target: { value: 'not-present' } });
    expect(screen.getByRole('heading', { name: 'No matching friends' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search your friends' }), { target: { value: '@ava' } });
    expect(screen.getByRole('button', { name: 'Message Ava Morgan' })).toBeEnabled();
    tab('Find Friends');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search by username' }), { target: { value: 'unknown-user' } });
    expect(await screen.findByRole('heading', { name: 'No matching users' })).toBeInTheDocument();
  });

  test('tabs support roving focus, arrow keys, Home, End, and proper panel associations', async () => {
    await ready();
    const all = screen.getByRole('tab', { name: /^All Friends/ });
    all.focus();
    fireEvent.keyDown(all, { key: 'ArrowRight' });
    const pending = screen.getByRole('tab', { name: /^Pending Requests/ });
    expect(pending).toHaveFocus();
    expect(pending).toHaveAttribute('aria-selected', 'true');
    expect(all).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', pending.id);
    fireEvent.keyDown(pending, { key: 'End' });
    const blocked = screen.getByRole('tab', { name: /^Blocked Users/ });
    expect(blocked).toHaveFocus();
    fireEvent.keyDown(blocked, { key: 'ArrowRight' });
    expect(all).toHaveFocus();
    fireEvent.keyDown(all, { key: 'ArrowLeft' });
    expect(blocked).toHaveFocus();
    fireEvent.keyDown(blocked, { key: 'Home' });
    expect(all).toHaveFocus();
  });

  test('self search cannot send a request; discovery sends once and synchronizes outgoing requests', async () => {
    const service = await ready();
    const send = jest.spyOn(service, 'sendRequest');
    const self = within(await search(currentUser.username));
    expect(self.getByText('This is you')).toBeInTheDocument();
    expect(self.queryByRole('button', { name: /Add .* as a friend/ })).not.toBeInTheDocument();
    const mina = within(await search('mina.patel'));
    fireEvent.click(mina.getByRole('button', { name: 'Add Mina Patel as a friend' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel request to Mina Patel' })).toBeInTheDocument());
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Add Mina Patel as a friend' })).not.toBeInTheDocument();
    tab(/^Pending Requests/);
    expect(within(screen.getByRole('list', { name: 'Outgoing requests' })).getByText('Mina Patel')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Pending Requests 3 total/ })).toBeInTheDocument();
  });

  test('accepting from a public profile updates its relationship and friends without inventing a DM', async () => {
    await ready();
    tab(/^Pending Requests/);
    fireEvent.click(screen.getByRole('button', { name: 'View profile for Jules Park' }));
    const profile = within(screen.getByRole('dialog', { name: 'Public profile' }));
    expect(profile.getByText('Incoming request')).toBeInTheDocument();
    fireEvent.click(profile.getByRole('button', { name: 'Accept request from Jules Park' }));
    await waitFor(() => expect(profile.getByText('Friends')).toBeInTheDocument());
    expect(profile.getByRole('button', { name: 'Message Jules Park' })).toBeDisabled();
    expect(profile.getByText(/Creating a conversation is not available yet/)).toBeInTheDocument();
    fireEvent.click(profile.getByRole('button', { name: 'Close public profile' }));
    tab(/^All Friends/);
    expect(within(screen.getByRole('list', { name: 'Your friends' })).getByText('Jules Park')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Pending Requests 1 total/ })).toBeInTheDocument();
  });

  test('declining and canceling remove pending requests and expose discovery actions again', async () => {
    await ready();
    tab(/^Pending Requests/);
    fireEvent.click(screen.getByRole('button', { name: 'Decline request from Jules Park' }));
    await screen.findByText('No incoming requests right now.');
    expect(screen.queryByRole('button', { name: 'Accept request from Jules Park' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request to Kai Chen' }));
    await screen.findByText('You have no pending sent requests.');
    const results = within(await search('kai.chen'));
    expect(results.getByRole('button', { name: 'Add Kai Chen as a friend' })).toBeEnabled();
  });

  test('remove is confirmed, cancel is safe, and a successful removal updates the list', async () => {
    const service = await ready();
    const remove = jest.spyOn(service, 'removeFriend');
    const trigger = screen.getByRole('button', { name: 'More actions for Ava Morgan' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove friend' }));
    let dialog = within(screen.getByRole('dialog', { name: 'Remove friend?' }));
    expect(dialog.getByText(/Existing chat history and shared files will stay/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Message Ava Morgan' })).toBeInTheDocument();
    const frames: FrameRequestCallback[] = [];
    const frame = jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const allTab = screen.getByRole('tab', { name: /^All Friends/ });
    const focus = jest.spyOn(allTab, 'focus');
    try {
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole('menuitem', { name: 'Remove friend' }));
      dialog = within(screen.getByRole('dialog', { name: 'Remove friend?' }));
      fireEvent.click(dialog.getByRole('button', { name: 'Remove friend' }));
      await screen.findByRole('heading', { name: 'Make your first connection' });
      expect(remove).toHaveBeenCalledWith('demo-ava');
      expect(screen.queryByRole('dialog', { name: 'Remove friend?' })).not.toBeInTheDocument();
      expect(focus).not.toHaveBeenCalled();
      act(() => frames.forEach((callback) => callback(0)));
      expect(allTab).toHaveFocus();
    } finally {
      frame.mockRestore();
      focus.mockRestore();
    }
  });

  test('confirmation success returns focus inside a public profile that remains open', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'View profile for Ava Morgan' }));
    const profile = screen.getByRole('dialog', { name: 'Public profile' });
    fireEvent.click(within(profile).getByRole('button', { name: 'More actions for Ava Morgan' }));
    fireEvent.click(within(profile).getByRole('menuitem', { name: 'Block user' }));
    const confirmation = within(screen.getByRole('dialog', { name: 'Block user?' }));
    fireEvent.click(confirmation.getByRole('button', { name: 'Block user' }));
    await waitFor(() => expect(within(profile).getByText('Blocked')).toBeInTheDocument());
    await waitFor(() => expect(within(profile).getByRole('button', { name: 'Close public profile' })).toHaveFocus());
    expect(profile).toHaveAttribute('open');
    expect(screen.queryByRole('dialog', { name: 'Block user?' })).not.toBeInTheDocument();
  });

  test('blocking removes friend actions and unblocking leaves the user unfriended', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Ava Morgan' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Block user' }));
    const confirm = within(screen.getByRole('dialog', { name: 'Block user?' }));
    expect(confirm.getByText(/does not enforce server messaging permissions/)).toBeInTheDocument();
    fireEvent.click(confirm.getByRole('button', { name: 'Block user' }));
    await screen.findByRole('heading', { name: 'Make your first connection' });
    tab(/^Blocked Users/);
    expect(screen.getByRole('button', { name: 'Unblock Ava Morgan' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Unblock Ava Morgan' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Unblock Ava Morgan' })).not.toBeInTheDocument());
    expect(within(await search('ava.morgan')).getByRole('button', { name: 'Add Ava Morgan as a friend' })).toBeEnabled();
  });

  test('API failure never shows success or a raw error and retains the confirmed relationship', async () => {
    const service = await ready();
    jest.spyOn(service, 'sendRequest').mockRejectedValue(new Error('PRIVATE backend token secret-account'));
    const results = within(await search('mina.patel'));
    fireEvent.click(results.getByRole('button', { name: 'Add Mina Patel as a friend' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The action could not be confirmed. Refresh Friends before trying again.'));
    expect(screen.queryByText('Friend request sent.')).not.toBeInTheDocument();
    expect(screen.queryByText(/PRIVATE backend token/)).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Add Mina Patel as a friend' })).toBeEnabled();
    expect(screen.getByRole('tab', { name: /^Pending Requests 2 total/ })).toBeInTheDocument();
  });

  test('Message uses the supplied conversation adapter and handles failure without replacing chat', async () => {
    const open = jest.fn<Promise<void>, [FriendUser]>().mockRejectedValue(new Error('internal connection state'));
    await ready(new LocalDemoFriendsService(), open);
    fireEvent.click(screen.getByRole('button', { name: 'Message Ava Morgan' }));
    await screen.findByText('This conversation could not be opened. Please try again.');
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'demo-ava' }));
    expect(screen.queryByText('internal connection state')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Message Ava Morgan' })).toBeEnabled();
  });

  test('load failures offer retry and never populate fictional data as a fallback', async () => {
    const service = new LocalDemoFriendsService();
    jest.spyOn(service, 'getSnapshot').mockRejectedValueOnce(new Error('unauthorized remote detail'));
    render(<Harness service={service} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Friends could not be refreshed. Try again before making changes.'));
    expect(screen.queryByRole('list', { name: 'Your friends' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Your friends' })).toBeInTheDocument();
    expect(screen.queryByText('unauthorized remote detail')).not.toBeInTheDocument();
  });

  test('search errors offer an explicit retry for the same query without a mock fallback', async () => {
    const service = await ready();
    const searchUsers = jest.spyOn(service, 'searchUsers').mockRejectedValueOnce(new Error('private search detail'));
    tab('Find Friends');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search by username' }), { target: { value: 'mina.patel' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Search is unavailable. Try again.');
    expect(screen.queryByRole('list', { name: 'User search results' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry username search' }));
    expect(await screen.findByRole('button', { name: 'Add Mina Patel as a friend' })).toBeEnabled();
    expect(screen.getByRole('searchbox', { name: 'Search by username' })).toHaveValue('mina.patel');
    expect(searchUsers).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('private search detail')).not.toBeInTheDocument();
  });
});
