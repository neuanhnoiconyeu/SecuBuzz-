'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Ban, Check, MessageCircle, Search, UserPlus, Users, X } from 'lucide-react';
import { Button, Dialog, DropdownMenu, TextInput } from '@/components/ui';
import { ProfileAvatar } from '@/components/profile/ProfileAvatar';
import { relationshipForUser } from '@/friends/friendsModel';
import type { FriendUser, RelationshipStatus, UserSearchResult } from '@/friends/friendsModel';
import type { FriendAction, FriendsController } from '@/hooks/useFriends';

export interface FriendsPageProps {
  controller: FriendsController;
  currentUser: FriendUser | null;
  onMessage(user: FriendUser): Promise<void>;
  canMessage(userId: string): boolean;
}

type FriendsTab = 'all' | 'pending' | 'find' | 'blocked';
type Confirmation = { type: 'remove' | 'block'; user: FriendUser };

const tabLabels: Record<FriendsTab, string> = {
  all: 'All Friends', pending: 'Pending Requests', find: 'Find Friends', blocked: 'Blocked Users',
};
const tabs: FriendsTab[] = ['all', 'pending', 'find', 'blocked'];
const relationshipLabels: Record<RelationshipStatus, string> = {
  self: 'This is you', none: 'Not friends', friend: 'Friends', incoming: 'Incoming request',
  outgoing: 'Request sent', blocked: 'Blocked',
};
const presenceLabels = { online: 'Online', away: 'Away', offline: 'Offline', busy: 'Busy' };

function EmptyState({ children, heading, icon = <Users size={25} aria-hidden="true" /> }: {
  heading: string; children: ReactNode; icon?: ReactNode;
}) {
  return (
    <div className="friends-empty">
      <span className="friends-empty-icon">{icon}</span>
      <h3 className="friends-empty-heading display-heading display-heading--empty">{heading}</h3>
      <p className="friends-empty-copy">{children}</p>
    </div>
  );
}

export function FriendsPage({ canMessage, controller, currentUser, onMessage }: FriendsPageProps) {
  const { snapshot, isLoading, isPending, isStale, mode } = controller;
  const [activeTab, setActiveTab] = useState<FriendsTab>('all');
  const [friendFilter, setFriendFilter] = useState('');
  const [selectedProfile, setSelectedProfile] = useState<FriendUser | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [messageError, setMessageError] = useState('');
  const [messagePending, setMessagePending] = useState(false);
  const messageLock = useRef(false);
  const profileOpener = useRef<HTMLButtonElement | null>(null);
  const profileFocusPending = useRef<{ userId: string | undefined; opener: HTMLButtonElement | null } | null>(null);
  const confirmationFocusPending = useRef(false);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Partial<Record<FriendsTab, HTMLButtonElement | null>>>({});
  const tabPrefix = useId();
  const disabled = isPending || isLoading || isStale || messagePending || !currentUser;
  const pendingCount = snapshot.incomingRequests.length + snapshot.outgoingRequests.length;
  const normalizedFilter = friendFilter.trim().replace(/^@/, '').toLocaleLowerCase();
  const friends = snapshot.friends.filter((friend) =>
    `${friend.displayName} ${friend.username}`.toLocaleLowerCase().includes(normalizedFilter)
  );
  const allUsers = [
    ...snapshot.friends, ...snapshot.blockedUsers,
    ...snapshot.incomingRequests.map((request) => request.user),
    ...snapshot.outgoingRequests.map((request) => request.user), ...controller.searchResults,
    ...(currentUser ? [currentUser] : []),
  ];
  const profile = selectedProfile ? allUsers.find((user) => user.id === selectedProfile.id) ?? selectedProfile : null;

  const selectTab = (tab: FriendsTab) => {
    setActiveTab(tab);
    setMessageError('');
  };

  const closePublicProfile = () => {
    profileFocusPending.current = { userId: selectedProfile?.id, opener: profileOpener.current };
    setSelectedProfile(null);
  };

  useEffect(() => {
    if (selectedProfile || !profileFocusPending.current) return;
    const pending = profileFocusPending.current;
    const frame = window.requestAnimationFrame(() => {
      profileFocusPending.current = null;
      if (!pageRef.current?.isConnected || pageRef.current.closest('[hidden]')) return;
      if (pending.opener?.isConnected && !pending.opener.closest('[hidden]')) {
        pending.opener.focus();
        return;
      }
      // Service refreshes can replace the original search-result row while this dialog is open.
      const replacement = Array.from(pageRef.current.querySelectorAll<HTMLButtonElement>('[data-friend-profile]'))
        .find((button) => button.dataset.friendProfile === pending.userId && !button.closest('[hidden]'));
      (replacement ?? tabRefs.current[activeTab])?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, selectedProfile]);

  useEffect(() => {
    if (confirmation || !confirmationFocusPending.current) return;
    const frame = window.requestAnimationFrame(() => {
      confirmationFocusPending.current = false;
      if (!pageRef.current?.isConnected || pageRef.current.closest('[hidden]')) return;
      const profileDialog = pageRef.current.querySelector<HTMLDialogElement>('.friends-profile-dialog[open]');
      const profileControl = profileDialog?.querySelector<HTMLButtonElement>('button:not(:disabled)');
      const activeTabControl = tabRefs.current[activeTab];
      if (profileControl) profileControl.focus();
      else if (activeTabControl && !activeTabControl.closest('[hidden]')) activeTabControl.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, confirmation]);

  const handleTabKeys = (event: KeyboardEvent<HTMLButtonElement>, tab: FriendsTab) => {
    const index = tabs.indexOf(tab);
    let next: FriendsTab | undefined;
    if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
    if (event.key === 'ArrowLeft') next = tabs[(index + tabs.length - 1) % tabs.length];
    if (event.key === 'Home') next = tabs[0];
    if (event.key === 'End') next = tabs[tabs.length - 1];
    if (!next) return;
    event.preventDefault();
    selectTab(next);
    tabRefs.current[next]?.focus();
  };

  const perform = async (action: FriendAction) => {
    setMessageError('');
    return controller.perform(action);
  };

  const openMessage = async (user: FriendUser) => {
    if (disabled || !canMessage(user.id) || messageLock.current) return;
    messageLock.current = true;
    setMessagePending(true);
    setMessageError('');
    try {
      await onMessage(user);
      setSelectedProfile(null);
    } catch {
      setMessageError('This conversation could not be opened. Please try again.');
    } finally {
      messageLock.current = false;
      setMessagePending(false);
    }
  };

  const relationship = (userId: string) => relationshipForUser(snapshot, userId, currentUser?.id ?? '');
  const relationshipBadge = (value: RelationshipStatus) => (
    <span className="friends-relationship" data-relationship={value}>{relationshipLabels[value]}</span>
  );

  const messageAction = (user: FriendUser) => (
    <Button size="sm" disabled={disabled || messagePending || !canMessage(user.id)}
      leadingIcon={<MessageCircle size={15} aria-hidden="true" />}
      aria-label={`Message ${user.displayName}`} onClick={() => void openMessage(user)}>Message</Button>
  );

  const relationshipActions = (user: FriendUser, suppliedResult?: UserSearchResult) => {
    const state = suppliedResult ?? relationship(user.id);
    if (state.relationship === 'self') return <span className="friends-row-note">You cannot add yourself.</span>;
    if (state.relationship === 'friend') return messageAction(user);
    if (state.relationship === 'blocked') return (
      <Button size="sm" variant="outline" disabled={disabled}
        aria-label={`Unblock ${user.displayName}`} onClick={() => void perform({ type: 'unblock', id: user.id })}>Unblock</Button>
    );
    if (state.relationship === 'incoming') return (
      <>
        <Button size="sm" disabled={disabled || !state.requestId} leadingIcon={<Check size={15} aria-hidden="true" />}
          aria-label={`Accept request from ${user.displayName}`}
          onClick={() => { if (state.requestId) void perform({ type: 'accept', id: state.requestId }); }}>Accept</Button>
        <Button size="sm" variant="outline" disabled={disabled || !state.requestId}
          aria-label={`Decline request from ${user.displayName}`}
          onClick={() => { if (state.requestId) void perform({ type: 'decline', id: state.requestId }); }}>Decline</Button>
      </>
    );
    if (state.relationship === 'outgoing') return (
      <Button size="sm" variant="outline" disabled={disabled || !state.requestId}
        aria-label={`Cancel request to ${user.displayName}`}
        onClick={() => { if (state.requestId) void perform({ type: 'cancel', id: state.requestId }); }}>Cancel request</Button>
    );
    return (
      <Button size="sm" disabled={disabled} leadingIcon={<UserPlus size={15} aria-hidden="true" />}
        aria-label={`Add ${user.displayName} as a friend`} onClick={() => void perform({ type: 'send', id: user.id })}>Add Friend</Button>
    );
  };

  const person = (user: FriendUser, status: RelationshipStatus) => (
    <div className="friends-person">
      <ProfileAvatar displayName={user.displayName} avatar={user.avatar} />
      <div className="friends-identity">
        <span className="friends-name">{user.displayName}</span>
        <span className="friends-username">@{user.username}</span>
        <span className="friends-presence">{user.presence ? `${presenceLabels[user.presence]}${mode === 'local-demo' ? ' · simulated' : ''}` : 'Presence unknown'}</span>
      </div>
      {relationshipBadge(status)}
    </div>
  );

  const viewProfile = (user: FriendUser) => (
    <Button size="sm" variant="outline" aria-label={`View profile for ${user.displayName}`}
      aria-haspopup="dialog" data-friend-profile={user.id} onClick={(event) => {
        profileOpener.current = event.currentTarget;
        setMessageError('');
        setSelectedProfile(user);
      }}>View profile</Button>
  );

  const managementMenu = (user: FriendUser, status: RelationshipStatus) => (
    <DropdownMenu label={`More actions for ${user.displayName}`} className="friends-more-menu" items={[
      ...(status === 'friend' ? [{
        id: 'remove', label: 'Remove friend', destructive: true, disabled,
        onSelect: () => setConfirmation({ type: 'remove', user }),
      }] : []),
      {
        id: 'block', label: 'Block user', destructive: true, disabled,
        onSelect: () => setConfirmation({ type: 'block', user }),
      },
    ]} />
  );

  const counts: Partial<Record<FriendsTab, number>> = {
    all: snapshot.friends.length, pending: pendingCount, blocked: snapshot.blockedUsers.length,
  };
  const dialogError = controller.error || messageError;

  return (
    <div className="friends-page" ref={pageRef}>
      <header className="friends-heading">
        <div className="friends-heading-copy">
          <p className="friends-eyebrow">YOUR PEOPLE, ONE PLACE</p>
          <h1 id="friends-page-title" className="display-heading display-heading--page">Friends</h1>
          <p className="friends-summary">Find familiar faces. Make new connections.</p>
        </div>
        <Button variant="outline" leadingIcon={<UserPlus size={17} aria-hidden="true" />}
          onClick={() => { selectTab('find'); tabRefs.current.find?.focus(); }}>Find Friends</Button>
      </header>

      {mode === 'local-demo' && (
        <p className="friends-demo-note"><strong>Local demo.</strong> People and requests are fictional and reset on refresh.
          {' '}Search checks demo usernames only. Blocking is local to this page and is not server-enforced.</p>
      )}

      <div className="friends-tabs" role="tablist" aria-label="Friends sections">
        {tabs.map((tab) => (
          <button type="button" key={tab} role="tab" id={`${tabPrefix}-${tab}-tab`}
            aria-controls={`${tabPrefix}-${tab}-panel`} aria-selected={activeTab === tab}
            tabIndex={activeTab === tab ? 0 : -1} ref={(node) => { tabRefs.current[tab] = node; }}
            className={`friends-tab${activeTab === tab ? ' is-active' : ''}`}
            onClick={() => selectTab(tab)} onKeyDown={(event) => handleTabKeys(event, tab)}>
            {tabLabels[tab]}
            {counts[tab] !== undefined && !isLoading && <span className="friends-tab-count" aria-label={`${counts[tab]} total`}>{counts[tab]}</span>}
          </button>
        ))}
      </div>

      <div className="friends-feedback" role="status" aria-live="polite" aria-atomic="true">
        {isPending ? 'Updating relationship…' : controller.notice}
      </div>
      {(controller.error || messageError) && (
        <div className="friends-feedback friends-feedback--error" role="alert">
          <p>{controller.error || messageError}</p>
          {controller.error && <Button size="sm" variant="outline" disabled={isLoading || isPending}
            onClick={() => void controller.refresh()}>Try again</Button>}
        </div>
      )}

      {tabs.map((tab) => (
        <section key={tab} role="tabpanel" id={`${tabPrefix}-${tab}-panel`}
          aria-labelledby={`${tabPrefix}-${tab}-tab`} hidden={activeTab !== tab} className="friends-panel"
          aria-busy={isLoading || isPending} tabIndex={0}>
          {isLoading ? <p role="status">Loading friends…</p> : tab === 'all' ? (
            <>
              <div className="friends-panel-heading">
                <h2 className="display-heading display-heading--section">Your friends</h2>
                <span className="friends-count">{snapshot.friends.length} {snapshot.friends.length === 1 ? 'friend' : 'friends'}</span>
              </div>
              <TextInput id="friends-filter" type="search" className="friends-search" label="Search your friends"
                placeholder="Name or username" value={friendFilter} onChange={(event) => setFriendFilter(event.target.value)} />
              {friends.length ? (
                <ul className="friends-list" aria-label="Your friends">
                  {friends.map((user) => (
                    <li className="friends-row" key={user.id}>
                      {person(user, 'friend')}
                      <div className="friends-actions">{messageAction(user)}{viewProfile(user)}{managementMenu(user, 'friend')}</div>
                      {!canMessage(user.id) && <p className="friends-row-note">No direct chat is connected for this user. Creating a conversation is not available yet.</p>}
                    </li>
                  ))}
                </ul>
              ) : <EmptyState heading={snapshot.friends.length ? 'No matching friends' : 'Make your first connection'}>
                {snapshot.friends.length ? 'Try another name or username.' : mode === 'local-demo'
                  ? 'Find a demo username or accept an incoming request to get started.'
                  : 'Find a username or accept an incoming request to get started.'}
              </EmptyState>}
            </>
          ) : tab === 'pending' ? (
            <div className="friends-request-groups">
              {(['incoming', 'outgoing'] as const).map((direction) => {
                const requests = direction === 'incoming' ? snapshot.incomingRequests : snapshot.outgoingRequests;
                return (
                  <div className="friends-request-group" key={direction}>
                    <div className="friends-panel-heading">
                      <h2 className="display-heading display-heading--section">{direction === 'incoming' ? 'Incoming' : 'Sent requests'}</h2>
                      <span className="friends-count">{requests.length}</span>
                    </div>
                    {requests.length ? (
                      <ul className="friends-list" aria-label={direction === 'incoming' ? 'Incoming requests' : 'Outgoing requests'}>
                        {requests.map((request) => (
                          <li className="friends-row" key={request.id}>
                            {person(request.user, direction)}
                            <div className="friends-actions">{relationshipActions(request.user)}{viewProfile(request.user)}</div>
                          </li>
                        ))}
                      </ul>
                    ) : <p className="friends-row-note">{direction === 'incoming' ? 'No incoming requests right now.' : 'You have no pending sent requests.'}</p>}
                  </div>
                );
              })}
            </div>
          ) : tab === 'find' ? (
            <>
              <div className="friends-panel-heading"><h2 className="display-heading display-heading--section">Find your people</h2></div>
              <TextInput id="friends-discovery" type="search" className="friends-search" label="Search by username"
                placeholder="Enter a username" maxLength={64} autoComplete="off" spellCheck={false}
                value={controller.query} onChange={(event) => controller.setQuery(event.target.value)}
                hint={mode === 'local-demo' ? 'Try ava.morgan, jules.park, kai.chen, mina.patel, rowan.blake, or your own demo username.' : 'Only public profiles available to you appear in results.'} />
              {controller.searchLoading ? <p role="status">Searching usernames…</p> : controller.searchError ? (
                <div role="alert" className="friends-feedback friends-feedback--error">
                  <p>{controller.searchError}</p>
                  <Button size="sm" variant="outline" disabled={isLoading || isPending}
                    aria-label="Retry username search" onClick={() => void controller.refresh()}>Try search again</Button>
                </div>
              ) : controller.searchResults.length ? (
                <ul className="friends-list" aria-label="User search results">
                  {controller.searchResults.map((user) => (
                    <li className="friends-row" key={user.id}>
                      {person(user, user.relationship)}
                      <div className="friends-actions">{relationshipActions(user, user)}{viewProfile(user)}
                        {user.relationship !== 'self' && user.relationship !== 'blocked' && managementMenu(user, user.relationship)}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <EmptyState heading={controller.hasSearched ? 'No matching users' : 'A connection starts here'} icon={<Search size={25} aria-hidden="true" />}>
                {controller.hasSearched ? 'Try another username.' : 'Search by username to see public profiles and request status.'}
              </EmptyState>}
            </>
          ) : (
            <>
              <div className="friends-panel-heading"><h2 className="display-heading display-heading--section">Blocked users</h2></div>
              <p className="friends-discovery-hint">Unblocking does not restore a friendship. Chat history and shared files are preserved.</p>
              {snapshot.blockedUsers.length ? (
                <ul className="friends-list" aria-label="Blocked users">
                  {snapshot.blockedUsers.map((user) => (
                    <li className="friends-row" key={user.id}>
                      {person(user, 'blocked')}
                      <div className="friends-actions">{relationshipActions(user)}{viewProfile(user)}</div>
                    </li>
                  ))}
                </ul>
              ) : <EmptyState heading="No blocked users" icon={<Ban size={25} aria-hidden="true" />}>People you block will appear here.</EmptyState>}
            </>
          )}
        </section>
      ))}

      <Dialog open={Boolean(profile)} onOpenChange={(open) => { if (!open) closePublicProfile(); }}
        title="Public profile" closeLabel="Close public profile" description="Public identity and your relationship."
        className="friends-profile-dialog">
        {profile && (
          <div className="friends-profile">
            <div className="friends-profile-identity">
              <ProfileAvatar displayName={profile.displayName} avatar={profile.avatar} size="lg" />
              <div><h3 className="display-heading display-heading--section">{profile.displayName}</h3>
                <p className="friends-username">@{profile.username}</p></div>
            </div>
            <dl className="friends-profile-details">
              <div><dt>Relationship</dt><dd>{relationshipBadge(relationship(profile.id).relationship)}</dd></div>
              <div><dt>Presence</dt><dd>{profile.presence ? `${presenceLabels[profile.presence]}${mode === 'local-demo' ? ' · simulated' : ''}` : 'Unknown'}</dd></div>
            </dl>
            {mode === 'local-demo' && <p className="friends-row-note">Fictional local demo profile. No private account information is shown.</p>}
            {relationship(profile.id).relationship === 'friend' && !canMessage(profile.id) && <p className="friends-message-note">No direct chat is connected for this user. Creating a conversation is not available yet.</p>}
            <div className="friends-dialog-actions">{relationshipActions(profile)}
              {relationship(profile.id).relationship !== 'self' && relationship(profile.id).relationship !== 'blocked' && managementMenu(profile, relationship(profile.id).relationship)}
            </div>
            <p role="status" className="friends-feedback" aria-live="polite">{isPending ? 'Updating relationship…' : controller.notice}</p>
            {dialogError && <p role="alert" className="friends-feedback friends-feedback--error">{dialogError}</p>}
          </div>
        )}
      </Dialog>

      <Dialog open={Boolean(confirmation)} onOpenChange={(open) => { if (!open && !isPending) setConfirmation(null); }}
        title={confirmation?.type === 'remove' ? 'Remove friend?' : 'Block user?'}
        description={confirmation?.type === 'remove' ? 'You can send a new friend request later.' : 'Resolve this block before sending another friend request.'}
        closeLabel="Close confirmation" dismissible={!isPending} className="friends-confirm-dialog"
        footer={<div className="friends-dialog-actions">
          <Button variant="outline" disabled={isPending} onClick={() => setConfirmation(null)}>Cancel</Button>
          <Button variant="danger" loading={isPending} disabled={disabled} leadingIcon={confirmation?.type === 'remove' ? <X size={16} aria-hidden="true" /> : <Ban size={16} aria-hidden="true" />}
            onClick={() => {
              if (!confirmation) return;
              void perform({ type: confirmation.type, id: confirmation.user.id }).then((success) => {
                if (!success) return;
                confirmationFocusPending.current = true;
                setConfirmation(null);
              });
            }}>{confirmation?.type === 'remove' ? 'Remove friend' : 'Block user'}</Button>
        </div>}>
        <p className="friends-confirm-note">{confirmation?.type === 'remove' ? 'Remove ' : 'Block '}<strong>{confirmation?.user.displayName}</strong>?
          {' '}Existing chat history and shared files will stay.</p>
        {confirmation?.type === 'block' && mode === 'local-demo' && <p className="friends-row-note">This block only changes the local friends demo. It does not enforce server messaging permissions.</p>}
        {controller.error && <p role="alert" className="friends-feedback friends-feedback--error">{controller.error}</p>}
      </Dialog>
    </div>
  );
}
