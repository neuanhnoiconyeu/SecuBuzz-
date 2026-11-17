# DB-3 profiles and friends API

Machine-readable contract: [profiles-friends-openapi.json](profiles-friends-openapi.json). All routes run through the existing DB-2 session and exact Origin/transport gate. Every mutation additionally requires the authenticated session's X-CSRF-Token, bootstrapped with GET /api/auth/csrf. Actor identity always comes from req.auth; caller-supplied owners, identity headers and extra query/body fields cannot select another actor.

## Public and private projections

`FriendUser = {id,username,displayName,avatar}`. Presence is omitted because no connected presence service exists. Email, credentials, session IDs/verifiers, last_seen, profile preferences and relationship owners are never included.

`SearchResult = FriendUser & {relationship:'self'|'none'|'friend'|'incoming'|'outgoing', requestId?}`. A requestId is present only for the actor's pending authenticated request. Blocked/inactive/credential-less accounts return the same profile/request-target 404 as unknown users; discovery excludes them. There is no account-visibility setting in the existing schema: active credential-enabled accounts are discoverable by public username unless either party blocks the other. Legacy/demo identities are not discoverable. No email search or unbounded directory endpoint exists.

Own `UserProfile = FriendUser & {statusMessage,presencePreference,isDemo:false}`. Only GET/PATCH /users/me returns the private editable fields. Public profile reads, including friend views, intentionally use the frontend FriendUser contract and exclude them. Built-in avatar references only; no upload/remote avatar URL support. Stored presencePreference is not live presence and never changes Users.status or broadcasts an event.

## Endpoints

| Method/path | Input | Successful response |
| --- | --- | --- |
| GET /api/users/search | q, limit?, cursor? | 200 `{items:SearchResult[],nextCursor}`. |
| GET /api/users/me | No query/body | 200 `{profile:UserProfile}`. |
| GET /api/users/:id | Public user ID; no query/body | 200 `{user:SearchResult}` if visible. |
| PATCH /api/users/me | Partial editable profile object | 200 `{profile:UserProfile}`; omitted fields retained. |
| GET /api/friends | limit?, cursor?, revision? | 200 collection page of FriendUser. |
| DELETE /api/friends/:id | **Friend's user ID**, no body | 204. Removes only the actor/target canonical pair; repeated/missing removal is idempotent. Accounts, sessions and other friendships remain. |
| GET /api/friends/requests | direction?, status?, limit?, cursor?, revision? | 200 collection page of Request. |
| POST /api/friends/requests | `{userId:targetId}` | 201 `{request:Request}`; authenticated sender is implicit. |
| POST /api/friends/requests/:id/accept | No body or empty object | 200 `{request:Request}` after atomic friendship creation/status change. Recipient only; pending only. |
| POST /api/friends/requests/:id/decline | No body or empty object | 200 `{request:Request}`. Recipient only; pending only. |
| DELETE /api/friends/requests/:id | No body or empty object | 204. Sender only; pending or already cancelled. Accepted/declined requests cannot be cancelled. |
| GET /api/blocks | limit?, cursor?, revision? | 200 collection page of FriendUser for the actor's outgoing blocks. |
| POST /api/blocks | `{userId:targetId}` | 204. Idempotent own block; removes friendship and cancels both pending directions atomically. |
| DELETE /api/blocks/:userId | Target user ID, no body | 204. Idempotent removal of the actor's block only; restores no request/friendship. |

`Request = {id,user:FriendUser,direction:'incoming'|'outgoing',status:'pending'|'accepted'|'declined'|'cancelled',createdAt,resolvedAt:string|null}`. Times are server UTC ISO strings. direction defaults to all; status defaults to pending. Explicit all returns authorized history. The other participant must remain active and unblocked; unrelated users' requests are never returned or mutable.

## Validation and ordering

- Profile: displayName trimmed, required when supplied, max 40 Unicode code points; statusMessage trimmed, max 160, empty clears it. Both reject control characters and malformed Unicode. Avatar is initials/smile/star/rocket/cat; preference is available/busy/away/invisible. Null, empty patches, IDs, username/email/isDemo and all unknown fields are rejected.
- Discovery: normalized ASCII username **prefix**, trimmed/lowercased, 2..64 characters from letters/digits/`.`/`_`/`-`. It does not search display names or email. Rank/order is username_key then user ID ascending; no contains/wildcard/full-table search. Prefixes longer than an actual username simply match nothing.
- Lists: default limit 20, range 1..50, no offsets or total counts. Friends/blocks sort by immutable username_key/user ID ascending; requests sort by createdAt/request ID descending. Each query fetches at most limit+1 candidates after privacy filtering and projects joined users in one SQL statement (no per-row queries).
- IDs: 1..128 ASCII letters/digits/`.`/`_`/`:`/`-`, starting with a letter/digit. Real DB-2 IDs are UUIDs. Unknown valid IDs and blocked/inactive profiles share NOT_FOUND; malformed IDs return VALIDATION_ERROR. No ownership field is accepted.
- JSON: 8 KiB maximum; application/json only when a mutation has a body; compressed bodies rejected. Accept/decline/cancel/remove/unblock accept absent/empty objects only. Unknown query parameters and duplicate/array parameters are rejected.

## Consistent paginated snapshots

Collection pages are `{items,nextCursor:string|null,revision:string}`. Revision is an actor-scoped decimal **string**, not a timestamp, global activity count or one-event counter. Mutations and relevant visible identity/account changes update it transactionally; private preferences of other users, unrelated relationships and blocked-away profile edits do not expose activity through it.

1. Fetch all /friends pages. Save its revision R; every cursor includes R.
2. Fetch pending /friends/requests and /blocks with `revision=R`, following their cursors. Split requests into incoming/outgoing arrays.
3. Publish the resulting complete FriendsSnapshot only if every response is valid and every revision is R.
4. If the actor's visible data changes during this process, the next page/collection returns 409 STALE_STATE without items. Discard the partial snapshot and refetch from the beginning, with a bounded retry/backoff policy. Never retry a mutation automatically.

Cursors are canonical base64url JSON, bounded to 1024 bytes, validated and bound to actor/endpoint/filters. They are untrusted paging hints, not authentication or authorization tokens. Changing filters requires a new first page. Each page validates the authoritative session and reads the data/revision in one SQLite read transaction. Search pages do not carry a collection revision or promise a frozen global directory; refetch search after relationship changes. A complete snapshot is coherent at R, not a guarantee that the server cannot change after the last response.

## Errors and privacy

Reuse DB-2 `{code,fields:[]}`. Field errors may contain only DB-3 input names. Common statuses: 400 VALIDATION_ERROR; 401 UNAUTHENTICATED/SESSION_EXPIRED; 403 FORBIDDEN/CSRF_INVALID; 404 NOT_FOUND; 409 CONFLICT/STALE_STATE; 413/415 body/type errors; 429 RATE_LIMITED with Retry-After; 500 INTERNAL_ERROR; 503 SERVICE_UNAVAILABLE for a competing writer. Blocks are not identified as a distinct error to the target. Denied request IDs return 404 whether missing, historical or unrelated.

Two accepts produce one success and one CONFLICT. Repeated decline or action on resolved state returns CONFLICT. Cancelled sender cancellations, missing friend removals and repeated own block/unblock are idempotent. The owner can list bare public identities in their own block list even during a mutual block; that does not grant access to the target's public-profile endpoint or private fields.

Legacy /api/users CRUD paths remain unavailable (503); PATCH /users/:otherId is 404 and cannot edit that profile. /api/messages and /api/logs remain closed. No messaging, group, upload, live presence, realtime notification or Gemini route was added.
