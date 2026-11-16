import type { RealtimeClient, RealtimeEvent } from '@/realtime/realtimeModel';
import type { AuthUser } from '@/auth/authModel';
import { LiveKitConnectionService } from '@/voice/livekitConnection';
import { CALL_CLIENT_EVENTS as C, type CallClientEventName, type CallSnapshot } from '../../../shared/directCalls';
import type { CallSignalingPort } from '@/calls/callSignaling';
import { TestVoiceRoom, voiceUser } from './liveVoiceFixture';

export const callId = '11111111-2222-4333-8444-555555555555';
export const alice = { ...voiceUser, id: 'alice', displayName: 'Alice' };
export const bob = { ...voiceUser, id: 'bob', displayName: 'Bob' };
export const identity = (id: string) => (id === alice.id ? 'a' : 'b').repeat(64);

/** Test-only signaling broker. Application code never imports fabricated signaling or SDK tracks. */
export class CallTestBroker {
  call: CallSnapshot | null = null;
  readonly clients: CallTestClient[] = [];
  emit(call: CallSnapshot) { this.call = call; for (const client of this.clients) client.state(call); }
  client(user: AuthUser) { const client = new CallTestClient(user, this); this.clients.push(client); return client; }
  async request(actor: string, event: CallClientEventName, body: unknown) {
    if (event === C.sync) return { status: 'ok', calls: this.call ? [this.call] : [] };
    if (event === C.initiate) {
      const input = body as { kind: 'voice' | 'video' };
      const timestamp = new Date().toISOString();
      this.emit({ callId, conversationId: 'dm-ab', caller: { userId: actor, displayName: actor === 'alice' ? 'Alice' : 'Bob' },
        recipient: { userId: actor === 'alice' ? 'bob' : 'alice', displayName: actor === 'alice' ? 'Bob' : 'Alice' },
        kind: input.kind, status: 'ringing', revision: 1, createdAt: timestamp, updatedAt: timestamp,
        ringExpiresAt: new Date(Date.now() + 30_000).toISOString(), acceptedAt: null, endedAt: null, reason: null });
    } else if (this.call) {
      const timestamp = new Date().toISOString();
      const status = event === C.accept ? 'accepted' : event === C.decline ? 'declined' : event === C.cancel ? 'cancelled' : 'ended';
      this.emit({ ...this.call, status, revision: this.call.revision + 1, updatedAt: timestamp,
        acceptedAt: status === 'accepted' ? timestamp : this.call.acceptedAt, endedAt: status === 'accepted' ? null : timestamp,
        reason: status === 'accepted' ? null : status });
    }
    return { status: 'ok', call: this.call };
  }
}
export class CallTestClient {
  readonly actorId: string;
  readonly mode = 'realtime' as const;
  status: 'connected' | 'reconnecting' | 'disconnected' = 'connected';
  readonly listeners = new Set<(event: RealtimeEvent) => void>();
  readonly callListeners = new Set<(event: 'state' | 'cleared', payload: unknown) => void>();
  readonly calls: CallSignalingPort & { request: jest.Mock };
  constructor(user: AuthUser, broker: CallTestBroker) {
    this.actorId = user.id;
    this.calls = { getConnectionId: () => `${user.id}-socket`, request: jest.fn(async (event, body) => {
      if (this.status !== 'connected') throw new Error('Signaling unavailable');
      return broker.request(user.id, event, body);
    }), subscribe: listener => { this.callListeners.add(listener); return () => { this.callListeners.delete(listener); }; } };
  }
  getStatus = () => this.status;
  subscribe = (listener: (event: RealtimeEvent) => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  state(call: CallSnapshot) { for (const listener of this.callListeners) listener('state', call); }
  changeStatus(status: typeof this.status) { this.status = status; for (const listener of this.listeners) listener({ type: 'connection', status }); }
  port() { return this as unknown as RealtimeClient; }
}
export function callMediaService(user: AuthUser, room = new TestVoiceRoom()) {
  room.localParticipant.identity = identity(user.id);
  const fetchToken = jest.fn(async (_url: RequestInfo | URL, options?: RequestInit) => ({ status: 200, ok: true, text: async () => JSON.stringify({
    roomId: JSON.parse(options?.body as string).callId, roomName: `direct:${'d'.repeat(64)}`, participantIdentity: identity(user.id),
    peerIdentity: identity(user.id === 'alice' ? 'bob' : 'alice'), serverUrl: 'wss://media.example.invalid/', token: 'header.payload.signature',
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  }) } as Response));
  const service = new LiveKitConnectionService({ user, authMode: 'api', enabled: true, serverUrl: 'wss://media.example.invalid', purpose: 'direct-call',
    getCsrfToken: () => 'csrf', getConnectionId: () => `${user.id}-socket`, createRoom: async () => room.port(), fetch: fetchToken });
  return { service, room, fetchToken };
}
