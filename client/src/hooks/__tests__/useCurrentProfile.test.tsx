import { act, renderHook, waitFor } from '@testing-library/react';
import { useCurrentProfile } from '../useCurrentProfile';
import { createDemoProfile, type UserProfile } from '@/profiles/profileModel';
import { LocalDemoProfileService } from '@/profiles/profileService';

describe('useCurrentProfile', () => {
  test('loads, updates, and observes the local profile', async () => {
    const service = new LocalDemoProfileService();
    const { result } = renderHook(() => useCurrentProfile(service));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.profile).toEqual(createDemoProfile());
    await act(async () => {
      expect(await result.current.updateProfile({ displayName: 'Casey', statusMessage: 'Ready', avatar: 'rocket' })).toBe(true);
      expect(await result.current.setPresencePreference('busy')).toBe(true);
    });
    expect(result.current.profile).toMatchObject({ displayName: 'Casey', statusMessage: 'Ready', avatar: 'rocket', presencePreference: 'busy' });
    await act(async () => { await service.updateProfile({ statusMessage: 'Changed from another view' }); });
    expect(result.current.profile?.statusMessage).toBe('Changed from another view');
  });

  test('keeps invalid edits out of the saved profile and exposes field feedback', async () => {
    const { result } = renderHook(() => useCurrentProfile());
    await waitFor(() => expect(result.current.profile).not.toBeNull());
    await act(async () => { expect(await result.current.updateProfile({ displayName: '   ' })).toBe(false); });
    expect(result.current.profile?.displayName).toBe('Demo Explorer');
    expect(result.current.fieldErrors.displayName).toBe('Display name is required.');
  });

  test('handles update failure with safe feedback and preserves the last loaded identity', async () => {
    const service = new LocalDemoProfileService();
    jest.spyOn(service, 'updateProfile').mockRejectedValueOnce(new Error('sensitive provider details'));
    const { result } = renderHook(() => useCurrentProfile(service));
    await waitFor(() => expect(result.current.profile).not.toBeNull());
    await act(async () => { expect(await result.current.updateProfile({ displayName: 'Unsaved' })).toBe(false); });
    expect(result.current.profile?.displayName).toBe('Demo Explorer');
    expect(result.current.error).toBe('Your profile could not be updated. Your changes have not been saved.');
    expect(result.current.error).not.toContain('sensitive');
    expect(result.current.isSaving).toBe(false);
  });

  test('prevents duplicate submissions while an update is pending', async () => {
    const service = new LocalDemoProfileService();
    let resolveSave: ((profile: UserProfile) => void) | undefined;
    const pending = new Promise<UserProfile>((resolve) => { resolveSave = resolve; });
    const save = jest.spyOn(service, 'updateProfile').mockReturnValueOnce(pending);
    const { result } = renderHook(() => useCurrentProfile(service));
    await waitFor(() => expect(result.current.profile).not.toBeNull());
    let firstSave: Promise<boolean> | undefined;
    await act(async () => {
      firstSave = result.current.updateProfile({ displayName: 'Casey' });
      expect(await result.current.updateProfile({ displayName: 'Duplicate' })).toBe(false);
    });
    expect(result.current.isSaving).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSave?.({ ...createDemoProfile(), displayName: 'Casey' });
      expect(await firstSave).toBe(true);
    });
    expect(result.current.profile?.displayName).toBe('Casey');
    expect(result.current.isSaving).toBe(false);
  });

  test('allows retry after loading fails without exposing provider errors', async () => {
    const service = new LocalDemoProfileService();
    jest.spyOn(service, 'getCurrentProfile').mockRejectedValueOnce(new Error('internal account details'));
    const { result } = renderHook(() => useCurrentProfile(service));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('Your local profile could not be loaded. Try again.');
    await act(async () => { await result.current.loadProfile(); });
    expect(result.current.profile).toEqual(createDemoProfile());
    expect(result.current.error).toBeNull();
  });

  test('does not overwrite a subscribed update with an older in-flight load', async () => {
    const service = new LocalDemoProfileService();
    let resolveLoad: ((profile: UserProfile) => void) | undefined;
    jest.spyOn(service, 'getCurrentProfile').mockReturnValueOnce(new Promise<UserProfile>((resolve) => { resolveLoad = resolve; }));
    const { result } = renderHook(() => useCurrentProfile(service));
    await act(async () => { await service.updateProfile({ displayName: 'Latest profile' }); });
    await act(async () => { resolveLoad?.(createDemoProfile()); });
    expect(result.current.profile?.displayName).toBe('Latest profile');
  });
});
