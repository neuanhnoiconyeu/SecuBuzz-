import { ApiError, type SessionApi } from '@/api/sessionApi';
import { ownProfile, record } from '@/api/socialValidation';
import { ProfileValidationError, validateProfileFields, type ProfileFieldErrors, type ProfileUpdates, type PresencePreference, type UserProfile } from './profileModel';
import { ProfileServiceError, type ProfileService } from './profileService';

export class RemoteProfileService implements ProfileService {
  private profile: UserProfile | null = null;
  private readonly listeners = new Set<(profile: UserProfile) => void>();
  private saving = false;
  private version = 0;
  constructor(private readonly api: SessionApi) {}
  async getCurrentProfile(): Promise<UserProfile> {
    const version = this.version;
    const loaded = ownProfile(record(await this.api.request('/api/users/me')).profile, this.api.actor);
    if (version === this.version) this.profile = loaded;
    return { ...loaded };
  }
  async updateProfile(updates: ProfileUpdates): Promise<UserProfile> {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates) ||
      Reflect.ownKeys(updates).some(key => !['displayName', 'statusMessage', 'avatar', 'presencePreference'].includes(key as string))) {
      throw new ProfileServiceError('unsupported_update');
    }
    if (this.saving) throw new ApiError('conflict');
    this.saving = true;
    try {
      const current = this.profile ?? await this.getCurrentProfile();
      const validated = validateProfileFields({ ...current, ...updates });
      if (!validated.valid) throw new ProfileValidationError(validated.errors);
      const body = Object.fromEntries(Object.keys(updates).map(key => [key, validated.value[key as keyof ProfileUpdates]]));
      const confirmed = ownProfile(record(await this.api.request('/api/users/me', { method: 'PATCH', body })).profile, this.api.actor);
      this.version += 1;
      this.profile = confirmed;
      for (const listener of this.listeners) {
        try { listener({ ...confirmed }); } catch { /* A view cannot change the confirmed save outcome. */ }
      }
      return { ...confirmed };
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'validation' && failure.fields.length) {
        const errors: ProfileFieldErrors = {};
        for (const key of failure.fields) {
          if (['displayName', 'statusMessage', 'avatar', 'presencePreference'].includes(key)) errors[key as keyof ProfileUpdates] = 'Check this field and try again.';
        }
        if (Object.keys(errors).length) throw new ProfileValidationError(errors);
      }
      throw failure;
    } finally { this.saving = false; }
  }
  setPresencePreference(preference: PresencePreference) { return this.updateProfile({ presencePreference: preference }); }
  subscribeToProfileChanges(listener: (profile: UserProfile) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
}
