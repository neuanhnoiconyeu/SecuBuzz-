# Requirements: secure realtime integration (Socket.IO, DATA and E2EE v2)

## Introduction

DATA (Database Team) now provides real accounts and sessions, the social graph, direct conversations, the DB-7 key directory, and the DB-4B persistence pipeline that verifies recipient keys before committing envelope v2. The Kiro realtime server (Phase 8.7B) still has no real adapters. This work connects the two so that two real accounts exchange encrypted messages over Socket.IO, with DATA as the only authority for identity, membership, key verification and persistence.

It does not add AI features, schemas, a second database, a second verifier, a second session authority, JWTs, or any new cryptographic protocol.

Ownership: Kiro owns `server/` and `.kiro/specs/`. `client/` (Codex) and `DATA/` (Database Team) are read-only. Needs outside `server/` are written as handoffs.

## Glossary

- **Actor**: the account and session that DATA resolved from the session cookie.
- **Bound store**: DATA's `messaging.bindStore(context, proof)`, one per connection. DATA re-verifies session and CSRF proof on every call.
- **Committed**: DATA returned `created` after its transactional insert.
- **Hint**: a realtime event that accelerates reconciliation but is never proof (key-change events, live `message:new`).

## Requirements

### Requirement 1: Handshake authentication

**User Story:** As a user, I want the realtime connection to be tied to my login so that nobody can connect as me.

1. THE System SHALL authenticate a connection only from DATA's session cookie through DATA's own session resolver, including Origin allowlist and secure-transport checks.
2. THE System SHALL require `handshake.auth` to be exactly `{ csrfToken }` for real accounts and SHALL verify it with DATA's `auth.csrfProof` for the same session, requiring the proof's session and user to equal the resolved actor.
3. WHEN the cookie is absent THE System SHALL answer `AUTH_REQUIRED`; WHEN the session or CSRF token is unknown, wrong, foreign, pre-login or malformed, or `auth` has extra keys, THE System SHALL answer `UNAUTHORIZED`; WHEN the session expired, `SESSION_EXPIRED`.
4. THE System SHALL NOT accept a user ID, session ID, display name or demo identity from the client, and SHALL reject demo identities even if a resolver returns one.
5. WHEN DATA or the binder fails, times out or answers malformed data, THE System SHALL reject the handshake with `REALTIME_UNAVAILABLE`.
6. THE System SHALL decide transport security with the same rule as DATA (direct TLS, exact trusted proxy with `https`, or the explicit loopback opt-in) and SHALL NOT trust forwarded headers from other peers.
7. THE System SHALL NOT install a global actor-bound store; each connection SHALL get its own.

### Requirement 2: Revocation

1. WHEN a logout commits through DATA, THE System SHALL close every socket of that session immediately and refuse later handshakes with the old cookie and token.
2. THE System SHALL close sockets whose session DATA reports expired or revoked within the revalidation interval (15 seconds).
3. WHEN DATA refuses a store call because the session or proof is invalid, THE System SHALL answer `policy_denied` and close the connection.

### Requirement 3: Authorization

1. THE System SHALL grant rooms only for conversations DATA lists for the actor with `interactionAllowed`, and no client event SHALL select a room.
2. THE System SHALL refresh grants on connect, periodically, and after committed block, unblock, friend accept, friend removal and DM creation.
3. THE System SHALL authorize typing, read receipts, delivery receipts and presence through DATA state; presence SHALL be limited to accepted friends with no block in either direction.
4. THE System SHALL re-authorize each recipient with DATA immediately before every message delivery and withhold delivery on denial, failure or timeout.
5. WHEN a refresh fails THE System SHALL keep the last verified grants and SHALL NOT add any.

### Requirement 4: Persistence pipeline

1. THE System SHALL process `message:send` in this order: validate schema, authenticate sender, resolve membership, submit the exact envelope v2 to DATA, receive DATA's result, acknowledge, broadcast.
2. THE System SHALL NOT acknowledge success or broadcast before DATA commits, and SHALL NOT broadcast after a refusal, timeout or unavailable DATA.
3. THE System SHALL NOT verify keys itself in DATA mode; DATA's verifier and in-transaction recheck decide.
4. THE System SHALL accept only envelope version 2 on real-account connections, with no downgrade and no plaintext path.
5. THE System SHALL relay the envelope byte for byte (ciphertext, IV, `keyId`, client message ID) and SHALL return DATA's `storedAt` as the ack timestamp.
6. THE System SHALL keep client message IDs idempotent: a retry returns the original timestamp and SHALL NOT produce a second message or second delivery.
7. THE System SHALL charge DATA's per-user and per-source write budget for socket writes.

### Requirement 5: Errors

1. THE System SHALL map DATA refusals only to the client's existing ack error codes, using only an allowlisted code token and field names, and SHALL NOT expose or log DATA messages.
2. THE System SHALL distinguish retryable infrastructure errors (`unavailable`, `rate_limited`) from permanent authorization and crypto failures, and SHALL NOT retry crypto failures itself.

### Requirement 6: Delivery

1. THE System SHALL deliver only to currently authorized members, across multiple sockets per account.
2. THE System SHALL keep sent, delivered and read states distinct and persist receipts through DATA.
3. THE System SHALL relay typing without any message content.
4. THE System SHALL honor the stored presence preference from the first publish, and SHALL fail the handshake when it cannot be read.

### Requirement 7: Key changes

1. WHEN DATA commits a device registration, device revocation or epoch publication through this process, THE System SHALL emit `conversation:keys-changed` with exactly `{ conversationId, currentEpoch: { keyId, epoch } | null }`.
2. THE System SHALL obtain each recipient's payload from DATA as that recipient, so an account DATA refuses receives nothing, and SHALL NOT include keys, wraps, signatures or device records.
3. THE System SHALL document that the event is a process-local hint, is not replayed, and does not guarantee client revalidation, and SHALL NOT add polling that implies a guarantee.

### Requirement 8: Reconnection

1. THE System SHALL re-authenticate every reconnect and rejoin only rooms DATA still allows.
2. THE System SHALL join rooms before the client can request history, so subscribe-then-fetch leaves no gap, and SHALL document dedupe by wire message ID and the absence of an exactly-once guarantee.

### Requirement 9: Safety and scope

1. THE System SHALL NOT log ciphertext, IVs, keys, tokens, cookies, session IDs or error messages.
2. THE System SHALL NOT import DATA code from `src/`, open a second database, or modify `client/` or `DATA/`.
3. THE System SHALL keep existing realtime behavior unchanged when no connection binder is configured.

### Requirement 10: Verification and documentation

1. THE System SHALL be tested against the real DATA application on an isolated database with real sockets, two accounts, two device identities and real v2 ciphertext, and SHALL NOT present mocked persistence as full-stack proof.
2. THE System SHALL document architecture, DATA boundary, auth and CSRF flow, event contracts, authorization, persistence and ack flow, error codes, key changes, reconnection, deployment, limitations and test evidence, plus a client handoff.
