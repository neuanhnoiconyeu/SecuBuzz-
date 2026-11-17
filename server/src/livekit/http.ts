import type { IncomingMessage, ServerResponse } from 'node:http';
import { LIVEKIT_CALL_ID, LIVEKIT_CALL_TOKEN_PATH, LIVEKIT_ROOM_ID, LIVEKIT_TOKEN_PATH } from '../../../shared/livekit.ts';
import type { RealtimeServerHandle } from '../realtime/server.ts';
import { callAdapter } from '../realtime/adapterCall.ts';
import { normalizeOrigin } from '../realtime/config.ts';
import type { RealtimeActor, RealtimeAuthorizer, SessionResolver } from '../realtime/contracts.ts';
import { COOKIE_NAME, extractSessionCookie } from '../realtime/cookies.ts';
import { TokenBucket } from '../realtime/rateLimiter.ts';
import { isDemoIdentity, isIdentifier, parseIdentifierList, parseSessionResolution } from '../realtime/validation.ts';
import type { LiveKitConfig, LiveKitRoomAccess } from './config.ts';

export interface LiveKitHttpOptions {
  readonly directCalls?: Pick<RealtimeServerHandle, 'authorizeCallMedia'>;
  readonly config: LiveKitConfig;
  readonly allowedOrigins: readonly string[];
  readonly sessionCookieName?: string;
  readonly sessionResolver?: SessionResolver;
  readonly authorizer?: RealtimeAuthorizer;
  /** Same session-bound CSRF verifier used by the application's authenticated HTTP APIs. */
  readonly verifyCsrf?: (request: IncomingMessage, actor: RealtimeActor) => Promise<boolean>;
  /** Voice-specific group/block policy, supplied by its owner; missing fails closed. */
  readonly authorizeRoom?: (actor: RealtimeActor, room: LiveKitRoomAccess) => Promise<boolean>;
  readonly adapterTimeoutMs?: number;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}

function readRoomId(request: IncomingMessage, directCall = false, captureConnection?: (id: string) => void): Promise<string | null> {
  return new Promise((resolve) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (roomId: string | null) => {
      clearTimeout(timer);
      request.off('data', data); request.off('end', end); request.off('error', failed); request.off('aborted', failed);
      if (!request.readableEnded) request.resume();
      resolve(roomId);
    };
    const failed = () => finish(null);
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1_024) { finish(null); return; }
      chunks.push(chunk);
    };
    const end = () => {
      try {
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const key = directCall ? 'callId' : 'roomId';
        const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : null;
        const connectionId = input && typeof input === 'object' ? (input as Record<string, unknown>).connectionId : null;
        if (input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === (directCall ? 2 : 1) &&
            (!directCall || isIdentifier(connectionId)) &&
            typeof value === 'string' && (directCall ? LIVEKIT_CALL_ID : LIVEKIT_ROOM_ID).test(value)) {
          if (directCall) captureConnection?.(connectionId as string);
          finish(value); return;
        }
      } catch { /* Invalid JSON is never echoed to the caller. */ }
      finish(null);
    };
    const timer = setTimeout(failed, 5_000); timer.unref();
    request.on('data', data); request.on('end', end); request.on('error', failed); request.on('aborted', failed);
  });
}

/** Mount before JSON body parsing. Never accepts a caller-selected identity or arbitrary media room. */
export function createLiveKitHttpHandler(options: LiveKitHttpOptions) {
  const origins = new Set(options.allowedOrigins.map(normalizeOrigin));
  const cookieName = options.sessionCookieName ?? 'secubuzz_session';
  const timeout = options.adapterTimeoutMs ?? 4_000;
  if (!COOKIE_NAME.test(cookieName) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 4_000) {
    throw new TypeError('Invalid LiveKit HTTP configuration.');
  }
  // A bounded process-wide budget supplements the host API's own request limits.
  const tokens = new TokenBucket({ capacity: 30, refillPerSecond: 2 });
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = (request as IncomingMessage & { originalUrl?: string }).originalUrl ?? request.url ?? '';
    const directCall = path.split('?')[0] === LIVEKIT_CALL_TOKEN_PATH;
    if (!directCall && path.split('?')[0] !== LIVEKIT_TOKEN_PATH) return false;
    const reject = (status: number, error: string): true => { json(response, status, { error }); return true; };
    try {
      if (request.method !== 'POST') { response.setHeader('allow', 'POST'); return reject(405, 'method_not_allowed'); }
      const { sessionResolver, authorizer, verifyCsrf, authorizeRoom, config } = options;
      if (!(directCall ? config.directCallsReady && options.directCalls : config.status === 'ready' && authorizeRoom) || !sessionResolver || !authorizer || !verifyCsrf) {
        return reject(503, 'livekit_unavailable');
      }
      const origin = request.headers.origin;
      if (!origin || !origins.has(origin) || request.headers['sec-fetch-site'] === 'cross-site') return reject(403, 'origin_denied');
      if (!tokens.take()) return reject(429, 'rate_limited');
      const cookie = extractSessionCookie(request.headers.cookie, cookieName);
      if (cookie.status !== 'present') return reject(401, 'authentication_required');
      const context = { sessionToken: cookie.value, origin, remoteAddress: request.socket.remoteAddress ?? '',
        userAgent: request.headers['user-agent'] ?? null, secure: 'encrypted' in request.socket && request.socket.encrypted === true,
        receivedAt: new Date() };
      const authenticate = async () => {
        const result = await callAdapter(() => sessionResolver.resolveSession({ ...context, receivedAt: new Date() }), timeout);
        return result.ok ? parseSessionResolution(result.value) : null;
      };
      const resolution = await authenticate();
      if (!resolution) return reject(503, 'authentication_unavailable');
      if (resolution.status !== 'authenticated' || resolution.session.expiresAt.getTime() <= Date.now() + 1_000 ||
          isDemoIdentity(resolution.session.userId)) return reject(401, 'authentication_required');
      const actor: RealtimeActor = Object.freeze({ userId: resolution.session.userId,
        sessionId: resolution.session.sessionId, displayName: resolution.session.displayName });
      const csrfHeader = request.headers['x-csrf-token'];
      if (typeof csrfHeader !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(csrfHeader)) return reject(403, 'csrf_denied');
      const csrf = await callAdapter(() => verifyCsrf(request, actor), timeout);
      if (!csrf.ok) return reject(503, 'authentication_unavailable');
      if (csrf.value !== true) return reject(403, 'csrf_denied');
      if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return reject(415, 'invalid_payload');
      const length = request.headers['content-length'];
      if (length && (!/^\d+$/.test(length) || Number(length) > 1_024)) return reject(413, 'invalid_payload');
      let connectionId = '';
      const roomId = await readRoomId(request, directCall, id => { connectionId = id; });
      if (!roomId) return reject(400, 'invalid_payload');
      if (directCall) {
        const result = await callAdapter(() => options.directCalls!.authorizeCallMedia(actor, roomId, connectionId), timeout);
        if (!result.ok) return reject(503, 'authorization_unavailable');
        const grant = result.value;
        if (grant && 'status' in grant && grant.status === 'media_in_use') return reject(409, 'media_in_use');
        if (grant && 'status' in grant && grant.status === 'media_unavailable') return reject(503, 'livekit_unavailable');
        if (grant && 'status' in grant) return reject(403, 'call_forbidden');
        if (!grant || !grant.current()) return reject(403, 'call_forbidden');
        const active = await authenticate();
        if (!active || active.status !== 'authenticated' || active.session.userId !== actor.userId || active.session.sessionId !== actor.sessionId ||
          active.session.expiresAt.getTime() <= Date.now() + 1000) return reject(401, 'authentication_required');
        const details = await config.issueDirectCallToken(grant.call, actor, active.session.expiresAt);
        if (!grant.current()) return reject(403, 'call_forbidden');
        json(response, 200, details); return true;
      }
      const room = config.room(roomId);
      if (!room) return reject(403, 'room_forbidden');
      const access = await callAdapter(() => authorizer.listConversationIds(actor), timeout);
      const grants = access.ok ? parseIdentifierList(access.value, 1_000) : null;
      if (!grants) return reject(503, 'authorization_unavailable');
      if (!grants.includes(room.conversationId)) return reject(403, 'room_forbidden');
      const policy = await callAdapter(() => authorizeRoom!(actor, room), timeout);
      if (!policy.ok) return reject(503, 'authorization_unavailable');
      if (policy.value !== true) return reject(403, 'room_forbidden');
      // Auth adapters may be slow. Recheck session revocation before minting a capability.
      const active = await authenticate();
      if (!active) return reject(503, 'authentication_unavailable');
      if (active.status !== 'authenticated' || active.session.userId !== actor.userId ||
          active.session.sessionId !== actor.sessionId || active.session.expiresAt.getTime() <= Date.now() + 1_000) {
        return reject(401, 'authentication_required');
      }
      json(response, 200, await config.issueToken(room.roomId, actor, active.session.expiresAt));
      return true;
    } catch { return reject(503, 'livekit_unavailable'); }
  };
}
