import { createHash } from 'node:crypto';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { LIVEKIT_CALL_ID, LIVEKIT_ROOM_ID, parseLiveKitUrl, type LiveKitConnectionDetails } from '../../../shared/livekit.ts';
import type { CallSnapshot } from '../calls/protocol.ts';
import type { RealtimeActor } from '../realtime/contracts.ts';
import { isDemoIdentity, isIdentifier } from '../realtime/validation.ts';

export interface LiveKitRoomAccess {
  readonly roomId: string;
  readonly conversationId: string;
  readonly roomName: string;
}

export function liveKitParticipantIdentity(actor: RealtimeActor): string {
  return createHash('sha256').update(JSON.stringify([actor.userId, actor.sessionId])).digest('hex');
}
export const directCallRoomName = (callId: string) => `direct:${createHash('sha256').update(callId).digest('hex')}`;
export const directCallParticipantIdentity = (callId: string, userId: string) => createHash('sha256').update(JSON.stringify([callId, userId])).digest('hex');

/** Private credentials stay out of JSON, inspection, responses and the frontend bundle. */
export class LiveKitConfig {
  readonly status: 'disabled' | 'unconfigured' | 'ready';
  readonly serverUrl: string | null;
  readonly directCallsReady: boolean;
  readonly #apiKey: string;
  readonly #apiSecret: string;
  readonly #rooms = new Map<string, LiveKitRoomAccess>();

  constructor(env: NodeJS.ProcessEnv) {
    this.serverUrl = parseLiveKitUrl(env.LIVEKIT_URL, env.NODE_ENV !== 'production');
    this.#apiKey = env.LIVEKIT_API_KEY ?? '';
    this.#apiSecret = env.LIVEKIT_API_SECRET ?? '';
    let validRooms = false;
    try {
      const rooms: unknown = JSON.parse(env.LIVEKIT_ROOM_CONVERSATIONS ?? '{}');
      if (rooms && typeof rooms === 'object' && !Array.isArray(rooms)) {
        const entries = Object.entries(rooms);
        validRooms = entries.length > 0 && entries.length <= 1_000 && entries.every(([id, conversation]) =>
          LIVEKIT_ROOM_ID.test(id) && isIdentifier(conversation) && !isDemoIdentity(conversation));
        if (validRooms) for (const [roomId, conversationId] of entries) {
          this.#rooms.set(roomId, Object.freeze({ roomId, conversationId: conversationId as string,
            roomName: `voice:${createHash('sha256').update(conversationId as string).digest('hex')}` }));
        }
      }
    } catch { /* Invalid configuration keeps the handler unavailable. */ }
    const credentialsValid = /^[\x21-\x7e]{1,256}$/.test(this.#apiKey) && /^[\x21-\x7e]{32,512}$/.test(this.#apiSecret);
    this.directCallsReady = env.LIVEKIT_ENABLED === 'true' && Boolean(this.serverUrl) && credentialsValid;
    this.status = env.LIVEKIT_ENABLED !== 'true' ? 'disabled'
      : this.serverUrl && credentialsValid && validRooms ? 'ready' : 'unconfigured';
  }

  room(roomId: string): LiveKitRoomAccess | null { return this.#rooms.get(roomId) ?? null; }

  createRoomService(): RoomServiceClient {
    if (!this.directCallsReady || !this.serverUrl) throw new Error('LiveKit unavailable.');
    return new RoomServiceClient(this.serverUrl.replace(/^ws/, 'http'), this.#apiKey, this.#apiSecret, { requestTimeout: 3 });
  }
  async issueDirectCallToken(call: CallSnapshot, actor: RealtimeActor, sessionExpiresAt: Date): Promise<LiveKitConnectionDetails> {
    const ttl = Math.min(30, Math.floor((sessionExpiresAt.getTime() - Date.now()) / 1000));
    if (!this.directCallsReady || !this.serverUrl || !LIVEKIT_CALL_ID.test(call.callId) || call.status !== 'accepted' || ttl < 1 ||
      ![call.caller.userId, call.recipient.userId].includes(actor.userId)) throw new Error('LiveKit unavailable.');
    const participantIdentity = directCallParticipantIdentity(call.callId, actor.userId);
    const peerId = actor.userId === call.caller.userId ? call.recipient.userId : call.caller.userId;
    const roomName = directCallRoomName(call.callId);
    const token = new AccessToken(this.#apiKey, this.#apiSecret, { identity: participantIdentity, name: actor.displayName, ttl });
    token.addGrant({ roomJoin: true, room: roomName, canSubscribe: true, canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE], canPublishData: false, canUpdateOwnMetadata: false });
    return { roomId: call.callId, roomName, participantIdentity, peerIdentity: directCallParticipantIdentity(call.callId, peerId),
      serverUrl: this.serverUrl, token: await token.toJwt(), expiresAt: new Date((Math.floor(Date.now() / 1000) + ttl) * 1000).toISOString() };
  }

  /** Internal signing primitive; the HTTP service must authenticate and authorize first. */
  async issueToken(roomId: string, actor: RealtimeActor, sessionExpiresAt: Date): Promise<LiveKitConnectionDetails> {
    const room = this.room(roomId);
    const ttl = Math.min(300, Math.floor((sessionExpiresAt.getTime() - Date.now()) / 1_000));
    if (this.status !== 'ready' || !this.serverUrl || !room || ttl < 1) throw new Error('LiveKit unavailable.');
    const participantIdentity = liveKitParticipantIdentity(actor);
    const token = new AccessToken(this.#apiKey, this.#apiSecret, { identity: participantIdentity, ttl });
    token.addGrant({ roomJoin: true, room: room.roomName, canSubscribe: true, canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA], canPublishData: false, canUpdateOwnMetadata: false });
    const expiresAt = new Date((Math.floor(Date.now() / 1_000) + ttl) * 1_000).toISOString();
    const signed = await token.toJwt();
    return { roomId, roomName: room.roomName, participantIdentity, serverUrl: this.serverUrl,
      token: signed, expiresAt };
  }
}

export const loadLiveKitConfig = (env: NodeJS.ProcessEnv): LiveKitConfig => new LiveKitConfig(env);
