import { callAdapter } from './adapterCall.ts';
import type { ServerClock } from './clock.ts';
import type { ResolvedRealtimeConfig } from './config.ts';
import type { ConnectionSecurityContext, HandshakeContext, RealtimeActor } from './contracts.ts';
import { extractSessionCookie } from './cookies.ts';
import { safeLog } from './logger.ts';
import { connectError, type ConnectErrorCode } from './protocol.ts';
import type { ConnectionRegistry, HandshakeGrant, RealtimeSocket } from './registry.ts';
import { isDemoIdentity, parseIdentifierList, parseSecurityDecision, parseSessionResolution } from './validation.ts';

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

function reject(code: ConnectErrorCode, reason: string): HandshakeOutcome {
  return { ok: false, code, reason };
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
      const context: HandshakeContext = Object.freeze({
        sessionToken: cookie.value,
        origin,
        remoteAddress: typeof socket.handshake.address === 'string' ? socket.handshake.address : '',
        userAgent: typeof userAgent === 'string' ? userAgent.slice(0, MAX_USER_AGENT) : null,
        secure: socket.handshake.secure === true,
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
      const timeout = budget();
      const loadedSequence = this.#deps.beginAccessLoad();
      const [conversations, blocked] = await Promise.all([
        callAdapter(() => listConversationIds(actor), timeout),
        callAdapter(() => listBlockedUserIds(actor), timeout),
      ]);
      if (!conversations.ok) return reject('REALTIME_UNAVAILABLE', `conversations_${conversations.reason}`);
      if (!blocked.ok) return reject('REALTIME_UNAVAILABLE', `blocks_${blocked.reason}`);
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
        }),
      };
    } finally {
      registry.pendingHandshakes -= 1;
    }
  }
}
