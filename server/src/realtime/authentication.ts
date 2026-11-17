import { callAdapter } from './adapterCall.ts';
import type { ServerClock } from './clock.ts';
import type { ResolvedRealtimeConfig } from './config.ts';
import type { BoundConnection, ConnectionSecurityContext, HandshakeContext, MessageStore, PresencePreference, RealtimeActor } from './contracts.ts';
import { extractSessionCookie } from './cookies.ts';
import { safeLog } from './logger.ts';
import { connectError, type ConnectErrorCode } from './protocol.ts';
import type { ConnectionRegistry, HandshakeGrant, RealtimeSocket } from './registry.ts';
import { hasOnlyKeys, isDemoIdentity, isPlainObject, parseIdentifierList, parseSecurityDecision, parseSessionResolution } from './validation.ts';

export type HandshakeOutcome =
  | { readonly ok: true; readonly grant: HandshakeGrant }
  | { readonly ok: false; readonly code: ConnectErrorCode; readonly reason: string };

export interface AuthenticatorDependencies {
  readonly config: ResolvedRealtimeConfig;
  readonly registry: ConnectionRegistry;
  readonly clock: ServerClock;
  readonly isClosing: () => boolean;
  readonly isSessionRevoked: (sessionId: string) => boolean;
  /** Returns a new access sequence number; taken right before the authorizer is queried. */
  readonly beginAccessLoad: () => number;
}

export function isAllowedOrigin(config: ResolvedRealtimeConfig, origin: unknown): origin is string {
  return typeof origin === 'string' && config.allowedOrigins.has(origin);
}

const MAX_USER_AGENT = 512;
const MAX_CSRF_TOKEN = 512;

function reject(code: ConnectErrorCode, reason: string): HandshakeOutcome {
  return { ok: false, code, reason };
}

/**
 * `handshake.auth` in real-account mode is exactly `{ csrfToken: string }`, or empty. Any other
 * field (for example a client-asserted `userId`) is refused rather than silently ignored.
 */
function parseHandshakeAuth(auth: unknown): string | null | 'malformed' {
  if (auth === undefined || auth === null) return null;
  if (!isPlainObject(auth) || !hasOnlyKeys(auth, ['csrfToken'])) return 'malformed';
  const token = auth.csrfToken;
  if (token === undefined) return null;
  return typeof token === 'string' && token.length > 0 && token.length <= MAX_CSRF_TOKEN && /^[\x21-\x7e]+$/.test(token) ? token : 'malformed';
}

const PREFERENCES: ReadonlySet<unknown> = new Set(['available', 'away', 'busy', 'invisible']);

export function parsePresencePreference(value: unknown): PresencePreference | null | 'malformed' {
  if (value === null || value === undefined) return null;
  return PREFERENCES.has(value) ? value as PresencePreference : 'malformed';
}

function parseBoundConnection(value: unknown): BoundConnection | 'rejected' | 'malformed' {
  if (value === null) return 'rejected';
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['store'])) return 'malformed';
  const store = value.store as Record<string, unknown> | null;
  if (store === null || typeof store !== 'object' || typeof store.storeMessage !== 'function' ||
    typeof store.findMessage !== 'function' || typeof store.recordReceipt !== 'function') return 'malformed';
  return { store: value.store as MessageStore };
}

/**
 * Socket.IO namespace middleware. Authentication uses only the configured session cookie; the
 * handshake `auth` payload and query string are never read. One deadline covers every adapter call.
 */
export class HandshakeAuthenticator {
  readonly #deps: AuthenticatorDependencies;

  constructor(deps: AuthenticatorDependencies) {
    this.#deps = deps;
  }

  readonly middleware = (socket: RealtimeSocket, next: (error?: Error) => void): void => {
    this.authenticate(socket).then((outcome) => {
      if (!outcome.ok) {
        const level = outcome.code === 'REALTIME_UNAVAILABLE' ? 'warn' : 'info';
        safeLog(this.#deps.config.logger, level, 'realtime.connection.rejected', { code: outcome.code, reason: outcome.reason });
        next(connectError(outcome.code));
        return;
      }
      socket.data.realtime = outcome.grant;
      next();
    }, () => {
      safeLog(this.#deps.config.logger, 'error', 'realtime.connection.rejected', { code: 'REALTIME_UNAVAILABLE', reason: 'internal' });
      next(connectError('REALTIME_UNAVAILABLE'));
    });
  };

  async authenticate(socket: RealtimeSocket): Promise<HandshakeOutcome> {
    const { config, registry, clock } = this.#deps;
    const { limits, timing } = config;
    const started = clock.nowMs();
    const deadline = started + timing.handshakeTimeoutMs;
    const budget = () => Math.max(0, Math.min(timing.adapterTimeoutMs, deadline - clock.nowMs()));

    if (this.#deps.isClosing()) return reject('REALTIME_UNAVAILABLE', 'closing');
    const headers = socket.handshake.headers;
    const origin = headers.origin;
    if (!isAllowedOrigin(config, origin)) return reject('ORIGIN_NOT_ALLOWED', 'origin');
    const resolver = config.sessionResolver;
    const authorizer = config.authorizer;
    if (!resolver || !authorizer) return reject('REALTIME_UNAVAILABLE', 'not_configured');
    if (registry.pendingHandshakes >= limits.maxPendingHandshakes ||
      registry.connectionCount + registry.pendingHandshakes >= limits.maxConnections) {
      return reject('CONNECTION_LIMIT', 'capacity');
    }

    registry.pendingHandshakes += 1;
    try {
      const cookie = extractSessionCookie(headers.cookie, config.sessionCookieName);
      if (cookie.status === 'absent') return reject('AUTH_REQUIRED', 'cookie_absent');
      if (cookie.status === 'malformed') return reject('UNAUTHORIZED', 'cookie_malformed');

      const userAgent = headers['user-agent'];
      const remoteAddress = typeof socket.handshake.address === 'string' ? socket.handshake.address : '';
      const forwarded = headers['x-forwarded-proto'];
      const encrypted = socket.handshake.secure === true;
      const context: HandshakeContext = Object.freeze({
        sessionToken: cookie.value,
        origin,
        remoteAddress,
        userAgent: typeof userAgent === 'string' ? userAgent.slice(0, MAX_USER_AGENT) : null,
        // Direct TLS unless the composition attests a trusted-proxy boundary itself; never from raw headers.
        secure: config.resolveTransportSecurity
          ? config.resolveTransportSecurity({ remoteAddress, encrypted, forwardedProto: typeof forwarded === 'string' ? forwarded : null }) === true
          : encrypted,
        receivedAt: new Date(started),
      });
      const resolveSession = resolver.resolveSession.bind(resolver);
      const resolved = await callAdapter(() => resolveSession(context), budget());
      if (!resolved.ok) return reject('REALTIME_UNAVAILABLE', `resolver_${resolved.reason}`);
      const resolution = parseSessionResolution(resolved.value);
      if (!resolution) return reject('REALTIME_UNAVAILABLE', 'resolver_malformed');
      if (resolution.status === 'missing') return reject('AUTH_REQUIRED', 'session_missing');
      if (resolution.status === 'invalid') return reject('UNAUTHORIZED', 'session_invalid');
      if (resolution.status === 'expired') return reject('SESSION_EXPIRED', 'session_expired');

      const session = resolution.session;
      if (session.expiresAt.getTime() <= clock.nowMs()) return reject('SESSION_EXPIRED', 'session_expired');
      if (isDemoIdentity(session.userId)) {
        safeLog(config.logger, 'warn', 'realtime.connection.demo_identity_rejected', {});
        return reject('UNAUTHORIZED', 'demo_identity');
      }
      if (this.#deps.isSessionRevoked(session.sessionId)) return reject('UNAUTHORIZED', 'session_revoked');
      if (registry.connectionsForUser(session.userId) >= limits.maxConnectionsPerUser) {
        return reject('CONNECTION_LIMIT', 'user_capacity');
      }
      const actor: RealtimeActor = Object.freeze({
        userId: session.userId,
        sessionId: session.sessionId,
        displayName: session.displayName,
      });

      // Real-account mode: the handshake must prove the session's CSRF token, and the connection
      // receives its own bound store. Nothing is read from `auth` unless a binder is configured.
      let store: MessageStore | null = null;
      const binder = config.connectionBinder;
      if (binder) {
        const csrf = parseHandshakeAuth(socket.handshake.auth);
        if (csrf === 'malformed') return reject('UNAUTHORIZED', 'handshake_auth_shape');
        const bind = binder.bind.bind(binder);
        const bound = await callAdapter(() => bind(actor, Object.freeze({ sessionToken: context.sessionToken, csrfToken: csrf, remoteAddress: context.remoteAddress })), budget());
        if (!bound.ok) return reject('REALTIME_UNAVAILABLE', `binder_${bound.reason}`);
        const connection = parseBoundConnection(bound.value);
        if (connection === 'rejected') return reject('UNAUTHORIZED', csrf === null ? 'csrf_missing' : 'csrf_invalid');
        if (connection === 'malformed') return reject('REALTIME_UNAVAILABLE', 'binder_malformed');
        store = connection.store;
        // Re-check after the adapter: a logout may have happened while the proof was verified.
        if (this.#deps.isSessionRevoked(session.sessionId)) return reject('UNAUTHORIZED', 'session_revoked');
      }

      const policy = config.securityPolicy;
      if (policy?.evaluateConnection) {
        const securityContext: ConnectionSecurityContext = Object.freeze({
          actor,
          origin,
          remoteAddress: context.remoteAddress,
          userAgent: context.userAgent,
        });
        const evaluateConnection = policy.evaluateConnection.bind(policy);
        const evaluated = await callAdapter(() => evaluateConnection(securityContext), budget());
        if (!evaluated.ok) return reject('REALTIME_UNAVAILABLE', `policy_${evaluated.reason}`);
        const decision = parseSecurityDecision(evaluated.value);
        if (decision.action === 'deny') return reject('POLICY_DENIED', `policy_${decision.reason}`);
      }

      const listConversationIds = authorizer.listConversationIds.bind(authorizer);
      const listBlockedUserIds = authorizer.listBlockedUserIds.bind(authorizer);
      const loadPreference = authorizer.presencePreference?.bind(authorizer);
      const timeout = budget();
      const loadedSequence = this.#deps.beginAccessLoad();
      const [conversations, blocked, preference] = await Promise.all([
        callAdapter(() => listConversationIds(actor), timeout),
        callAdapter(() => listBlockedUserIds(actor), timeout),
        callAdapter(() => (loadPreference ? loadPreference(actor) : null), timeout),
      ]);
      if (!conversations.ok) return reject('REALTIME_UNAVAILABLE', `conversations_${conversations.reason}`);
      if (!blocked.ok) return reject('REALTIME_UNAVAILABLE', `blocks_${blocked.reason}`);
      // A hidden ("invisible") user must never be published as online, so an unreadable preference fails the handshake.
      if (!preference.ok) return reject('REALTIME_UNAVAILABLE', `preference_${preference.reason}`);
      const presencePreference = parsePresencePreference(preference.value);
      if (presencePreference === 'malformed') return reject('REALTIME_UNAVAILABLE', 'preference_malformed');
      const conversationIds = parseIdentifierList(conversations.value, limits.maxConversationsPerUser);
      if (!conversationIds) return reject('REALTIME_UNAVAILABLE', 'conversations_malformed');
      const blockedUserIds = parseIdentifierList(blocked.value, limits.maxBlockedUsersPerUser);
      if (!blockedUserIds) return reject('REALTIME_UNAVAILABLE', 'blocks_malformed');

      // Close the race with a logout or shutdown that happened while adapters were running.
      if (this.#deps.isSessionRevoked(session.sessionId)) return reject('UNAUTHORIZED', 'session_revoked');
      if (this.#deps.isClosing()) return reject('REALTIME_UNAVAILABLE', 'closing');
      if (session.expiresAt.getTime() <= clock.nowMs()) return reject('SESSION_EXPIRED', 'session_expired');

      return {
        ok: true,
        grant: Object.freeze({
          actor,
          expiresAt: session.expiresAt.getTime(),
          conversationIds: Object.freeze(conversationIds),
          blockedUserIds: Object.freeze(blockedUserIds),
          loadedSequence,
          store,
          presencePreference,
        }),
      };
    } finally {
      registry.pendingHandshakes -= 1;
    }
  }
}
