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

  const tokenHandler=createLiveKitHttpHandler({config:livekit,allowedOrigins:config.origins,sessionCookieName:config.sessionCookie,
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
        data.setDirectCallTokenHandler?.(null);
        await realtime.close();
      })();
      return closing;
    },
  };
}
