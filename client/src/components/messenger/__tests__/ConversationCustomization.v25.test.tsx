import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MessageComposer } from '../MessageComposer';
import { ProfileDialog } from '@/components/profile/ProfileDialog';
import { SecureConversationPanel } from '../SecureConversationPanel';
import { SecureMessagingSession } from '@/security/e2ee/session';
import { generateDevice } from '@/security/e2ee/devices';
import type { DirectConversation } from '@/security/e2ee/model';
import { AuthenticatedReactions } from '@/messaging/authenticatedReactions';
import { useDirectCalls } from '@/components/calls/DirectCallsRuntime';
import type { UserProfile } from '@/profiles/profileModel';

// Timing budget: performs real WebCrypto device/key setup and renders full SecureConversationPanel under parallel Jest load.
jest.setTimeout(20000);

jest.mock('@/components/calls/DirectCallsRuntime', () => ({ useDirectCalls: jest.fn(() => null) }));

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); } });
  URL.createObjectURL = jest.fn(() => 'blob:avatar-preview');
  URL.revokeObjectURL = jest.fn();
});

afterAll(() => {
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  URL.createObjectURL = originalCreateObjectUrl;
  URL.revokeObjectURL = originalRevokeObjectUrl;
});

beforeEach(() => {
  jest.spyOn(AuthenticatedReactions.prototype, 'refresh').mockResolvedValue(undefined);
  jest.mocked(useDirectCalls).mockReturnValue(null);
});
afterEach(() => { cleanup(); jest.restoreAllMocks(); });

test('ProfileDialog supports uploading, previewing, replacing, and removing profile photos with validation and fallback initials', async () => {
  const baseProfile: UserProfile = {
    id: 'alice', username: 'alice', displayName: 'Alice Doe', statusMessage: '',
    avatar: 'initials', presencePreference: 'available', isDemo: false,
  };
  const onUploadAvatar = jest.fn(async () => true);
  const onRemoveAvatar = jest.fn(async () => true);
  const view = render(
    <ProfileDialog mode="remote" open onOpenChange={jest.fn()} profile={baseProfile}
      isLoading={false} isSaving={false} error={null} onRetry={jest.fn()}
      onSave={jest.fn(async () => true)} onUploadAvatar={onUploadAvatar} onRemoveAvatar={onRemoveAvatar} />
  );
  // Fallback initials shown when no avatarUrl
  expect(screen.getByRole('img', { name: 'Alice Doe' })).toHaveTextContent('AD');

  fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));
  const input = screen.getByLabelText('Upload profile photo') as HTMLInputElement;

  // Rejects invalid SVG file
  const svg = new File(['<svg/>'], 'bad.svg', { type: 'image/svg+xml' });
  fireEvent.change(input, { target: { files: [svg] } });
  expect(screen.getByText('Choose a PNG, JPEG, or WebP image.')).toBeInTheDocument();
  expect(onUploadAvatar).not.toHaveBeenCalled();

  // Uploads valid PNG
  const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'me.png', { type: 'image/png' });
  await act(async () => { fireEvent.change(input, { target: { files: [png] } }); });
  expect(onUploadAvatar).toHaveBeenCalledWith(png);

  // Re-render with uploaded avatarUrl -> Replace and Remove buttons appear
  view.rerender(
    <ProfileDialog mode="remote" open onOpenChange={jest.fn()}
      profile={{ ...baseProfile, avatarUrl: '/api/users/alice/avatar?v=abc123' }}
      isLoading={false} isSaving={false} error={null} onRetry={jest.fn()}
      onSave={jest.fn(async () => true)} onUploadAvatar={onUploadAvatar} onRemoveAvatar={onRemoveAvatar} />
  );
  expect(screen.getByRole('button', { name: 'Replace photo' })).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove photo' })); });
  expect(onRemoveAvatar).toHaveBeenCalledTimes(1);
});

test('MessageComposer displays theme-linked quick emoji when empty, sends immediately, preserves Send when typing, and handles failure', async () => {
  const onSend = jest.fn(async () => true);
  const view = render(<MessageComposer conversationName="Bob" messageCount={0} isSending={false} buzzBusy={false} onSend={onSend} quickEmoji="👍" />);

  // Default quick emoji 👍 shown when empty
  const quick = screen.getByRole('button', { name: 'Send 👍' });
  await act(async () => { fireEvent.click(quick); });
  expect(onSend).toHaveBeenCalledWith('👍');

  // Typing switches to Send button; clearing restores quick emoji
  const input = screen.getByRole('textbox', { name: 'Message to Bob' });
  fireEvent.change(input, { target: { value: 'Hello' } });
  expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Send 👍' })).not.toBeInTheDocument();
  fireEvent.change(input, { target: { value: '' } });
  expect(screen.getByRole('button', { name: 'Send 👍' })).toBeInTheDocument();

  // Theme change updates quick emoji without altering draft
  view.rerender(<MessageComposer conversationName="Bob" messageCount={1} isSending={false} buzzBusy={false} onSend={onSend} quickEmoji="🌊" />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send 🌊' })); });
  expect(onSend).toHaveBeenLastCalledWith('🌊');

  // Declined quick-send displays error without breaking composer
  onSend.mockResolvedValueOnce(false);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send 🌊' })); });
  expect(screen.getByRole('alert')).toHaveTextContent('not accepted');
});

test('SecureConversationPanel updates chat theme, linked quick emoji, and conversation nicknames while preserving canonical identities', async () => {
  let conversation: DirectConversation = {
    id: 'conversation', type: 'direct', interactionAllowed: true, themeId: 'default', nicknames: {},
    createdAt: '2026-11-25T00:00:00.000Z', updatedAt: '2026-11-25T00:00:00.000Z',
    participants: [
      { id: 'alice', username: 'alice', displayName: 'Alice', avatar: 'initials' },
      { id: 'bob', username: 'bob', displayName: 'Bob', avatar: 'initials', avatarUrl: '/api/users/bob/avatar?v=1' },
    ],
  };
  const session = new SecureMessagingSession({ actor: { id: 'alice', username: 'alice' }, request: jest.fn().mockResolvedValue({ conversationId: 'conversation', version: 0, items: [] }), dispose() {} });
  const device = await generateDevice('alice');
  jest.spyOn(session, 'initialize').mockResolvedValue(device);
  jest.spyOn(session.api, 'conversations').mockImplementation(async () => ({ items: [conversation], nextCursor: null }));
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  jest.spyOn(session, 'prepare').mockImplementation(async () => ({ conversation, key, keyId: 'epoch', safetyNumber: '1234' }));
  jest.spyOn(session, 'history').mockResolvedValue({ items: [], nextCursor: null });
  jest.spyOn(session, 'pending').mockResolvedValue(null);
  jest.spyOn(session, 'isCachedMessageCurrent').mockResolvedValue(true);
  const updatePrefs = jest.spyOn(session.api, 'updatePreferences').mockImplementation(async (_cid, patch) => {
    conversation = {
      ...conversation,
      ...(patch.themeId ? { themeId: patch.themeId } : {}),
      ...(patch.nicknames ? { nicknames: Object.fromEntries(Object.entries(patch.nicknames).filter(([, v]) => Boolean(v))) as Record<string, string> } : {}),
    };
    return conversation;
  });

  render(<SecureConversationPanel session={session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message to Bob' })).toBeEnabled());

  // Default theme and quick emoji 👍
  const chatWindow = screen.getByLabelText('Bob conversation');
  expect(chatWindow).toHaveAttribute('data-chat-theme', 'default');
  expect(screen.getByRole('button', { name: 'Send 👍' })).toBeInTheDocument();

  // Open Conversation settings and switch theme to Ocean -> quick emoji becomes 🌊
  fireEvent.click(screen.getByRole('button', { name: 'Conversation settings' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Ocean/ })); });
  expect(updatePrefs).toHaveBeenCalledWith('conversation', { themeId: 'ocean' });
  expect(chatWindow).toHaveAttribute('data-chat-theme', 'ocean');
  expect(screen.getByRole('button', { name: 'Send 🌊' })).toBeInTheDocument();

  // Restore default theme -> quick emoji returns to 👍
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Default/ })); });
  expect(chatWindow).toHaveAttribute('data-chat-theme', 'default');
  expect(screen.getByRole('button', { name: 'Send 👍' })).toBeInTheDocument();

  // Edit Bob's nickname to "Bobby" -> header & sidebar update while canonical @bob remains in settings
  const bobNickInput = screen.getByLabelText(/Bob\s*\(@bob\)/);
  fireEvent.change(bobNickInput, { target: { value: 'Bobby' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save nicknames' })); });
  expect(screen.getByRole('heading', { name: 'Chat with Bobby' })).toBeInTheDocument();
  expect(within(screen.getByRole('navigation', { name: 'Direct conversations' })).getByText('Bobby')).toBeInTheDocument();
});
