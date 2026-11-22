# Authenticated reactions — Phase 7

Both authorized direct-conversation participants may add, replace or remove a single Unicode emoji
on active authenticated V2 text messages. Existing quick reactions, full EmojiPicker, badges,
selected-user state and counts are reused. Demo Mode keeps its existing local reducer and transport.

## Database and API review

Additive `0009-authenticated-message-reactions.sql` follows migration 0008 without changing it.
It adds `MessageReactionVersions`, `MessageReactionActors` and `MessageReactionOperations` plus
insert/update eligibility guards and atomic Unsend cleanup. No existing table, ciphertext, nonce,
key, fingerprint, message identity, lifecycle constraint or encryption trigger changes.

The actor table's `(conversation_id,message_id,user_id)` primary key enforces one reaction slot
per user/message. Removing a reaction clears its emoji but retains its actor revision until Unsend.
Each actor uses compare-and-swap independently, so different users can react concurrently without
overwriting each other. Same-account concurrent edits conflict instead of silently replacing state.
Operation IDs are scoped by authenticated account; exact retries return the prior acknowledgment.
On Unsend, actor rows and operation records are deleted; a monotonic version marker remains.
Subsequent old requests are rejected because the message is terminally deleted.

- `GET /api/conversations/:id/reactions?ids=<storageIds>` returns metadata for up to 50 requested
  storage IDs per batch, including each user's revision. Every target must belong to that authorized
  conversation. It includes no message body, ciphertext or keys.
- `POST /api/messages/:storageId/reaction` accepts exactly `{ emoji, expectedRevision, operationId }`.
  `emoji: null` removes the current actor's choice. The server never accepts a client actor/owner field.

The new repository/service/router reuse DATA's session, CSRF proof, `withInteraction`, transactional
membership policy, rate limiter and audit infrastructure. Shared `reactionEmoji.ts` validates a bounded
single Unicode emoji grapheme without copying a dataset. The existing full picker dataset is covered
by a regression test. Plain text, multiple emojis and malformed sequences are rejected.

## Security and realtime integration

Reaction emojis, actor IDs, timestamps and versions are server-visible metadata. Decrypted message
text never enters this metadata pipeline. Existing E2EE V2 encryption, verification and key handling
are unchanged. Reaction authorization does not grant access to message keys.

The Next proxy and authenticated request allowlist add only the two explicit routes. Identity checks
before/after fetch, same-origin cookies, CSRF and session invalidation stay in force. The combined
DATA/realtime bridge emits a server-only `message:reactions-changed` hint containing exactly
`{ conversationId, messageId }` after confirmation; existing `mayReceive` checks freshly authorize
each socket. Clients do not trust reaction state from a hint and fetch an authorized snapshot.

`AuthenticatedReactions` maps stable UI wire IDs to storage IDs, batches metadata for loaded messages,
coalesces refreshes, rejects stale responses, and discards state after access removal/disposal.
Changes are absolute intentions, not retryable blind toggles. Failed requests keep the last confirmed
state; uncertain outcomes reconcile metadata, retaining the operation ID for an explicit retry.
The shared MessageList blocks duplicate submissions and preserves its existing keyboard/picker UI.
Async picker focus is restored only if the user has not moved to another control. Message-ID
dictionaries use null prototypes so valid wire IDs cannot collide with object property names.
Refresh, sign-in and reconnect load server state. Local hidden messages remain filtered; Unsend
clears reaction counts and cannot be undone by stale events. Pins and encrypted Reply/Forward are unchanged.

## Validation and limits

Tests cover two real DATA/Socket.IO accounts, concurrent users, same-account conflicts, duplicate IDs,
ownership/session/CSRF/block failures, Unicode validation, counts, failed/lost responses, Unsend,
additive migrations, original encrypted bytes and existing protection triggers.
`node scripts/verify-client-realtime.cjs --reactions-only` runs actual isolated Chrome contexts through
Next's proxy for realtime, full-picker replacement, refresh, logout/login and offline recovery.

Migration checks use isolated databases; existing local development SQLite data is preserved.
Metadata is fetched in batches of 50 loaded messages under new per-feature rate limits. Immediate
cross-process delivery needs a shared notification bus, as with existing DATA hints. Authenticated
media messaging and Edit remain disabled. Calling and attachment infrastructure is unchanged.
