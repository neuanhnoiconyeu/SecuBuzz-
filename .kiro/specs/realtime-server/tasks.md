# Implementation Plan

- [x] 1. Scaffold the realtime server package
  - Create `server/package.json` (ESM, Node.js ≥ 22.18, `socket.io` 4.8 runtime dependency; `socket.io-client`, `tsx`, `typescript` 5.9, `@types/node` dev dependencies) and strict `server/tsconfig.json` (`erasableSyntaxOnly`, `verbatimModuleSyntax`, `noEmit`)
  - Add `start`, `type-check` and `test` scripts and `server/.env.example`; keep lockfiles out of Git per the root `.gitignore`
  - _Requirements: 1.1, 17.1_

- [x] 2. Define the protocol and adapter contracts
- [x] 2.1 Centralize event names and error vocabularies
  - `server/src/realtime/protocol.ts`: client and server event names from the Client_Contract, connect-error codes, ack error codes, ack builders
  - _Requirements: 3.7, 5.1, 5.6_
- [x] 2.2 Define adapter interfaces and domain types
  - `server/src/realtime/contracts.ts`: `SessionResolver`, `RealtimeAuthorizer`, `MessageStore`, `RecipientKeyVerifier`, `RealtimeSecurityPolicy`, `RealtimeLogger`, envelope and receipt types, documented for the Database Team
  - _Requirements: 2.1, 4.1, 8.3, 9.7, 16.3, 18.1_

- [x] 3. Implement validation primitives and payload parsers
- [x] 3.1 Strict parsers for identifiers, timestamps, canonical base64, client bodies, envelopes, delivery acks and adapter results
  - _Requirements: 5.2, 6.4, 7.2, 9.1, 9.2, 9.3, 11.3_
- [x] 3.2 Session cookie extraction (single occurrence, bounded, decoded, control-character free)
  - _Requirements: 2.1, 3.1, 3.2_
- [x] 3.3 Unit tests for validation and cookie parsing
  - _Requirements: 5.2, 9.2, 9.3, 3.2_

- [x] 4. Implement configuration, clock, rate limiter, logger and adapter deadlines
- [x] 4.1 `config.ts`: defaults, range validation, origin/path/namespace/cookie-name validation, adapter method checks, environment mapping
  - _Requirements: 1.2, 1.9, 12.4_
- [x] 4.2 `clock.ts` (monotonic per-key timestamps, bounded), `rateLimiter.ts` (token buckets), `logger.ts` (primitive fields only), `adapterCall.ts` (deadline wrapper)
  - _Requirements: 6.8, 7.6, 12.1, 16.1, 3.4_
- [x] 4.3 Unit tests for config, clock, token buckets and adapter deadlines
  - _Requirements: 1.2, 1.9, 6.8, 12.1, 3.4_

- [x] 5. Build Socket.IO initialization and handshake authentication
- [x] 5.1 `server.ts`: attach to a caller-supplied HTTP server, duplicate-attach guard, `allowRequest` Origin allowlist, exact credentialed CORS, payload cap, no client serving or state recovery, default-namespace guard, fail-closed mode logging
  - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_
- [x] 5.2 `authentication.ts`: capacity checks, cookie extraction, session resolution within the handshake deadline, result validation, demo-identity rejection, revoked-during-handshake check, security policy, parallel grant and block loading
  - _Requirements: 2.1–2.5, 3.1–3.8, 4.3, 13.3, 16.3, 16.4_
- [x] 5.3 Test harness and fixtures in `server/test/support/` (ephemeral port, injected adapters, production refusal, real `socket.io-client` helpers)
  - _Requirements: 17.1, 17.2, 17.3_
- [x] 5.4 Integration tests: missing/invalid/expired/duplicate sessions, resolver failure and timeout, demo identity, identity-override attempts, origin rejection, CORS headers, connection limits, fail-closed mode, generic error messages
  - _Requirements: 1.3, 1.4, 1.8, 2.2, 2.5, 3.1–3.8_

- [x] 6. Implement the registry, room manager and authorization behavior
- [x] 6.1 `registry.ts` and `rooms.ts`: per-user grants applied to all connections, `user:*`/`conv:*` rooms, block reverse index, `refreshUserAccess`, `revokeConversationAccess`
  - Order authorizer snapshots with a sequence number and tombstones so a stale handshake or refresh cannot re-grant a revoked conversation
  - _Requirements: 4.1, 4.2, 4.4, 4.5, 4.6, 4.7_
- [x] 6.2 `eventGate.ts`: argument shape, token buckets, invalid-event budget with disconnect, pending-ack bound, unknown-event detection, security-policy evaluation
  - _Requirements: 5.3, 5.4, 5.5, 12.1, 12.2, 16.3, 16.4, 16.5_
- [x] 6.3 Integration tests: room isolation, group membership denial, malformed or oversized grants, revocation, refresh, block filtering, unknown events, invalid budget
  - _Requirements: 4.1–4.8, 5.3, 5.4_

- [x] 7. Implement typing relay
- [x] 7.1 `typing.ts`: validated relay with server actor and monotonic timestamps, exclusion of own and blocked connections, TTL state, stop on disconnect and revocation
  - _Requirements: 6.1–6.8_
- [x] 7.2 Integration tests: valid relay, unauthorized drop, spoofed fields rejected, rate limiting, own-connection exclusion, disconnect and revocation cleanup
  - _Requirements: 6.1–6.8_

- [x] 8. Implement presence infrastructure
- [x] 8.1 `presence.ts`: status derivation with preferences, subscription replacement, privacy filtering, snapshot, refresh sweep, `unknown` on authorization loss, multi-connection awareness, cleanup
  - _Requirements: 7.1–7.10_
- [x] 8.2 Integration tests: single and multiple connections, filtering, privacy denial, filter failure, blocks, refresh cadence and monotonic timestamps, disconnect cleanup, preferences
  - _Requirements: 7.1–7.10_

- [x] 9. Implement the read and delivery receipt boundary
- [x] 9.1 `receipts.ts`: authorized read requests through the `MessageStore`, structured acks, peer `message:read` only on first durable record, delivery acks bound to recipient sockets
  - _Requirements: 8.1–8.8, 11.1–11.6_
- [x] 9.2 Integration tests: authorized read, unauthorized read, forged reader ignored, unknown message, sender reading own message, missing store, store failure, duplicate receipt, ack shape
  - _Requirements: 8.1–8.8_

- [x] 10. Implement the message send boundary and idempotency
- [x] 10.1 `messages.ts`: strict envelope, actor match, room check, skew, policy, capability gate, verifier, in-flight coalescing, fingerprinted idempotent store call, durable-first `message:new` fan-out with delivery callbacks
  - _Requirements: 9.1–9.9, 10.1–10.5, 11.1–11.6_
- [x] 10.2 Integration tests: plaintext, demo and malformed envelopes, actor mismatch, unauthorized send, production-default denial, verifier denial, duplicate handling, changed-payload collision, concurrent coalescing, store failure, delivery receipts and group semantics
  - _Requirements: 9.1–9.9, 10.1–10.5, 11.1–11.6_

- [x] 11. Implement lifecycle: expiry, revocation, revalidation, reconnect and shutdown
- [x] 11.1 Session expiry timers, `revokeSession`, `disconnectUser`, periodic `checkSession` and grant revalidation, cleanup of all per-connection state, `getStats`, idempotent `close()` that leaves the caller's HTTP server open
  - _Requirements: 13.1–13.5, 14.1–14.3, 15.1–15.5, 4.8_
- [x] 11.2 Integration tests: reconnect re-verification, no duplicate handlers, expiry, revocation, revalidation, listener and state cleanup, graceful shutdown, oversized packets
  - _Requirements: 13.1–13.5, 14.1–14.3, 15.1–15.5_

- [x] 12. Add the public entry point and standalone server
- [x] 12.1 `src/index.ts` exports and `src/main.ts` standalone process (environment configuration, health endpoint, signal handling, fail-closed mode)
  - _Requirements: 1.8, 2.6, 17.2_
- [x] 12.2 Smoke test that runs `node src/main.ts` as a child process and checks fail-closed rejection and health
  - _Requirements: 17.5_

- [x] 13. Verify compatibility with the Phase 8.7A client
- [x] 13.1 Run the real `SocketIoRealtimeClient` and client parsers against the server: connect, auth rejection codes, typing, presence, read acks, server-initiated disconnect, disabled sends
  - _Requirements: 5.7, 17.4_

- [x] 14. Write documentation
- [x] 14.1 `docs/realtime-server-integration.md` Database Team handoff and contract conflicts; `server/README.md` usage
  - _Requirements: 18.1, 18.2, 18.3_

- [x] 15. Run full verification
  - Server type-check and tests; client type-check, lint, tests and production build; `git diff --check`; record exact results
  - _Requirements: 17.3, 17.4, 17.5_
