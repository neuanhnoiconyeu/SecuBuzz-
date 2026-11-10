/**
 * Adapter contracts between the realtime server and the teams that own its dependencies.
 *
 * Every adapter is optional when the server is constructed so it can start before integration,
 * but a missing adapter disables the capability that depends on it (fail closed):
 *
 * | Adapter                 | Owner           | Missing means                                         |
 * | ----------------------- | --------------- | ----------------------------------------------------- |
 * | SessionResolver         | Database Team   | Every connection is rejected (REALTIME_UNAVAILABLE)   |
 * | RealtimeAuthorizer      | Database Team   | Every connection is rejected (REALTIME_UNAVAILABLE)   |
 * | MessageStore            | Database Team   | Read receipts `unavailable`; sends disabled           |
 * | RecipientKeyVerifier    | Security Team   | Sends disabled (`recipient_keys_unavailable`)         |
 * | RealtimeSecurityPolicy  | Phase 10        | No extra policy; authentication/authorization apply   |
 *
 * Adapter methods may be async and may throw. The server applies a deadline to every call,
 * treats throws, timeouts and malformed results as failures, and never logs their messages.
 * See docs/realtime-server-integration.md for the full handoff.
 */
import type { ClientEventName } from './protocol.ts';

/** The authenticated identity bound to one connection. Never taken from client input. */
export interface RealtimeActor {
  readonly userId: string;
  /** Opaque server-side session identifier. It must not be the cookie value itself. */
  readonly sessionId: string;
  /** Public display name used in `typing:update` and checked against `message:send` sender metadata. */
  readonly displayName: string;
}

/** Input to {@link SessionResolver.resolveSession}. Raw headers, query and handshake `auth` are withheld on purpose. */
export interface HandshakeContext {
  /** Value of the configured session cookie (URL-decoded). Secret: never log, persist or echo it. */
  readonly sessionToken: string;
  /** Allowlisted Origin of the handshake. */
  readonly origin: string;
  /** Direct peer address. Behind a reverse proxy this is the proxy. */
  readonly remoteAddress: string;
  readonly userAgent: string | null;
  /** True when the HTTP connection that carried the handshake used TLS directly. */
  readonly secure: boolean;
  readonly receivedAt: Date;
}

export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly userId: string;
  /** 1–160 characters, no control characters. */
  readonly displayName: string;
  /** Absolute expiry. The server disconnects the connection at this time. */
  readonly expiresAt: Date;
}

/**
 * `missing` → AUTH_REQUIRED, `invalid` → UNAUTHORIZED, `expired` → SESSION_EXPIRED.
 * Return `invalid` for unknown, revoked, tampered or foreign tokens; do not reveal which.
 */
export type SessionResolution =
  | { readonly status: 'authenticated'; readonly session: AuthenticatedSession }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid' }
  | { readonly status: 'expired' };

export interface SessionReference {
  readonly sessionId: string;
  readonly userId: string;
}

export type SessionCheck =
  | { readonly status: 'active'; readonly expiresAt: Date }
  | { readonly status: 'expired' }
  | { readonly status: 'revoked' };

export interface SessionResolver {
  /** Authenticate a handshake from the session cookie only. */
  resolveSession(context: HandshakeContext): Promise<SessionResolution>;
  /**
   * Optional periodic revalidation of an established session without its cookie.
   * Used to catch logouts performed in another process and sliding expiry changes.
   */
  checkSession?(session: SessionReference): Promise<SessionCheck>;
}

/**
 * Authoritative membership and relationship decisions. Results are validated and bounded by the
 * server; returning more entries than the configured limits fails the connection closed.
 */
export interface RealtimeAuthorizer {
  /** Every direct and group conversation the actor may currently receive events for. */
  listConversationIds(actor: RealtimeActor): Promise<readonly string[]>;
  /** Users with a block relationship with the actor in EITHER direction. */
  listBlockedUserIds(actor: RealtimeActor): Promise<readonly string[]>;
  /**
   * The subset of `subjectIds` whose presence `viewer` may observe (for example accepted friends
   * that have not hidden their presence). The server intersects the result with the request.
   */
  filterPresenceSubjects(viewer: RealtimeActor, subjectIds: readonly string[]): Promise<readonly string[]>;
}

/** Version 1 AES-256-GCM metadata. Structure alone is not proof of multi-user E2EE. */
export interface EncryptionEnvelope {
  readonly version: 1;
  readonly algorithm: 'AES-256-GCM';
  readonly encoding: 'base64';
  /** Canonical base64 of exactly 12 bytes. */
  readonly iv: string;
  /** Canonical base64 of more than 16 bytes, including the 128-bit tag. */
  readonly ciphertext: string;
}

/**
 * `message:send` body. The fields `conversationId`, `id`, `senderId`, `senderName` and `timestamp`
 * are AES-GCM additional authenticated data on the client, so the server relays them unchanged.
 */
export interface MessageEnvelope {
  readonly id: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly timestamp: string;
  readonly type: 'text';
  readonly encryption: EncryptionEnvelope;
}

export interface StoredMessageRef {
  readonly conversationId: string;
  readonly messageId: string;
  readonly senderId: string;
}

export interface ReceiptRecord {
  readonly conversationId: string;
  readonly messageId: string;
  /** The authenticated observer (reader or receiving recipient). */
  readonly userId: string;
  readonly status: 'delivered' | 'read';
  readonly observedAt: Date;
}

/** Idempotent per (conversationId, messageId, userId, status). `recordedAt` is the first durable time. */
export type ReceiptOutcome =
  | { readonly outcome: 'created'; readonly recordedAt: Date }
  | { readonly outcome: 'duplicate'; readonly recordedAt: Date };

export interface StoreMessageRequest {
  /** Already validated; `envelope.senderId` equals the authenticated actor. */
  readonly envelope: MessageEnvelope;
  /** Lowercase hex SHA-256 of the canonical envelope (see `envelopeFingerprint`). */
  readonly fingerprint: string;
  readonly receivedAt: Date;
}

/**
 * Idempotency contract:
 * - `(conversationId, envelope.id)` is unique within a conversation.
 * - Same key, same sender and same fingerprint → `duplicate` with the ORIGINAL `storedAt`.
 * - Same key with a different sender or fingerprint → `conflict`.
 * - Must be atomic across processes (for example a unique index plus a transaction) and must
 *   re-check that the sender is a member of the conversation.
 */
export type StoreMessageOutcome =
  | { readonly outcome: 'created'; readonly storedAt: Date }
  | { readonly outcome: 'duplicate'; readonly storedAt: Date }
  | { readonly outcome: 'conflict' };

export interface MessageStore {
  /** Message metadata scoped to one conversation; `null` when the message is not in it. */
  findMessage(conversationId: string, messageId: string): Promise<StoredMessageRef | null>;
  recordReceipt(receipt: ReceiptRecord): Promise<ReceiptOutcome>;
  storeMessage(request: StoreMessageRequest): Promise<StoreMessageOutcome>;
}

export type KeyVerification = { readonly verified: true } | { readonly verified: false };

/**
 * Security Team attestation that an envelope is encrypted for the authenticated recipient keys of
 * the conversation. Absent in production, so message delivery stays disabled.
 */
export interface RecipientKeyVerifier {
  verifyEnvelope(actor: RealtimeActor, envelope: MessageEnvelope): Promise<KeyVerification>;
}

/** `reason` is an audit code (identifier characters, at most 64), logged but never sent to clients. */
export type SecurityDecision = { readonly action: 'allow' } | { readonly action: 'deny'; readonly reason: string };

export interface ConnectionSecurityContext {
  readonly actor: RealtimeActor;
  readonly origin: string;
  readonly remoteAddress: string;
  readonly userAgent: string | null;
}

/** Metadata only. Ciphertext, IVs and display text are never included. */
export interface EventSecurityContext {
  readonly actor: RealtimeActor;
  readonly event: ClientEventName;
  readonly conversationId: string | null;
  readonly messageId: string | null;
  /** Number of requested presence subjects, for `presence:subscribe`. */
  readonly subjectCount: number | null;
  /** Approximate UTF-8 size of the event body in bytes. */
  readonly payloadBytes: number;
}

/**
 * Phase 10 extension point (Auditor Bot, Sentinel Bot, BUZZ Guard). Evaluated after authentication
 * and authorization; a throw or timeout denies the handshake or event.
 */
export interface RealtimeSecurityPolicy {
  evaluateConnection?(context: ConnectionSecurityContext): Promise<SecurityDecision>;
  evaluateEvent?(context: EventSecurityContext): Promise<SecurityDecision>;
}

export type LogLevel = 'info' | 'warn' | 'error';
/** Primitive values only, so payload objects cannot be logged by accident. */
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

export interface RealtimeLogger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
}

/** Server-side presence preference set by a future profile integration. */
export type PresencePreference = 'available' | 'away' | 'busy' | 'invisible';
