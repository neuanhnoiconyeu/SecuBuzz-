import {
  createDemoProfile,
  DISPLAY_NAME_MAX_LENGTH,
  PRESENCE_OPTIONS,
  STATUS_MESSAGE_MAX_LENGTH,
  validateProfileFields,
  type EditableProfileFields,
  type PresencePreference,
  type ProfileAvatarId,
} from '../profileModel';

const fields = (updates: Partial<EditableProfileFields> = {}): EditableProfileFields => ({
  ...createDemoProfile(),
  ...updates,
});

describe('profile validation', () => {
  test('accepts a display name and trims editable text without changing identity fields', () => {
    const result = validateProfileFields(fields({ displayName: '  Casey Chen  ', statusMessage: '  Ready to chat  ' }));
    expect(result).toEqual({
      valid: true,
      value: { displayName: 'Casey Chen', statusMessage: 'Ready to chat', avatar: 'initials', presencePreference: 'available' },
    });
  });

  test.each(['', '    '])('rejects an empty display name (%p)', (displayName) => {
    expect(validateProfileFields(fields({ displayName }))).toMatchObject({
      valid: false,
      errors: { displayName: 'Display name is required.' },
    });
  });

  test('counts Unicode code points when enforcing the display and status limits', () => {
    expect(validateProfileFields(fields({ displayName: '🐱'.repeat(DISPLAY_NAME_MAX_LENGTH) })).valid).toBe(true);
    expect(validateProfileFields(fields({ displayName: 'A'.repeat(DISPLAY_NAME_MAX_LENGTH + 1) }))).toMatchObject({
      valid: false,
      errors: { displayName: expect.stringContaining('40') },
    });
    expect(validateProfileFields(fields({ statusMessage: '🌻'.repeat(STATUS_MESSAGE_MAX_LENGTH) })).valid).toBe(true);
    expect(validateProfileFields(fields({ statusMessage: 'A'.repeat(STATUS_MESSAGE_MAX_LENGTH + 1) }))).toMatchObject({
      valid: false,
      errors: { statusMessage: expect.stringContaining('160') },
    });
  });

  test('accepts optional and Unicode status text', () => {
    expect(validateProfileFields(fields({ statusMessage: '' })).valid).toBe(true);
    expect(validateProfileFields(fields({ statusMessage: 'こんにちは 🌻 — café' })).valid).toBe(true);
  });

  test.each(['name\u0000suffix', 'name\nnext line', '\tname', 'name\u0085suffix'])(
    'rejects control characters in editable text', (value) => {
      expect(validateProfileFields(fields({ displayName: value }))).toMatchObject({ valid: false, errors: { displayName: expect.any(String) } });
      expect(validateProfileFields(fields({ statusMessage: value }))).toMatchObject({ valid: false, errors: { statusMessage: expect.any(String) } });
    }
  );

  test('rejects avatars outside the built-in set and invalid presence preferences', () => {
    expect(validateProfileFields(fields({ avatar: 'https://example.test/avatar.png' as ProfileAvatarId })))
      .toMatchObject({ valid: false, errors: { avatar: expect.any(String) } });
    expect(validateProfileFields(fields({ presencePreference: 'online' as PresencePreference })))
      .toMatchObject({ valid: false, errors: { presencePreference: expect.any(String) } });
  });

  test.each(PRESENCE_OPTIONS)('accepts the $label local presence preference', ({ value }) => {
    expect(validateProfileFields(fields({ presencePreference: value })).valid).toBe(true);
  });
});
