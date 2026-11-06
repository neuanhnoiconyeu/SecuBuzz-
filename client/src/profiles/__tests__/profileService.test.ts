import { createDemoProfile, ProfileValidationError, type ProfileUpdates } from '../profileModel';
import { LocalDemoProfileService, ProfileServiceError } from '../profileService';

describe('LocalDemoProfileService', () => {
  test('loads an explicitly local demo identity and keeps separate sessions independent', async () => {
    const first = new LocalDemoProfileService();
    const second = new LocalDemoProfileService();
    expect(await first.getCurrentProfile()).toEqual(createDemoProfile());
    await first.updateProfile({ displayName: 'Casey' });
    expect((await second.getCurrentProfile()).displayName).toBe('Demo Explorer');
  });

  test('updates editable fields without changing the user ID or username', async () => {
    const service = new LocalDemoProfileService();
    const updated = await service.updateProfile({ displayName: '  Casey  ', statusMessage: 'Ready 🌻', avatar: 'cat' });
    expect(updated).toMatchObject({
      id: 'local-user', username: 'demo-explorer', displayName: 'Casey', statusMessage: 'Ready 🌻', avatar: 'cat', isDemo: true,
    });
    expect(await service.setPresencePreference('invisible')).toMatchObject({ presencePreference: 'invisible' });
  });

  test.each(['id', 'username', 'isDemo', 'unexpected'])('rejects runtime attempts to change %s', async (field) => {
    const service = new LocalDemoProfileService();
    await expect(service.updateProfile({ [field]: 'changed' } as ProfileUpdates)).rejects.toBeInstanceOf(ProfileServiceError);
    expect(await service.getCurrentProfile()).toEqual(createDemoProfile());
  });

  test('rejects invalid updates atomically and keeps the saved profile intact', async () => {
    const service = new LocalDemoProfileService();
    await expect(service.updateProfile({ displayName: 'New name', statusMessage: 'invalid\u0000text' }))
      .rejects.toBeInstanceOf(ProfileValidationError);
    expect(await service.getCurrentProfile()).toEqual(createDemoProfile());
  });

  test('returns snapshots and notifies subscribers without sharing mutable state', async () => {
    const service = new LocalDemoProfileService();
    const received: string[] = [];
    const unsubscribe = service.subscribeToProfileChanges((profile) => {
      received.push(profile.displayName);
      profile.displayName = 'Modified listener snapshot';
    });
    const updated = await service.updateProfile({ displayName: 'Casey' });
    updated.displayName = 'Modified caller snapshot';
    expect((await service.getCurrentProfile()).displayName).toBe('Casey');
    unsubscribe();
    await service.updateProfile({ displayName: 'Jules' });
    expect(received).toEqual(['Casey']);
  });
});
