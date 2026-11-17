import type { DirectConversation, EnvelopeV2 } from '@/security/e2ee/model';
import type { AuthenticatedSocketOptions, LiveHandlers } from '../AuthenticatedSocketIoClient';
import type { SocketPort } from '../SocketIoRealtimeClient';
export const conversation: DirectConversation = { id: 'conversation-1', type: 'direct', participants: [
  { id: 'alice', username: 'alice', displayName: 'Alice', avatar: 'cat' }, { id: 'bob', username: 'bob', displayName: 'Bob', avatar: 'cat' },
], createdAt: '2026-11-16T12:00:00.000Z', updatedAt: '2026-11-16T12:00:00.000Z', interactionAllowed: true };
export const envelope: EnvelopeV2 = { id: 'wire-1', conversationId: conversation.id, senderId: 'alice', senderName: 'Alice',
  timestamp: conversation.createdAt, type: 'text', encryption: { version: 2, algorithm: 'AES-256-GCM', encoding: 'base64',
    keyId: 'AAAAAAAAAAAAAAAAAAAAAA', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' } };
export const ack = { conversationId: conversation.id, messageId: envelope.id, status: 'sent', timestamp: envelope.timestamp };
export const proof = { csrfToken: 'A'.repeat(43) };
export const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
export class FakeSocket implements SocketPort {
  connected = false;
  io = { on: jest.fn(), off: jest.fn(), reconnection: jest.fn() };
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  volatile = { emit: jest.fn() };
  emit = jest.fn((_event: string, _body: unknown, _ack?: (value: unknown) => void) => {});
  constructor(readonly options: AuthenticatedSocketOptions, private auto = true) {}
  on(event: string, fn: (...args: unknown[]) => void) { const entries = this.listeners.get(event) ?? new Set(); entries.add(fn); this.listeners.set(event, entries); }
  off(event: string, fn: (...args: unknown[]) => void) { this.listeners.get(event)?.delete(fn); }
  fire(event: string, ...args: unknown[]) { for (const fn of [...this.listeners.get(event) ?? []]) fn(...args); }
  connect() { if (this.auto) { this.connected = true; this.fire('connect'); } }
  disconnect = jest.fn(() => { const was = this.connected; this.connected = false; if (was) this.fire('disconnect', 'io client disconnect'); });
  drop() { this.connected = false; this.fire('disconnect', 'transport close'); }
}
export function handlers(): LiveHandlers {
  return { connection: jest.fn(), message: jest.fn().mockResolvedValue(true), keys: jest.fn(), receipt: jest.fn(),
    typing: jest.fn(), presence: jest.fn(), updated: jest.fn() };
}
