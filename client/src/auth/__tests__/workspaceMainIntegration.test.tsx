import { useState, useEffect } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthProvider } from '../AuthProvider';
import { AuthenticatedWorkspace } from '../AuthenticatedWorkspace';
import type { AuthService } from '../authService';

// Existing UI boundaries are doubled to verify workspace ownership. The unmodified
// media suites and full build separately expose main's missing shared dependencies.
const mockMounted = jest.fn(), mockDisposed = jest.fn();
jest.mock('@/components/messenger/RealMessengerWorkspace', () => ({
  RealMessengerWorkspace: function Workspace({ onOpenVoiceRooms, active }: { onOpenVoiceRooms(): void; active: boolean }) {
    const [draft, setDraft] = useState('');
    useEffect(() => { mockMounted(); return () => { mockDisposed(); }; }, []);
    return <div hidden={!active}><section aria-label="DATA workspace" data-active={active}><input aria-label="Retained draft" value={draft} onChange={e => setDraft(e.target.value)} />
      <button onClick={onOpenVoiceRooms}>Open Voice Rooms</button></section></div>;
  },
}));
jest.mock('@/components/voice/VoiceRoomsWorkspace', () => ({ VoiceRoomsWorkspace: ({ onClose, onLogout }: { onClose(): void; onLogout(): void }) =>
  <section aria-label="Media workspace"><button onClick={onClose}>Back to account</button><button onClick={onLogout}>Sign Out</button></section> }));
jest.mock('@/components/messenger/ApiRealtimeConnection', () => ({ ApiRealtimeConnection: ({ children,enableDirectCalls }: { children: React.ReactNode;enableDirectCalls?:boolean }) =>
  <div data-testid="legacy-calling-transport" data-direct-calls={String(enableDirectCalls)}>{children}</div> }));
jest.mock('@/components/messenger/MessengerApp', () => ({ MessengerApp: () => null }));
jest.mock('../messengerSession', () => ({ createDemoMessengerSession: jest.fn() }));
jest.mock('@/dev/calling/DevelopmentCallingTestView', () => ({ DevelopmentCallingTestView: () => <p>Development calling</p> }));

beforeEach(() => {
  jest.clearAllMocks();
  jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'test', NEXT_PUBLIC_DEV_CALLS_ENABLED: 'false' });
});
afterEach(() => jest.restoreAllMocks());

test('opening media preserves DATA resources and drafts; logout disposes the session', async () => {
  const service: AuthService = { mode: 'api', getCurrentUser: async () => ({ id: 'real-user', username: 'real', displayName: 'Real', avatar: 'cat', isDemo: false }),
    login: jest.fn(), register: jest.fn(), logout: jest.fn().mockResolvedValue(undefined) };
  render(<AuthProvider service={service}><AuthenticatedWorkspace /></AuthProvider>);
  const draft = await screen.findByRole('textbox', { name: 'Retained draft' });
  fireEvent.change(draft, { target: { value: 'Private draft' } });
  expect(screen.queryByTestId('legacy-calling-transport')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open Voice Rooms' }));
  expect(screen.getByRole('region', { name: 'Media workspace' })).toBeInTheDocument();
  expect(screen.getByTestId('legacy-calling-transport')).toHaveAttribute('data-direct-calls','false');
  expect(mockMounted).toHaveBeenCalledTimes(1); expect(mockDisposed).not.toHaveBeenCalled();
  expect(screen.getByRole('region', { name: 'DATA workspace', hidden: true })).toHaveAttribute('data-active', 'false');
  fireEvent.click(screen.getByRole('button', { name: 'Back to account' }));
  expect(screen.getByRole('textbox', { name: 'Retained draft' })).toHaveValue('Private draft');
  expect(screen.getByRole('region', { name: 'DATA workspace' })).toHaveAttribute('data-active', 'true');
  expect(screen.queryByTestId('legacy-calling-transport')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open Voice Rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }));
  await waitFor(() => expect(mockDisposed).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('region', { name: 'Media workspace' })).not.toBeInTheDocument();
  expect(service.logout).toHaveBeenCalledTimes(1);
});
