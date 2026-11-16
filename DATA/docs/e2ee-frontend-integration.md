# DATA recipient-key directory: frontend handoff

This post-DB-4B dependency task implements the DATA side of Kiro's `secubuzz-dm-keys` v1 protocol. It does not activate the existing client composer, implement browser key management or prove two-browser E2EE. The existing page-local demo key manager cannot send real-account messages. This document supersedes the old DB-4B statement that no real DATA verifier is composed.

## Transport and six exact operations

Use the DB-2 HttpOnly session cookie, actual allowlisted Origin and session CSRF token on mutations. Do not put credentials in query parameters or log them. Use exact same-origin proxy mappings for these operations, plus the existing conversation/message APIs; the current client proxy does not provide them. No client or root proxy file was changed.

| Method / path | Body | Response |
| --- | --- | --- |
| POST `/api/keys/devices` | `{deviceId,keyVersion,createdAt,agreementPublicKey,signingPublicKey,signature}` | 201 `{device}`; identical registration 200 with the original record |
| GET `/api/keys/devices` | None | `{items:[device]}`; own records, all statuses, newest first, max 50 |
| POST `/api/keys/devices/:deviceId/revoke` | Empty or `{}` | `{outcome:'revoked'|'unchanged'}` |
| GET `/api/conversations/:id/keys` | None; optional `?cursor=...` | `{conversationId,participantIds,devices,currentEpoch,epochs,cursor}` |
| GET `/api/conversations/:id/keys/epochs/:keyId` | None | `{epoch}` including all ordered signed wraps |
| POST `/api/conversations/:id/keys/epochs` | `{keyId,epoch,previousKeyId,creatorDeviceKeyId,createdAt,wraps,signature}` | 201 `{epoch}`; identical repeat 200 with original publishedAt |

Exact schemas and errors: [e2ee-keys-openapi.json](e2ee-keys-openapi.json). Device projection is `{deviceKeyId,userId,deviceId,keyVersion,createdAt,agreementPublicKey,signingPublicKey,signature,status,registeredAt}`. Epoch projection is `{conversationId,keyId,epoch,previousKeyId,creatorUserId,creatorDeviceKeyId,createdAt,wraps,signature,publishedAt}`. Neither registration nor publication accepts a top-level actor userId/creatorUserId; DATA derives the actor from the session. Recipient user IDs inside signed wraps must match the authoritative active-device set. Caller flags claiming verification are not accepted.

Device mutations permit 8192 JSON bytes; epochs permit 16384. Mutations share 30/minute/actor plus 120/minute/direct source; reads share 120/minute/actor, with Retry-After on 429. Only application/json is accepted for nonempty mutation bodies; compression is refused. Unknown query/body fields fail validation. Lists of epochs return the latest 20, with response `cursor` for older pages; use this field, not the message API's nextCursor. Cursors bind the actor and conversation and reapply current authority. Device listings deliberately have no cursor in the agreed six-operation contract.

## Required browser implementation

1. Create separate non-extractable ECDSA P-256 and ECDH P-256 private keys per account/browser. Persist CryptoKey objects and stable deviceId in an account-scoped IndexedDB namespace. Generate deviceId from 16 random bytes, canonical base64url. Start keyVersion at 1, increasing it for rotation; never reuse a revoked deviceId.
2. Export only the public uncompressed P-256 points (65 bytes, base64url). Sign Kiro's exact registration statement using ECDSA/SHA-256 and P1363 signature encoding. Keep createdAt canonical UTC milliseconds within five minutes of server time. Submit the body above. Verify the returned deviceKeyId and record self-signature locally.
3. Download the conversation state, verify every device's derived ID/self-signature, and pin the peer's keys with TOFU. Show device changes and offer an out-of-band safety-number check. The server-trusted directory cannot detect a malicious operator substituting keys; do not suppress that limitation.
4. Publish an epoch when absent or the active device set changes. Generate a 32-byte conversation key in the browser, HPKE-wrap it separately for **every active device of both participants**, strictly ordered by userId then deviceKeyId. Sign the canonical epoch statement using an active creator device. Use epoch=current+1, previousKeyId=current.keyId or null for epoch 1, and a random 16-byte keyId. Import the AES key as non-extractable and zero raw key bytes after use. DATA never supplies plaintext keys or performs wrapping/unwrapping.
5. Before opening a device's own wrap, verify the creator record and complete epoch signature. Full wraps are returned because the signature covers their complete ordered list; this is not authorization to decrypt peer-device wraps. A new device receives future epochs after rotation and is not automatically granted old ciphertext keys. Retain locally verified historical creator keys/epoch keys. The six-route contract does not supply a general retired-peer-key or historical rewrapping API; fresh-device recovery of old history requires a future agreed contract.
6. Send envelope v2 through the existing POST `/api/conversations/:id/messages`, preserving exact authenticated metadata and the keyId in AAD. Preserve both returned identities: wire `id` for AAD/idempotency and server `storageId` for lifecycle URLs. Render active v1 historical messages with their original v1 AAD; default sending never verifies v1. Unapproved legacy-origin records remain hidden under the existing DB-4B policy.
7. On logout/account switch clear decrypted caches and separate account namespaces. Logout does not revoke an enrolled device. Explicit removal uses the revoke endpoint before deleting local keys. Rotation supersedes old keys permanently; revocation permanently revokes every version of that deviceId.

Do not implement HPKE by copying a test reference into the client. Use the reviewed protocol implementation selected by the client/security owner and validate RFC 9180 A.3.1 and `server/test/e2ee/vectors/protocol-v1.json`. Those vectors contain synthetic private keys strictly for tests.

## V2 message and authenticated bytes

```js
{
  id, conversationId, senderId, senderName, timestamp, type:'text',
  encryption:{version:2,algorithm:'AES-256-GCM',encoding:'base64',keyId,iv,ciphertext}
}
// Exact AES-GCM AAD, UTF-8 encoded:
JSON.stringify(['yahoo-security-messenger',2,conversationId,id,
  senderId,senderName,timestamp,'text',keyId])
```

keyId is canonical 22-character base64url, IV is canonical padded base64 of 12 bytes, ciphertext includes the 16-byte GCM tag and decodes to more than 16 bytes; maximum 65,536 base64 characters and 131,072 request bytes. Do not add demo scope, plaintext, raw/private keys, a separate tag or an invented signature field. The server preserves AAD rather than rewriting names, IDs or time. For new messages senderName must match the current public display name; identical retries retain original names after a rename.

## Errors, retries and lifecycle

- 400 VALIDATION_ERROR / KEY_PROOF_INVALID: fix the shape, canonical encodings, timestamp or signature; do not retry a forged proof.
- 409 KEY_CONFLICT / DEVICE_LIMIT: use the original owning device, monotonically rotate, revoke an unwanted device, or enroll a new deviceId after permanent revocation as appropriate.
- 409 RECIPIENT_KEYS_CHANGED: refetch state, review peer changes and publish a newly signed epoch. 409 RECIPIENT_KEYS_UNAVAILABLE on publication means a participant has no active device.
- 403 RECIPIENT_KEYS_UNVERIFIED: unknown/stale keyId, changed active devices, revoked creator or mismatched signatures/state. Nothing new is stored by that request; refresh key state and resolve changes. **Reconcile history after an uncertain earlier outcome before re-encrypting**: the atomic key recheck also precedes duplicate lookup, so an old stored message can now receive 403 after rotation. An existing conversation/wire ID cannot be reused with changed ciphertext/keyId; that is 409 IDEMPOTENCY_CONFLICT. If the logical message is already stored, reconcile it instead of creating a second ID; if it was never stored, a fresh valid envelope may reuse its uncommitted ID.
- 503 RECIPIENT_KEYS_UNAVAILABLE: protocol/directory unavailable or verifier deadline; retain an unavailable UI. No demo/plaintext fallback or public bypass exists. Other auth, CSRF, blocking, size and rate codes retain their meanings.

History pagination, monotonic sender tombstones and eligible first-observation receipts remain DB-4B behavior; [messaging-openapi.json](messaging-openapi.json) now describes both envelope versions. A tombstone hides public encryption but retains stored bytes and does not delete already received device copies. Encrypted editing remains deferred.
