# DB-3 frontend and realtime handoff

The current Phase 8.6 frontend work was inspected read-only and preserved. Authentication already uses the real DB-2 APIs; DB-3 does not change it or re-enable demo data. No frontend, Kiro, Docker or Gemini files were modified. See [API](profiles-friends-api.md), [OpenAPI](profiles-friends-openapi.json) and [relationship rules](relationships.md).

## Codex: same-origin routing and adapters

The current `client/authProxy.cjs`/`client/next.config.js` rewrite allowlist covers five auth routes only. Extend the owner-controlled proxy with the **documented** /api/users, /api/friends and /api/blocks paths before wiring the UI. Keep server-only backend configuration, same-origin credentials, trusted transport, Cookie/Set-Cookie/Origin preservation, no-store and CSP behavior. Do not add unrestricted API/AI proxying or forge Origin/CSRF headers. Production TLS/proxy boundaries stay as documented by DB-2.

Reuse the existing real-auth bootstrap sequence before every mutation: GET /api/auth/csrf, then send X-CSRF-Token and the browser-managed HttpOnly cookie through same-origin fetch. Retain request deadlines, strict response validation, safe error mapping and no automatic mutation retry. A failed remote call never selects LocalDemoFriendsService or LocalDemoProfileService.

### ProfileService (`client/src/profiles/profileService.ts`)

| Method | API mapping |
| --- | --- |
| getCurrentProfile() | GET /api/users/me, validate and return body.profile. |
| updateProfile(updates) | PATCH /api/users/me with only displayName/statusMessage/avatar/presencePreference; return confirmed profile. |
| setPresencePreference(value) | Same PATCH with presencePreference only; it is a persisted preference, not live presence. |
| subscribeToProfileChanges | Notify after confirmed own updates; later polling/realtime invalidation belongs to the frontend/realtime owners. |

Limits match the existing UI: displayName 40 code points, statusMessage 160, five avatar presets and four presence preferences. Username/id/isDemo remain immutable; no uploads or private fields in public discovery.

### FriendsService (`client/src/friends/friendsService.ts`)

Bind actor state to the authenticated session; target/request IDs are mutation arguments, never owners. Set mode=remote. Map searchUsers to username-prefix discovery; explain the two-character minimum and 64-character maximum. Search returns SearchResult directly. Omit presence so the UI keeps Unknown.

For getSnapshot(), follow the consistent-revision algorithm in the API guide: collect **all pages** of friends at R, requests pending at R and blocks at R, split incoming/outgoing requests, then return the existing four-array FriendsSnapshot. Refuse malformed, stale, partial or mismatched revisions. On 409 STALE_STATE discard the partial read, use bounded refresh/backoff, and publish only a complete confirmed snapshot. Existing list* methods can share that snapshot. Do not mistake a first page for a complete list; configure a deliberate client resource budget and fail visibly if it is exceeded.

| Service action | API mapping |
| --- | --- |
| sendRequest(userId) | POST /friends/requests `{userId}`. |
| acceptRequest / declineRequest | POST /friends/requests/:id/accept or /decline, no owner/body required. |
| cancelRequest | DELETE /friends/requests/:id, sender only. |
| removeFriend(userId) | DELETE /friends/:userId. |
| blockUser / unblockUser | POST /blocks `{userId}` / DELETE /blocks/:userId. |
| listBlockedUsers | Own outgoing block list only; never infer who blocked the actor. |

After every confirmed mutation refresh the complete snapshot; after an ambiguous failure reconcile before allowing another write. Subscribe locally after confirmed updates and use an agreed polling/invalidation strategy for other users' actions. DB-3 does not emit Socket.IO events. Do not add a second socket client.

Map 400 to allowlisted validation/invalid_query, 401 to session invalidation, 403 to safe forbidden feedback, 404 to generic unavailable, 409 CONFLICT to invalid_transition/refresh, STALE_STATE to snapshot refresh, 429 to safe throttling using bounded Retry-After, and 5xx to unavailable. Do not forward raw response strings or label every 404 as blocked_user: blocked and nonexistent/inactive are intentionally indistinguishable.

The UI's existing direct/group actions remain disconnected. Friendship does not create a conversation or exchange keys. `conversationAdapter.ts` still needs DB-4's approved idempotent get-or-create DM contract; group invitation work belongs to DB-5. Do not restore fictional chats to fill these gaps.

## Kiro and DB-4: block enforcement and change consumption

`createSocialRepository(db)` uses the same migrated caller-owned DB connection. `isBlocked(a,b)` checks both directions, including legacy restrictive blocks; `blockedIds(actor)` returns the union of blocked subjects in either direction for trusted backend integration. These internal methods are not HTTP block-list exports. New friends/public lists must use authenticated provenance and active accounts.

Before any future direct-message creation/send/history/presence or group-related access, apply the relevant membership/relationship/privacy policy using current durable state. A prior friendship, successful socket handshake or cached client snapshot is not a lasting grant. Serialize block-sensitive writes under the same database transaction boundary as membership/message persistence to close accept/block/send races. DB-3 does not implement messaging, history access or cryptography.

No events are broadcast and no Kiro modules are mounted by this phase. The owner can poll actor revision/state or later publish committed changes through an agreed durable notification mechanism. Failed/rolled-back transactions must emit no success event. If sockets cache presence/membership grants, revalidate after block/unfriend/disable, remove affected subscriptions and stop delivery before allowing protected actions. Do not poll or expose someone else's private block list through a client endpoint.

DB-2's SessionResolver/CSRF contracts remain intact. RealtimeAuthorizer, durable MessageStore, globally/scoped message-ID agreement, recipient key verification and full frontend Messenger wiring remain DB-4/Security integration dependencies. No Gemini setting or call was enabled.
