# DB-4B realtime and shared-write handoff

The subsequent [key-directory/realtime handoff](e2ee-realtime-integration.md)
supersedes this document's absent-verifier and v1-only statements. Secure per-actor
Socket.IO composition remains an owning-team dependency; it was not enabled here.

No Kiro source was modified or Socket.IO integration enabled. This document defines the actual implemented DATA boundary and the missing secure composition. Read [storage/E2EE contract](db4b-e2ee-storage-contract.md), [REST OpenAPI](messaging-openapi.json) and DB-4A's authorization contract first.

## One authoritative pipeline

`application.messaging.submit(context,proof,conversationId,envelope)` is the only new authorized ciphertext-write pipeline. Both REST and the actor-bound adapter delegate to it. It validates the existing immutable encrypted envelope, derives/binds sender identity, checks the DB-4A policy and DB-2 proof/session, obtains a bounded Security-team recipient-key attestation, then rechecks authority under BEGIN IMMEDIATE before idempotent insertion/audit. No database transaction crosses an await.

`context={userId,sessionId}` and the session CSRF `proof` are trusted DB-2 references, never fields inferred from an untrusted message. SQL persistence stays in `createRepositories(db).messages` on the same connection, with existing membership and receipt FKs. New provenance/indexes do not create another database. A committed result is returned only after its transaction completes; a throw, policy change, conflict or persistence failure never grants delivery authority.

The service exposes an actor-bound adapter:

```js
const store = application.messaging.bindStore(trustedContext, trustedSessionProof);
await store.storeMessage({envelope, fingerprint, receivedAt: new Date()});
// {outcome:'created'|'duplicate', storedAt:Date} or {outcome:'conflict'}
await store.findMessage(conversationId, wireMessageId);
// {conversationId,messageId:wireMessageId,senderId} | null
await store.recordReceipt({conversationId,messageId:wireMessageId,
  userId:trustedContext.userId,status:'read'|'delivered',observedAt:new Date()});
// {outcome:'created'|'duplicate', recordedAt:Date}
```

The adapter recomputes/compares the fingerprint and calls the same submit service; supplied receivedAt does not override DATA's authoritative storage clock. It validates current authority every time, including retries. The adapter's find/receipt lookups map wire IDs to the separate storage UUID internally; existing FK-backed MessageReceipts use storage UUIDs. Sender receipts and forged observer IDs are refused. Delivered status may be recorded only by an owning integration after a genuine eligible recipient acknowledgement; REST exposes only read, not a fake delivered shortcut.

Compatibility tests load the **actual** read-only Kiro validation module in memory, compare envelope parsing and fingerprint bytes, check created/duplicate/conflict/Date outcomes, and verify eligible read/delivery receipt shapes. They also verify a bound-store write followed by a REST retry shares one durable record. These are interface/storage tests, not live Socket.IO tests.

## Current Kiro contract limitation

Kiro's current global `MessageStore.storeMessage(request)` contains an envelope/fingerprint/time but no trusted per-call SessionReference or CSRF proof. `envelope.senderId` alone cannot establish authority. A store bound to Alice must **not** be installed as the global store for all connections. Kiro's owner must thread the authenticated context into a per-actor binding or revise the owning adapter contract/composition. It must also obtain/propagate the correct verified session proof. No actor-ID-only write API is provided as a shortcut.

The existing Kiro `RecipientKeyVerifier.verifyEnvelope(actor,envelope)` interface remains Security-owned. DATA also independently requires it; structural encryption metadata and a successful socket handshake do not replace recipient verification. The default DATA entrypoint has no verifier and refuses submission. Test fixture attestation is not a deployable security implementation.

## Separate-process integration

Importing DATA functions into a separate Kiro process is not a secure remote call and does not automatically share its connection/session context. No unauthenticated internal endpoint, forged X-User-Id header, generic service-role write token or cross-process test bypass is exposed.

The approved available transport boundary is the existing authenticated REST API over the trusted HTTPS/public-origin gateway. A future Kiro transport must securely forward the caller's **actual** bound session cookie and valid session CSRF proof, with the original validated allowlisted Origin, to the exact documented path. DATA resolves the actor again; the envelope's sender assertion cannot replace that check. Session material stays in protected process memory/TLS and must never enter URLs, logs, storage, event payloads or browser-local token storage. Do not fabricate an Origin to bypass the transport gate.

Current Kiro contracts deliberately withhold raw credentials from MessageStore, so this credential propagation is **not yet implemented**. The owning teams must add a secure context/credential binding or separately approve an authenticated service-to-service attestation protocol (for example a properly scoped mutually authenticated channel); DB-4B does not invent such a protocol. Until that work and genuine recipient-key verification are supplied, leave realtime submission disabled. Directly opening the same SQLite file in another process is useful for isolated concurrency tests but is not a substitute for a trusted authorization composition.

## Acknowledgement, errors and delivery

- Use the exact fingerprint from `server/src/realtime/validation.ts`; DATA compares it to its own recomputation. Original routing/name/timestamp bytes remain unchanged for GCM AAD.
- Only a created/duplicate committed result acknowledges durable storage. Duplicate returns the first storage time; conflicting wire-ID reuse returns conflict. REST equivalents are 201, 200 and 409 `IDEMPOTENCY_CONFLICT`.
- Membership/session/friendship/block checks are repeated after asynchronous verification, so a block/logout during verification cannot commit a new message. Unknown/blocked/unrelated resources share a privacy-safe 404. Verification failures/timeouts and database busy/storage failures are unavailable outcomes without raw diagnostics. Rate limits remain shared in SQLite.
- Kiro may fan out a created envelope **only after successful persistence**, preserving its original wire fields. The existing created-only fan-out behavior prevents duplicate emissions on ordinary retries; DATA itself emits nothing.
- Revalidate current recipient membership/account/block policy before delivery; an earlier store commit or cached room grant is not permanent authority. A later block can require dropping delivery even though ciphertext remains stored.
- Record delivered only after the authenticated eligible recipient's real delivery acknowledgement. Read receipts likewise use a current eligible recipient context. Retrying either receipt preserves the first durable recording time.
- Persistence is idempotent; network delivery is not claimed exactly-once. A crash between commit and fan-out needs authorized history reconciliation or a future owner-approved durable delivery/outbox design. DB-4B provides no live-delivery guarantee or outbox.

Message history uses immutable per-conversation sequences and snapshot cursors independently of socket/client clocks. Deletion is a one-way sender tombstone, not a ciphertext rewrite, and must be reflected as state by later clients. No encrypted edit protocol, group logic, attachments or cryptographic key exchange is part of this handoff.
