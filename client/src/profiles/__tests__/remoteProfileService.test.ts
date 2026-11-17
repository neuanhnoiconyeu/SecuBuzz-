import { RemoteProfileService } from '../remoteProfileService';
import { ApiError, type SessionApi } from '@/api/sessionApi';

const profile = { id: 'alice-id', username: 'alice', displayName: 'Alice', avatar: 'cat', isDemo: false, statusMessage: '', presencePreference: 'away' };
function setup() {
  const request = jest.fn(); const api: SessionApi = { actor: profile, request, dispose: jest.fn() };
  return { request, service: new RemoteProfileService(api) };
}
test('loads own private preferences, sends only allowed updates and publishes confirmed server fields', async () => {
  const { service, request } = setup(); request.mockResolvedValueOnce({ profile }).mockResolvedValueOnce({ profile: { ...profile, displayName: 'Alice Edited', avatar: 'star' } });
  expect(await service.getCurrentProfile()).toEqual(profile); const listener = jest.fn(); service.subscribeToProfileChanges(listener);
  expect(await service.updateProfile({ displayName: ' Alice Edited ', avatar: 'star' })).toMatchObject({ displayName: 'Alice Edited', avatar: 'star' });
  expect(request.mock.calls[1]).toEqual(['/api/users/me', { method: 'PATCH', body: { displayName: 'Alice Edited', avatar: 'star' } }]);
  expect(listener).toHaveBeenCalledTimes(1);
});
test('failed save preserves the confirmed profile and never notifies subscribers', async () => {
  const { service, request } = setup(); request.mockResolvedValueOnce({ profile }).mockRejectedValueOnce(new ApiError('unavailable'));
  await service.getCurrentProfile(); const listener = jest.fn(); service.subscribeToProfileChanges(listener);
  await expect(service.updateProfile({ statusMessage: 'Draft' })).rejects.toMatchObject({ code: 'unavailable' }); expect(listener).not.toHaveBeenCalled();
});
test('maps only editable server validation fields to safe field errors', async () => {
  const { service, request } = setup(); request.mockResolvedValueOnce({ profile }).mockRejectedValueOnce(new ApiError('validation', ['statusMessage', 'password']));
  await service.getCurrentProfile(); await expect(service.updateProfile({ statusMessage: 'Draft' })).rejects.toMatchObject({ fieldErrors: { statusMessage: 'Check this field and try again.' } });
});
test.each([{ ...profile, id: 'bob-id' }, { ...profile, isDemo: true }, { ...profile, presencePreference: 'online' }, { ...profile, avatar: 'https://example.test' }])(
  'rejects malformed or wrong-actor profiles', async value => {
    const { service, request } = setup(); request.mockResolvedValue({ profile: value }); await expect(service.getCurrentProfile()).rejects.toMatchObject({ code: 'invalid_response' });
  });
test('rejects immutable fields and invalid edits without sending a write', async () => {
  const { service, request } = setup(); request.mockResolvedValue({ profile });
  await expect(service.updateProfile({ id: 'bob-id' } as never)).rejects.toMatchObject({ code: 'unsupported_update' });
  await expect(service.updateProfile({ displayName: '' })).rejects.toMatchObject({ fieldErrors: { displayName: 'Display name is required.' } });
  expect(request).toHaveBeenCalledTimes(1);
});
