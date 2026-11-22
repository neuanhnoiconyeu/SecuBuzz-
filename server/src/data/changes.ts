import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { PresencePreference, RealtimeActor, RealtimeAuthorizer, RealtimeLogger } from '../realtime/contracts.ts';
import type { RealtimeServerHandle } from '../realtime/server.ts';
import { isIdentifier } from '../realtime/validation.ts';

/**
 * Turns committed DATA mutations into realtime effects.
 *
 * DATA exposes no durable change feed and no event emitter, so the bridge observes the same HTTP
 * server DATA is mounted on. Effects require a successful post-commit response. Unsend and pin hints
 * require DATA's complete confirmation body, even if the HTTP connection closes before `finish`. Nothing is read
 * from request bodies: effects use DATA's own authenticated request state (`req.auth`, `req.csrfProof`),
 * its response, and its authorization services.
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
  | { readonly kind: 'message-deleted'; readonly storageId: string }
  | { readonly kind: 'message-edited'; readonly storageId:string }
  | { readonly kind: 'pins'; readonly storageId: string }
  | { readonly kind: 'reactions'; readonly storageId: string }
  | { readonly kind: 'keys-epoch'; readonly conversationId: string };

const CONVERSATION_ID = /^[A-Za-z0-9._:@-]{1,256}$/;
const PREFERENCES: ReadonlySet<string> = new Set(['available', 'away', 'busy', 'invisible']);

/** Express matches fixed path segments case-insensitively and ignores one trailing slash; so does this. */
const ROUTES: ReadonlyArray<{ readonly method: string; readonly pattern: RegExp; readonly statuses: readonly number[]; readonly build: (match: RegExpExecArray) => Change | null }> = [
  {method:'PATCH',pattern:/^\/api\/messages\/([^/]+)\/?$/i,statuses:[200],build:match=>{
    try{const id=decodeURIComponent(match[1]??'');return isIdentifier(id)?{kind:'message-edited',storageId:id}:null;}catch{return null;}
  }},
  {
    method:'POST',pattern:/^\/api\/messages\/([^/]+)\/reaction\/?$/i,statuses:[200],
    build:match=>{try{const id=decodeURIComponent(match[1]??'');return isIdentifier(id)?{kind:'reactions',storageId:id}:null;}catch{return null;}},
  },
  {
    method: 'POST', pattern: /^\/api\/messages\/([^/]+)\/pin\/?$/i, statuses: [200],
    build: match => { try { const id=decodeURIComponent(match[1] ?? ''); return isIdentifier(id) ? {kind:'pins',storageId:id} : null; } catch { return null; } },
  },
  {
    method: 'DELETE', pattern: /^\/api\/messages\/([^/]+)\/?$/i, statuses: [200],
    build: match => {
      try { const id = decodeURIComponent(match[1] ?? ''); return isIdentifier(id) ? { kind: 'message-deleted', storageId: id } : null; }
      catch { return null; }
    },
  },
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

type RealtimeEffects = Pick<RealtimeServerHandle, 'revokeSession' | 'refreshAllAccess' | 'notifyKeysChanged' | 'setPresencePreference' | 'notifyMessageDeleted' | 'notifyMessageEdited' | 'notifyPinsChanged' | 'notifyReactionsChanged'>;

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
  readonly csrfProof?: { readonly type?: unknown; readonly sessionId?: unknown; readonly userId?: unknown };
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

  const apply = (change: Change, request: AuthenticatedRequest, responseBody?: Buffer): void => {
    switch (change.kind) {
      case 'message-edited':{
        const actor=actorOf(request),proof=request.csrfProof;
        if(!actor||proof?.type!=='session'||proof.sessionId!==actor.sessionId||proof.userId!==actor.userId||!responseBody)return;
        const body=JSON.parse(responseBody.toString('utf8')) as {outcome?:unknown;edit?:Record<string,unknown>},e=body.edit;
        if(!['created','duplicate'].includes(body.outcome as string)||!e||e.storageId!==change.storageId||e.senderId!==actor.userId||!isIdentifier(e.conversationId)||!isIdentifier(e.messageId)||!Number.isInteger(e.revision)||(e.revision as number)<1||typeof e.proofHash!=='string'||!/^[0-9a-f]{64}$/.test(e.proofHash))return;
        void effects.notifyMessageEdited(e.conversationId,e.messageId).catch(()=>warn('realtime.data.edit_notify_failed','error'));return;
      }
      case 'reactions': {
        const actor=actorOf(request),proof=request.csrfProof;
        if(!actor||proof?.type!=='session'||proof.sessionId!==actor.sessionId||proof.userId!==actor.userId||!responseBody)return;
        const body=JSON.parse(responseBody.toString('utf8')) as Record<string,unknown>;
        if(body.storageId!==change.storageId||body.userId!==actor.userId||!isIdentifier(body.conversationId)||!isIdentifier(body.messageId)||!Number.isSafeInteger(body.version)||!Number.isSafeInteger(body.revision))return;
        void effects.notifyReactionsChanged(body.conversationId,body.messageId).catch(()=>warn('realtime.data.reactions_notify_failed','error'));return;
      }
      case 'pins': {
        const actor=actorOf(request),proof=request.csrfProof;
        if(!actor||proof?.type!=='session'||proof.sessionId!==actor.sessionId||proof.userId!==actor.userId||!responseBody)return;
        const body=JSON.parse(responseBody.toString('utf8')) as Record<string,unknown>;
        if(body.storageId!==change.storageId||!isIdentifier(body.conversationId)||!isIdentifier(body.messageId)||typeof body.pinned!=='boolean'||!Number.isSafeInteger(body.version)||(body.version as number)<0||!isIdentifier(body.operationId))return;
        void effects.notifyPinsChanged(body.conversationId).catch(()=>warn('realtime.data.pins_notify_failed','error')); return;
      }
      case 'message-deleted': {
        const actor = actorOf(request), proof = request.csrfProof;
        if (!actor || proof?.type !== 'session' || proof.sessionId !== actor.sessionId || proof.userId !== actor.userId || !responseBody) return;
        // Read only DATA's own post-commit response, never a request body or raw database.
        // The hint is not a deletion grant: clients still fetch authorized durable history.
        const body = JSON.parse(responseBody.toString('utf8')) as { message?: Record<string, unknown> };
        const message = body?.message;
        if (!message || message.storageId !== change.storageId || message.senderId !== actor.userId || message.state !== 'deleted' || message.encryption !== null ||
          !isIdentifier(message.conversationId) || !isIdentifier(message.id) ||
          typeof message.deletedAt !== 'string' || !Number.isFinite(Date.parse(message.deletedAt)) || !Number.isSafeInteger(message.revision) || (message.revision as number) < 1) return;
        void effects.notifyMessageDeleted(message.conversationId, message.id).catch(() => warn('realtime.data.message_notify_failed', 'error'));
        return;
      }
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
    // Bound capture to small lifecycle/pin/reaction confirmation receipts, never ciphertext histories.
    // A committed mutation still counts if its HTTP connection closes before the
    // caller receives it. Failed mutations and other HTTP traffic produce no hint.
    const observeMessage = (['DELETE','PATCH'].includes(method) && /^\/api\/messages\/[^/?]+\/?(?:\?.*)?$/i.test(url)) ||
      (method === 'POST' && /^\/api\/messages\/[^/?]+\/(?:pin|reaction)\/?(?:\?.*)?$/i.test(url));
    let chunks: Buffer[] = [], size = 0;
    if (observeMessage) {
      const capture = (chunk: unknown, encoding: unknown) => {
        if (size > 16_384) return;
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8')
          : chunk instanceof Uint8Array ? Buffer.from(chunk) : null;
        if (!bytes) return;
        size += bytes.length;
        if (size > 16_384) chunks = []; else chunks.push(bytes);
      };
      const write = response.write, end = response.end;
      response.write = function(this: ServerResponse, chunk: unknown, ...args: unknown[]) { capture(chunk, args[0]); return Reflect.apply(write, this, [chunk, ...args]); } as typeof response.write;
      response.end = function(this: ServerResponse, chunk?: unknown, ...args: unknown[]) { capture(chunk, args[0]); return Reflect.apply(end, this, [chunk, ...args]); } as typeof response.end;
    }
    let observed = false;
    const afterResponse = () => {
      if (observed) return; observed = true;
      if (disposed) return;
      try {
        const change = classify(method, url, response.statusCode);
        if (change) apply(change, request as unknown as AuthenticatedRequest, observeMessage && size <= 16_384 ? Buffer.concat(chunks) : undefined);
      } catch {
        warn('realtime.data.observe_failed', 'error');
      }
    };
    response.once('finish', afterResponse);
    if (observeMessage) response.once('close', afterResponse);
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
