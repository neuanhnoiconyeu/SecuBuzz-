# DB-3 relationship state and legacy policy

The existing FriendRequests, Friendships and Blocks tables remain the only relationship stores. Friendships has one binary-ordered canonical (user_low,user_high) pair; Blocks is directional; the pending request unique expression prevents reversed duplicates. DB-3 uses the same caller-owned connection and BEGIN IMMEDIATE writer transactions, not in-memory locks. Policy follows [OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html): verify the actor and object on every request and refuse hidden/unrelated objects by default.

| Starting state/action | Result |
| --- | --- |
| No relationship → send | New authenticated pending request, sender from the verified session. |
| Pending in either direction → send | 409 CONFLICT; no reversed duplicate. |
| Self / inactive or hidden target → send | 400 for self, privacy-safe 404 for unknown/inactive/blocked target. |
| Pending → recipient accept | Insert/confirm one authenticated friendship and mark accepted in the same transaction. |
| Pending → recipient decline | Mark declined; create no friendship. |
| Pending → sender cancel | Mark cancelled; recipient/unrelated users cannot cancel. |
| Accepted/declined → accept/decline/cancel | 409; cancellation cannot remove an established friendship. |
| Friend → remove by either participant | Delete that pair only. Repeated removal is 204. Request history remains; a later new request needs fresh acceptance. |
| Any state → actor block | Insert/confirm actor's block, cancel both pending directions, remove the pair's friendship, audit metadata and update revisions atomically. |
| Block → owner unblock | Remove only that direction; restore no friendship/request. Opposite block remains effective. |

Every mutation revalidates the session-bound CSRF proof inside the write transaction, after body parsing, to close expiry/revocation races. Session IDs/owners cannot come from input. Block checks always consider **both** directions, including restrictive legacy blocks. Public profile/discovery and authorized histories hide either-direction blocked or inactive participants. The owner-only block list may show the target's bare FriendUser identity, never their private profile/account fields or block list.

## Concurrency and rollback

- Reversed simultaneous sends serialize; one pending pair is created and the other request conflicts.
- Simultaneous accepts serialize; exactly one friendship is created.
- Accept versus cancel leaves either accepted+friendship or cancelled+no friendship.
- Accept versus block always finishes with the block and no friendship. If acceptance commits first, block removes it; if block commits first, acceptance is denied.
- Removal/block/unblock are idempotent for the actor's pair/direction. Unrelated accounts and sessions are never removed.
- Profile updates, relationship transitions, metadata-only audits and actor revisions share the same transaction. Any storage failure rolls back every step. A busy writer returns a fixed 503; the API does not blindly retry writes.

## Legacy data

DB-1 already copied historical Contacts into normalized tables. Those records do not prove authenticated consent. Migration 0004 adds origin=legacy by default to **all existing** request/friendship/block rows, without deleting them or changing Contacts/users/sessions. Only explicit authenticated DB-3 operations mark new authoritative requests/friendships authenticated. Low-level legacy DAL writers remain legacy by default.

- Historical requests are not listed or actionable through DB-3; historical friendships are not returned as real friends.
- Credential-less/demo accounts cannot be discovered or targeted; no account is activated or claimed by migration.
- An explicit new request may resolve a legacy pending projection as cancelled to release the old pending-pair unique constraint. It then creates a distinct authenticated pending request. Contacts remains untouched.
- A recipient's explicit acceptance may replace the legacy pair's provenance with authenticated and set the new friendship time. This is the first real two-party consent, not a migration-time promotion.
- Legacy blocks remain restrictive for privacy. Their owner can list/unblock them; explicit blocking confirms that direction as authenticated. Unblocking never reimports Contacts or revives historical relationships.

## Revision infrastructure

SocialRevisions stores one integer per user, not copies of relationships or a global activity counter. SQL triggers update relevant actors for authenticated requests/friendships, blocks, visible public-profile changes and account visibility. Owner-only preference changes affect only the owner's version. A user blocked away from someone does not learn that person's profile edits via revisions; a block owner can still receive changes to the bare identity their own block list legitimately displays.

Do not interpret numeric gaps as event counts: one transaction can update several tables. Read it as an opaque equality token. All collection pages read it and their data in one read transaction. It enables the existing frontend's coherent FriendsSnapshot contract without inventing an unlimited snapshot endpoint. Future writers must retain the triggers or implement equivalent transactional invalidation.
