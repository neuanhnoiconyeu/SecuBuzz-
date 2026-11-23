# Encrypted Edit: historical Phase 5 blocker review

Phase 11 implements the former blockers through an additive, signed append-only revision protocol. See [authenticated-edit-protocol.md](authenticated-edit-protocol.md) for current implementation, migration 0011, verification and Security review requirements. The original ciphertext remains immutable; unsigned legacy overwrite attempts are still refused. The analysis below records the **pre-Phase-11** state rather than current enablement.

During Phase 5, real-account Edit stayed disabled (`REAL_ACCOUNT_MESSAGING_CAPABILITIES.edit = false`).
This phase adds refusal-path regression tests and this contract review; it does not enable
PATCH, alter encryption validation, or change database rules. Demo editing remains available.

## Pre-Phase-11 implementation

| Source | Existing contract |
| --- | --- |
| `DATA/server/routes/messaging.js` | PATCH uses authenticated sessions, CSRF and rate limits, then calls `service.edit`. It does not pass the request body to an edit implementation. |
| `DATA/server/messaging/service.js` | `edit` resolves a **storage ID**, checks conversation interaction and original sender ownership, then deliberately throws `503 FEATURE_UNAVAILABLE`. A recipient gets 403; an outsider gets 404. |
| `DATA/server/database/migrations/0007-recipient-keys.sql` | `messages_envelope_immutable` rejects changes to ciphertext, IV, key ID, fingerprint and identity. `messages_tombstone_monotonic` only permits a revision increment when an active message becomes deleted. Neither allows an active edit. |
| `DATA/server/database/repositories.js` | Authenticated storage supports insert, history, lookup and tombstone; it has no atomic edit operation. |
| `DATA/server/messaging/service.js` | Submitting changed encrypted bytes with the same wire ID conflicts with the original fingerprint (409). A new wire ID creates another message, not an edit. |
| `client/src/security/e2ee/api.ts` | The stored-message parser accepts active revision 0 or deleted revision 1. No edit API exists. |
| `client/src/security/e2ee/session.ts` | Sending creates a new UUID; pending sends and retries preserve the original encrypted bytes. No edit/revision workflow exists. |
| `client/src/realtime/SecureRealtimeWorkspace.ts` | Two different active V2 envelopes with the same ID are rejected as conflicting. Tombstones are terminal. |
| `server/src/realtime/protocol.ts` | Send/read/deletion hints exist; an authenticated edit notification contract is absent. |
| `client/src/components/messenger/MessageList.tsx` | The existing multiline editor has Save, Cancel and failure handling. Capabilities prevent it from opening for real accounts. |

V2 AES-GCM can encrypt new text with a fresh reserved nonce. That alone does not authorize
mutating an existing message. Its AAD binds the original message/conversation/sender/header
and key ID, but has no edit revision or operation ID. Arbitrarily allowing changed ciphertext
or higher active revisions would relax current validation without an approved replacement.

## Former contracts needed before Fullstack integration

1. **Database/message-service owners:** approve a versioned encrypted PATCH request and authoritative
   stored-message response, addressed by storage ID with unchanged wire ID, conversation, sender,
   original timestamp, sequence and stored time. Provide an approved schema/trigger migration or
   revision-storage design and an atomic sender-authorized edit operation. Existing membership,
   session, CSRF, recipient-key validation and audit checks must remain in force.
2. **Database/message-service owners:** define compare-and-swap using an expected revision,
   durable idempotency for uncertain responses, conflict errors, and authoritative edit revision/
   timestamp semantics (including their relation to `updatedAt`). Concurrent edits must not
   silently overwrite each other; Unsend must be terminal.
   History and receipts must continue using the same message identity.
3. **Security owners:** approve how replacement V2 content binds the target, revision and edit
   operation; whether a compatible encrypted content extension or a new envelope version is
   required; fresh nonce reservation; permitted historical/current key epochs and current device
   coverage; and validation/replay/rollback rules. Preserve validated encrypted reply/forward
   metadata and exact-byte retry behavior without sharing the new-message pending-send slot.
4. **Fullstack, after those contracts ship:** integrate the existing multiline editor through
   `SecureMessagingSession`; validate confirmations before changing UI content; derive the Edited
   indicator from authoritative metadata. Add a server-only, freshly authorized edit hint and
   history-based reconciliation. Update only the approved revision/merge rules so delayed events,
   reconnects, offline recipients and concurrent Unsend cannot restore stale content.

Do not implement a local-only edit, route real edits through demo/legacy APIs, mutate SQLite
directly, disguise an edit as a new message, or disable immutable-envelope validation.

## Historical validation scope

`server/test/data/edit-unavailable.test.ts` exercises real authenticated DATA/Socket.IO sessions
and V2 encryption with isolated databases: ownership/CSRF/session checks, valid replacement
refusal, concurrent attempts, same-ID retry conflict, multiline Unicode preservation after
history reload/reconnect, and terminal Unsend. The capability tests keep real Edit unavailable
even when callbacks or a previously open demo editor are supplied. These are refusal and
preservation tests; successful two-user edit synchronization remains blocked.

The browser check `node scripts/verify-client-realtime.cjs --edit-unavailable-only` (from `client`)
verifies menu gating and PATCH refusal through Next's real proxy, plus original Unicode content
and encrypted history preservation in two isolated authenticated browser contexts after reload
and an offline gap.
