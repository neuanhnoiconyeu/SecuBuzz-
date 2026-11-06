export const DEMO_USER_ID = 'local-user';
export const DISPLAY_NAME_MAX_LENGTH = 40;
export const STATUS_MESSAGE_MAX_LENGTH = 160;

export const PROFILE_AVATARS = [
  { id: 'initials', label: 'Initials' },
  { id: 'smile', label: 'Smile' },
  { id: 'star', label: 'Star' },
  { id: 'rocket', label: 'Rocket' },
  { id: 'cat', label: 'Cat' },
] as const;

export type ProfileAvatarId = typeof PROFILE_AVATARS[number]['id'];

export const PRESENCE_OPTIONS = [
  { value: 'available', label: 'Available' },
  { value: 'busy', label: 'Busy' },
  { value: 'away', label: 'Away' },
  { value: 'invisible', label: 'Invisible' },
] as const;

/** Local preference only; this value is not actual realtime presence. */
export type PresencePreference = typeof PRESENCE_OPTIONS[number]['value'];

export interface EditableProfileFields {
  displayName: string;
  statusMessage: string;
  avatar: ProfileAvatarId;
  presencePreference: PresencePreference;
}

export interface UserProfile extends EditableProfileFields {
  readonly id: string;
  readonly username: string;
  readonly isDemo: boolean;
}

export type ProfileUpdates = Partial<EditableProfileFields>;
export type ProfileFieldErrors = Partial<Record<keyof EditableProfileFields, string>>;
export type ProfileValidationResult =
  | { valid: true; value: EditableProfileFields }
  | { valid: false; errors: ProfileFieldErrors };

export function createDemoProfile(): UserProfile {
  return {
    id: DEMO_USER_ID,
    username: 'demo-explorer',
    displayName: 'Demo Explorer',
    statusMessage: 'Exploring the local demo',
    avatar: 'initials',
    presencePreference: 'available',
    isDemo: true,
  };
}

const invalidControlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;

/** Validate editable fields without imposing backend account constraints. */
export function validateProfileFields(input: EditableProfileFields): ProfileValidationResult {
  const errors: ProfileFieldErrors = {};
  const candidate = input && typeof input === 'object' ? input : {} as Partial<EditableProfileFields>;
  const displayName = typeof candidate.displayName === 'string' ? candidate.displayName.trim() : '';
  const statusMessage = typeof candidate.statusMessage === 'string' ? candidate.statusMessage.trim() : '';

  if (typeof candidate.displayName !== 'string' || !displayName) {
    errors.displayName = 'Display name is required.';
  } else if (invalidControlCharacters.test(candidate.displayName)) {
    errors.displayName = 'Display name cannot contain control characters.';
  } else if ([...displayName].length > DISPLAY_NAME_MAX_LENGTH) {
    errors.displayName = `Display name must be ${DISPLAY_NAME_MAX_LENGTH} characters or fewer.`;
  }

  if (typeof candidate.statusMessage !== 'string') {
    errors.statusMessage = 'Status message must be text.';
  } else if (invalidControlCharacters.test(candidate.statusMessage)) {
    errors.statusMessage = 'Status message cannot contain control characters.';
  } else if ([...statusMessage].length > STATUS_MESSAGE_MAX_LENGTH) {
    errors.statusMessage = `Status message must be ${STATUS_MESSAGE_MAX_LENGTH} characters or fewer.`;
  }

  if (!PROFILE_AVATARS.some((preset) => preset.id === candidate.avatar)) {
    errors.avatar = 'Choose one of the built-in avatars.';
  }
  if (!PRESENCE_OPTIONS.some((option) => option.value === candidate.presencePreference)) {
    errors.presencePreference = 'Choose a valid local presence preference.';
  }

  if (Object.keys(errors).length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      displayName,
      statusMessage,
      avatar: candidate.avatar as ProfileAvatarId,
      presencePreference: candidate.presencePreference as PresencePreference,
    },
  };
}

export class ProfileValidationError extends Error {
  constructor(public readonly fieldErrors: ProfileFieldErrors) {
    super('Please check the highlighted profile fields.');
    this.name = 'ProfileValidationError';
  }
}
