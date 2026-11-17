# DB-4B encrypted storage and E2EE boundary

Historical v1 storage contract. The post-DB-4B [key-directory handoff](e2ee-key-directory-handoff.md)
and [frontend contract](e2ee-frontend-integration.md) now define default genuine
verification, v2 AAD/keyId and preserved historical v1. The original standalone
DB-4B behavior documented below is retained as phase history.

DB-4B stores ciphertext. It does **not** supply complete E2EE, trusted recipient keys, key exchange or production message delivery. The normal DATA entrypoint has no recipient-key verifier and fails message submission closed. Existing frontend/realtime source and cryptography are unchanged.

## Existing format, preserved exactly

Read-only authoritative sources inspected:

- `client/src/utils/crypto.ts`: browser WebCrypto AES-256-GCM, non-extractable key, random 96-bit IV, 128-bit authentication tag appended to ciphertext.
- `client/src/security/conversationCryptoService.ts` and key management: current default demo key manager is page-local and is not a multi-user recipient-key authority.
- `server/src/realtime/contracts.ts` and `validation.ts`: exact MessageEnvelope fields, canonical base64/ISO validation, canonical envelope fingerprint and RecipientKeyVerifier contract.

The accepted POST body is the existing wire envelope, without a wrapper or additional identity/idempotency fields:

```json
{
  "id":"client-generated-message-id",
  "conversationId":"authenticated-conversation-id",
  "senderId":"authenticated-user-id",
  "senderName":"Current public display name",
  "timestamp":"2026-11-14T12:00:00.000Z",
  "type":"text",
  "encryption":{
    "version":1,
    "algorithm":"AES-256-GCM",
    "encoding":"base64",
    "iv":"<canonical base64 of exactly 12 bytes>",
    "ciphertext":"<canonical base64 ciphertext with attached 16-byte tag>"
  }
}
```

The placeholder strings above explain byte requirements; they are not valid encrypted fixtures. Ciphertext must decode to **more than 16 bytes** and have at most 65,536 base64 characters. IV is exactly 12 bytes / 16 base64 characters. JSON body maximum is 131,072 bytes. Encoding is canonical padded base64, not base64url. `content`, plaintext-only payloads, demo markers, `encryption.scope`, keys, separate tags and unknown fields are rejected. No key ID is invented for a version-1 envelope that does not contain one.

Wire identifiers follow Kiro's 1–256 UTF-16-character bound without whitespace, controls or unpaired surrogates. Sender name is 1–160 characters, nonblank and control-free; for a new message it must match the authenticated current display name. Timestamps must be valid explicit-zone ISO strings, including valid calendar days. Routing and sender IDs must match the authorized path/session, not a header assertion. No trimming, timestamp rewriting or display-name substitution is performed on the encrypted metadata.

The browser authenticates this exact AAD serialization:

```js
JSON.stringify(['yahoo-security-messenger', 1,
  conversationId, id, senderId, senderName, timestamp, 'text'])
```

GCM ciphertext/tag validation is an endpoint/key-holder responsibility; parsing base64 does not prove recipient encryption or message authenticity. DATA never decrypts, encrypts, stores private keys or generates fake E2EE keys. Tests import and transform the actual read-only client TypeScript module **in memory**, encrypt/decrypt valid isolated fixtures with its real WebCrypto code, and verify that stored metadata decrypts using the original AAD. No cryptographic code is added to the production backend beyond SHA-256 idempotency hashing.

## Fingerprint and identities

The SHA-256 fingerprint exactly matches Kiro's `envelopeFingerprint`:

```js
JSON.stringify([id, conversationId, senderId, senderName, timestamp, type,
  encryption.version, encryption.algorithm, encryption.encoding,
  encryption.iv, encryption.ciphertext])
```

DATA recomputes lowercase hex rather than trusting a submitted digest. `id` is the **required stable client idempotency ID** and stays unchanged as encrypted AAD. The same `(conversationId,id)` with a different sender/fingerprint is a 409 conflict. Identical retries retain original ciphertext, IV, AAD, server identity, sequence and first storage time, including after restart or a sender rename. A renamed sender's old envelope can be an identical retry; it cannot create a new message using stale sender metadata.

DB-1's global `Messages.message_id` PK is retained as a separate **server-generated storage UUID** returned as `storageId`. `Messages.client_id` stores the original wire ID. A partial UNIQUE `(conversation_id,client_id)` for authenticated rows implements Kiro's conversation-scoped wire-ID rule across senders. A wire ID can be reused independently in another conversation without colliding with the global PK. Lifecycle URLs use storageId; AAD and realtime payloads use the original wire id. Never interchange or rewrite them.

Migration 6 adds provenance, sequence and tombstone fields to the same Messages table. Earlier rows default to legacy and remain byte-for-byte intact in their original fields. Legacy ciphertext, even with modern-looking fields or in an activated conversation, is not exposed as newly approved E2EE history. No parallel store or automatic cryptographic upgrade exists.

## Recipient-key security gate

`createApp` accepts a trusted composition-only `messageOptions.recipientKeyVerifier` implementing the existing Security Team contract:

```ts
verifyEnvelope(actor, immutableEnvelope): Promise<{verified:true}|{verified:false}>
```

The actor is resolved from the current DB-2 session. DATA also supplies a third optional immutable context with the actual recipient ID, conversation ID and canonical fingerprint. A genuine verifier must bind its decision to this exact immutable actor/envelope and the current authorized recipient keys, rotation/trust policy and authenticated metadata. It must not return true merely because ciphertext/base64 looks valid. No backend key-exchange protocol or fabricated public/private key registry is supplied by DB-4B.

- Missing verifier: 503 `RECIPIENT_KEYS_UNAVAILABLE` in all normal environments, including development. No environment flag enables it.
- Negative/malformed verification: 403 `RECIPIENT_KEYS_UNVERIFIED`. Only a plain object with the sole own property `verified:true` allows submission; arrays, functions, class instances and extra properties are refused.
- Throw/timeout: sanitized 503. Deadline defaults to two seconds (composition may choose 10–4000 ms); at most 32 verifications are pending per service instance. Late resolution cannot commit a message.
- No transaction spans an asynchronous verification call. A short authorized preparation transaction precedes it; a second immediate transaction rechecks the durable session, CSRF proof, friendship, members, accounts, archive and blocks before insertion or duplicate lookup.
- `testOnly:true` verifiers are refused when the authoritative auth configuration is production. The normal DATA entrypoint imports no test fixture/verifier and supplies no verifier at all.
- Adapter options cannot replace the authoritative DB/auth/conversation dependencies.

The isolated fixture worker under `DATA/tests/support/` is a distinct test entrypoint. It requires NODE_ENV=test, an explicit test-worker marker and the test helper's temporary DB path. It injects a test-only positive verifier so **storage** can be exercised through real HTTP with real cookies/CSRF. There is no special HTTP bypass route, no user database fixture, and no production cryptographic claim. Security/recipient-key integration remains a deployment dependency; ordinary production submission stays disabled until it is genuinely supplied.
