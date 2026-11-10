import { callAdapter } from './adapterCall.ts';
import { rememberBounded } from './bounded.ts';
import type { ServerClock } from './clock.ts';
import type { ResolvedRealtimeConfig } from './config.ts';
import type { PresencePreference } from './contracts.ts';
import { safeLog } from './logger.ts';
import { SERVER_EVENTS, type PresenceStatus, type PresenceUpdateEvent } from './protocol.ts';
import type { Connection, ConnectionRegistry } from './registry.ts';
import { parseIdentifierList } from './validation.ts';

type ObservableStatus = Exclude<PresenceStatus, 'unknown'>;

const presenceKey = (userId: string) => JSON.stringify(['presence', userId]);

/**
 * Privacy-filtered presence. A connection only ever receives `presence:update` for subjects it
 * requested AND the authorizer allowed AND that have no block relationship with the viewer.
 */
export class PresenceManager {
  readonly #subscribers = new Map<string, Set<Connection>>();
  readonly #preferences = new Map<string, PresencePreference>();
  readonly #config: ResolvedRealtimeConfig;
  readonly #registry: ConnectionRegistry;
  readonly #clock: ServerClock;

  constructor(config: ResolvedRealtimeConfig, registry: ConnectionRegistry, clock: ServerClock) {
    this.#config = config;
    this.#registry = registry;
    this.#clock = clock;
  }

  get subscriptionCount(): number {
    let count = 0;
    for (const connections of this.#subscribers.values()) count += connections.size;
    return count;
  }

  statusOf(userId: string): ObservableStatus {
    if (this.#registry.connectionsForUser(userId) === 0) return 'offline';
    const preference = this.#preferences.get(userId) ?? 'available';
    if (preference === 'available') return 'online';
    return preference === 'invisible' ? 'offline' : preference;
  }

  setPreference(userId: string, preference: PresencePreference): void {
    const before = this.statusOf(userId);
    rememberBounded(this.#preferences, userId, preference, this.#config.limits.maxPresencePreferences);
    if (this.statusOf(userId) !== before) this.publishStatus(userId);
  }

  /** Replaces the connection's requested scope and re-authorizes it. Stale results are discarded. */
  async subscribe(connection: Connection, requested: readonly string[]): Promise<void> {
    const generation = ++connection.presenceGeneration;
    const self = connection.actor.userId;
    const wanted = requested.filter((id) => id !== self);
    connection.presenceRequested = Object.freeze(wanted);
    const wantedSet = new Set(wanted);
    let allowed = new Set<string>();
    const authorizer = this.#config.authorizer;
    if (wanted.length > 0 && authorizer) {
      const filterPresenceSubjects = authorizer.filterPresenceSubjects.bind(authorizer);
      const request = Object.freeze([...wanted]);
      const result = await callAdapter(() => filterPresenceSubjects(connection.actor, request), this.#config.timing.adapterTimeoutMs);
      if (generation !== connection.presenceGeneration || connection.closed) return;
      const parsed = result.ok ? parseIdentifierList(result.value, this.#config.limits.maxPresenceSubjects) : null;
      if (parsed) allowed = new Set(parsed.filter((id) => wantedSet.has(id)));
      else safeLog(this.#config.logger, 'warn', 'realtime.presence.filter_failed', { outcome: result.ok ? 'malformed' : result.reason });
    }
    if (connection.closed) return;
    for (const id of [...allowed]) if (this.#registry.isBlockedPair(self, id)) allowed.delete(id);
    const added: string[] = [];
    for (const id of [...connection.presenceAuthorized]) {
      if (allowed.has(id)) continue;
      this.#unindex(connection, id);
      // Only authorization loss is announced; subjects the client stopped requesting are simply dropped.
      if (wantedSet.has(id)) this.#emit(connection, id, 'unknown');
    }
    for (const id of allowed) {
      if (connection.presenceAuthorized.has(id)) continue;
      this.#index(connection, id);
      added.push(id);
    }
    for (const id of added) this.#emit(connection, id, this.statusOf(id));
  }

  /** Re-runs authorization for the connection's last request (after relationship or block changes). */
  refilter(connection: Connection): Promise<void> {
    return this.subscribe(connection, connection.presenceRequested);
  }

  /** Emits the subject's current status to every authorized, unblocked subscriber. */
  publishStatus(userId: string): void {
    const connections = this.#subscribers.get(userId);
    if (!connections || connections.size === 0) return;
    const status = this.statusOf(userId);
    const timestamp = this.#clock.next(presenceKey(userId));
    for (const connection of [...connections]) {
      if (this.#registry.isBlockedPair(connection.actor.userId, userId)) continue;
      this.#emit(connection, userId, status, timestamp);
    }
  }

  /** A new block between two users removes each from the other's authorized presence immediately. */
  revokePair(first: string, second: string): void {
    for (const [viewer, subject] of [[first, second], [second, first]] as const) {
      for (const connection of this.#registry.user(viewer)?.connections ?? []) {
        if (!connection.presenceAuthorized.has(subject)) continue;
        this.#unindex(connection, subject);
        this.#emit(connection, subject, 'unknown');
      }
    }
  }

  removeConnection(connection: Connection): void {
    connection.presenceGeneration += 1;
    for (const id of [...connection.presenceAuthorized]) this.#unindex(connection, id);
  }

  /** Periodic freshness refresh: one fresh timestamp per subject, sent to each authorized subscriber. */
  refreshAll(): void {
    for (const [userId, connections] of [...this.#subscribers]) {
      const status = this.statusOf(userId);
      const timestamp = this.#clock.next(presenceKey(userId));
      for (const connection of [...connections]) {
        if (this.#registry.isBlockedPair(connection.actor.userId, userId)) continue;
        this.#emit(connection, userId, status, timestamp);
      }
    }
  }

  clear(): void {
    this.#subscribers.clear();
    this.#preferences.clear();
  }

  #index(connection: Connection, subjectId: string): void {
    connection.presenceAuthorized.add(subjectId);
    const connections = this.#subscribers.get(subjectId) ?? new Set<Connection>();
    connections.add(connection);
    this.#subscribers.set(subjectId, connections);
  }

  #unindex(connection: Connection, subjectId: string): void {
    connection.presenceAuthorized.delete(subjectId);
    const connections = this.#subscribers.get(subjectId);
    connections?.delete(connection);
    if (connections && connections.size === 0) this.#subscribers.delete(subjectId);
  }

  #emit(connection: Connection, userId: string, status: PresenceStatus, timestamp = this.#clock.next(presenceKey(userId))): void {
    if (connection.closed) return;
    const payload: PresenceUpdateEvent = { userId, status, timestamp };
    connection.socket.emit(SERVER_EVENTS.presenceUpdate, payload);
  }
}
