import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { Server, type DefaultEventsMap, type Namespace } from 'socket.io';
import { callAdapter, forEachLimited } from './adapterCall.ts';
import { HandshakeAuthenticator, isAllowedOrigin } from './authentication.ts';
import { rememberBounded } from './bounded.ts';
import { ServerClock } from './clock.ts';
import { resolveRealtimeConfig, type RealtimeServerOptions } from './config.ts';
import type { PresencePreference } from './contracts.ts';
import { EventGate, onceAck } from './eventGate.ts';
import { safeLog } from './logger.ts';
import { MessageRouter } from './messages.ts';
import { PresenceManager } from './presence.ts';
import { CLIENT_EVENT_NAMES, CLIENT_EVENTS, connectError, errorAck, SERVER_EVENTS, type ClientEventName } from './protocol.ts';
import { ReceiptRouter } from './receipts.ts';
import {
  ConnectionRegistry,
  createBuckets,
  type Connection,
  type RealtimeSocket,
  type RealtimeSocketData,
  type UserState,
} from './registry.ts';
import { conversationRoom, isConversationRoom, RoomManager } from './rooms.ts';
import { TypingRouter } from './typing.ts';
import {
  isDisplayName,
  isIdentifier,
  parseIdentifierList,
  parseMessageEnvelope,
  parsePresenceBody,
  parseReadBody,
  parseSessionCheck,
  parseTypingBody,
} from './validation.ts';

type RealtimeIo = Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, RealtimeSocketData>;
type RealtimeNamespace = Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, RealtimeSocketData>;

export interface RealtimeStats {
  readonly mode: 'fail-closed' | 'ready';
  readonly messageDelivery: 'disabled' | 'enabled';
  readonly closing: boolean;
  readonly connections: number;
  readonly users: number;
  readonly sessions: number;
  readonly pendingHandshakes: number;
  readonly conversationRooms: number;
  readonly presenceSubscriptions: number;
  readonly typingEntries: number;
  readonly pendingAcks: number;
  readonly pendingDeliveryAcks: number;
  readonly inFlightSends: number;
}

/** In-process API for the Database Team's auth, membership and profile integrations. */
export interface RealtimeServerHandle {
  /** Disconnects every connection of a session (logout, revocation). Returns the number closed. */
  revokeSession(sessionId: string): number;
  /** Disconnects every connection of a user (suspension, deletion). */
  disconnectUser(userId: string): number;
  /** Re-queries the authorizer for a connected user and applies grant, block and presence changes. */
  refreshUserAccess(userId: string): Promise<boolean>;
  /** Immediately removes one conversation grant from a connected user, without calling the authorizer. */
  revokeConversationAccess(userId: string, conversationId: string): boolean;
  /** Profile integration point for away/busy/invisible. */
  setPresencePreference(userId: string, preference: PresencePreference): void;
  /** Emits `conversation:updated` to the conversation room. Never changes membership. */
  notifyConversationUpdated(conversationId: string, update?: { readonly displayName?: string }): number;
  getStats(): RealtimeStats;
  /** Stops accepting handshakes and closes every transport. Leaves the HTTP server open. Idempotent. */
  close(): Promise<void>;
}

const MAX_TIMER_MS = 2_147_483_647;
const PRESENCE_PREFERENCES = new Set<PresencePreference>(['available', 'away', 'busy', 'invisible']);
const attachedServers = new WeakSet<HttpServer | HttpsServer>();

function invalidArgument(name: string): never {
  throw new TypeError(`Invalid ${name}.`);
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (predicate() || Date.now() - started >= timeoutMs) return resolve();
      setTimeout(check, 10).unref();
    };
    check();
  });
}

/**
 * Attaches the SecuBuzz realtime server to an existing Node.js HTTP(S) server.
 * Throws if the options are invalid or the same server was already attached.
 */
export function attachRealtimeServer(httpServer: HttpServer | HttpsServer, options: RealtimeServerOptions): RealtimeServerHandle {
  if (attachedServers.has(httpServer)) throw new Error('A realtime server is already attached to this HTTP server.');
  const config = resolveRealtimeConfig(options);
  const { limits, timing, logger } = config;
  const clock = new ServerClock(limits.maxTrackedTimestampKeys);
  const registry = new ConnectionRegistry();
  const revokedSessions = new Map<string, number>();
  let closing = false;
  let closed: Promise<void> | null = null;
  let revalidating = false;
  /**
   * Orders authorizer snapshots against revocations. A snapshot whose queries started before a
   * revocation (or before a newer snapshot) must not re-grant what was removed in the meantime.
   */
  let accessSequence = 0;
  const beginAccessLoad = (): number => ++accessSequence;
  const tombstoneTtlMs = timing.handshakeTimeoutMs + timing.adapterTimeoutMs + 5_000;
  /** userId → conversationId → removal recorded at `sequence`. */
  const grantTombstones = new Map<string, Map<string, { sequence: number; at: number }>>();

  const io: RealtimeIo = new Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, RealtimeSocketData>(httpServer, {
    path: config.path,
    serveClient: false,
    transports: ['polling', 'websocket'],
    allowEIO3: false,
    cookie: false,
    maxHttpBufferSize: limits.maxPayloadBytes,
    pingInterval: timing.pingIntervalMs,
    pingTimeout: timing.pingTimeoutMs,
    connectTimeout: timing.handshakeTimeoutMs + 2_000,
    // Credentialed CORS for the polling transport: only exact allowlisted origins are reflected.
    cors: {
      origin: (origin, callback) => callback(null, isAllowedOrigin(config, origin)),
      credentials: true,
      methods: ['GET', 'POST'],
    },
    // WebSocket upgrades are not covered by CORS, so every new engine session checks Origin here.
    allowRequest: (request, callback) => callback(null, !closing && isAllowedOrigin(config, request.headers.origin)),
  });
  attachedServers.add(httpServer);
  const nsp: RealtimeNamespace = io.of(config.namespace);
  if (config.namespace !== '/') io.of('/').use((_socket, next) => next(connectError('REALTIME_UNAVAILABLE')));

  const isSessionRevoked = (sessionId: string): boolean => {
    const revokedAt = revokedSessions.get(sessionId);
    return revokedAt !== undefined && clock.nowMs() - revokedAt < timing.revokedSessionTtlMs;
  };

  const terminate = (connection: Connection, reason: string): void => {
    if (connection.closed) return;
    safeLog(logger, 'info', 'realtime.connection.terminated', { reason });
    connection.socket.disconnect(true);
    // `disconnect` normally runs cleanup synchronously; this covers a socket that was already closing.
    cleanup(connection, reason);
  };

  const gate = new EventGate(config, terminate);
  const typing = new TypingRouter(nsp, registry, clock, timing.typingTtlMs);
  const rooms = new RoomManager((user, conversationId) => {
    const first = user.connections.values().next();
    if (!first.done) typing.clearUserInConversation(first.value.actor, conversationId);
  });
  const presence = new PresenceManager(config, registry, clock);
  const receipts = new ReceiptRouter(config, registry, clock, gate);
  const messages = new MessageRouter(config, registry, clock, gate, receipts, nsp.adapter);
  const authenticator = new HandshakeAuthenticator({
    config, registry, clock, isClosing: () => closing, isSessionRevoked, beginAccessLoad,
  });

  const recordTombstones = (userId: string, conversationIds: readonly string[], sequence: number): void => {
    if (conversationIds.length === 0) return;
    const entries = grantTombstones.get(userId) ?? new Map<string, { sequence: number; at: number }>();
    for (const id of conversationIds) {
      const latest = Math.max(sequence, entries.get(id)?.sequence ?? Number.NEGATIVE_INFINITY);
      rememberBounded(entries, id, { sequence: latest, at: clock.nowMs() }, limits.maxConversationsPerUser);
    }
    rememberBounded(grantTombstones, userId, entries, limits.maxRevokedSessions);
  };

  const pruneTombstones = (): void => {
    const oldest = clock.nowMs() - tombstoneTtlMs;
    for (const [userId, entries] of [...grantTombstones]) {
      for (const [id, entry] of [...entries]) if (entry.at < oldest) entries.delete(id);
      if (entries.size === 0) grantTombstones.delete(userId);
    }
  };

  const applyBlocked = (user: UserState, next: ReadonlySet<string>): void => {
    const { added, removed } = registry.replaceBlocked(user, next);
    for (const other of added) presence.revokePair(user.userId, other);
    for (const other of removed) {
      for (const connection of registry.user(other)?.connections ?? []) void presence.refilter(connection);
    }
  };

  /**
   * Applies an authorizer snapshot unless a newer one is already in effect. Conversations revoked
   * after the snapshot's queries started are excluded. Returns false for a stale snapshot.
   */
  const applySnapshot = (user: UserState, conversationIds: readonly string[], blockedUserIds: readonly string[], loadedSequence: number): boolean => {
    if (loadedSequence <= user.snapshotSequence) return false;
    const tombstones = grantTombstones.get(user.userId);
    const granted = conversationIds.filter((id) => {
      const removal = tombstones?.get(id);
      return removal === undefined || removal.sequence < loadedSequence;
    });
    const { removed } = rooms.applyGrants(user, new Set(granted));
    recordTombstones(user.userId, removed, loadedSequence);
    applyBlocked(user, new Set(blockedUserIds));
    user.snapshotSequence = loadedSequence;
    return true;
  };

  const scheduleExpiry = (connection: Connection): void => {
    if (connection.expiryTimer) clearTimeout(connection.expiryTimer);
    connection.expiryTimer = null;
    if (connection.closed) return;
    const delay = connection.expiresAt - clock.nowMs();
    if (delay <= 0) {
      terminate(connection, 'session_expired');
      return;
    }
    connection.expiryTimer = setTimeout(() => {
      connection.expiryTimer = null;
      scheduleExpiry(connection);
    }, Math.min(delay, MAX_TIMER_MS));
    connection.expiryTimer.unref();
  };

  function cleanup(connection: Connection, reason: string): void {
    if (connection.closed) return;
    connection.closed = true;
    if (connection.expiryTimer) clearTimeout(connection.expiryTimer);
    connection.expiryTimer = null;
    // Typing cleanup needs the user's block state, so it runs before the registry detaches the user.
    typing.clearConnection(connection);
    presence.removeConnection(connection);
    const { lastForUser } = registry.detach(connection);
    if (lastForUser) presence.publishStatus(connection.actor.userId);
    safeLog(logger, 'info', 'realtime.connection.closed', { reason, connections: registry.connectionCount });
  }

  const refreshUserAccess = async (userId: string): Promise<boolean> => {
    const user = registry.user(userId);
    const authorizer = config.authorizer;
    const first = user?.connections.values().next();
    if (!user || !authorizer || closing || !first || first.done) return false;
    const actor = first.value.actor;
    const listConversationIds = authorizer.listConversationIds.bind(authorizer);
    const listBlockedUserIds = authorizer.listBlockedUserIds.bind(authorizer);
    const loadedSequence = beginAccessLoad();
    const [conversations, blocked] = await Promise.all([
      callAdapter(() => listConversationIds(actor), timing.adapterTimeoutMs),
      callAdapter(() => listBlockedUserIds(actor), timing.adapterTimeoutMs),
    ]);
    if (closing || registry.user(userId) !== user || loadedSequence <= user.snapshotSequence) return false;
    const conversationIds = conversations.ok ? parseIdentifierList(conversations.value, limits.maxConversationsPerUser) : null;
    const blockedUserIds = blocked.ok ? parseIdentifierList(blocked.value, limits.maxBlockedUsersPerUser) : null;
    if (!conversationIds || !blockedUserIds) {
      // Keep the last verified grants: nothing is granted on failure, explicit revocation stays immediate.
      safeLog(logger, 'warn', 'realtime.access.refresh_failed', {
        conversations: conversations.ok ? (conversationIds ? 'ok' : 'malformed') : conversations.reason,
        blocks: blocked.ok ? (blockedUserIds ? 'ok' : 'malformed') : blocked.reason,
      });
      return false;
    }
    applySnapshot(user, conversationIds, blockedUserIds, loadedSequence);
    await Promise.all([...user.connections].map((connection) => presence.refilter(connection)));
    return true;
  };

  const revalidate = async (): Promise<void> => {
    if (revalidating || closing) return;
    revalidating = true;
    try {
      const resolver = config.sessionResolver;
      if (resolver?.checkSession) {
        const checkSession = resolver.checkSession.bind(resolver);
        await forEachLimited(registry.sessionReferences(), 8, async (reference) => {
          const result = await callAdapter(() => checkSession(Object.freeze({ ...reference })), timing.adapterTimeoutMs);
          if (closing) return;
          const check = result.ok ? parseSessionCheck(result.value) : null;
          if (!check) {
            safeLog(logger, 'warn', 'realtime.session.check_failed', { outcome: result.ok ? 'malformed' : result.reason });
            return;
          }
          for (const connection of registry.sessionConnections(reference.sessionId)) {
            if (check.status === 'active') {
              connection.expiresAt = check.expiresAt.getTime();
              scheduleExpiry(connection);
            } else {
              terminate(connection, check.status === 'expired' ? 'session_expired' : 'session_revoked');
            }
          }
          if (check.status === 'revoked') rememberBounded(revokedSessions, reference.sessionId, clock.nowMs(), limits.maxRevokedSessions);
        });
      }
      await forEachLimited(registry.allUsers().map((user) => user.userId), 8, async (userId) => {
        await refreshUserAccess(userId);
      });
    } finally {
      revalidating = false;
    }
  };

  const reply = (ack: ((response: unknown) => void) | null, response: unknown): void => {
    if (ack) onceAck(ack)(response);
  };

  const onTyping = (connection: Connection, args: unknown[], isTyping: boolean): void => {
    const event: ClientEventName = isTyping ? CLIENT_EVENTS.typingStart : CLIENT_EVENTS.typingStop;
    const parts = gate.split(connection, args, 'forbidden');
    if (!parts || !gate.admit(connection, 'typing')) return;
    const body = parseTypingBody(parts.body);
    if (!body) {
      gate.invalid(connection, 'typing_body');
      return;
    }
    if (!connection.user.conversations.has(body.conversationId)) return;
    if (!config.securityPolicy?.evaluateEvent) {
      typing.handle(connection, body.conversationId, isTyping);
      return;
    }
    // Keep start/stop ordering while an asynchronous policy decides.
    connection.typingChain = connection.typingChain.then(async () => {
      const decision = await gate.evaluate(connection, event, parts.body, { conversationId: body.conversationId });
      if (decision === 'allow') typing.handle(connection, body.conversationId, isTyping);
    });
  };

  const onPresenceSubscribe = (connection: Connection, args: unknown[]): void => {
    const parts = gate.split(connection, args, 'forbidden');
    if (!parts || !gate.admit(connection, 'presence')) return;
    const body = parsePresenceBody(parts.body, limits.maxPresenceSubjects);
    if (!body) {
      gate.invalid(connection, 'presence_body');
      return;
    }
    if (!config.securityPolicy?.evaluateEvent) {
      void presence.subscribe(connection, body.userIds);
      return;
    }
    // Policy decisions are serialized so a later request always reaches `subscribe` later and wins.
    connection.presenceChain = connection.presenceChain.then(async () => {
      const decision = await gate.evaluate(connection, CLIENT_EVENTS.presenceSubscribe, parts.body, { subjectCount: body.userIds.length });
      if (decision === 'allow' && !connection.closed) void presence.subscribe(connection, body.userIds);
    });
  };

  const onRead = async (connection: Connection, args: unknown[]): Promise<void> => {
    const parts = gate.split(connection, args, 'required');
    if (!parts) return;
    if (!gate.admit(connection, 'read')) return reply(parts.ack, errorAck('rate_limited'));
    const body = parseReadBody(parts.body);
    if (!body) {
      gate.invalid(connection, 'read_body');
      return reply(parts.ack, errorAck('invalid_payload'));
    }
    if (connection.pendingAcks >= limits.maxPendingAcksPerConnection) return reply(parts.ack, errorAck('rate_limited'));
    connection.pendingAcks += 1;
    try {
      reply(parts.ack, await receipts.handleRead(connection, body, parts.body));
    } catch {
      reply(parts.ack, errorAck('unavailable'));
    } finally {
      connection.pendingAcks -= 1;
    }
  };

  const onSend = async (connection: Connection, args: unknown[]): Promise<void> => {
    const parts = gate.split(connection, args, 'required');
    if (!parts) return;
    if (!gate.admit(connection, 'send')) return reply(parts.ack, errorAck('rate_limited'));
    const envelope = parseMessageEnvelope(parts.body, limits);
    if (!envelope) {
      gate.invalid(connection, 'send_body');
      return reply(parts.ack, errorAck('invalid_payload'));
    }
    if (connection.pendingAcks >= limits.maxPendingAcksPerConnection) return reply(parts.ack, errorAck('rate_limited'));
    connection.pendingAcks += 1;
    try {
      reply(parts.ack, await messages.handleSend(connection, envelope, parts.body));
    } catch {
      reply(parts.ack, errorAck('unavailable'));
    } finally {
      connection.pendingAcks -= 1;
    }
  };

  const onConnection = (socket: RealtimeSocket): void => {
    const grant = socket.data.realtime;
    if (!grant || closing) {
      socket.disconnect(true);
      return;
    }
    const { actor } = grant;
    if (isSessionRevoked(actor.sessionId) || grant.expiresAt <= clock.nowMs() ||
      registry.connectionCount >= limits.maxConnections || registry.connectionsForUser(actor.userId) >= limits.maxConnectionsPerUser) {
      safeLog(logger, 'warn', 'realtime.connection.rejected_late', {});
      socket.disconnect(true);
      return;
    }
    const now = clock.nowMs();
    const { user, created } = registry.ensureUser(actor.userId);
    // The newest authorizer snapshot wins for every connection of the user; a stale handshake
    // snapshot is ignored and the new connection joins the grants already in effect.
    applySnapshot(user, grant.conversationIds, grant.blockedUserIds, grant.loadedSequence);
    const connection: Connection = {
      id: socket.id,
      socket,
      actor,
      user,
      connectedAt: now,
      buckets: createBuckets(config.rates, () => clock.nowMs()),
      expiresAt: grant.expiresAt,
      expiryTimer: null,
      closed: false,
      pendingAcks: 0,
      pendingDeliveryAcks: 0,
      presenceRequested: [],
      presenceAuthorized: new Set(),
      presenceGeneration: 0,
      typingChain: Promise.resolve(),
      presenceChain: Promise.resolve(),
    };
    registry.attach(connection);
    rooms.joinConnection(connection);

    socket.onAny((event: unknown) => {
      if (typeof event !== 'string' || !CLIENT_EVENT_NAMES.has(event)) gate.invalid(connection, 'unknown_event');
    });
    socket.on(CLIENT_EVENTS.typingStart, (...args: unknown[]) => onTyping(connection, args, true));
    socket.on(CLIENT_EVENTS.typingStop, (...args: unknown[]) => onTyping(connection, args, false));
    socket.on(CLIENT_EVENTS.presenceSubscribe, (...args: unknown[]) => onPresenceSubscribe(connection, args));
    socket.on(CLIENT_EVENTS.messageRead, (...args: unknown[]) => void onRead(connection, args));
    socket.on(CLIENT_EVENTS.messageSend, (...args: unknown[]) => void onSend(connection, args));
    socket.on('disconnect', (reason: string) => cleanup(connection, reason));

    scheduleExpiry(connection);
    if (created) presence.publishStatus(actor.userId);
    safeLog(logger, 'info', 'realtime.connection.opened', { connections: registry.connectionCount, users: registry.userCount });
  };

  nsp.use(authenticator.middleware);
  nsp.on('connection', onConnection);

  const intervals: NodeJS.Timeout[] = [
    setInterval(() => presence.refreshAll(), timing.presenceRefreshIntervalMs),
    setInterval(() => {
      typing.sweep();
      pruneTombstones();
    }, Math.max(50, Math.floor(timing.typingTtlMs / 2))),
  ];
  if (timing.revalidationIntervalMs > 0) intervals.push(setInterval(() => void revalidate(), timing.revalidationIntervalMs));
  for (const interval of intervals) interval.unref();

  const ready = Boolean(config.sessionResolver && config.authorizer);
  safeLog(logger, ready ? 'info' : 'warn', 'realtime.started', {
    mode: ready ? 'ready' : 'fail-closed',
    messageDelivery: messages.deliveryEnabled ? 'enabled' : 'disabled',
    path: config.path,
    namespace: config.namespace,
    allowedOrigins: config.allowedOrigins.size,
  });

  return {
    revokeSession(sessionId) {
      if (!isIdentifier(sessionId)) invalidArgument('sessionId');
      rememberBounded(revokedSessions, sessionId, clock.nowMs(), limits.maxRevokedSessions);
      const connections = registry.sessionConnections(sessionId);
      for (const connection of connections) terminate(connection, 'session_revoked');
      return connections.length;
    },
    disconnectUser(userId) {
      if (!isIdentifier(userId)) invalidArgument('userId');
      const connections = [...(registry.user(userId)?.connections ?? [])];
      for (const connection of connections) terminate(connection, 'user_disconnected');
      return connections.length;
    },
    refreshUserAccess(userId) {
      if (!isIdentifier(userId)) invalidArgument('userId');
      return refreshUserAccess(userId);
    },
    revokeConversationAccess(userId, conversationId) {
      if (!isIdentifier(userId)) invalidArgument('userId');
      if (!isIdentifier(conversationId)) invalidArgument('conversationId');
      // Recorded even for users who are not connected, so an in-flight handshake cannot re-grant it.
      recordTombstones(userId, [conversationId], beginAccessLoad());
      const user = registry.user(userId);
      return user ? rooms.revoke(user, conversationId) : false;
    },
    setPresencePreference(userId, preference) {
      if (!isIdentifier(userId)) invalidArgument('userId');
      if (!PRESENCE_PREFERENCES.has(preference)) invalidArgument('preference');
      presence.setPreference(userId, preference);
    },
    notifyConversationUpdated(conversationId, update = {}) {
      if (!isIdentifier(conversationId)) invalidArgument('conversationId');
      if (update.displayName !== undefined && !isDisplayName(update.displayName)) invalidArgument('displayName');
      const room = conversationRoom(conversationId);
      const recipients = nsp.adapter.rooms.get(room)?.size ?? 0;
      if (recipients === 0 || closing) return 0;
      nsp.to(room).emit(SERVER_EVENTS.conversationUpdated, {
        conversationId,
        ...(update.displayName !== undefined ? { displayName: update.displayName } : {}),
        updatedAt: clock.next(JSON.stringify(['conversation', conversationId])),
      });
      return recipients;
    },
    getStats() {
      let conversationRooms = 0;
      for (const room of nsp.adapter.rooms.keys()) if (isConversationRoom(room)) conversationRooms += 1;
      let pendingAcks = 0;
      let pendingDeliveryAcks = 0;
      for (const connection of registry.allConnections()) {
        pendingAcks += connection.pendingAcks;
        pendingDeliveryAcks += connection.pendingDeliveryAcks;
      }
      return {
        mode: ready ? 'ready' : 'fail-closed',
        messageDelivery: messages.deliveryEnabled ? 'enabled' : 'disabled',
        closing,
        connections: registry.connectionCount,
        users: registry.userCount,
        sessions: registry.sessionCount,
        pendingHandshakes: registry.pendingHandshakes,
        conversationRooms,
        presenceSubscriptions: presence.subscriptionCount,
        typingEntries: typing.entryCount,
        pendingAcks,
        pendingDeliveryAcks,
        inFlightSends: messages.inFlightCount,
      };
    },
    close() {
      if (closed) return closed;
      closing = true;
      closed = (async () => {
        for (const interval of intervals) clearInterval(interval);
        // Transport close (not a server disconnect packet), so clients may reconnect to another instance.
        for (const connection of registry.allConnections()) connection.socket.conn.close();
        io.engine.close();
        await waitFor(() => registry.connectionCount === 0, timing.shutdownTimeoutMs);
        for (const connection of registry.allConnections()) cleanup(connection, 'shutdown');
        nsp.removeAllListeners('connection');
        typing.clear();
        presence.clear();
        messages.clear();
        revokedSessions.clear();
        grantTombstones.clear();
        clock.clear();
        safeLog(logger, 'info', 'realtime.stopped', {});
      })();
      return closed;
    },
  };
}
