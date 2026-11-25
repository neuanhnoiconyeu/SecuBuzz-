# DB-1 repository and integration contract

Post-DB-4B key integration adds `server/e2ee/repository.js` over the same injected
SQLite connection: public device lookup/history/own list/active-set insertion and
status transitions, current/selected/bounded epoch lookup and ordered wrap insertion.
It stores public data only and supplies no authorization by itself. `application.keys`
applies DB-2/4A policies and calls Kiro's actual registration/revocation/publication
planners inside immediate transactions. `createSqliteKeyDirectory` reads a consistent
snapshot and supplies Kiro's genuine verifier. DB-4B `insertAuthenticated` accepts
key_id for v2; `submit` performs the synchronous persisted-key recheck before any
idempotency lookup. See [the current runtime/shared-service boundary](e2ee-realtime-integration.md).

DB-4A extends the existing `conversations` namespace with authenticated direct creation/activation, joined authorized lookup and bounded keyset listing. The original generic methods remain compatible and default to legacy provenance. See [the DB-4A interface and transaction contract](db4a-integration.md) for exact methods, shared write-time authorization and the DB-4B boundary. This phase does not implement the proposed message persistence service below.

DB-4B now implements the shared authorized message service and extends this same `messages` namespace with `insertAuthenticated`, `getAuthenticated`, `findAuthenticatedClient`, `highWater`, bounded `history` and monotonic `tombstone`; `receipts.get` supports first-observation idempotency. Original generic/legacy methods remain compatible and are not authorization boundaries. The [current shared-service contract](db4b-realtime-integration.md) supersedes the historical proposed boundary below. Wire ID scope is resolved additively: the global PK is an independent storage UUID, and authenticated `(conversation_id,client_id)` uniqueness preserves Kiro's wire IDs/AAD without collision across conversations. Do not call trusted DAL insertion directly from REST or realtime.

```js
const { openDatabase } = require('../server/database/connection');
const { createRepositories } = require('../server/database/repositories');
const db = openDatabase({ filename: '/absolute/path/to/database.sqlite' });
const repositories = createRepositories(db);
try {
    // Trusted server-side persistence calls; authorize at the service boundary first.
    const user = repositories.users.get('authoritative-user-id');
} finally {
    db.close();
}
```

All operations are synchronous and use the same injected connection. Repositories neither close connections nor open additional ones. Rows use the schema's snake_case column names; missing records return `null`; lists return arrays; status/update/remove operations return `{ changes: number }` unless stated otherwise. Insert operations return the stored row. Generated IDs are UUID strings. Optional IDs can be supplied by trusted callers, preserving shared identity. Inputs use positional identifiers or the explicit object fields below; object methods reject unknown fields.

DB-2 extends this foundation with `createAuthRepository(db)` and `createAuthService(...)`; see [authentication integration](auth-integration.md) and [session architecture](auth-sessions.md). `sessions.insert` now additionally accepts optional `auth_version` (default zero, insufficient to authenticate). The historical phase handoff below describes DB-1's boundary; DB-2's implemented auth/session/CSRF contract supersedes its proposed authentication work.

DB-3 adds `createSocialRepository(db)` plus the authorized social service: [API/contract](profiles-friends-api.md), [transaction/legacy rules](relationships.md) and [integration handoff](db3-integration.md). The low-level legacy methods below retain their signatures and now write legacy provenance by default. They are not a substitute for DB-3 authorization. Read-only pages use deferred transactions, mutations use immediate transactions, and domain rejections preserve fixed 4xx errors while rolling back. Only the new HTTP service confirms authenticated social consent.

Repository errors are `RepositoryError` with a safe fixed message and `code`: `DUPLICATE`, `REFERENCE`, `INVALID`, `BUSY` or `DATABASE`. SQL statements/values and nested causes are not attached or logged. Raw connections and migration errors are internal operator interfaces; do not serialize them in API responses. Repositories are persistence primitives, not auth/session verifiers or public APIs.

## Available operations

| Repository | Methods and input contract |
| --- | --- |
| users | `create({user_id?, username, display_name})`, `get(id)`, `list()`, `setStatus(id, status)`; profile created by trigger in the same statement. |
| profiles | `get(userId)`, `update(userId, {display_name?, avatar?, custom_status?, presence_preference?})` returns row/null; omitted/null fields leave the old value, empty custom_status clears it. Display-name synchronization is transactional. |
| sessions | `insert({session_id,user_id,token_hash,csrf_token_hash?,issued_at_ms,expires_at_ms})`, `get(sessionId)`, `findByHash(hash)`, `revoke(id, atMs)`, `touch(id, atMs)`. Revoke preserves the first timestamp. These methods do not establish that a session is authenticated, active or authorized. |
| friendRequests | `insert({request_id?,sender_id,recipient_id})`, `get(id)`, `listForUser(id)`, `setStatus(id,status,resolvedAt)` returns row/null. Set pending with NULL resolution, other statuses with a resolution time. No friendship/block policy is performed. |
| friendships | `insert(a,b)`, `get(a,b)`, `listForUser(id)`; pair canonicalized; duplicate insertion throws DUPLICATE. |
| blocks | `insert(blocker,blocked)`, `get(blocker,blocked)`, `listForUser(blocker)`, `remove(blocker,blocked)`. Direction is significant. |
| conversations | `create({conversation_id?,kind,title?,created_by?,dm_user_low?,dm_user_high?})`, `get(id)`, `findDirect(a,b)`, `listForUser(id)`, `archive(id,at)`. Direct create requires canonical pair and inserts both members atomically. Group create adds the supplied creator as owner atomically; a creator-less group is a staging primitive that a later service must not expose as a complete group. |
| members | `insert({conversation_id,user_id,role?})`, `get(conversation,userId)`, `list(conversation)`, `setRole(conversation,userId,role)`, `leave(conversation,userId,at)`; no invitations, visibility or owner-transfer workflow. |
| messages | `insert(encryptedRow)`, `get(messageId)`, `list(conversation,limit=50,offset=0)`, `setLegacyStatus(messageId,status)`. `encryptedRow` fields are listed below. Status update returns `{changes}` and atomically adds a scoped legacy receiver receipt. Original envelope metadata is immutable. |
| receipts | `insert({conversation_id,message_id,user_id,status,observed_at})`, `list(conversation,messageId)`; duplicate scoped status insertion returns the first row/times. |
| attachments | `insert({attachment_id?,conversation_id,message_id?,uploaded_by,storage_key,encrypted_metadata?,media_type?,byte_size})`, `get(id)`, `setStatus(id,status)`; metadata only, no byte transport/storage implementation. |
| audit | `insert({audit_id?,actor_user_id?,event_type,severity?,source,subject_id?,metadata?})`, `get(id)`, `listForActor(id,limit=50)`. Metadata allowlist: identifier strings `reason_code`, `operation`, `outcome` (1..64 characters, letters/digits/`_.:-`); finite nonnegative numbers `count`, `duration_ms`. No nested values or free-text prompt/message/credential fields. |
| legacy | `addContact(userId,friendId)`, `getContacts(userId)`, `saveMessage(sender,receiver,ciphertext,iv)`, `getConversation(a,b,limit=50,offset=0)`, `createSecurityLog(userId,eventType,severity,source,description,details={})`, `getSecurityLogs(limit=50,offset=0)`, `getCriticalLogs()`; exclusively for the existing routes/facade. |

## DB-6B attachment repository additions

`database/attachmentRepository.js` adds a persistence facade for migration 0009. Read operations are `getById`, `messageUsage`, `searchHighWater`, `searchPage`, `usageForUser`, `usageForConversation`, `pendingCountForUser`, `reservationUsage`, `listExpiredPending`, `listPurgeCandidates`, `listExpiredReservations`, `listForReconciliation`, and `hasStorageKey`. Write operations are `insertReservation`, `deleteReservation`, `deleteExpiredReservation`, `deleteExpiredReservations`, `insertPending`, `associate`, `markDeleted`, and `markPurged`. `searchPage` uses the ready-only search index and a caller-supplied high-water mark; quota methods expose committed usage and live reservation counts/bytes for the service's atomic admission decision. The retention methods return bounded expiry and purge candidates. Callers own the surrounding immediate transaction for every write; the repository validates input shape and maps SQLite errors but is not an authorization boundary and does not access private-storage bytes.

`encryptedRow`: `message_id?`, `conversation_id`, `sender_id`, `receiver_id?`, `ciphertext`, `iv`, `algorithm?` (default AES-256-GCM), `envelope_version?`, `encoding?`, `sender_name?`, `client_timestamp?`, `message_type?`, `fingerprint?`, `client_id?`. For a modern envelope supply version 1, encoding base64, original sender name/client timestamp, type text and a lowercase 64-hex fingerprint together. For legacy rows leave all those optional envelope fields NULL. A group receiver is NULL; a direct receiver must be the other participant. Ciphertext includes the authentication tag when the client envelope uses that format. There is no plaintext field.

List operations are trusted internal primitives. API services must validate/cap limits and offsets, project public fields and authorize every request. `messages.list()` currently returns an offset-based page ordered oldest-to-newest within the selected latest page; DB-4 must add cursor pagination using the existing `(conversation_id,created_at,message_id)` index. No full-history export or untrusted arbitrary SQL interface exists.

## Transactions and compatibility

`repositories.transaction(r => { ... })` uses an immediate transaction and returns the synchronous callback result. Throwing rolls it back. Nested repository operations use savepoints where necessary. Promise-returning callbacks are rejected; do not begin asynchronous work inside a transaction, since later async continuations cannot be rolled back. Use transactions around subsequent multi-record business operations. The connection busy timeout bounds competing writers; BUSY requires the caller to decide whether a retry is safe.

`database.js` retains all thirteen original exported functions and argument positions; it delegates to this one repository implementation through `db.js`. Existing object fields remain; returned rows may now include additive metadata. Legacy contact creation writes Contacts and the corresponding pending request atomically. Later normalized relationship changes are **not** projected back to Contacts: DB-3 must retire or explicitly adapt those legacy endpoints when it implements complete relationship workflows. Direct raw SQL writes to Contacts are outside this compatibility contract.

Legacy saveMessage creates/reuses the pair's direct conversation and inserts into the same Messages table. Receipt updates preserve the first timestamp and add normalized receipts. Legacy security logs retain their original descriptions/details; only metadata mirrors into AuditLogs. This compatibility path is not a new authorization bypass: it preserves the existing unauthenticated API, which still requires DB-2/DB-3 authorization before real deployment.

## Handoff by phase

| Phase | Reuse | Work still owned by that phase |
| --- | --- | --- |
| DB-2 | Users/UserProfiles, Sessions; users/profiles/sessions repositories; connection and migration runner | Add credential/private-email storage in a new migration (prefer a private table, because existing public user routes SELECT public identity); decide username/email normalization; password hashing/verification, token generation/hashing, cookie/CSRF policy, expiry/revocation enforcement, rate limiting, auth endpoints and SessionResolver. Never add a password field to a public identity response. |
| DB-3 | UserProfiles, FriendRequests, Friendships, Blocks and transaction helper | Ownership/privacy checks, blocks, atomic request acceptance, full profile/friends APIs, legacy contact endpoint transition. |
| DB-4 | Conversations, members, Messages, receipts; opaque modern envelope fields; cursor index | One shared authorized and idempotent write service for REST and Socket.IO, cursor pagination, fingerprints, edits/deletion protocol and realtime adapter. |
| DB-5 | Group conversation kind, roles, active-owner uniqueness, retained membership | Invitations/role policy, owner transfer, history access, leave/removal/rejoin rules. |
| DB-6 | Attachments and scoped FKs | Actual byte store, validation, access control, upload/download/search/retention. |
| DB-7 | AuditLogs, metadata-restricted audit repository and legacy event provenance | Authorized queries, audit policy and retention, AI consent/task metadata and durable AI quota store in future migrations. No private AI prompt persistence. |

## Proposed DB-4 shared message persistence boundary

The current realtime contract in `server/src/realtime/contracts.ts` was inspected, not modified. DB-4 should implement **one** adapter/service using this connection/repository layer and inject that same service into REST and realtime:

```ts
interface SharedMessagePersistence {
    storeMessage(request: {
        envelope: MessageEnvelope; fingerprint: string; receivedAt: Date;
    }): Promise<
        { outcome: 'created' | 'duplicate'; storedAt: Date } |
        { outcome: 'conflict' }
    >;
    findMessage(conversationId: string, messageId: string): Promise<StoredMessageRef | null>;
    recordReceipt(receipt: ReceiptRecord): Promise<
        { outcome: 'created' | 'duplicate'; recordedAt: Date }
    >;
}
```

Inside one write transaction the later service must recheck authoritative membership/block policy, inspect the scoped key/fingerprint, preserve original storedAt for duplicates, report conflicts and write only once. Map envelope id/conversationId/senderId/senderName/timestamp/type and encryption fields into the stored fields without changing authenticated metadata. `created_at` is server storage time, not the authenticated client timestamp. `messages.insert` deliberately throws DUPLICATE rather than implementing the later business outcome policy.

Coordination required before wiring:

- Legacy `message_id` is globally unique. The realtime contract guarantees uniqueness per conversation. DB-4 must either agree global UUID uniqueness with the owners or add a scoped-storage migration and a legacy lookup policy; do not silently reinterpret this stricter foundation key.
- Decide the canonical fingerprint algorithm with realtime; DB-1 merely preserves supplied fingerprints. Do not calculate a different fingerprint on each path.
- Only Security can attest recipient key distribution and verify multi-user encryption. No key store, key exchange, decryption or RecipientKeyVerifier is supplied here. Unknown legacy authenticated metadata remains unknown.
- Wire the SessionResolver, authorization and durable MessageStore only after the later services exist. No Kiro-owned modules or frontend code were edited, and remote AI remains disabled.

## DB-5B group repository additions

This section adds to the historical contracts above. `createGroupRepository(db)` in `server/database/groupRepository.js` composes `createRepositories(db)` on the caller's already migrated connection. It opens no connection and supplies no public API or feature-gate wiring. It is trusted internal persistence, not an authorization boundary. The service must apply session, CSRF, role, block, feature and payload checks under the approved contracts. This addition does not change E2EE, key management or realtime security.

### Two additive base-repository edits

1. `audit.insert` additionally allows `target_id` and `role`. Like `reason_code`, `operation` and `outcome`, both must be identifier strings matching `^[a-zA-Z0-9_.:-]{1,64}$`. Numeric `count` and `duration_ms` remain finite and nonnegative. No arbitrary metadata, nested values, prompts, ciphertext, passwords or free-form reasons are permitted.
2. `repositories.js` exports its existing `translate` function. Its behavior is unchanged. In particular, the base mapper still maps a trigger constraint to INVALID; the group-specific mapper described below maps a raw SQLite trigger abort to CONFLICT. Already-translated RepositoryError instances pass through unchanged.

### Transaction ownership and errors

Reads carry `.kind = 'read'`; writes carry `.kind = 'write'`. Reads normalize errors and need no transaction. Every write throws TypeError before argument validation/SQL when no transaction is open. Each write runs in a savepoint: a failed function restores its own changes even if the caller catches the error and continues.

The seven membership/interval primitives and `insertGroup` require `withMembershipTransaction(db, work)`, which owns an outer `BEGIN IMMEDIATE` transaction and rejects ambient/nested transactions and asynchronous or Promise-returning work. An ordinary caller transaction cannot invoke those primitives. It tracks groups touched across repository instances, permits coordinated membership/interval writes inside the transaction, and validates exactly one active owner, one open interval per active member and none per former member after work and before COMMIT. A callback exception or failed final validation rolls back the complete transaction; a validation mismatch is DATABASE. No write occurs between validation and the driver's commit. Immediate SQLite constraints and migration 0008 hardening remain enabled throughout. Metadata, Invitation, read-position and revision writes retain their ordinary open-transaction guard and can participate in this coordinated transaction.

`readFunction`, `writeFunction`, `compareAndSet` and `normaliseError` are the internal core helpers. Conditional updates compare their expected previous state; the read-position UPSERT instead atomically retains the maximum. `compareAndSet` requires exactly one returned/changed row or throws CONFLICT, with its own savepoint. Bulk cancellation performs one such conditional update per selected pending row within the function savepoint.

| Raw SQLite condition | Group repository class |
| --- | --- |
| Primary-key/unique constraint | DUPLICATE |
| Trigger abort or stale compare-and-set | CONFLICT |
| CHECK/other constraint or invalid repository input | INVALID |
| Foreign-key constraint | REFERENCE |
| Busy/locked | BUSY |
| Cannot open, I/O, full disk, read-only | UNAVAILABLE; OP-09 remains provisional, unchanged by this task |
| Unknown driver or unexpected error | DATABASE |

Only fixed class messages escape; no driver message, SQL, bound value, constraint name or cause is attached. RepositoryError passes through unchanged. These are internal classes, not a change to public HTTP error contracts. The hardened second-open-interval guard intentionally yields CONFLICT instead of its former unique-index DUPLICATE; ordinary duplicate keys and pending Invitations remain DUPLICATE.

### Group reads and returned values

Rows are internal persistence records, not public DTOs. Keyset lists take `{limit, after}` (default 20, maximum 50) and return at most limit+1 raw rows; the service slices the lookahead and encodes cursors. `after` accepts the ordering tuple or a decoded `{last: tuple}`. The repository itself returns no cursor.

| Function | Contract |
| --- | --- |
| `getVisibleGroup(id)` | Combined conversation/extension row only for group kind, authenticated origin and an existing extension; otherwise null. Archived groups remain readable. |
| `getMember(id, user)`, `countActiveMembers(id)` | Retained membership row/null, including former membership for internal checks; active count or zero for an invisible group. |
| `activeMemberIds(id)` | Active member user IDs in stable order for internal receipt fan-out; returns an empty list for an invisible group. This internal projection is not a public membership or visibility grant. |
| `listGroupsForUser(actor, options)` | Active memberships ordered by updated time and group id descending, with role, member count and permitted unread count. |
| `listMembers(id, options)` | Active rows by open-period join time/user ascending; `former: true` returns former rows by leave time/user ascending, using their latest closed period. |
| `getCreationKey(user, key)` | Idempotency row/null restricted to a visible group. |
| `invariantReport(id)` | Counts active owners, active members, open intervals and membership/interval mismatches. |
| `getInvitation(invitationId)` | Invitation row/null restricted to a visible group, including terminal and past-expiry rows. |
| `findPending(id, invitee)` | Pending row/null, including a past-expiry pending row for subsequent lazy expiry. |
| `countPendingForGroup(id, nowIso)`, `countPendingForInvitee(user, nowIso)` | Count only unexpired pending rows of visible groups; expiry equal to now is expired. |
| `listPendingForInvitee(user, nowIso, options)`, `listPendingForGroup(id, nowIso, options)` | Unexpired pending rows by creation time and invitation id descending. Own-list rows additionally project group name and inviter display name, with no member list or message content. |
| `closedIntervalSince(id, user, sinceIso)` | Whether a retained closed interval ended at or after the supplied time, including removal evidence before a rejoin. |
| `intervalsFor(id, user)`, `openInterval(id, user)` | Retained intervals in interval-number order; current open row/null. These internal metadata reads do not grant a former member history access. |
| `historyPage(id, user, {policy, limit, highWater, before})` | One SQL query applies authorized membership ranges before LIMIT; returns limit+1 rows descending by sequence, bounded by fixed `highWater` and exclusive `before` (null by default). |
| `getPermittedMessage(id, user, policy, messageId)` | Authenticated message row/null under the same permitted-range predicate; an unknown, foreign-group or nonpermitted id has the same null result. Permitted tombstones remain rows for service projection. |
| `unreadCount(id, user, policy)` | Permitted authenticated messages above the stored position (zero if absent), excluding tombstones and the requester's own sends. |
| `getReadPosition(id, user)` | Stored integer or zero; a former/non-member or invisible group reveals no stored position. |

History, single-message and unread queries require current active membership and the supplied policy to match the immutable stored policy; a different valid policy fails closed. The range union includes prior and current periods; `all` additionally includes the prefix before the first join. Empty periods grant no message and absence gaps are always excluded. Former members and never-members receive no history. The first page's high-water must be reused on subsequent pages; an empty result has no lookahead or next-page indication. History uses `idx_messages_authenticated_history` without a full message scan.

### Group writes

| Function | Contract |
| --- | --- |
| `insertGroup({conversation_id?, created_by, title, description?, historyPolicy?})` | Uses the base conversation create operation for authenticated group kind and creator ownership, then extension revision 1 and the creator's first interval. Default description is NULL, default policy `from_joined`; only `all` and `from_joined` are valid. Returns the combined group row. The completed group is registered for mandatory final validation. |
| `updateSettings(id, patch, at)` | Accepts only supplied title/description fields; description NULL clears it. Updates conversation title/time and extension description atomically, never history policy. Returns the combined group row; archived/invisible groups conflict. |
| `archiveGroup(id, at)`, `touchConversation(id, at)` | Archive is a compare-and-set on unarchived state and writes archive/update times, returning the combined group. Touch sets update time on an unarchived visible group, returning the conversation row. |
| `bumpRevision(id)` | Adds exactly 1 and returns the new membership revision. Service coordinates one increment per logical membership/role operation. |
| `claimCreationKey(user, key, fingerprint, id, at)` | Inserts a key row, or explicitly deletes and inserts a row strictly older than 24 hours in one savepoint. Exactly 24 hours is still retained. Live collisions remain DUPLICATE; a failed renewal restores the old row. Returns the stored row. |
| `addMember(id, user, at)` | Insert a new member with the supplied first join time and role member; a retained row conflicts. Pair with interval opening. |
| `reactivateMember(id, user, at)` | Require former membership, clear leave time and reset role to member. Never rewrite the original ConversationMembers `joined_at`; pair with interval opening. |
| `endMembership(id, user, at)` | Require active non-owner membership, set leave time; pair with interval closure at the same operation timestamp. |
| `changeRole(id, user, from, to)` | Conditional active non-owner role change between member/admin using the expected old role. Ownership cannot be changed through this method. |
| `transferOwnership(id, from, to)` | Demote the active owner first, then promote an active admin/member. The current `FORMER_OWNER_ROLE` policy constant is admin. A failed promotion restores the demotion, even if caught by the caller. |
| `openIntervalAt(id, user, at, firstSeq?)` | Require active membership; append next interval number with `first_seq = highWater + 1`. A supplied sequence must equal that boundary. |
| `closeInterval(id, user, at, lastSeq?)` | Require membership ended at the same timestamp; close its open interval with `last_seq = highWater`, including an empty `[first_seq, first_seq - 1]` period. A supplied sequence must match. |
| `insertInvitation({invitation_id, conversation_id, invitee_id, inviter_id, created_at, expires_at?})` | Insert pending with NULL resolution. Expiry is creation plus the fixed 604800 seconds; an explicitly supplied expiry must agree. Returns the row. Session/role/block/maximum revalidation remains service work. |
| `resolveInvitation(id, to, at)` | Pending-only transition to accepted, declined, cancelled or expired; returns the row. A terminal or missing row conflicts and never changes. |
| `cancelPendingFor(id, user, at)` | Cancel all pending Invitations addressed to or issued by that user in the group, returning the count; the whole batch is atomic. |
| `expirePast(id, invitee, nowIso)` | Expire the group's pending row for that invitee at or past expiry, returning 0 or 1. This permits a new pending row without deleting history. |
| `upsertReadPosition(id, user, n, at)` | Require active membership, safe integer 0 through high-water and a permitted range for n > 0. Uses valid UPSERT with `max` and returns the stored integer; equal/lower valid reports preserve both position and timestamp. Retained membership/read identity is unchanged. |

Membership and interval functions are coordinated primitives, not independently committable business operations. A typical already-authorized synchronous operation is:

```js
const groups = createGroupRepository(db);
withMembershipTransaction(db, () => {
    groups.addMember(groupId, userId, nowIso);
    groups.openIntervalAt(groupId, userId, nowIso);
    groups.bumpRevision(groupId);
});
```

Authorization, auditing and public result mapping remain with the service; no asynchronous verifier runs inside this transaction. These additions preserve all existing direct-message, authentication and Security/Realtime interfaces. Feature-gate activation and later API implementation remain separate owner-reviewed work.
