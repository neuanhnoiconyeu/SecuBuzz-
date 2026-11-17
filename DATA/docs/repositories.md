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
