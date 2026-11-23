import type { AuthUser } from '@/auth/authModel';
import type { AuthService } from '@/auth/authService';
import type { Room } from 'livekit-client';
import {ApiError,type SessionApi} from '@/api/sessionApi';
import { LIVEKIT_CALL_ID, LIVEKIT_CALL_TOKEN_PATH, LIVEKIT_ROOM_ID, LIVEKIT_TOKEN_PATH, parseLiveKitUrl, type LiveKitConnectionDetails } from '../../../shared/livekit';

export type LiveKitErrorCode = 'disabled' | 'configuration_missing' | 'authentication_required' | 'csrf_unavailable' |
  'room_forbidden' | 'rate_limited' | 'unavailable' | 'invalid_response' | 'connection_failed' | 'cancelled' | 'media_in_use';
export type LiveKitStatus = 'disabled' | 'disconnected' | 'requesting-token' | 'connecting' | 'connected' | 'reconnecting' | 'error';
export interface LiveKitSnapshot { status: LiveKitStatus; roomId: string | null; error: LiveKitErrorCode | null }
const messages: Record<LiveKitErrorCode, string> = {
  media_in_use: 'Call media is active on another device.',
  disabled: 'Live voice is disabled.', configuration_missing: 'Live voice is not configured.',
  authentication_required: 'Sign in with a real account before connecting to voice.', csrf_unavailable: 'Your session could not be verified. Sign in again.',
  room_forbidden: 'You do not have access to this voice room.', rate_limited: 'Too many voice requests. Try again shortly.',
  unavailable: 'The voice service is unavailable.', invalid_response: 'The voice connection details could not be verified.',
  connection_failed: 'The voice connection failed. Check your connection and try again.', cancelled: 'The voice connection was cancelled.',
};
export class LiveKitConnectionError extends Error {
  readonly code: LiveKitErrorCode;
  constructor(code: LiveKitErrorCode) { super(messages[code]); this.name = 'LiveKitConnectionError'; this.code = code; }
}

/** Small SDK boundary for deterministic lifecycle tests; no media is enabled by connecting. */
export interface LiveKitRoomPort {
  readonly media?: Room;
  readonly state: string;
  connect(url: string, token: string): Promise<unknown>;
  disconnect(stopTracks?: boolean): Promise<void> | void;
  on(event: 'connectionStateChanged', listener: (state: string) => void): unknown;
  off(event: 'connectionStateChanged', listener: (state: string) => void): unknown;
}
interface ConnectionOptions {
  requestToken?: (roomId:string,connectionId:string,signal:AbortSignal)=>Promise<unknown>;
  purpose?: 'voice-room' | 'direct-call';
  getConnectionId?: () => string | null;
  user: AuthUser | null;
  authMode: AuthService['mode'];
  enabled: boolean;
  serverUrl: string | undefined;
  getCsrfToken: () => string | null;
  onAuthenticationRequired?: () => void;
  fetch?: typeof fetch;
  createRoom?: () => Promise<LiveKitRoomPort>;
  timeoutMs?: number;
}

function parseDetails(input: unknown, roomId: string, serverUrl: string, directCall: boolean): LiveKitConnectionDetails {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new LiveKitConnectionError('invalid_response');
  const value = input as Record<string, unknown>;
  if (value.roomId !== roomId || value.serverUrl !== serverUrl || typeof value.roomName !== 'string' || !(directCall ? /^direct:[a-f0-9]{64}$/ : /^voice:[a-f0-9]{64}$/).test(value.roomName) ||
      typeof value.participantIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(value.participantIdentity) ||
      typeof value.token !== 'string' || value.token.length > 12_000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.token) ||
      typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) {
    throw new LiveKitConnectionError('invalid_response');
  }
  if (directCall && (typeof value.peerIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(value.peerIdentity) || value.peerIdentity === value.participantIdentity)) throw new LiveKitConnectionError('invalid_response');
  return { roomId, serverUrl, roomName: value.roomName, participantIdentity: value.participantIdentity, token: value.token, expiresAt: value.expiresAt,
    ...(directCall ? { peerIdentity: value.peerIdentity as string } : {}) };
}

/** One instance per authenticated session. Tokens are never written to persistent browser storage. */
export class LiveKitConnectionService {
  readonly #options: ConnectionOptions;
  readonly #url: string | null;
  readonly #disabled: LiveKitErrorCode | null;
  #snapshot: LiveKitSnapshot;
  #listeners = new Set<(state: LiveKitSnapshot) => void>();
  #room: LiveKitRoomPort | null = null;
  #unbind: (() => void) | null = null;
  #abort: AbortController | null = null;
  #generation = 0;
  #disposed = false;
  #participantIds: ReadonlySet<string> | null = null;

  constructor(options: ConnectionOptions) {
    this.#options = options;
    this.#url = parseLiveKitUrl(options.serverUrl, process.env.NODE_ENV !== 'production');
    this.#disabled = !options.enabled ? 'disabled'
      : options.authMode !== 'api' || !options.user || options.user.isDemo !== false ||
        options.user.id === 'local-user' || /^demo[-_:]/i.test(options.user.id) ? 'authentication_required'
        : !this.#url ? 'configuration_missing' : null;
    this.#snapshot = { status: this.#disabled ? 'disabled' : 'disconnected', roomId: null, error: this.#disabled };
  }

  getSnapshot = (): LiveKitSnapshot => ({ ...this.#snapshot });
  subscribe = (listener: (state: LiveKitSnapshot) => void): (() => void) => {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };
  /** For a future media renderer; ownership/disposal stays with this service. */
  getRoom(): LiveKitRoomPort | null { return this.#room; }
  getParticipantIds(): ReadonlySet<string> | null { return this.#participantIds; }

  #publish(state: LiveKitSnapshot): void {
    this.#snapshot = state;
    for (const listener of this.#listeners) {
      try { listener(this.getSnapshot()); } catch { /* One consumer cannot interrupt the lifecycle. */ }
    }
  }
  async #release(): Promise<void> {
    this.#abort?.abort(); this.#abort = null;
    this.#unbind?.(); this.#unbind = null;
    const room = this.#room; this.#room = null;
    this.#participantIds = null;
    try { await room?.disconnect(true); } catch { /* SDK diagnostics can contain connection details. */ }
  }

  async #token(roomId: string, signal: AbortSignal): Promise<LiveKitConnectionDetails> {
    if(this.#options.purpose==='direct-call'&&this.#options.requestToken){
      const id=this.#options.getConnectionId?.();if(!id)throw new LiveKitConnectionError('authentication_required');
      try{return parseDetails(await this.#options.requestToken(roomId,id,signal),roomId,this.#url!,true);}
      catch(error){
        if(error instanceof LiveKitConnectionError)throw error;
        if(error instanceof ApiError){
          const code=error.code==='unauthorized'?'authentication_required':error.code==='csrf_invalid'?'csrf_unavailable':error.code==='cancelled'?'cancelled':
            error.code==='conflict'?'media_in_use':error.code==='forbidden'||error.code==='not_found'?'room_forbidden':error.code==='rate_limited'?'rate_limited':'unavailable';
          throw new LiveKitConnectionError(code);
        }throw new LiveKitConnectionError('unavailable');
      }
    }
    let csrf: string | null;
    try { csrf = this.#options.getCsrfToken(); } catch { throw new LiveKitConnectionError('csrf_unavailable'); }
    if (!csrf || !/^[\x21-\x7e]{1,512}$/.test(csrf)) throw new LiveKitConnectionError('csrf_unavailable');
    const directCall = this.#options.purpose === 'direct-call';
    const connectionId = directCall ? this.#options.getConnectionId?.() : null;
    if (directCall && (!connectionId || !/^[^\s\u0000-\u001f]{1,256}$/.test(connectionId))) throw new LiveKitConnectionError('authentication_required');
    const response = await (this.#options.fetch ?? globalThis.fetch)(directCall ? LIVEKIT_CALL_TOKEN_PATH : LIVEKIT_TOKEN_PATH, {
      method: 'POST', body: JSON.stringify(directCall ? { callId: roomId, connectionId } : { roomId }), signal, credentials: 'same-origin', mode: 'same-origin',
      redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    });
    if (response.status === 401) {
      try { this.#options.onAuthenticationRequired?.(); } catch { /* Session revalidation must not mask the failure. */ }
      throw new LiveKitConnectionError('authentication_required');
    }
    if (response.status === 403) throw new LiveKitConnectionError('room_forbidden');
    if (response.status === 409 && directCall) throw new LiveKitConnectionError('media_in_use');
    if (response.status === 429) throw new LiveKitConnectionError('rate_limited');
    if (!response.ok) throw new LiveKitConnectionError('unavailable');
    const body = await response.text();
    if (body.length > 16_384) throw new LiveKitConnectionError('invalid_response');
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw new LiveKitConnectionError('invalid_response'); }
    return parseDetails(parsed, roomId, this.#url!, directCall);
  }

  async connect(roomId: string): Promise<void> {
    if (this.#disposed) throw new LiveKitConnectionError('cancelled');
    if (this.#disabled) throw new LiveKitConnectionError(this.#disabled);
    if (!(this.#options.purpose === 'direct-call' ? LIVEKIT_CALL_ID : LIVEKIT_ROOM_ID).test(roomId)) throw new LiveKitConnectionError('room_forbidden');
    const generation = ++this.#generation;
    await this.#release();
    const current = () => !this.#disposed && generation === this.#generation;
    if (!current()) throw new LiveKitConnectionError('cancelled');
    const abort = new AbortController(); this.#abort = abort;
    this.#publish({ status: 'requesting-token', roomId, error: null });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort.signal.addEventListener('abort', () => reject(new LiveKitConnectionError('cancelled')), { once: true });
    });
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new LiveKitConnectionError('connection_failed')), this.#options.timeoutMs ?? 15_000);
    });
    const open = async () => {
      const details = await this.#token(roomId, abort.signal);
      if (!current()) throw new LiveKitConnectionError('cancelled');
      const room = this.#options.createRoom ? await this.#options.createRoom() : await createSdkRoom();
      if (!current()) { await room.disconnect(true); throw new LiveKitConnectionError('cancelled'); }
      this.#room = room;
      this.#participantIds = details.peerIdentity ? new Set([details.participantIdentity, details.peerIdentity]) : null;
      const changed = (state: string) => {
        if (!current()) return;
        const status = state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting'
          : state === 'reconnecting' || state === 'signalReconnecting' ? 'reconnecting' : 'disconnected';
        this.#publish({ status, roomId: status === 'disconnected' ? null : roomId, error: null });
      };
      room.on('connectionStateChanged', changed);
      this.#unbind = () => { room.off('connectionStateChanged', changed); };
      this.#publish({ status: 'connecting', roomId, error: null });
      await room.connect(details.serverUrl, details.token);
      if (!current()) { await room.disconnect(true); throw new LiveKitConnectionError('cancelled'); }
      if (room.state !== 'connected') throw new LiveKitConnectionError('connection_failed');
      if (details.peerIdentity && room.media?.localParticipant.identity !== details.participantIdentity) throw new LiveKitConnectionError('invalid_response');
      changed(room.state);
    };
    try { await Promise.race([open(), cancelled, deadline]); }
    catch (failure) {
      const error = failure instanceof LiveKitConnectionError ? failure : new LiveKitConnectionError('connection_failed');
      if (current()) {
        // Invalidate pending dynamic imports and SDK completions before releasing their resources.
        const failedGeneration = ++this.#generation;
        await this.#release();
        if (failedGeneration === this.#generation && !this.#disposed) this.#publish({ status: 'error', roomId: null, error: error.code });
      }
      throw error;
    } finally { clearTimeout(timer); }
  }

  async disconnect(): Promise<void> {
    const generation = ++this.#generation;
    await this.#release();
    if (generation === this.#generation) this.#publish({ status: this.#disabled ? 'disabled' : 'disconnected', roomId: null, error: this.#disabled });
  }
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#listeners.clear();
    await this.disconnect();
  }
}

async function createSdkRoom(): Promise<LiveKitRoomPort> {
  const sdk = new (await import('livekit-client')).Room({ adaptiveStream: true, dynacast: true,
    publishDefaults: { stopMicTrackOnMute: true } });
  return { media: sdk, get state() { return sdk.state; },
    connect: (url, token) => sdk.connect(url, token), disconnect: (stopTracks) => sdk.disconnect(stopTracks),
    on: (event, listener) => sdk.on(event, listener), off: (event, listener) => sdk.off(event, listener) };
}

/** Uses the existing cookie-session identity and CSRF bootstrap; never falls back to demo. */
export function createSessionLiveKitConnection(user: AuthUser | null, authMode: AuthService['mode'], onAuthenticationRequired?: () => void, purpose: 'voice-room' | 'direct-call' = 'voice-room', getConnectionId?: () => string | null,secure?:{api:SessionApi;enabled:boolean}) {
  const enabled = purpose === 'direct-call' ? process.env.NEXT_PUBLIC_DIRECT_CALLS_ENABLED ?? process.env.NEXT_PUBLIC_LIVEKIT_ENABLED : process.env.NEXT_PUBLIC_LIVEKIT_ENABLED;
  return new LiveKitConnectionService({ user, authMode, enabled: enabled === 'true'&&secure?.enabled!==false,
    purpose,
    ...(getConnectionId ? { getConnectionId } : {}),
    ...(secure&&purpose==='direct-call'?{requestToken:(callId:string,connectionId:string,signal:AbortSignal)=>secure.api.request('/api/calls/token',{method:'POST',body:{callId,connectionId},signal})}:{}),
    serverUrl: process.env.NEXT_PUBLIC_LIVEKIT_URL,
    getCsrfToken: () => typeof document === 'undefined' ? null : document.querySelector<HTMLMetaElement>('meta[name="secubuzz-csrf-token"]')?.content ?? null,
    ...(onAuthenticationRequired ? { onAuthenticationRequired } : {}) });
}
