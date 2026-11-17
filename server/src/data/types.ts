/**
 * The part of DATA's application object (the result of DATA's `createApp` or `startServer`) that the
 * realtime bridge uses. DATA is CommonJS and owned by the Database Team, so it is never imported here:
 * the composition root passes the object in and {@link assertDataApplication} verifies its shape.
 *
 * Only methods that DATA documents and tests are listed. Nothing here reads a DATA table or opens a
 * second database connection.
 */
import type { MessageStore } from '../realtime/contracts.ts';

/** DATA's actor context. Always derived from an authenticated session, never from client input. */
export interface DataContext {
  readonly userId: string;
  readonly sessionId: string;
}

/** `auth.csrfProof(...)` for a session: the proof DATA re-verifies on every write. */
export interface DataSessionProof {
  readonly type: 'session';
  readonly sessionId: string;
  readonly userId: string;
  readonly csrfHash: string;
}

export interface DataSessionStatus {
  readonly status: 'active' | 'expired' | 'revoked';
}

export interface DataAuth {
  readonly config: {
    readonly origins: readonly string[];
    readonly sessionCookie: string;
    readonly allowHttpLocal: boolean;
    readonly trustedProxyIps: readonly string[];
  };
  csrfProof(sessionToken: string, preToken: string | null, csrfToken: string): DataSessionProof | { readonly type: string };
  checkSession(reference: { readonly sessionId: string; readonly userId: string }): DataSessionStatus;
}

export interface DataConversationItem {
  readonly id: string;
  readonly interactionAllowed: boolean;
}

export interface DataPage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
}

export interface DataConversations {
  list(context: DataContext, input: { readonly limit: string; readonly cursor?: string }): DataPage<DataConversationItem>;
  detail(context: DataContext, id: string, input?: object): { readonly conversation: DataConversationItem };
}

export interface DataSocial {
  listBlocks(context: DataContext, input: { readonly limit: string; readonly cursor?: string }): DataPage<{ readonly id: string }>;
  ownProfile(context: DataContext): { readonly profile: { readonly presencePreference: unknown } };
  readonly repository: {
    friendship(a: string, b: string): unknown;
    isBlocked(a: string, b: string): boolean;
    active(userId: string): unknown;
  };
}

export interface DataKeys {
  state(context: DataContext, id: string, input: object): { readonly currentEpoch: unknown };
}

export interface DataMessaging {
  bindStore(context: DataContext, proof: DataSessionProof): MessageStore;
  /** DATA's per-user and per-source write budget. DATA applies it in its REST routers, so socket writes must charge it too. */
  rate(operation: 'submit' | 'read', context: DataContext, source: string): void;
}

export interface DataAdapters {
  readonly sessionResolver: {
    resolveSession(context: unknown): Promise<unknown>;
    checkSession?(reference: unknown): Promise<unknown>;
  };
}

export interface DataApplication {
  readonly auth: DataAuth;
  readonly adapters: DataAdapters;
  readonly conversations: DataConversations;
  readonly social: DataSocial;
  readonly keys: DataKeys;
  readonly messaging: DataMessaging;
}

export class DataBridgeError extends Error {
  override name = 'DataBridgeError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function requireFunctions(owner: string, value: unknown, names: readonly string[]): void {
  if (!isRecord(value)) throw new DataBridgeError(`DATA application is missing ${owner}.`);
  for (const name of names) {
    if (typeof value[name] !== 'function') throw new DataBridgeError(`DATA application is missing ${owner}.${name}().`);
  }
}

/**
 * Verifies the structure of the DATA application at attach time, so a DATA version without the
 * documented methods fails at startup instead of failing open or half-working at runtime.
 */
export function assertDataApplication(value: unknown): DataApplication {
  if (!isRecord(value)) throw new DataBridgeError('DATA application object is required.');
  requireFunctions('auth', value.auth, ['csrfProof', 'checkSession']);
  const config = (value.auth as Record<string, unknown>).config;
  if (!isRecord(config) || !Array.isArray(config.origins) || config.origins.length === 0 ||
    config.origins.some((origin) => typeof origin !== 'string') || typeof config.sessionCookie !== 'string' ||
    typeof config.allowHttpLocal !== 'boolean' || !Array.isArray(config.trustedProxyIps)) {
    throw new DataBridgeError('DATA auth.config must list origins, sessionCookie, allowHttpLocal and trustedProxyIps.');
  }
  const adapters = value.adapters;
  if (!isRecord(adapters)) throw new DataBridgeError('DATA application is missing adapters.');
  requireFunctions('adapters.sessionResolver', adapters.sessionResolver, ['resolveSession']);
  requireFunctions('conversations', value.conversations, ['list', 'detail']);
  requireFunctions('social', value.social, ['listBlocks', 'ownProfile']);
  const social = value.social as Record<string, unknown>;
  requireFunctions('social.repository', social.repository, ['friendship', 'isBlocked', 'active']);
  requireFunctions('keys', value.keys, ['state']);
  requireFunctions('messaging', value.messaging, ['bindStore', 'rate']);
  return value as unknown as DataApplication;
}

/** The definitive HTTP-style refusal codes DATA throws (`AuthError.code`). Anything else is infrastructure. */
export function dataErrorCode(error: unknown): string | null {
  if (!isRecord(error)) return null;
  const { code } = error;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null;
}

/** DATA says the actor is not allowed to see or use this resource (as opposed to DATA being unavailable). */
const DENIAL_CODES: ReadonlySet<string> = new Set([
  'NOT_FOUND', 'FORBIDDEN', 'UNAUTHENTICATED', 'SESSION_EXPIRED', 'CSRF_INVALID', 'VALIDATION_ERROR',
]);

export function isDataDenial(error: unknown): boolean {
  const code = dataErrorCode(error);
  return code !== null && DENIAL_CODES.has(code);
}

export function dataContext(actor: { readonly userId: string; readonly sessionId: string }): DataContext {
  return Object.freeze({ userId: actor.userId, sessionId: actor.sessionId });
}
