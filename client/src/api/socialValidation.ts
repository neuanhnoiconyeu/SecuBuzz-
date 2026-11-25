import { ApiError } from './sessionApi';
import { PROFILE_AVATARS, validateProfileFields, type UserProfile } from '@/profiles/profileModel';
import type { FriendUser, UserSearchResult } from '@/friends/friendsModel';

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('invalid_response');
  return value as Record<string, unknown>;
}
export function resourceId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) || /^(?:demo[-_:]|local-user$)/i.test(value)) {
    throw new ApiError('invalid_response');
  }
  return value;
}
export function validAvatarUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && /^\/api\/users\/[A-Za-z0-9._:-]+\/avatar(?:\?v=[A-Za-z0-9_-]+)?$/.test(value)) return value;
  throw new ApiError('invalid_response');
}
export function publicUser(value: unknown): FriendUser {
  const user = record(value);
  if (typeof user.username !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,29}$/.test(user.username) ||
    typeof user.displayName !== 'string' || !user.displayName.trim() || [...user.displayName].length > 40 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(user.displayName) || !PROFILE_AVATARS.some(avatar => avatar.id === user.avatar)) {
    throw new ApiError('invalid_response');
  }
  const avatarUrl = validAvatarUrl(user.avatarUrl);
  // Project only the public identity. Never infer presence from a preference.
  return { id: resourceId(user.id), username: user.username, displayName: user.displayName, avatar: user.avatar as FriendUser['avatar'], ...(avatarUrl ? { avatarUrl } : {}) };
}
export function searchUser(value: unknown): UserSearchResult {
  const user = record(value);
  if (!['self', 'none', 'friend', 'incoming', 'outgoing'].includes(user.relationship as string)) throw new ApiError('invalid_response');
  const pending = user.relationship === 'incoming' || user.relationship === 'outgoing';
  if (!pending && user.requestId !== undefined) throw new ApiError('invalid_response');
  return { ...publicUser(user), relationship: user.relationship as UserSearchResult['relationship'],
    ...(pending ? { requestId: resourceId(user.requestId) } : {}) };
}
export function ownProfile(value: unknown, actor: { id: string; username: string }): UserProfile {
  const profile = record(value);
  const user = publicUser(profile);
  if (profile.isDemo !== false || user.id !== actor.id || user.username !== actor.username) throw new ApiError('invalid_response');
  const validated = validateProfileFields(profile as unknown as UserProfile);
  if (!validated.valid) throw new ApiError('invalid_response');
  return { ...user, ...validated.value, isDemo: false };
}
export function cursor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw new ApiError('invalid_response');
  return value;
}
export function revision(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,19}$/.test(value)) throw new ApiError('invalid_response');
  return value;
}
