/**
 * Public entry point of the SecuBuzz realtime server (Phase 8.7B).
 *
 * Test fixtures and harnesses live in `server/test/` and are intentionally not exported here,
 * so production code cannot import a test session resolver or authorizer.
 */
export { attachRealtimeServer } from './realtime/server.ts';
export type { RealtimeServerHandle, RealtimeStats } from './realtime/server.ts';
export {
  DEFAULT_LIMITS,
  DEFAULT_NAMESPACE,
  DEFAULT_PATH,
  DEFAULT_RATES,
  DEFAULT_SESSION_COOKIE,
  DEFAULT_TIMING,
  loadStandaloneConfig,
  normalizeOrigin,
  RealtimeConfigError,
  resolveRealtimeConfig,
} from './realtime/config.ts';
export type {
  RealtimeLimits,
  RealtimeRates,
  RealtimeServerOptions,
  RealtimeTiming,
  ResolvedRealtimeConfig,
  StandaloneConfig,
} from './realtime/config.ts';
export type * from './realtime/contracts.ts';
export {
  ACK_ERROR_CODES,
  CLIENT_EVENTS,
  CONNECT_ERROR_CODES,
  SERVER_EVENTS,
} from './realtime/protocol.ts';
export type {
  AckErrorCode,
  ClientEventName,
  ConnectErrorCode,
  ConversationUpdatedEvent,
  ErrorAck,
  PresenceStatus,
  PresenceUpdateEvent,
  ReadAck,
  ReceiptEvent,
  SendAck,
  ServerEventName,
  TypingUpdateEvent,
} from './realtime/protocol.ts';
export type { RateSetting } from './realtime/rateLimiter.ts';
export { createConsoleLogger, silentLogger } from './realtime/logger.ts';
export { envelopeFingerprint } from './realtime/validation.ts';
