# Design: authenticated recipient-key verification (post DB-4B)

## 1. Architecture assessment (audit before implementation)

Audited on branch `chuong-data`, HEAD `72f4e80`, with 145 uncommitted entries from other owners preserved.

| Question | Finding | Source |
| --- | --- | --- |
| Envelope schema | Version 1 only: `id, conversationId, senderId, senderName, timestamp, type:'text', encryption{version:1, algorithm:'AES-256-GCM', encoding:'base64', iv, ciphertext}`. No key ID. AAD is `["yahoo-security-messenger",1,conversationId,id,senderId,senderName,timestamp,"text"]`. | `client/src/utils/crypto.ts`, `server/src/realtime/validation.ts`, `DATA/server/messaging/validation.js` |
| Key generation and storage | One non-extractable AES-256-GCM key per (local user, conversation), generated in page memory. Lost on reload. | `client/src/security/keyManagement.ts` (`InMemoryDemoKeyManager`) |
| Key scope | Session-local and page-local. Not per user, not per device, not shared. | same |
| Recipient identity | None. `getRecipientPublicKeyMetadata` returns `null`; `establishAuthenticatedKeyExchange` throws `key_exchange_not_configured`. | same |
| Can recipients decrypt? | No. Bob's browser never receives Alice's key, and the key is non-extractable so it cannot be wrapped. | same |
| Key-to-account binding | None. DATA has no key tables; DB-1 to DB-6 migrations contain no public-key records. | `DATA/server/database/migrations/` |
| Current rejection | DATA: no verifier → `503 RECIPIENT_KEYS_UNAVAILABLE`; negative → `403 RECIPIENT_KEYS_UNVERIFIED`; throw/timeout → 503. Realtime: no store or verifier → `recipient_keys_unavailable`. | `DATA/server/messaging/service.js`, `server/src/realtime/messages.ts` |
| Refresh, reconnect, multiple browsers | Not supported: keys die with the page and each browser has different keys. | client key manager |
| Real-account client messaging | Not present. `RealMessengerWorkspace` shows "No conversations yet"; the Next proxy maps only auth and social paths. | `client/src/components/messenger/RealMessengerWorkspace.tsx`, `client/authProxy.cjs` |
| DATA verifier seam | `createApp({messageOptions:{recipientKeyVerifier}})`; called as `verifyEnvelope(actor, envelope, {conversationId, recipientIds, fingerprint})` outside any transaction, then authority is rechecked under `BEGIN IMMEDIATE`. Only an exact `{verified:true}` passes. `testOnly` verifiers are refused in production. | `DATA/server/messaging/service.js` |
| Realtime verifier seam | `RecipientKeyVerifier.verifyEnvelope(actor, envelope)` (two arguments). | `server/src/realtime/contracts.ts` |
| Realtime-to-DATA write path | Absent. Kiro's global `MessageStore` has no per-call session or CSRF proof; DATA's `bindStore(context, proof)` needs both. | `DATA/docs/db4b-realtime-integration.md` |
| Module boundary | Node 24.20 can `require()` Kiro's TypeScript ESM from DATA's CommonJS (checked), so DATA can host Kiro's verifier in-process. | local check |

**Conclusion.** AES-256-GCM is implemented correctly per message, but there is no multi-user E2EE: no recipient keys, no key delivery, no key IDs and no persistence. A verifier cannot honestly return `verified:true` for any version-1 envelope, because nothing binds the ciphertext to a recipient key. A positive path needs (a) device keys and key delivery in the client, (b) a persisted key directory in DATA, (c) an envelope version that names its key, and (d) server-side verification. Kiro owns (d) and the canonical definition of (c); (a) and (b) are handoffs. Production sending must stay blocked.

## 2. Protocol: `secubuzz-dm-keys` version 1

### 2.1 Algorithms

All primitives are standard and available in WebCrypto and `node:crypto`. Nothing is invented.

| Purpose | Algorithm | Encoding |
| --- | --- | --- |
| Device signing | ECDSA P-256 with SHA-256 | Signature: IEEE P1363 `r‖s`, 64 bytes, base64url (86 chars) |
| Device key agreement | ECDH P-256 | Public key: uncompressed point `04‖X‖Y`, 65 bytes, base64url (87 chars) |
| Conversation-key wrap | HPKE, RFC 9180, mode_base, KEM 0x0010 DHKEM(P-256, HKDF-SHA256), KDF 0x0001 HKDF-SHA256, AEAD 0x0002 AES-256-GCM | `enc` 65 bytes (87 chars); ciphertext 48 bytes (64 chars) |
| Message encryption | AES-256-GCM, 96-bit random IV, 128-bit tag (unchanged) | Canonical padded base64 (unchanged) |
| Identifiers and digests | SHA-256 | base64url or lowercase hex as stated |

Private keys are generated non-extractable and never leave the browser. The epoch key is 32 random bytes, used only after `importKey('raw', …, false, ['encrypt','decrypt'])`; the raw bytes are zeroed after wrapping or unwrapping.

base64url values are unpadded and canonical: re-encoding the decoded bytes must reproduce the input. Canonical text is `JSON.stringify` of an array whose items are strings, safe integers, `null` or arrays of those, the same method as the existing AAD and fingerprint.

### 2.2 Identifiers

| Name | Format | Origin |
| --- | --- | --- |
| `userId` | DB-2 user ID | Authenticated session only |
| `deviceId` | 16 random bytes, base64url (22 chars) | Client, once per device |
| `keyVersion` | Integer 1–1,000,000 | Client; increases on device-key rotation |
| `deviceKeyId` | base64url(SHA-256(`["secubuzz-device-key-id",1,agreementPublicKey,signingPublicKey]`)) (43 chars) | Derived; content-addressed, globally unique |
| `keyId` (epoch) | 16 random bytes, base64url (22 chars) | Client, once per epoch |
| `epoch` | Integer 1–1,000,000,000, strictly `+1` per conversation | Client, checked by server |
| timestamps | `YYYY-MM-DDTHH:mm:ss.sssZ`, equal to `new Date(value).toISOString()` | Client |

### 2.3 Device registration statement

```
["secubuzz-device-key", 1, userId, deviceId, keyVersion, createdAt, agreementPublicKey, signingPublicKey]
```

Signed with the device's ECDSA key. The signature proves possession of the signing key and binds both keys to the account. Possession of the ECDH private key is not proven directly; that is harmless because every wrap's HPKE `info` names the recipient `deviceKeyId`, so a wrap addressed to a falsely claimed key is useless to the claimant.

Request: `{deviceId, keyVersion, createdAt, agreementPublicKey, signingPublicKey, signature}`. The user comes from the session.

### 2.4 Epoch statement and wraps

```
["secubuzz-conversation-key", 1, conversationId, keyId, epoch, previousKeyId|null,
 creatorUserId, creatorDeviceKeyId, createdAt,
 [[recipientUserId, recipientDeviceKeyId, enc, ciphertext], …]]
```

Wraps are sorted strictly by `recipientUserId`, then `recipientDeviceKeyId` (code-unit order). Each wrap is `HPKE.SealBase(pkR = recipient agreement key, info, aad = "", pt = epoch key)` with

```
info = ["secubuzz-conversation-key-wrap", 1, conversationId, keyId, epoch,
        creatorUserId, creatorDeviceKeyId, recipientUserId, recipientDeviceKeyId]
```

HPKE base mode does not authenticate the sender, so the creator signs the statement, which covers every `enc` and ciphertext. Recipients verify the signature against the creator's registered (and pinned) signing key before opening their wrap. Because `info` names the creator, a third party cannot re-sign someone else's wraps as its own.

Request: `{keyId, epoch, previousKeyId, creatorDeviceKeyId, createdAt, wraps, signature}`. The creator user comes from the session.

### 2.5 Envelope v2

```json
{ "id": "…", "conversationId": "…", "senderId": "…", "senderName": "…", "timestamp": "…", "type": "text",
  "encryption": { "version": 2, "algorithm": "AES-256-GCM", "encoding": "base64",
                  "keyId": "<22 base64url>", "iv": "<12 bytes>", "ciphertext": "<more than 16 bytes>" } }
```

- AAD: `["yahoo-security-messenger", 2, conversationId, id, senderId, senderName, timestamp, "text", keyId]`.
- Fingerprint (lowercase hex SHA-256): `[id, conversationId, senderId, senderName, timestamp, type, 2, "AES-256-GCM", "base64", keyId, iv, ciphertext]`.
- Version 1 parsing and its fingerprint are unchanged. Version 1 is never verifiable.

### 2.6 Rules enforced at the directory (DATA calls Kiro's planners inside one immediate transaction)

Registration (`planDeviceRegistration`): identical repeat → duplicate; existing `deviceKeyId` not active → `key_revoked`; owned by another user, device or version → `key_in_use`; `deviceId` of another user → `device_owned_by_another_user`; revoked `deviceId` → `device_revoked`; `keyVersion ≤` existing → `stale_key_version`; stale `createdAt` → `stale_registration`; more than 10 active devices → `device_limit`. A new version supersedes the device's previous active version.

Revocation (`planDeviceRevocation`): owner only; every version of the `deviceId` becomes revoked; repeats are unchanged; others get not-found.

Publication (`planEpochPublication`): identical repeat → duplicate; same `keyId` with other content → `key_id_conflict`; actor not a participant → `not_participant`; not exactly two participants → `unsupported_conversation`; stale `createdAt` → `stale_publication`; number or `previousKeyId` not following the current epoch → `epoch_out_of_order`; creator not an active device of the actor → `creator_device_unknown`; a participant without devices → `recipient_without_devices`; wraps not exactly the active devices → `recipient_set_mismatch`; bad structure → `invalid_publication`; bad signature → `signature_invalid`.

### 2.7 Verification at message submission

`evaluateRecipientKeys(envelope, context, state)`, synchronous and pure:

1. Envelope is v2, `conversationId` matches, `senderId` equals the authenticated actor.
2. The state names exactly two participants; the actor is one; DATA's `recipientIds`, when given, equal the other one.
3. The epoch named by `keyId` exists in this conversation (`unknown_key`) and is the current one (`stale_key`).
4. Every participant has an active device (`recipient_without_devices`); every active device record re-derives its `deviceKeyId` and its self-signature verifies (`device_record_invalid`).
5. The epoch's recipients equal exactly the active devices (`recipient_keys_changed`), its creator is an active device of a participant, and its signature verifies (`epoch_signature_invalid`).
6. DATA's fingerprint, when given, equals the v2 fingerprint (`fingerprint_mismatch`).

`createRecipientKeyVerifier({directory})` reads the state through `directory.loadConversationKeyState({conversationId, keyId})` under a deadline, parses it strictly and calls the evaluator. It returns a fresh `{verified:true}` or `{verified:false}`. Directory failures throw `RecipientKeyServiceUnavailableError` (fail closed). `verifyRecipientKeysSync(envelope, context, state)` returns a boolean for DATA's in-transaction recheck.

The server cannot check that a ciphertext was really produced with the named key. A sender who lies only makes its own message unreadable; recipients reject it on the GCM tag.

## 3. Sequence

```mermaid
sequenceDiagram
  participant A as Alice device
  participant D as DATA (DB-2/3/4A/4B + key directory)
  participant K as Kiro verifier (in DATA process)
  participant B as Bob device
  A->>D: POST /api/keys/devices (session, CSRF, signed statement)
  D->>K: validateDeviceRegistration + planDeviceRegistration (in transaction)
  B->>D: POST /api/keys/devices
  A->>D: GET /api/conversations/:id/keys
  D-->>A: participants, active devices, epochs
  A->>A: verify self-signatures, pin Bob's keys (TOFU), HPKE-seal epoch key per device, sign
  A->>D: POST /api/conversations/:id/keys/epochs
  D->>K: planEpochPublication (in withInteraction transaction)
  A->>A: encrypt envelope v2 with keyId
  A->>D: POST /api/conversations/:id/messages
  D->>K: verifyEnvelope(actor, envelope, {conversationId, recipientIds, fingerprint})
  K->>D: loadConversationKeyState
  K-->>D: {verified:true}
  D->>K: verifyRecipientKeysSync (inside BEGIN IMMEDIATE, with session/friendship/block recheck)
  D-->>A: 201 created
  B->>D: GET history + keys; verify epoch signature; HPKE-open own wrap; decrypt
```

## 4. Threat model and trust

| Adversary | Protected | Not protected |
| --- | --- | --- |
| Network attacker | Content and keys (TLS plus E2EE) | Traffic metadata |
| Database reader or backup thief | Message plaintext and epoch keys (only public keys, wraps and ciphertext stored) | Who talks to whom, timing, sizes, device counts |
| Another account (Charlie) | Cannot register keys for Alice, read Alice/Bob keys, publish epochs, or decrypt: no wrap for Charlie's devices | — |
| Stolen session cookie | Requires CSRF proof and Origin for every mutation | An attacker with a valid session and CSRF token can register a device and receive future epochs until the user revokes it |
| Malicious or compromised server operator | Cannot read content with the registry as registered | **Can substitute keys**: add a device under Bob's account and receive future epochs. The server's attestation is only as trustworthy as the server (server trust plus client TOFU). Detecting this needs clients to warn on key changes and users to compare safety numbers out of band |
| Compromised device | Revocation plus rotation stops future epochs | Past epochs it received stay readable; no forward secrecy inside an epoch |
| Malicious participant | — | Shared epoch keys mean a holder can forge messages that appear to come from the other participant to itself; messages are not individually signed |

Replay: registrations cannot be replayed after rotation or revocation (monotonic versions, permanent revocation, `deviceKeyId` uniqueness); epochs cannot roll back (`epoch = current + 1`, `previousKeyId`, clients track the highest epoch); messages use DB-4B wire-ID idempotency and the realtime clock-skew check.

Substitution: cross-user key substitution is blocked by the session binding plus the signed `userId`; wrap substitution breaks the creator signature; epoch substitution across conversations breaks `info`, the statement and the AAD.

## 5. Cross-process boundary

The verifier is a library that DATA instantiates in its own process (`require('../../server/src/e2ee/index.ts')`) with a DATA-owned `RecipientKeyDirectory`. No credentials cross a process boundary. The recommended deployment runs DATA's Express app and Kiro's Socket.IO server in one Node process on one HTTP server, sharing the DB-2 auth service, the database connection and this verifier. A separate realtime process would need a DATA-owned authenticated read API for key state and the per-actor credential propagation described in DB-4B; neither exists, so realtime sending stays disabled.

## 6. Components

| Path | Responsibility |
| --- | --- |
| `server/src/e2ee/protocol.ts` | Labels, suite IDs, lengths, limits, refusal codes |
| `server/src/e2ee/codec.ts` | Canonical base64url, canonical JSON, SHA-256 |
| `server/src/e2ee/keys.ts` | P-256 point validation, `deviceKeyId` derivation |
| `server/src/e2ee/statements.ts` | Registration, epoch, wrap-info and recipient-set canonical text |
| `server/src/e2ee/signatures.ts` | Synchronous ECDSA P-256 verification with a bounded positive cache |
| `server/src/e2ee/envelope.ts` | Envelope v2 parser, fingerprint and AAD |
| `server/src/e2ee/records.ts` | Strict parsing of stored device keys, epochs and directory state |
| `server/src/e2ee/registration.ts` | `validateDeviceRegistration`, `planDeviceRegistration`, `planDeviceRevocation` |
| `server/src/e2ee/epochs.ts` | `planEpochPublication` |
| `server/src/e2ee/evaluation.ts` | `evaluateRecipientKeys`, `verifyRecipientKeysSync` |
| `server/src/e2ee/verifier.ts` | `createRecipientKeyVerifier`, `RecipientKeyDirectory` contract |
| `server/src/e2ee/index.ts` | Public API, exported as `secubuzz-realtime-server/e2ee` |
| `server/test/e2ee/**` | Tests, test-only HPKE and device simulator, in-memory directory, directory contract suite, interop vectors |

No realtime runtime file changes: the Socket.IO path keeps refusing sends. Section L of the report lists what the Socket.IO integration needs.

## 7. Error mapping (DATA endpoints, handoff)

| Planner result | HTTP | Code |
| --- | --- | --- |
| `invalid_registration`, `invalid_publication` | 400 | `VALIDATION_ERROR` |
| `stale_registration`, `stale_publication`, `signature_invalid` | 400 | `KEY_PROOF_INVALID` |
| `key_in_use`, `key_revoked`, `device_owned_by_another_user`, `device_revoked`, `stale_key_version` | 409 | `KEY_CONFLICT` |
| `device_limit` | 409 | `DEVICE_LIMIT` |
| `epoch_out_of_order`, `recipient_set_mismatch`, `creator_device_unknown`, `key_id_conflict` | 409 | `RECIPIENT_KEYS_CHANGED` |
| `recipient_without_devices` | 409 | `RECIPIENT_KEYS_UNAVAILABLE` |
| `not_participant`, `unsupported_conversation`, revocation not found | 404 | `NOT_FOUND` |
| Verifier `{verified:false}` at submission | 403 | `RECIPIENT_KEYS_UNVERIFIED` (existing) |
| Verifier throws or no verifier | 503 | `RECIPIENT_KEYS_UNAVAILABLE` (existing) |

## 8. Testing strategy

- Unit: canonical encodings, point validation, signatures, statements, envelope v2, planners, evaluator, verifier failure modes and log hygiene.
- Interop vectors: fixed synthetic keys and fixed ciphertexts in `server/test/e2ee/vectors/protocol-v1.json`; the client can run the same file.
- HPKE: the test-only reference implementation is checked against RFC 9180 A.3.1 before use.
- Two-account flow: independent WebCrypto device keys for Alice, Bob and Charlie, real HPKE wraps, real AES-GCM, multi-device, rotation, revocation, restart, substitution limitation.
- Directory contract: reusable suite run against the in-memory reference; DATA runs it against SQLite.
- Real DATA: real DB-2 registration/login/CSRF, DB-3 friendship, DB-4A DM and the DB-4B pipeline with Kiro's verifier injected.
- Realtime: the Socket.IO server with Kiro's verifier still refuses sends.

## 9. Decisions

| Decision | Chosen | Rejected | Reason |
| --- | --- | --- | --- |
| Key scope | Per device, persisted in IndexedDB | Per session; one key per account | Survives refresh and reconnect; supports several browsers; a session is not a device |
| Curves | P-256 (ECDSA, ECDH) | X25519/Ed25519 | Universal WebCrypto and `node:crypto` support; X25519 can be a later suite |
| Key delivery | HPKE RFC 9180 per device, epoch signed by creator | Custom ECIES; static-static ECDH; server-side wrapping | Documented standard with maintained libraries; signature is verifiable by the server too |
| Group-key model | One epoch key per conversation, rotated on any device change | Per-message or per-recipient encryption | Matches the single-ciphertext DB-4B envelope; rotation enforces revocation |
| Envelope | New version 2 with `keyId` in AAD | Keep v1 and trial-decrypt | v1 cannot bind a key; the server could not detect use of a superseded epoch |
| Verification location | Pure synchronous library run inside DATA's process and transaction | Kiro HTTP service; Kiro-owned database | No credentials cross processes; checks and writes stay in one transaction; DATA owns persistence |
| Recipient-set rule | Exact equality with all active devices of both participants | Superset or recipients-only | Equality forces rotation on revocation and covers the sender's other devices |
| Trust model | Server-authenticated registration plus client TOFU, safety numbers recommended | Claim protection from a malicious server | Not achievable without out-of-band verification |
