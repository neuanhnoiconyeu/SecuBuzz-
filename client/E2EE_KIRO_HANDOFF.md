# Client E2EE → Kiro realtime handoff

November 16 update: [REALTIME_CLIENT_INTEGRATION.md](REALTIME_CLIENT_INTEGRATION.md) is the current authenticated v2 client handoff. Its browser evidence covers live DATA/Socket.IO delivery. The original dependency record below predates that integration; its transport limitations are historical.

This post-DB-4B task modifies client only. DATA's migration-7 key directory/verifier and Kiro's protocol/server remain unchanged. The actual client now has persistent device keys, signed epochs and v2 encrypted REST messaging. It does not enable SocketIoRealtimeClient.canSendMessages or modify Kiro-owned files.

## Current usable boundary

SecureMessagingSession uses the existing SessionApi for authenticated key, conversation and message HTTP operations. Its API layer derives sender from the bound session; device/epoch proofs are verified locally and again by DATA. The real workspace is intentionally explicit about manual Refresh and lack of live delivery. The old demo v1 flow remains isolated by authenticated mode.

The audited SocketIoRealtimeClient currently uses withCredentials=true, no per-handshake CSRF binding and canSendMessages=false. Its sendMessage rejects recipient_keys_unavailable. Existing realtime models/parsers describe v1 and demo scope; no v2 payload is silently pushed through that older contract.

## Required owning-team socket work

1. Establish the secure same-origin/TLS session composition from docs/e2ee-recipient-key-integration.md §11. The actual DB-2 session cookie stays HttpOnly. A fresh session CSRF proof must be obtained through the existing auth owner and supplied in the agreed handshake auth.csrfToken field; current client SocketClientOptions does not expose that field. Do not create a second login/token mechanism or infer authority from envelope.senderId.
2. Kiro must validate the cookie/session and handshake CSRF, derive the trusted DATA context/proof and bind application.messaging.bindStore(context,proof) per connection. A single actor-bound store must not be installed globally. Separate-process integration requires the approved authenticated HTTPS credential/proof boundary; imports/shared SQLite access/user-ID headers are not authorization.
3. Accept envelope v2 and its exact Kiro fingerprint. The event payload must contain only the seven original wire fields below. Keep server storage metadata outside encrypted AAD; do not substitute storageId for wire id.
4. Persist through DATA's same shared pipeline, including its synchronous key-state recheck under the write transaction. Acknowledge only durable created/duplicate outcomes. A conflicting existing logical ID is an error, never permission to encrypt again under a different ID automatically.
5. Reauthorize actual recipients against DATA membership/account/block policy immediately before fan-out. Socket rooms and old key-state reads are not lasting grants. A device/key change during verification must still be refused by the final DATA check.
6. Agree and implement the proposed conversation:keys-changed payload {conversationId,currentEpoch}. Invalidate client prepared state, fetch the current directory, verify records/epoch signatures and prompt on changed peer devices before future sends. No raw keys, signatures, tokens or plaintext belong in socket logs or notification previews. Client-discovered changes already trigger this same review via REST.
7. On reconnect, revalidate session/proof, reconcile durable pending IDs and fetch authorized snapshot history. Reuse exact encrypted pending bytes if still eligible. After an uncertain old-epoch send, reconcile history first; DATA verifies current keys before duplicate lookup and can refuse an already-stored stale envelope. Do not manufacture plaintext echoes or changed-key retries.
8. Record delivered only after a real eligible recipient acknowledgement; mark read only from an eligible authenticated recipient after actual local reading. Persistence and successful local decryption do not prove network delivery/read. Retain tombstones, first-observation receipt semantics and block revalidation. No exactly-once network delivery/outbox guarantee is supplied here.

## Exact envelope and client modules

```ts
type EnvelopeV2 = {
  id: string; conversationId: string; senderId: string; senderName: string;
  timestamp: string; type: 'text';
  encryption: { version: 2; algorithm: 'AES-256-GCM'; encoding: 'base64';
    keyId: string; iv: string; ciphertext: string };
};
// AES-GCM AAD:
JSON.stringify(['yahoo-security-messenger',2,conversationId,id,
  senderId,senderName,timestamp,'text',keyId]);
// Kiro v2 fingerprint, lowercase SHA-256 hex:
JSON.stringify([id,conversationId,senderId,senderName,timestamp,'text',
  2,'AES-256-GCM','base64',keyId,iv,ciphertext]);
```

keyId is canonical 16-byte base64url; IV is canonical padded base64 of 12 random bytes; ciphertext includes the GCM tag. The client production modules are under src/security/e2ee/. Reuse protocol.parseEnvelope, messages.decryptV2 and the session's validated epoch/key lifecycle; never decrypt inside a socket transport/server or return plaintext through a persistence request. A future adapter needs an explicit reviewed transport seam for encrypted pending-envelope acknowledgement; do not call send twice to implement retry, because send creates a new logical message only when no prior pending envelope exists.

Current status/ack contracts need a coordinated client update alongside Kiro's v2 parser and actor binding. Created/duplicate must preserve first authoritative storedAt, while senderName/timestamp stay original AAD. API history uses storageId plus sequence; socket encrypted identity stays id. Keep row tombstones and current privacy checks during reconciliation.

## Trust and recovery boundaries

Server-authenticated directory plus client TOFU is not independent identity verification or malicious-operator resistance. Peer changes require explicit review, and safety numbers are available for an out-of-band comparison. Private keys and epoch keys persist as non-extractable CryptoKeys in account-scoped IndexedDB, which is not protected from compromised same-origin code. New enrollment does not grant old wraps. Retired creator discovery/historical rewrapping and device-pair rotation/recovery management require a future agreed contract; do not invent them in the socket layer.

Encrypted REST exchange, refresh restoration, key changes, revocation and account switching have been tested in real isolated Chrome contexts against DATA; Socket.IO v2 delivery has **not** been verified. Full production activation requires the coordinated transport integration and security/dependency review. Full commands, storage schema, algorithm details, limits, tests and exact source hashes are in [client integration](E2EE_CLIENT_INTEGRATION.md) and [verification](artifacts/client-e2ee/verification.json).
