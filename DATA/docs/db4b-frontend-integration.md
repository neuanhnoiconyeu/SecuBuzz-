# DB-4B frontend handoff

Historical DB-4B delivery contract. The subsequent [E2EE frontend handoff](e2ee-frontend-integration.md)
supersedes the absent-verifier/v1-only sending state below; client integration is
still pending. Historical v1 storage and lifecycle behavior remain documented here.

Ownership remains DATA only. No client rewrite, chat component, E2EE key manager or real send button was enabled. [OpenAPI](messaging-openapi.json) and [E2EE storage contract](db4b-e2ee-storage-contract.md) define the backend boundary.

## API mappings

| Operation | API / behavior |
| --- | --- |
| Send | `POST /api/conversations/:id/messages` with exactly the existing version-1 MessageEnvelope; 201 created / 200 identical retry |
| History | `GET /api/conversations/:id/messages?limit=20&cursor=...`; maximum 50; `{items,nextCursor}` |
| Sender global deletion | `DELETE /api/messages/:storageId`, no body or `{}`; 200 `{message}` tombstone, idempotent |
| Recipient read | `POST /api/messages/:storageId/read`, no body or `{}`; 200 `{outcome,receipt}` |
| Edit | `PATCH /api/messages/:storageId` is deferred; eligible sender gets 503 `FEATURE_UNAVAILABLE`, unauthorized callers get 401/403/404 as appropriate |

Use the existing HttpOnly same-origin session and fresh DB-2 CSRF bootstrap before every mutation. Preserve exact frontend Origin/security headers through the owner-controlled proxy. The current Next allowlist does not include DB-4A/B; the frontend owner must separately add only the documented conversation/message paths and a real adapter. Do not add a blanket API proxy or bypass keys to make a composer work.

## Send and retry

Generate one stable wire `id` for the logical message. Encrypt once using the approved recipient key and original context; retain that complete encrypted envelope across retries. Re-encrypting on retry produces a new nonce/fingerprint and is a conflict, not an identical retry. Do not add `content`, demo scope, private keys, actor selectors or extra idempotency fields. The envelope's id already is the client idempotency ID.

DATA derives authority from the session and requires senderId/path consistency. The current display name must match for a new message. The original AAD fields remain unchanged in stored history, including timestamp and senderName; server metadata never substitutes for them.

A normal backend without genuine recipient-key integration returns 503 `RECIPIENT_KEYS_UNAVAILABLE`. This is an expected security gate, not proof that the network is down and not permission to select a demo/key fallback. Denied attestation is 403 `RECIPIENT_KEYS_UNVERIFIED`; reused wire ID with different content/sender is 409 `IDEMPOTENCY_CONFLICT`. Other errors retain DB-2/3/4A `{code,fields}`, safe 401/403/404, bounded 429 Retry-After, 413/415, sanitized 500/503. After an ambiguous send outcome, reconcile/retry the **same** envelope under the same identity. No automatic plaintext or local-demo fallback exists.

## Response and client state

```js
{
  outcome: 'created' | 'duplicate',
  message: {
    storageId,             // server UUID; lifecycle URLs and UI record key
    id,                    // original client ID; encrypted AAD / realtime ID
    conversationId, senderId, senderName, timestamp, type: 'text',
    encryption,            // exact five-field version-1 envelope; null on tombstone
    storedAt, updatedAt,    // authoritative server metadata, separate from timestamp
    sequence, revision, state: 'active' | 'deleted', deletedAt
  }
}
```

Project only the seven original wire fields when passing an active response to the existing strict realtime/envelope parser. Additional server metadata belongs in the adapter/model; it must not alter authenticated routing bytes. Decrypt only active records with a verified local key and original AAD. Tombstones have encryption=null and must render a deleted state without invoking decryption. Do not invent plaintext previews or delivery/read status from successful persistence alone.

## History and pagination

Pages are newest **durable conversation sequence** first. The first page captures the maximum committed sequence and the cursor carries that snapshot plus a strict before position. Later insertions are excluded from that traversal, even when all storage timestamps are identical or the clock changes. Refresh from page one to see newer messages. Deletion leaves the original sequence in place; later pages can show its current tombstone once without shifting offsets or duplicating records. Client idempotency keys are unique within the conversation, while storageId is globally unique.

Cursor scope includes actor and conversation. Clear history/cursor/decryption caches on logout/account replacement. Each page rechecks current membership/account/block policy; do not display stale private history after authorization loss. Unfriending preserves metadata/history reads but disables sends, deletion and new receipts. Either-direction block hides history and all interactions. Unblock restores no friendship. Legacy messages remain omitted even if their conversation has been activated.

## Lifecycle policy

Editing is deferred because version-1 encrypted metadata is immutable and an agreed encrypted revision/conflict protocol is absent. It is not implemented as a plaintext patch or an unversioned ciphertext replacement.

Deletion is **sender-authorized global tombstoning**, not per-user hiding or physical erasure. First deletion sets deletedAt and revision=1; repeated deletion preserves both. Original ciphertext remains in the database and may already exist on devices/backups. No message is resurrected by retrying its original wire ID; changed-content reuse still conflicts. Per-user hiding, edits and unread-count APIs are not implemented.

Read receipts identify the authenticated eligible recipient, never a body-supplied observer. A new receipt on a tombstone is refused; a previously committed receipt can be returned idempotently. First observation/recording times survive retry/restart. Read does not assert delivery to other devices or create a delivered acknowledgement automatically.

The backend and storage contracts are ready for the next owner integration. Production E2EE readiness still depends on Security/Kiro recipient-key verification, credential propagation and the frontend key lifecycle. No browser or live socket verification is claimed by DB-4B.
