# Recipient-key verification for encrypted direct messages (post DB-4B)

Branch `chuong-data`, HEAD `72f4e80`, uncommitted. Spec: [.kiro/specs/e2ee-recipient-keys/](../.kiro/specs/e2ee-recipient-keys/). Owner of this work: Kiro (`server/`). `client/` and `DATA/` were not modified.

## 1. Status

| Item | State |
| --- | --- |
| Protocol for device keys, key delivery and envelope v2 | Specified (sections 3–6) |
| Server verifier and synchronous rules for DATA | Implemented in `server/src/e2ee/`, 63 tests |
| DATA key directory (tables, endpoints, v2 storage, wiring) | **Not implemented: Database Team handoff (section 9)** |
| Client device keys, HPKE key delivery, envelope v2 | **Not implemented: Codex handoff (section 10)** |
| Realtime per-actor store and v2 on sockets | Not implemented: next step (section 11) |
| Production sending | **Still disabled.** DATA returns `503 RECIPIENT_KEYS_UNAVAILABLE`; the socket answers `recipient_keys_unavailable` |
| Real two-account E2EE in a browser | **Not verified.** Verified: the protocol between independent simulated devices, and the seam with real DATA accounts (section 12) |

## 2. What the audit found

| Area | Finding |
| --- | --- |
| Envelope | Version 1 only; no key ID. AAD `["yahoo-security-messenger",1,conversationId,id,senderId,senderName,timestamp,"text"]`. |
| Keys | `InMemoryDemoKeyManager`: one non-extractable AES-256-GCM key per (local user, conversation) in page memory. No recipient key, no exchange; lost on reload. |
| Can Bob decrypt Alice's message? | No. Different browsers never share a key, and a non-extractable key cannot be wrapped. |
| Key-to-account binding | None. No key tables in DATA migrations 1–6. |
| Rejection today | DATA: no verifier → 503; `{verified:false}` → 403; throw/timeout → 503. Realtime: no store or verifier → `recipient_keys_unavailable`. |
| Refresh, reconnect, multiple browsers | Not supported by the current key manager. |
| Real-account messaging in the client | Absent; the Next proxy maps only auth and social paths. |
| Seams that exist | DATA `createApp({messageOptions:{recipientKeyVerifier}})` calls `verifyEnvelope(actor, envelope, {conversationId, recipientIds, fingerprint})`; realtime calls `verifyEnvelope(actor, envelope)`. |
| Module boundary | Node 24.20 lets DATA's CommonJS `require()` Kiro's TypeScript ESM (tested in production mode). |

AES-256-GCM per message is sound, but there is no multi-user E2EE. A version-1 envelope can never be verified honestly, because nothing binds it to a recipient key.

## 3. Protocol `secubuzz-dm-keys` v1

### 3.1 Algorithms and encodings

| Purpose | Algorithm | Wire format |
| --- | --- | --- |
| Device signing | ECDSA P-256, SHA-256 | Signature: IEEE P1363 `r‖s` (64 bytes) as base64url, 86 chars (WebCrypto's native output) |
| Device agreement | ECDH P-256 | Public key: uncompressed point `04‖X‖Y` (65 bytes) as base64url, 87 chars (`exportKey('raw')`) |
| Key delivery | HPKE RFC 9180, mode_base, KEM 0x0010 DHKEM(P-256, HKDF-SHA256), KDF 0x0001, AEAD 0x0002 AES-256-GCM, single-shot (sequence 0) | `enc` 87 chars; ciphertext 48 bytes (32-byte key + tag) as base64url, 64 chars |
| Messages | AES-256-GCM, random 96-bit IV, 128-bit tag (unchanged) | Canonical padded base64 (unchanged) |

All base64url is unpadded and canonical (re-encoding the bytes reproduces the string). Every statement is `JSON.stringify` of a fixed-order array of strings, safe integers, `null` and arrays, the same method as the existing AAD. Timestamps are `YYYY-MM-DDTHH:mm:ss.sssZ` equal to `new Date(t).toISOString()`.

### 3.2 Identifiers

| Field | Rule |
| --- | --- |
| `userId` | From the DB-2 session only |
| `deviceId` | 16 random bytes, base64url (22 chars), created once per browser profile and account |
| `keyVersion` | 1–1,000,000; increases when a device rotates its key pairs |
| `deviceKeyId` | base64url(SHA-256(`["secubuzz-device-key-id",1,agreementPublicKey,signingPublicKey]`)), 43 chars |
| epoch `keyId` | 16 random bytes, base64url (22 chars) |
| `epoch` | 1–1,000,000,000; exactly `current + 1` |

### 3.3 Statements

```text
registration: ["secubuzz-device-key",1,userId,deviceId,keyVersion,createdAt,agreementPublicKey,signingPublicKey]
epoch:        ["secubuzz-conversation-key",1,conversationId,keyId,epoch,previousKeyId|null,creatorUserId,
               creatorDeviceKeyId,createdAt,[[recipientUserId,recipientDeviceKeyId,enc,ciphertext],...]]
wrap info:    ["secubuzz-conversation-key-wrap",1,conversationId,keyId,epoch,creatorUserId,creatorDeviceKeyId,
               recipientUserId,recipientDeviceKeyId]          (HPKE info; HPKE aad is empty)
message AAD:  ["yahoo-security-messenger",2,conversationId,id,senderId,senderName,timestamp,"text",keyId]
fingerprint:  SHA-256 hex of [id,conversationId,senderId,senderName,timestamp,type,2,"AES-256-GCM","base64",keyId,iv,ciphertext]
```

Wraps are ordered strictly by `recipientUserId`, then `recipientDeviceKeyId` (code-unit order). The creator signs the epoch statement with its device signing key. Recipients check the creator's device record and that signature before opening their own wrap.

### 3.4 Envelope v2

Version 1 plus `encryption.keyId`; everything else unchanged:

```json
{ "id": "…", "conversationId": "…", "senderId": "…", "senderName": "…", "timestamp": "…", "type": "text",
  "encryption": { "version": 2, "algorithm": "AES-256-GCM", "encoding": "base64",
                  "keyId": "<22 base64url>", "iv": "<12 bytes>", "ciphertext": "<more than 16 bytes>" } }
```

Canonical parser and fingerprint: `server/src/e2ee/envelope.ts` (`parseMessageEnvelopeV2`, `envelopeV2Fingerprint`, `messageAadV2`). The version-1 parser and fingerprint in `server/src/realtime/validation.ts` are unchanged.

## 4. Threat model and guarantees

| Party | Protected | Not protected |
| --- | --- | --- |
| Network attacker | Content and keys | Traffic metadata |
| Database or backup reader | Plaintext and epoch keys: only public keys, signatures, HPKE wraps and ciphertext are stored | Who talks to whom, when, sizes, device counts |
| Other account (Charlie) | Cannot register keys for others, publish epochs in others' conversations, or decrypt (no wrap; opening another wrap fails) | — |
| Stolen session and CSRF token | Mutations still need Origin and CSRF | Attacker can register a device and receive future epochs until the user revokes it |
| Malicious server or operator | Cannot read content using the keys as users registered them | **Can substitute keys** (register its own device under Bob). The server's verification only proves consistency with its own registry: this is server trust plus client TOFU. Only client key-change warnings and out-of-band safety-number comparison reveal substitution. Tested in `two-account-flow.test.ts` |
| Compromised device | Revocation plus rotation stops future epochs | Epochs it already received; no forward secrecy within an epoch |
| Malicious participant | — | Holds the shared key, so it can forge messages "from" the other participant to itself; messages are not individually signed |

Replay: registrations cannot be replayed after rotation or revocation (monotonic versions, permanent revocation, unique `deviceKeyId`); epochs cannot roll back (`epoch = current + 1` with `previousKeyId`); messages keep DB-4B idempotency and the realtime clock-skew check. Substitution: the session binds and the signed statement names the user; changing a wrap breaks the epoch signature; moving an epoch or message to another conversation breaks the statement, HPKE info and AAD.

The server cannot check that a ciphertext really used the named key; a lying sender only makes its own message unreadable.

## 5. Key lifecycle

| Event | Client | Server (DATA calls Kiro rules) |
| --- | --- | --- |
| First sign-in on a browser | Generate ECDSA and ECDH P-256 pairs (private non-extractable), `deviceId`, store in IndexedDB under the user ID; sign and register | `validateDeviceRegistration` + `planDeviceRegistration` in one transaction |
| Refresh or reconnect | Reload keys from IndexedDB; no new registration | Identical repeat is a duplicate |
| Second browser | New device, new registration | Existing epochs become stale (exact-set rule) |
| Start chatting | Fetch key state, verify records, pin peer keys (TOFU), publish epoch 1 | `planEpochPublication` |
| Device set changed | Show the change; publish the next epoch | Old epoch refused at send time until then |
| Key rotation | Same `deviceId`, `keyVersion + 1`, new pairs | Old version superseded permanently |
| Lost browser | Revoke from another device | `planDeviceRevocation`: every version of that `deviceId` revoked permanently |
| Logout | Keep device keys (the device stays enrolled); clear decrypted caches | No key change |
| Account switch in one browser | Separate key namespace per user ID | Device IDs are per user |
| "Remove this browser" | Revoke, then delete local keys | Revocation |

## 6. Verification sequence

1. DATA authenticates the session and CSRF, validates the envelope, checks membership, friendship and blocks (existing DB-4B preparation transaction).
2. DATA calls `verifyEnvelope(actor, envelope, {conversationId, recipientIds, fingerprint})`.
3. The verifier refuses anything but v2, reads `directory.loadConversationKeyState({conversationId, keyId})` under a 1.5 s deadline, parses it strictly and evaluates:
   envelope conversation and sender match the actor → exactly two participants including the actor → DATA's recipients equal the other participant → DATA's fingerprint equals the v2 fingerprint → the epoch exists in this conversation and is current → every participant has an active device → every active device record re-derives its ID and its self-signature verifies → the epoch's recipients equal exactly the active devices → its creator is an active device of a participant → its signature verifies.
4. Result: exactly `{verified:true}` or `{verified:false}`. A directory failure throws `RecipientKeyServiceUnavailableError` (DATA → 503).
5. Inside the second `BEGIN IMMEDIATE` transaction DATA re-reads the key state and calls `verifyRecipientKeysSync(envelope, context, state)`, so a revocation committed during step 3 cannot let the message commit. **This recheck is a required DATA change.**

## 7. Server implementation (Kiro)

| File | Content |
| --- | --- |
| `server/src/e2ee/protocol.ts` | Labels, HPKE suite, byte lengths, limits, refusal codes |
| `server/src/e2ee/codec.ts` | Canonical base64url and timestamps, canonical JSON, SHA-256 |
| `server/src/e2ee/keys.ts` | P-256 point validation (coordinates below p, on curve), `deviceKeyIdFor` |
| `server/src/e2ee/signatures.ts` | Synchronous ECDSA P-256 verification (P1363) with a bounded cache of successes |
| `server/src/e2ee/statements.ts` | Canonical statements, wrap info, recipient order and set digest |
| `server/src/e2ee/envelope.ts` | Envelope v2 parser, fingerprint, AAD |
| `server/src/e2ee/records.ts` | Strict parsers for stored device keys, epochs and directory snapshots |
| `server/src/e2ee/registration.ts` | `validateDeviceRegistration`, `planDeviceRegistration`, `planDeviceRevocation` |
| `server/src/e2ee/epochs.ts` | `planEpochPublication` |
| `server/src/e2ee/evaluation.ts` | `evaluateRecipientKeys`, `verifyRecipientKeysSync` |
| `server/src/e2ee/verifier.ts` | `createRecipientKeyVerifier`, `RecipientKeyDirectory` contract |
| `server/src/e2ee/index.ts` | Public API (`secubuzz-realtime-server/e2ee`) |

Everything is synchronous except `verifyEnvelope`, so DATA can call the rules inside its own transactions. The verifier has no default directory and no environment switch; a `testOnly` directory is refused in production. Logs contain reason codes only.

## 8. Error codes

| Rule result | HTTP | Code |
| --- | --- | --- |
| `invalid_registration`, `invalid_publication` | 400 | `VALIDATION_ERROR` |
| `stale_registration`, `stale_publication`, `signature_invalid` | 400 | `KEY_PROOF_INVALID` (new) |
| `key_in_use`, `key_revoked`, `device_owned_by_another_user`, `device_revoked`, `stale_key_version` | 409 | `KEY_CONFLICT` (new) |
| `device_limit` | 409 | `DEVICE_LIMIT` (new) |
| `epoch_out_of_order`, `recipient_set_mismatch`, `creator_device_unknown`, `key_id_conflict` | 409 | `RECIPIENT_KEYS_CHANGED` (new) |
| `recipient_without_devices` | 409 | `RECIPIENT_KEYS_UNAVAILABLE` |
| `not_participant`, `unsupported_conversation`, revocation `not_found` | 404 | `NOT_FOUND` |
| Send: `{verified:false}` | 403 | `RECIPIENT_KEYS_UNVERIFIED` (existing) |
| Send: verifier throws, or no verifier | 503 | `RECIPIENT_KEYS_UNAVAILABLE` (existing) |

All other DB-2/3/4 errors keep their meaning (401 `UNAUTHENTICATED`/`SESSION_EXPIRED`, 403 `CSRF_INVALID`/`FORBIDDEN`, 413, 415, 429 with `Retry-After`, 503 `SERVICE_UNAVAILABLE`).

## 9. Database Team handoff (DATA)

### 9.1 Migration `0007-recipient-keys.sql` (new; versions 1–6 unchanged)

```sql
CREATE TABLE DeviceKeys (
  device_key_id TEXT PRIMARY KEY CHECK(length(device_key_id)=43),
  user_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
  device_id TEXT NOT NULL CHECK(length(device_id)=22),
  key_version INTEGER NOT NULL CHECK(typeof(key_version)='integer' AND key_version BETWEEN 1 AND 1000000),
  created_at TEXT NOT NULL,                 -- signed client time
  agreement_public_key TEXT NOT NULL CHECK(length(agreement_public_key)=87),
  signing_public_key TEXT NOT NULL CHECK(length(signing_public_key)=87),
  signature TEXT NOT NULL CHECK(length(signature)=86),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','revoked')),
  registered_at TEXT NOT NULL, status_changed_at TEXT,
  UNIQUE(device_id, key_version)
);
CREATE INDEX idx_device_keys_user_status ON DeviceKeys(user_id, status);
CREATE INDEX idx_device_keys_device ON DeviceKeys(device_id);
CREATE TABLE ConversationKeyEpochs (
  conversation_id TEXT NOT NULL REFERENCES Conversations(conversation_id) ON DELETE RESTRICT,
  key_id TEXT NOT NULL CHECK(length(key_id)=22),
  epoch INTEGER NOT NULL CHECK(typeof(epoch)='integer' AND epoch >= 1),
  previous_key_id TEXT CHECK(previous_key_id IS NULL OR length(previous_key_id)=22),
  creator_user_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
  creator_device_key_id TEXT NOT NULL REFERENCES DeviceKeys(device_key_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL, signature TEXT NOT NULL CHECK(length(signature)=86),
  recipient_set_digest TEXT NOT NULL CHECK(length(recipient_set_digest)=43), published_at TEXT NOT NULL,
  PRIMARY KEY(conversation_id, key_id), UNIQUE(conversation_id, epoch),
  CHECK((epoch = 1) = (previous_key_id IS NULL))
);
CREATE TABLE ConversationKeyWraps (
  conversation_id TEXT NOT NULL, key_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position >= 0),
  recipient_user_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
  recipient_device_key_id TEXT NOT NULL REFERENCES DeviceKeys(device_key_id) ON DELETE RESTRICT,
  enc TEXT NOT NULL CHECK(length(enc)=87), ciphertext TEXT NOT NULL CHECK(length(ciphertext)=64),
  PRIMARY KEY(conversation_id, key_id, recipient_device_key_id), UNIQUE(conversation_id, key_id, position),
  FOREIGN KEY(conversation_id, key_id) REFERENCES ConversationKeyEpochs(conversation_id, key_id) ON DELETE RESTRICT
);
```

Plus triggers: key material, epochs and wraps immutable and never deleted; `status` only `active→superseded`, `active→revoked`, `superseded→revoked`.

Messages: SQLite cannot alter a CHECK, so v2 needs a careful table rebuild (like DB-1's `Messages_next`) that allows `envelope_version IN (1,2)`, adds `key_id TEXT` (`NOT NULL` and 22 chars exactly when version is 2, `NULL` for version 1), and updates `messages_authenticated_insert` to accept version 2 only with `key_id`. Existing rows, IDs, ciphertext, receipts and indexes must survive byte-for-byte, with upgrade and rollback tests as in DB-4B.

### 9.2 Endpoints

All use the existing `/api` transport and Origin gate, `requireAuth`, `requireCsrf` for mutations, no-store, fixed errors, JSON only (8 KiB; 16 KiB for epochs), and rate limits (proposed: key mutations 30/min/actor and 120/min/source; reads 120/min/actor). User IDs never come from bodies.

| Method and path | Body | Transaction and rules | Success |
| --- | --- | --- | --- |
| `POST /api/keys/devices` | `{deviceId, keyVersion, createdAt, agreementPublicKey, signingPublicKey, signature}` | `validateDeviceRegistration(body,{userId:req.auth.userId})`; then in `BEGIN IMMEDIATE`: verify the CSRF proof, read `existingKey` (same `device_key_id`), `deviceHistory` (same `device_id`, any user), `activeDevicesOfUser`; `planDeviceRegistration(record, lookup, {nowMs})`; apply `supersede` and insert | 201 `{device}` / 200 `{device}` (duplicate) |
| `GET /api/keys/devices` | — | Caller's own devices, all statuses, newest first, at most 50 | 200 `{items:[device]}` |
| `POST /api/keys/devices/:deviceId/revoke` | empty or `{}` | Immediate transaction: `planDeviceRevocation(userId, deviceId, history)`; set `revoked` | 200 `{outcome:'revoked'\|'unchanged'}` |
| `GET /api/conversations/:id/keys` | — | Read transaction with DB-4A `authorizeInTransaction` (read; blocks hide it with 404) | 200 `{conversationId, participantIds, devices:[active device], currentEpoch:{keyId,epoch}\|null, epochs:[epoch]}` (latest 20, `cursor` for older) |
| `GET /api/conversations/:id/keys/epochs/:keyId` | — | Same authorization | 200 `{epoch}` |
| `POST /api/conversations/:id/keys/epochs` | `{keyId, epoch, previousKeyId, creatorDeviceKeyId, createdAt, wraps:[{recipientUserId, recipientDeviceKeyId, enc, ciphertext}], signature}` | Inside `conversations.withInteraction(context, proof, id, work)`: read active devices of `capability.participantIds`, the current epoch and the epoch with this `keyId`; `planEpochPublication(body, {actorUserId, conversationId, participantIds, activeDevices, currentEpoch, existingEpoch, nowMs})`; insert epoch, `recipient_set_digest` and wraps with `position` | 201 `{epoch}` / 200 `{epoch}` (duplicate) |

Projections (public fields only):

```text
device = {deviceKeyId, userId, deviceId, keyVersion, createdAt, agreementPublicKey, signingPublicKey, signature, status, registeredAt}
epoch  = {conversationId, keyId, epoch, previousKeyId, creatorUserId, creatorDeviceKeyId, createdAt, wraps, signature, publishedAt}
```

### 9.3 Message submission changes

1. Accept v2 envelopes, validated exactly like `parseMessageEnvelopeV2`; compute the fingerprint by version (v2 includes `keyId`); store `key_id`; return `encryption.keyId` in history for v2.
2. Inside the second `withInteraction` of `submit`, before the duplicate lookup: read the key state on the same connection and refuse with 403 `RECIPIENT_KEYS_UNVERIFIED` unless `verifyRecipientKeysSync(envelope, {actorUserId, conversationId, recipientIds:[capability.recipientId], fingerprint}, state)`.
3. Version 1 stays refused for new submissions once the verifier is wired (the verifier returns `{verified:false}`).

### 9.4 Directory adapter and wiring

```js
const e2ee = require('../../server/src/e2ee/index.ts'); // CommonJS require of the Kiro ESM entry (Node 24)
function createSqliteKeyDirectory(db) {
  const read = (conversationId, keyId) => {
    // Return null for an unknown conversation. participantIds: the active members with active
    // credential-enabled accounts of an authenticated, unarchived direct conversation.
    // activeDevices: DeviceKeys rows with status 'active' for those participants (projection above, plus status).
    // currentEpoch: the highest epoch {keyId, epoch} or null. epoch: the row with (conversationId, keyId) and its
    // wraps ordered by position, or null.
  };
  return {
    read, // synchronous, for the in-transaction recheck
    loadConversationKeyState: ({conversationId, keyId}) => db.transaction(() => read(conversationId, keyId)).deferred(),
  };
}
const directory = createSqliteKeyDirectory(db);
createApp({db, messageOptions: {recipientKeyVerifier: e2ee.createRecipientKeyVerifier({directory})}});
```

Wire it in `DATA/server.js` only after every item in 9.1–9.3 and 9.5 passes. Until then the normal entrypoint must keep supplying no verifier.

### 9.5 DATA tests

- Run `keyDirectoryContract(name, harness)` from `server/test/e2ee/support/keyDirectoryContract.ts` against the SQLite directory (implement `KeyDirectoryHarness` over the repositories or the REST routes, including `reopen` on a second connection).
- HTTP: unauthenticated and CSRF-less key requests refused; body `userId` refused; cross-user registration (`signRegistrationAs`) refused; revoked or superseded key and revoked device refused; stale version refused; device limit; Charlie cannot read or publish key state of Alice and Bob; blocked pairs get 404; unfriended pairs can read but not publish; expired and logged-out sessions refused.
- Concurrency: two processes publishing epoch n+1 at once → one 201 and one 409; identical registrations from two processes → one row; revocation committed during a slow verification → the message is not stored (in-transaction recheck).
- v2 submission end to end with the vector file and with two real accounts; restart retains keys and epochs; no plaintext or private key in rows, logs or WAL.

## 10. Codex handoff (client)

1. **Device keys** (`client/src/security/deviceKeys.ts`, new): per user ID, generate ECDSA and ECDH P-256 key pairs with non-extractable private keys and a random `deviceId`; persist the `CryptoKey` objects in IndexedDB (structured clone keeps them non-extractable); register through `POST /api/keys/devices`; rotate with `keyVersion + 1`; list and revoke devices in a device-management view.
2. **Remote key manager** (implements the existing `ConversationKeyManager`): fetch `GET /api/conversations/:id/keys`; verify every device record (`deviceKeyId` derivation and self-signature) and every epoch signature; pin peer `deviceKeyId`s per peer (TOFU); open the device's own wrap with HPKE; import the 32-byte key as non-extractable AES-GCM and zero the bytes; cache epoch keys by `keyId` in IndexedDB; publish the next epoch when there is none or the device set changed; `getSecurityStatus` may report `recipientKeyAvailable`/`authenticatedKeyExchangeEstablished` only after these checks pass.
3. **HPKE**: use a maintained RFC 9180 implementation for DHKEM(P-256, HKDF-SHA256)/HKDF-SHA256/AES-256-GCM that accepts non-extractable WebCrypto keys, or a reviewed in-house one; either way it must pass the RFC 9180 A.3.1 vector and `server/test/e2ee/vectors/protocol-v1.json`.
4. **Envelope v2**: add v2 encryption and decryption with the v2 AAD to `client/src/utils/crypto.ts` (keep v1 for the demo only); accept v2 in `client/src/realtime/realtimeValidation.ts`; never send `scope:'browser-demo'` or v1 for real accounts.
5. **Errors**: 403 `RECIPIENT_KEYS_UNVERIFIED` (nothing stored) → refresh key state, show any key change, publish the next epoch, re-encrypt with the same message `id`; 409 `RECIPIENT_KEYS_CHANGED` on publication → refetch and retry; 503 → unavailable, never a demo or plaintext fallback.
6. **Key-change UX**: show a security notice when a peer's devices change and before sending on a new epoch that includes new keys. Recommended: a safety number, SHA-256 hex of `["secubuzz-safety-number",1,[[lowUserId,[sorted deviceKeyIds]],[highUserId,[sorted deviceKeyIds]]]]`, shown in 16 groups of 4, for out-of-band comparison.
7. **Clock**: registrations and epochs need `createdAt` within 5 minutes of server time; use the server `Date` header when the local clock is off.
8. **Logout and account switch**: keep the device enrolled; clear decrypted message and epoch caches; separate IndexedDB namespaces per user ID.
9. **Proxy**: add exact same-origin rewrites for the DB-4A/4B paths and the six key paths in 9.2; no blanket proxy.
10. **Tests**: run the vector file in Jest; two independent browser profiles against real DATA once 9.1–9.4 exist.

## 11. Next step: Socket.IO integration requirements

1. Compose in one Node process: DATA's Express app and Kiro's Socket.IO server on the same HTTP server, sharing the DB connection, `createAuthAdapters(auth)` and this verifier. Production cookie `__Host-secubuzz_session`; `checkSession` revalidation every 15 s.
2. Per-actor writes: the client sends its DB-2 session CSRF token in the handshake `auth.csrfToken` (the only `auth` field read); the server verifies it with `csrfVerifier.verify`, derives the DATA proof with `auth.csrfProof(sessionToken, null, csrfToken)` and binds `messaging.bindStore(context, proof)` for that connection. Add a `bindMessageStore(actor, credentials)` option to the realtime server; keep the global `messageStore` for tests. Never log or keep the raw token after binding.
3. Parse v2 on `message:send` with `parseMessageEnvelopeV2` and the v2 fingerprint; refuse v1 for real sessions.
4. Supply a DATA-backed `RealtimeAuthorizer` (DB-4A conversations, DB-3 blocks) and re-check recipients before fan-out; no socket room is authorization.
5. Emit a new `conversation:keys-changed` event (`{conversationId, currentEpoch}`) after device registration, revocation or epoch publication, so clients refresh and rotate; this needs a client contract update.
6. Record delivery only from real client acknowledgements through the bound store.
7. Attest TLS (`secure`) from direct TLS or a restricted trusted proxy.

## 12. Verification

### Commands

```powershell
cd server; npm run type-check; npm test     # 397 tests, includes test/e2ee (63)
cd DATA;   npm test                          # 288 tests, unchanged
```

`test/e2ee/data-integration.test.ts` loads DATA from `../DATA` and needs DATA's dependencies installed (`npm ci` in `DATA/`).

### Results (Windows, Node 24.20.0)

| Check | Result |
| --- | --- |
| Server type-check | Passed |
| Server tests | 397 passed (334 existing + 63 new), 0 failed, 0 skipped |
| DATA tests (read-only run, isolated temp databases) | 288 passed before and after; tracked DATA databases unchanged (hash-checked) |
| RFC 9180 A.3.1 | Test-only HPKE matches every intermediate value and the ciphertext |

| Test file | Coverage |
| --- | --- |
| `hpke.test.ts` | RFC 9180 vector; wrong recipient, info, aad and tampering fail |
| `primitives.test.ts` | Canonical base64url and timestamps; off-curve, unreduced, compressed points refused; DER and forged signatures refused |
| `envelope.test.ts` | v2 parser and fingerprint; v1 parser and fingerprint unchanged |
| `rules.test.ts` | Session-bound registration, demo and missing identities, cross-user substitution, private-key fields, stale and replayed versions, revoked keys and devices, foreign devices, device limit, revocation, every publication rule |
| `directory-contract.test.ts` | Contract suite: snapshots, idempotency, ordering, scoping, concurrent publications and registrations, reopen |
| `verifier.test.ts` | Positive path for both seams; v1 never verified; actor, participant and recipient mismatch; fingerprint mismatch; unknown, foreign and stale keys; new, revoked and rotated devices; recipient without devices; membership change; corrupted records; tampered wraps; directory throw, hang, malformed (fail closed); capacity; no default; production refuses test directories; log hygiene |
| `two-account-flow.test.ts` | Independent Alice and Bob devices: registration, TOFU, HPKE delivery, v2 send, decrypt, reply; Charlie fails to read, open, publish or impersonate; tampered AAD fails; multi-device, rotation, revocation, restart; no plaintext, raw key or private key stored or logged; key substitution passes the server but is flagged by TOFU |
| `data-integration.test.ts` | Real DATA, real accounts: no verifier → 503; Kiro verifier → v1 refused 403 with DATA's real actor and recipient; v2 → 400 because DATA lacks v2 (verifier ready); unauthenticated, bad CSRF, expired, non-participant, blocked, unfriended, logged-out callers refused before verification; no plaintext in the database |
| `realtime-integration.test.ts` | Socket.IO with the genuine verifier and a store: v1 → `recipient_keys_unavailable`, v2 → `invalid_payload`, nothing stored or delivered |
| `vectors.test.ts` | Fixed synthetic vector: statements, IDs, signatures, rules, HPKE wraps, v2 decryption |
| `boundaries.test.ts` | Export list; imports limited to `node:crypto` and small realtime helpers; no environment switch; DATA can `require` it in production |

### Blockers

1. DATA: key tables, the six endpoints, v2 storage, the in-transaction recheck, the directory adapter and wiring (section 9).
2. Client: device keys, HPKE, remote key manager, envelope v2, key-change UX, proxy paths (section 10).
3. Realtime: per-actor binding, v2 on sockets, DATA authorizer, key-change events (section 11).

**Production encrypted sending is not enabled. Real two-account E2EE between browsers has not been verified.**
