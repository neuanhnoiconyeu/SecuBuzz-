import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FriendsPage } from '../FriendsPage';
import type { FriendsController } from '@/hooks/useFriends';
import type { UserSearchResult } from '@/friends/friendsModel';
import { ApiError } from '@/api/sessionApi';

const alice = { id: 'alice-id', username: 'alice', displayName: 'Alice', avatar: 'cat' } as const;
const bob: UserSearchResult = { id: 'bob-id', username: 'bob', displayName: 'Cached Bob', avatar: 'star', relationship: 'friend' };
const controller: FriendsController = { mode: 'remote', snapshot: { friends: [bob], blockedUsers: [], incomingRequests: [], outgoingRequests: [] },
  isLoading: false, isPending: false, isStale: false, error: null, notice: '', query: '', searchResults: [], searchLoading: false, searchError: null, hasSearched: false,
  setQuery: jest.fn(), refresh: jest.fn(), perform: jest.fn(), };
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
});
function renderPage(loader: (id: string, signal: AbortSignal) => Promise<UserSearchResult>) {
  return render(<FriendsPage controller={controller} currentUser={alice} canMessage={() => false} onMessage={jest.fn()} loadPublicProfile={loader} />);
}
test('public profile waits for GET and displays fresh fields rather than the cached list projection', async () => {
  let resolve!: (user: UserSearchResult) => void;
  const loader = jest.fn(() => new Promise<UserSearchResult>(done => { resolve = done; })); renderPage(loader);
  fireEvent.click(screen.getByRole('button', { name: 'View profile for Cached Bob' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Public profile' }));
  expect(dialog.getByText('Loading public profile…')).toBeInTheDocument(); expect(dialog.queryByText('Cached Bob')).not.toBeInTheDocument();
  await act(async () => resolve({ ...bob, displayName: 'Fresh Bob' }));
  expect(dialog.getByRole('heading', { name: 'Fresh Bob' })).toBeInTheDocument(); expect(loader).toHaveBeenCalledWith(bob.id, expect.any(AbortSignal));
});
test('404 suppresses cached profile content and relationship actions and offers retry', async () => {
  const loader = jest.fn().mockRejectedValueOnce(new ApiError('not_found')).mockResolvedValueOnce({ ...bob, displayName: 'Fresh Bob' }); renderPage(loader);
  fireEvent.click(screen.getByRole('button', { name: 'View profile for Cached Bob' })); const dialog = within(screen.getByRole('dialog', { name: 'Public profile' }));
  await waitFor(() => expect(dialog.getByRole('alert')).toHaveTextContent('no longer available'));
  expect(dialog.queryByText('@bob')).not.toBeInTheDocument(); expect(dialog.queryByRole('button', { name: /More actions/ })).not.toBeInTheDocument();
  fireEvent.click(dialog.getByRole('button', { name: 'Try public profile again' })); expect(await dialog.findByRole('heading', { name: 'Fresh Bob' })).toBeInTheDocument();
});
test('closing aborts and ignores a late public profile, including after unmount', async () => {
  let resolve!: (user: UserSearchResult) => void;
  const loader = jest.fn((_id: string, _signal: AbortSignal) => new Promise<UserSearchResult>(done => { resolve = done; })); const view = renderPage(loader);
  fireEvent.click(screen.getByRole('button', { name: 'View profile for Cached Bob' }));
  const signal = loader.mock.calls[0]?.[1]; fireEvent.click(screen.getByRole('button', { name: 'Close public profile' }));
  expect(signal?.aborted).toBe(true); view.unmount(); await act(async () => resolve({ ...bob, displayName: 'Late Bob' }));
  expect(screen.queryByText('Late Bob')).not.toBeInTheDocument();
});
