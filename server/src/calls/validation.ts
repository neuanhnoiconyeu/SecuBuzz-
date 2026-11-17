import { hasOnlyKeys, isDemoIdentity, isDisplayName, isIdentifier, isPlainObject } from '../realtime/validation.ts';
import type { CallParticipant, InitiateCallBody } from './protocol.ts';

export function parseInitiateCall(value: unknown): InitiateCallBody | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['requestId', 'conversationId', 'recipientId', 'kind']) ||
    !isIdentifier(value.requestId) || !isIdentifier(value.conversationId) || !isIdentifier(value.recipientId) ||
    (value.kind !== 'voice' && value.kind !== 'video')) return null;
  return { requestId: value.requestId, conversationId: value.conversationId, recipientId: value.recipientId, kind: value.kind };
}
export function parseCallAction(value: unknown): { callId: string } | null {
  return isPlainObject(value) && hasOnlyKeys(value, ['callId']) && isIdentifier(value.callId) ? { callId: value.callId } : null;
}
export const isCallSyncBody = (value: unknown): boolean => isPlainObject(value) && hasOnlyKeys(value, []);
export function parseDirectParticipants(value: unknown, conversationId: string, actorId: string, peerId: string): readonly CallParticipant[] | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['conversationId', 'type', 'participants']) || value.conversationId !== conversationId || value.type !== 'direct' ||
    !Array.isArray(value.participants) || value.participants.length !== 2) return null;
  const people: CallParticipant[] = [];
  for (const person of value.participants) {
    if (!isPlainObject(person) || !hasOnlyKeys(person, ['userId', 'displayName']) || !isIdentifier(person.userId) || isDemoIdentity(person.userId) || !isDisplayName(person.displayName)) return null;
    people.push(Object.freeze({ userId: person.userId, displayName: person.displayName }));
  }
  return actorId !== peerId && people.some(person => person.userId === actorId) && people.some(person => person.userId === peerId) ? Object.freeze(people) : null;
}
