import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { DEFAULT_LIMITS, type RealtimeServerOptions, type TransportEvidence } from '../realtime/config.ts';
import type { RealtimeLogger } from '../realtime/contracts.ts';
import { attachRealtimeServer, type RealtimeServerHandle } from '../realtime/server.ts';
import { createDataAuthorizer } from './authorizer.ts';
import { createDataConnectionBinder } from './binder.ts';
import { observeDataChanges } from './changes.ts';
import { assertDataApplication, DataBridgeError } from './types.ts';
import {createDataCallResolver} from './calls.ts';
import {loadLiveKitConfig,createDirectCallMediaLifecycle,createLiveKitHttpHandler,type LiveKitConfig} from '../livekit/index.ts';
import {extractSessionCookie} from '../realtime/cookies.ts';
import type {DirectCallOptions} from '../calls/config.ts';
import { catalogRoomName } from '../livekit/config.ts';

/** Session revalidation and grant refresh period. Also the worst-case staleness of typing and presence grants. */
export const DATA_REVALIDATION_INTERVAL_MS = 15_000;

export interface DataRealtimeOptions {
  readonly livekit?:LiveKitConfig;
  readonly directCalls?:Omit<DirectCallOptions,'conversationResolver'>;
  readonly logger?: RealtimeLogger;
  readonly path?: string;
  readonly namespace?: string;
  readonly limits?: RealtimeServerOptions['limits'];
  readonly rates?: RealtimeServerOptions['rates'];
  readonly timing?: RealtimeServerOptions['timing'];
  readonly securityPolicy?: RealtimeServerOptions['securityPolicy'];
  /** Set to `false` to skip observing DATA's HTTP mutations (logout, block, device and epoch changes). Default `true`. */
  readonly observeChanges?: boolean;
}

export interface DataRealtime {
  readonly realtime: RealtimeServerHandle;
  /** Stops observing DATA and closes every realtime connection. The HTTP server and DATA stay open. */
  close(): Promise<void>;
}

const normalizeIp = (value: string): string => value.replace(/^::ffff:/, '');
const isLoopback = (value: string): boolean => ['127.0.0.1', '::1'].includes(normalizeIp(value));

/**
 * Mirrors DATA's `secureRequest(req, config)` so the realtime handshake and DATA's REST API agree on
 * what counts as secure transport: direct TLS, or `X-Forwarded-Proto: https` from an exactly-listed
 * trusted proxy peer, or the explicit local-development opt-in on a loopback peer.
 */
export function transportSecurityFor(config: { readonly allowHttpLocal: boolean; readonly trustedProxyIps: readonly string[] }): (evidence: TransportEvidence) => boolean {
  const trusted = new Set(config.trustedProxyIps.map(normalizeIp));
  return ({ remoteAddress, encrypted, forwardedProto }) =>
    encrypted === true ||
    (trusted.has(normalizeIp(remoteAddress)) && forwardedProto === 'https') ||
    (config.allowHttpLocal && isLoopback(remoteAddress));
}

/**
 * Mounts the realtime server on the HTTP server that serves DATA's API and wires it to DATA's own
 * authentication, authorization, key verification and persistence. There is no second session
 * store, verifier or database: every decision is a call into the `application` object.
 *
 * `application` is the result of DATA's `startServer()` or `createApp()`. It is validated here, and a
 * DATA that lacks a documented method throws {@link DataBridgeError} instead of starting half-working.
 */
export function attachRealtimeToData(httpServer: HttpServer | HttpsServer, application: unknown, options: DataRealtimeOptions = {}): DataRealtime {
  const data = assertDataApplication(application);
  const { config } = data.auth;
  const maxConversations = options.limits?.maxConversationsPerUser ?? DEFAULT_LIMITS.maxConversationsPerUser;
  const maxBlockedUsers = options.limits?.maxBlockedUsersPerUser ?? DEFAULT_LIMITS.maxBlockedUsersPerUser;
  const authorizer = createDataAuthorizer(data, { maxConversations, maxBlockedUsers });
  const logger = options.logger;
  const livekit=options.livekit??loadLiveKitConfig(process.env);
  if(livekit.directCallsReady&&!data.setDirectCallTokenHandler)throw new DataBridgeError('DATA does not expose the authenticated direct-call token integration.');
  if (options.observeChanges !== undefined && typeof options.observeChanges !== 'boolean') {
    throw new DataBridgeError('observeChanges must be a boolean.');
  }

  const realtime = attachRealtimeServer(httpServer, {
    allowedOrigins: config.origins,
    sessionCookieName: config.sessionCookie,
    sessionResolver: data.adapters.sessionResolver as NonNullable<RealtimeServerOptions['sessionResolver']>,
    connectionBinder: createDataConnectionBinder(data),
    resolveTransportSecurity: transportSecurityFor(config),
    authorizer,
    buzzConversationResolver: createDataCallResolver(data),
    ...(livekit.directCallsReady||options.directCalls?{directCalls:{...options.directCalls,conversationResolver:createDataCallResolver(data),
      ...(options.directCalls?.media?{media:options.directCalls.media}:livekit.directCallsReady?{media:createDirectCallMediaLifecycle(livekit)}:{})}}:{}),
    ...(options.path !== undefined ? { path: options.path } : {}),
    ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    ...(options.rates !== undefined ? { rates: options.rates } : {}),
    ...(options.securityPolicy !== undefined ? { securityPolicy: options.securityPolicy } : {}),
    ...(logger !== undefined ? { logger } : {}),
    timing: { revalidationIntervalMs: DATA_REVALIDATION_INTERVAL_MS, ...options.timing },
  });

  const communityMedia = livekit.directCallsReady && data.voiceRooms ? livekit.createRoomService() : null;
  const tokenHandler=createLiveKitHttpHandler({config:livekit,allowedOrigins:config.origins,sessionCookieName:config.sessionCookie,
    ...(data.voiceRooms ? {authorizeCatalogRoom:async(actor,id)=>{
      try{return Boolean(data.voiceRooms!.authorize({userId:actor.userId,sessionId:actor.sessionId},id));}catch{return false;}
    }} : {}),
    ...(communityMedia ? {prepareCatalogRoom:async(actor,id)=>{
      await communityMedia.createRoom({name:catalogRoomName(id),maxParticipants:32,emptyTimeout:300,departureTimeout:30});
      try { if (data.voiceRooms?.authorize({userId:actor.userId,sessionId:actor.sessionId},id)) return true; } catch { /* Session/catalog changed during room creation. */ }
      // A deleted room may have been created after its first cleanup. Never issue a token.
      if (data.voiceRooms?.deleted().some(room=>room.id===id)) await communityMedia.deleteRoom(catalogRoomName(id));
      return false;
    }} : {}),
    sessionResolver:data.adapters.sessionResolver as NonNullable<RealtimeServerOptions['sessionResolver']>,authorizer,directCalls:realtime,
    resolveTransportSecurity:request=>transportSecurityFor(config)({remoteAddress:request.socket.remoteAddress??'',encrypted:'encrypted' in request.socket&&request.socket.encrypted===true,
      forwardedProto:typeof request.headers['x-forwarded-proto']==='string'?request.headers['x-forwarded-proto']:null}),
    verifyCsrf:async(request,actor)=>{
      const cookie=extractSessionCookie(request.headers.cookie,config.sessionCookie),token=request.headers['x-csrf-token'];
      if(cookie.status!=='present'||typeof token!=='string')return false;
      const proof=data.auth.csrfProof(cookie.value,null,token);
      return proof.type==='session'&&'sessionId'in proof&&proof.sessionId===actor.sessionId&&'userId'in proof&&proof.userId===actor.userId;
    }});
  data.setDirectCallTokenHandler?.(tokenHandler);

  // Tombstones survive process restarts. Reap again through the short token admission
  // window: LiveKit JWTs already issued cannot be individually revoked.
  const removedRooms = new Set<string>();
  const roomService = communityMedia;
  const cleanupRoom = async (id: string) => {
    if (!roomService) return;
    try { await roomService.deleteRoom(catalogRoomName(id)); }
    catch (error) { if ((error as {code?:string})?.code !== 'not_found') throw new Error('Voice room cleanup is unavailable.'); }
  };
  data.voiceRooms?.setCleanup(cleanupRoom);
  let reaping = false, stopped = false;
  const reap = async () => {
    if (reaping || stopped || !roomService) return; reaping = true;
    try { for (const room of data.voiceRooms!.deleted()) {
      if (stopped) break;
      if (!removedRooms.has(room.id) || Date.parse(room.deletedAt) > Date.now() - 60_000) {
        try { await cleanupRoom(room.id); removedRooms.add(room.id); } catch { /* Retry on the next sweep; never reopen admission. */ }
      }
    } } finally { reaping = false; }
  };
  const roomSweep = roomService ? setInterval(() => { void reap(); }, 2000) : null;
  roomSweep?.unref(); void reap();

  const observer = options.observeChanges === false
    ? null
    : observeDataChanges(httpServer, realtime, {
      logger: logger ?? { log: () => undefined },
      authorizer,
    });

  let closing: Promise<void> | null = null;
  return {
    realtime,
    close() {
      closing ??= (async () => {
        observer?.dispose();
        stopped = true; if (roomSweep) clearInterval(roomSweep); data.voiceRooms?.setCleanup(null);
        data.setDirectCallTokenHandler?.(null);
        await realtime.close();
      })();
      return closing;
    },
  };
}
