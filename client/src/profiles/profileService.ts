import {
  createDemoProfile,
  ProfileValidationError,
  validateProfileFields,
  type PresencePreference,
  type ProfileUpdates,
  type UserProfile,
} from './profileModel';

/** Implement this boundary with an authenticated API when that contract exists. */
export interface ProfileService {
  getCurrentProfile(): Promise<UserProfile>;
  updateProfile(updates: ProfileUpdates): Promise<UserProfile>;
  setPresencePreference(preference: PresencePreference): Promise<UserProfile>;
  subscribeToProfileChanges(listener: (profile: UserProfile) => void): () => void;
}

export class ProfileServiceError extends Error {
  constructor(public readonly code: 'unsupported_update') {
    super('Only display name, status message, avatar, and local presence preference can be edited.');
    this.name = 'ProfileServiceError';
  }
}

const editableKeys = new Set(['displayName', 'statusMessage', 'avatar', 'presencePreference']);

/** A fresh service instance is a fresh demo session. Nothing is persisted or broadcast. */
export class LocalDemoProfileService implements ProfileService {
  private profile: UserProfile;
  private readonly listeners = new Set<(profile: UserProfile) => void>();

  constructor(initialProfile: UserProfile = createDemoProfile()) {
    this.profile = { ...initialProfile };
  }

  async getCurrentProfile(): Promise<UserProfile> {
    return { ...this.profile };
  }

  async updateProfile(updates: ProfileUpdates): Promise<UserProfile> {
    if (
      !updates || typeof updates !== 'object' || Array.isArray(updates) ||
      Reflect.ownKeys(updates).some((key) => typeof key !== 'string' || !editableKeys.has(key))
    ) {
      throw new ProfileServiceError('unsupported_update');
    }

    const result = validateProfileFields({
      displayName: Object.prototype.hasOwnProperty.call(updates, 'displayName') ? updates.displayName! : this.profile.displayName,
      statusMessage: Object.prototype.hasOwnProperty.call(updates, 'statusMessage') ? updates.statusMessage! : this.profile.statusMessage,
      avatar: Object.prototype.hasOwnProperty.call(updates, 'avatar') ? updates.avatar! : this.profile.avatar,
      presencePreference: Object.prototype.hasOwnProperty.call(updates, 'presencePreference') ? updates.presencePreference! : this.profile.presencePreference,
    });
    if (!result.valid) throw new ProfileValidationError(result.errors);

    this.profile = { ...this.profile, ...result.value };
    for (const listener of this.listeners) {
      try {
        listener({ ...this.profile });
      } catch {
        // One view's listener must not interrupt other profile subscribers.
      }
    }
    return { ...this.profile };
  }

  setPresencePreference(preference: PresencePreference): Promise<UserProfile> {
    return this.updateProfile({ presencePreference: preference });
  }

  subscribeToProfileChanges(listener: (profile: UserProfile) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
