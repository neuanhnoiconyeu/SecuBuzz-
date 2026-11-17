# DATA recipient-key directory: Kiro realtime handoff

The authoritative Kiro handoff remains `docs/e2ee-recipient-key-integration.md` §9. DATA now implements that contract, migration 7, the six key APIs and real v2 persistence. This task changes only DATA; current Socket.IO parsing/delivery/composition is not wired or tested here. This is not a roadmap phase advance.

## Runtime boundary and default composition

`DATA/server/e2ee/protocol.js` is the only protocol import boundary. On Node 24.20.0, CommonJS directly requires the unchanged `server/src/e2ee/index.ts` public TypeScript ESM entry point. Required exports are checked; missing/incompatible exports leave the protocol unavailable, not mocked. No crypto implementation, transpilation output or protocol package is copied. No new dependency or environment switch is added. Deploy DATA with the sibling server public protocol source and its relative helper modules; a DATA-only file deployment without that source cannot verify sends.

`createApp` creates `application.keys`, whose SQLite repository/directory use the same db connection and DB-2/4A services. The normal entry point now composes `createRecipientKeyVerifier({directory})` automatically. This verifier derives decisions from persisted records, with Kiro's 1500 ms directory deadline and DATA's existing bounded 2 s verifier deadline. A trusted custom verifier option still uses the same v2 in-transaction recheck, which adapter options cannot replace. Existing branded v1 storage-test compositions remain isolated and production rejects testOnly verifiers. They are not part of the normal application.

```js
const directory = application.keys.directory;
await directory.loadConversationKeyState({conversationId,keyId});
// Single read transaction: {conversationId,participantIds,activeDevices,currentEpoch,epoch}|null

// Inside the message write's existing BEGIN IMMEDIATE only:
application.keys.verifyInTransaction(envelope, {
  actorUserId:context.userId, conversationId,
  recipientIds:[capability.recipientId], fingerprint
});
```

`directory.read` requires the caller's transaction and is synchronous. It derives authenticated unarchived direct participants using the exact DB-4A active account/member/block visibility policy, then reads only their active public device records, the latest epoch, and the requested epoch plus position-ordered wraps. The adapter is a trusted internal object, not an unauthenticated HTTP key-state endpoint. Public retrieval always applies session/DB-4A authorization.

## One message write pipeline

REST and `application.messaging.bindStore(trustedContext,trustedSessionProof)` share `submit`:

1. Parse v2 using Kiro's actual parseMessageEnvelopeV2, check sender/path against trusted identity, compute Kiro's envelopeV2Fingerprint, freeze metadata, and run the existing short DB-4A preparation transaction.
2. Outside any database transaction, call the actual Kiro RecipientKeyVerifier with authoritative actor and `{conversationId,recipientIds,fingerprint}`. It checks device IDs, public-point/record signatures, participant/recipient binding, current epoch, exact active-device coverage and epoch signature.
3. Under the second DB-4A immediate interaction transaction, recheck session/proof/account/membership/archive/friendship/blocks, read fresh state on the same connection, and call **verifyRecipientKeysSync before duplicate lookup**. Revocation, new devices or epoch rotation committed during step 2 therefore cause 403 with no new stored message.
4. Preserve DB-4B database-enforced wire-ID/sequence uniqueness, unchanged fingerprint equality/conflict semantics, atomic message/activity/audit write and authoritative first timestamps. Return only after commit. Tombstones and receipts retain existing behavior; message encryption.keyId is present for active v2 rows.

The sync check validates v2 independently, so even a trusted injected async adapter cannot grant a v2 write inconsistent with persisted state. A standalone message service without that recheck fails v2 closed with 503. Default v1 sending receives 403 RECIPIENT_KEYS_UNVERIFIED. Missing protocol/directory infrastructure or verifier failures return sanitized 503; no success flag from a body/header is authority.

## Per-actor and remote integration still required

The existing global Kiro MessageStore lacks per-call session/proof. Do not install an Alice-bound store globally. Implement Kiro's proposed secure per-connection bindMessageStore seam (validated session and handshake CSRF proof), or an agreed secure credential-bound remote composition. DATA's storeMessage still returns created/duplicate/conflict with Date timestamps, and recordReceipt requires the real eligible observer. Realtime must parse v2 and use its v2 fingerprint; old v1 realtime validation remains unchanged by this task.

Same-process composition may share DATA's HTTP server and auth adapters only after the Kiro owner implements the authenticated binding. Separate-process composition uses authenticated HTTPS REST with the actual caller's session, valid CSRF and original validated Origin; a direct import into another process does not create an authorization context. No user-ID header, generic service role, fabricated Origin, shared DB access grant or unauthenticated internal write route is introduced.

Fan out only after a committed creation, preserve the encrypted wire identity/AAD, and reauthorize recipients immediately before delivery. Duplicate persistence is not a new delivery grant. Record delivered only after a genuine eligible recipient acknowledgement; REST read receipts do not imply delivery. DATA implements no Socket.IO events, keys-changed event, outbox or exactly-once delivery guarantee.

## Contract nuances and remaining work

- The exact six §9 APIs are in [e2ee-keys-openapi.json](e2ee-keys-openapi.json). GET epoch responses contain all signed wraps; no seventh device-wrap path exists. Only a device's own HPKE private key opens its wrap. Device listing exposes only the caller's records; conversation discovery exposes authorized participant active public records.
- The key-state list uses `cursor` for older epochs, max 20/page, separate from message nextCursor. Publishing/refetching epochs does not rewrite old messages. Old epochs stay retrievable by authorized members even when no longer valid for new sends.
- Key changes apply to retries too. A previously committed envelope under a now-stale epoch may receive 403 before duplicate lookup. Reconcile durable history after an uncertain outcome; do not silently change an existing wire ID's fingerprint or create a second logical message.
- The six-route contract exposes only active peer keys. The client must retain verified historical creator keys/epoch keys; retired-peer-key discovery/historical rewrapping needs an owner-agreed future contract. New enrollment does not grant historical key material automatically.
- Server verification proves consistency with a server-trusted registry, not resistance to malicious server key substitution or truthful ciphertext use. Client signature verification, TOFU/key-change warnings and out-of-band comparison remain required.
- Kiro's old `server/test/e2ee/data-integration.test.ts` encodes the pre-integration expectation that DATA rejects v2 structurally; its owner must update that historical seam test to the new behavior. It was not edited. DATA runs the unchanged reusable directory suite against real SQLite/auth and the unchanged interoperability-vector suite; no full server or live socket pass is claimed here.

Frontend persistent device keys, approved browser HPKE, v2 crypto/parser/proxy/composer changes and two independent real browser accounts remain Codex work. Safe socket context binding, DATA authorizer, v2 parsing, post-commit delivery and key-change events remain Kiro work. Full product E2EE/security readiness requires those integrations and their browser/security review.
