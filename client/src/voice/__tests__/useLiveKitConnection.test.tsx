import { renderHook } from '@testing-library/react';
import { useAuth } from '@/auth/AuthProvider';
import { createDemoProfile } from '@/profiles/profileModel';
import { LiveKitConnectionService } from '../livekitConnection';
import { useLiveKitConnection } from '../useLiveKitConnection';

jest.mock('@/auth/AuthProvider', () => ({ useAuth: jest.fn() }));

afterEach(() => jest.restoreAllMocks());

test('session replacement, logout and unmount dispose the session-owned service without automatically connecting', () => {
  const dispose = jest.spyOn(LiveKitConnectionService.prototype, 'dispose');
  const connect = jest.spyOn(LiveKitConnectionService.prototype, 'connect');
  const auth = { user: { ...createDemoProfile(), id: 'real-user', isDemo: false }, mode: 'api', sessionVersion: 1, restoreSession: jest.fn() };
  (useAuth as jest.Mock).mockReturnValue(auth);
  const { result, rerender, unmount } = renderHook(useLiveKitConnection);
  const first = result.current.service;
  expect(first).not.toBeNull();
  expect(connect).not.toHaveBeenCalled();
  (useAuth as jest.Mock).mockReturnValue({ ...auth, sessionVersion: 2 });
  rerender();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(result.current.service).not.toBe(first);
  (useAuth as jest.Mock).mockReturnValue({ ...auth, user: null, sessionVersion: 3 });
  rerender();
  expect(dispose).toHaveBeenCalledTimes(2);
  expect(result.current.snapshot.status).toBe('disabled');
  unmount();
  expect(dispose).toHaveBeenCalledTimes(3);
  expect(connect).not.toHaveBeenCalled();
});
