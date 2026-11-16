import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { PresencePreference, RealtimeActor, RealtimeAuthorizer, RealtimeLogger } from '../realtime/contracts.ts';
import type { RealtimeServerHandle } from '../realtime/server.ts';

/**
 * Turns committed DATA mutations into realtime effects.
 *
 * DATA exposes no durable change feed and no event emitter, so the bridge observes the same HTTP
 * server DATA is mounted on. A mutation counts only after its response finished with a 2xx status,
 * which is after DATA committed it. Nothing is read from request bodies: the effects come from DATA's
 * own authenticated request state (`req.auth`, `req.csrfProof`) and from asking DATA again.
 *
 * These effects are HINTS that accelerate what the periodic revalidation and per-operation checks
 * already guarantee. They are process-local: a mutation made through a different DATA process is
 * not seen here, and nothing is queued for clients that are offline (they reconcile from DATA).
 */

type Change =
  | { readonly kind: 'logout' }
  | { readonly kind: 'social' }
  | { readonly kind: 'profile' }
  | { readonly kind: 'keys-actor' }
  | { readonly kind: 'keys-epoch'; readonly conversationId: string };

const CONVERSATION_ID = /^[A-Za-z0-9._:@-]{1,256}$/;
const PREFERENCES: ReadonlySet<string> = new Set(['available', 'away', 'busy', 'invisible']);

/** Express matches fixed path segments case-insensitively and ignores one trailing slash; so does this. */
const ROUTES: ReadonlyArray<{ readonly method: string; readonly pattern: RegExp; readonly statuses: readonly number[]; readonly build: (match: RegExpExecArray) => Change | null }> = [
  { method: 'POST', pattern: /^\/api\/auth\/logout\/?$/i, statuses: [204], build: () => ({ kind: 'logout' }) },
  { method: 'POST', pattern: /^\/api\/blocks\/?$/i, statuses: [204], build: () => ({ kind: 'social' }) },
  { method: 'DELETE', pattern: /^\/api\/blocks\/[^/]+\/?$/i, statuses: [204], build: () => ({ kind: 'social' }) },
  { method: 'POST', pattern: /^\/api\/friends\/requests\/[^/]+\/accept\/?$/i, statuses: [200], build: () => ({ kind: 'social' }) },
  { method: 'DELETE', pattern: /^\/api\/friends\/(?!requests(?:\/|$))[^/]+\/?$/i, statuses: [204], build: () => ({ kind: 'social' }) },
  { method: 'POST', pattern: /^\/api\/conversations\/dm\/?$/i, statuses: [200, 201], build: () => ({ kind: 'social' }) },
  { method: 'PATCH', pattern: /^\/api\/users\/me\/?$/i, statuses: [200], build: () => ({ kind: 'profile' }) },
  { method: 'POST', pattern: /^\/api\/keys\/devices\/?$/i, statuses: [201], build: () => ({ kind: 'keys-actor' }) },
  { method: 'POST', pattern: /^\/api\/keys\/devices\/[^/]+\/revoke\/?$/i, statuses: [200], build: () => ({ kind: 'keys-actor' }) },
  {
    method: 'POST',
    pattern: /^\/api\/conversations\/([^/]+)\/keys\/epochs\/?$/i,
    statuses: [201],
    build: (match) => {
      let id: string;
      try {
        id = decodeURIComponent(match[1] ?? '');
      } catch {
        return null;
      }
      return CONVERSATION_ID.test(id) ? { kind: 'keys-epoch', conversationId: id } : null;
    },
  },
];

function classify(method: string | undefined, url: string | undefined, status: number): Change | null {
  if (method === undefined || url === undefined) return null;
  const question = url.indexOf('?');
  const path = question === -1 ? url : url.slice(0, question);
  for (const route of ROUTES) {
    if (route.method !== method || !route.statuses.includes(status)) continue;
    const match = route.pattern.exec(path);
    if (match) return route.build(match);
  }
  return null;
}

/** Runs `work` over `items` with at most `limit` in flight. Never rejects. */
async function eachLimited<Item>(items: readonly Item[], limit: number, work: (item: Item) => Promise<unknown>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await work(item).catch(() => undefined);
    }
  });
  await Promise.all(lanes);
}

type RealtimeEffects = Pick<RealtimeServerHandle, 'revokeSession' | 'refreshAllAccess' | 'notifyKeysChanged' | 'setPresencePreference'>;

export interface ChangeObserverOptions {
  readonly logger: RealtimeLogger;
  readonly authorizer: RealtimeAuthorizer;
  /** Coalesces bursts of social mutations into one refresh. */
  readonly refreshDebounceMs?: number;
  /** Parallel `conversation:keys-changed` computations after a device change. */
  readonly keyNotifyConcurrency?: number;
}

export interface ChangeObserver {
  dispose(): void;
}

interface AuthenticatedRequest {
  readonly auth?: { readonly userId?: unknown; readonly sessionId?: unknown; readonly user?: { readonly displayName?: unknown } };
  readonly csrfProof?: { readonly type?: unknown; readonly sessionId?: unknown };
}

export function observeDataChanges(
  server: HttpServer | HttpsServer,
  effects: RealtimeEffects,
  options: ChangeObserverOptions,
): ChangeObserver {
  const { logger, authorizer } = options;
  const debounceMs = options.refreshDebounceMs ?? 50;
  const keyConcurrency = options.keyNotifyConcurrency ?? 4;
  let disposed = false;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let again = false;

  const warn = (event: string, reason: string): void => logger.log('warn', event, { reason });

  const runRefresh = async (): Promise<void> => {
    timer = null;
    running = true;
    try {
      await effects.refreshAllAccess();
    } catch {
      warn('realtime.data.refresh_failed', 'error');
    } finally {
      running = false;
      if (again && !disposed) {
        again = false;
        scheduleRefresh();
      }
    }
  };

  function scheduleRefresh(): void {
    if (disposed) return;
    if (running) {
      again = true;
      return;
    }
    if (timer) return;
    timer = setTimeout(() => void runRefresh(), debounceMs);
    timer.unref();
  }

  const actorOf = (request: AuthenticatedRequest): RealtimeActor | null => {
    const auth = request.auth;
    if (!auth || typeof auth.userId !== 'string' || typeof auth.sessionId !== 'string') return null;
    const name = auth.user?.displayName;
    return Object.freeze({ userId: auth.userId, sessionId: auth.sessionId, displayName: typeof name === 'string' ? name : '' });
  };

  const notifyActorConversations = async (actor: RealtimeActor): Promise<void> => {
    const ids = await authorizer.listConversationIds(actor);
    await eachLimited(ids, keyConcurrency, (id) => effects.notifyKeysChanged(id));
  };

  const applyPreference = async (actor: RealtimeActor): Promise<void> => {
    const load = authorizer.presencePreference?.bind(authorizer);
    if (!load) return;
    const value = await load(actor);
    if (value !== null && PREFERENCES.has(value)) effects.setPresencePreference(actor.userId, value as PresencePreference);
  };

  const apply = (change: Change, request: AuthenticatedRequest): void => {
    switch (change.kind) {
      case 'logout': {
        const proof = request.csrfProof;
        if (proof?.type === 'session' && typeof proof.sessionId === 'string') effects.revokeSession(proof.sessionId);
        return;
      }
      case 'social':
        scheduleRefresh();
        return;
      case 'profile': {
        const actor = actorOf(request);
        if (actor) void applyPreference(actor).catch(() => warn('realtime.data.preference_failed', 'error'));
        return;
      }
      case 'keys-actor': {
        const actor = actorOf(request);
        if (actor) void notifyActorConversations(actor).catch(() => warn('realtime.data.keys_notify_failed', 'error'));
        return;
      }
      case 'keys-epoch':
        void effects.notifyKeysChanged(change.conversationId).catch(() => warn('realtime.data.keys_notify_failed', 'error'));
        return;
    }
  };

  // Runs before DATA's own listener so the method and URL are captured before Express rewrites `req.url`.
  const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
    if (disposed) return;
    const method = request.method;
    const url = request.url;
    if (url === undefined || !/^\/api\//i.test(url) || method === undefined || method === 'GET' || method === 'HEAD') return;
    response.once('finish', () => {
      if (disposed) return;
      try {
        const change = classify(method, url, response.statusCode);
        if (change) apply(change, request as unknown as AuthenticatedRequest);
      } catch {
        warn('realtime.data.observe_failed', 'error');
      }
    });
  };
  server.prependListener('request', onRequest);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      server.off('request', onRequest);
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
