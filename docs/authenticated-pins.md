# Authenticated Pin / Unpin

Shared pins use metadata separate from E2EE messages. Both current, authorized direct-conversation
participants may pin or unpin supported V2 text messages. Demo Mode keeps its existing local pins.

## Database changes for review

Additive migration `DATA/server/database/migrations/0008-authenticated-message-pins.sql` adds:

- `ConversationPinVersions`: a monotonic version per conversation for compare-and-swap changes.
- `MessagePins`: storage IDs, conversation IDs, authenticated actor IDs and pin timestamps only.
- `MessagePinOperations`: account-scoped operation IDs and mutation results for durable idempotence.
- Insert eligibility, pin-row immutability, and post-Unsend cleanup triggers. The cleanup trigger
  removes the pin and advances its version in the existing Unsend transaction. At the safe-integer
  ceiling it saturates the counter so a pin cannot prevent Unsend.

No existing table, encrypted field, key, message envelope or protection trigger is replaced or
weakened. `pinRepository.js` is the separate metadata DAL. The migration preserves all old schema
objects and encrypted records, has FK/integrity regression coverage, and is repeatable. Existing
migration tests now include version 8 in their expected pending migration lists.

Migration validation uses isolated test databases. The existing development SQLite files are
preserved; normal DATA startup applies pending migrations through its existing migration runner.

## API and authorization

- `GET /api/conversations/:id/pins` returns an authorized versioned snapshot, including the existing
  encrypted stored-message DTO for each reference. It never returns decrypted text or keys.
- `POST /api/messages/:storageId/pin` accepts exactly `{ pinned, expectedVersion, operationId }`.
  It sets an absolute state, rather than toggling blindly. A UUID identifies the operation;
  duplicate requests replay the original acknowledgment and cannot undo a later change.
- Conflicting versions return 409; only the server decides conversation membership and eligibility.
  Mutations reuse `withInteraction`, session verification, CSRF proof verification, SQLite immediate
  transactions, rate limiting and audit records. Client ownership or permission fields are rejected.
- The UI's stable wire ID is mapped to the message's storage ID. A fresh snapshot confirms the
  displayed state. Lost responses reconcile before retrying, with the same unresolved operation ID.

`DATA/server/app.js` mounts the new narrow routers. `messaging/service.js` only exports its unchanged
stored-message projection for reuse. The Next proxy and `HttpAuthService` allowlist include the two
exact routes; cookie identity checks, same-origin policy, CSRF and session invalidation are unchanged.
Session API regression tests verify those protections and reject extra pin-path suffixes.
The existing E2EE primitive test's signature tampering now flips a byte deterministically, rather
than occasionally generating the unchanged original signature. Production crypto code is unchanged.

## Client and realtime integration

`AuthenticatedPins` owns session-scoped snapshots, duplicate-request protection and pending metadata
operations. Pin references are decrypted through the existing `SecureMessagingSession.decryptIncoming`
pipeline. The existing MessageList pin bar, pinned-message list and original-message navigation are reused.
Older pinned messages can be displayed without loading every intermediate history page.

The combined DATA/realtime process observes only successful pin acknowledgments and emits the
server-only `conversation:pins-changed` hint with `{ conversationId }`. Existing `mayReceive` checks
fresh authorization for every recipient. Clients fetch an authorized snapshot; a hint never grants
access or supplies trusted content. Reconnection refreshes pins, and the selected panel also refreshes
on the existing conversation refresh cycle. Sign-out/disposal removes pin plaintext from session memory.

Local Delete for Me filters pinned references on that account/browser without changing shared pins.
Unsent messages lose their pin atomically. Unavailable historical keys show an unavailable message
instead of plaintext; authorized participants can still unpin it. Tombstone identity and existing
immutable-envelope checks remain in force. Encrypted Reply/Forward metadata is unchanged.

## Validation and limits

Regression coverage includes real authenticated DATA/Socket.IO accounts, additive migration safety,
idempotence/CAS, sender/recipient pinning, outsider/CSRF/session/block failures, Unsend, local hides,
older-message navigation, unavailable keys, failed requests, and lost-response recovery.
`node scripts/verify-client-realtime.cjs --pins-only` (from `client`) exercises actual Chrome contexts
through Next's proxy, including reload, offline recovery, sign-out/sign-in and an isolated backend restart.

Snapshots are bounded to 50 shared pins per conversation. Metadata records operation IDs and pinning
actors/times; it does not hide that metadata from the server. Realtime hints are process-local like
the existing DATA bridge; multiple independent realtime processes require a shared notification bus
for immediate cross-process delivery. No Security-owned crypto protocol, calling or attachment
infrastructure changes are required. Real-account Edit remains disabled.
