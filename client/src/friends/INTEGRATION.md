# Phase 6: Friends System

This implementation follows the supplied Phase 6 Friends prompt. The older root roadmap uses different phase numbers; it has not been renumbered.

## Repository audit

The workspace started clean on `main` at `25f50c0`. The remote teammate branch `bon-7-8` was fetched for inspection without checkout, merge, or history changes. Its tip `07f3c15` directly follows `25f50c0` and modifies five message files with local reply/edit/delete/pin/reaction UI and attachment/voice/read metadata. Those five files are unchanged by Phase 6. That branch has no idempotent DM creation operation, group-member selector, authenticated friends API, or realtime presence adapter. Group lifecycle and member invitation interfaces are absent on both branches. Existing direct/group conversations are local UI examples.

No database schema, auth endpoint, Socket.IO handler, Kiro/MCP code, message transport, or crypto implementation is added or changed here. No new dependency or state library is required.

## Current runtime

`Home` explicitly constructs `LocalDemoFriendsService` once per page session and injects it into `useFriends`. The Friends screen always discloses fictional users, page-memory storage, refresh reset, local username search, and local-only blocking. A failed remote adapter never selects demo data. No friend data is written to localStorage/sessionStorage, and no real account is contacted or notified.

The service starts with Ava as a friend, Jules as an incoming request, Kai as an outgoing request, Rowan blocked, and Mina discoverable. The current profile is projected to public identity only. Profile display edits update self-search without changing the actor ID. Presence is omitted for all fixtures and displayed as Unknown. A local presence preference is never promoted to real presence.

Requests have directional IDs. Duplicate/self/blocked/stale/wrong-direction transitions fail with fixed safe messages. Accepting creates one friendship. Blocking clears that friendship and both pending directions for that person; unblocking restores neither. Repeated remove/block/unblock calls are idempotent for known users. Message history, drafts, and files are never removed.

`useFriends` shares one confirmed snapshot across lists, public-profile dialogs, navigation counts, and direct-chat relationship notices. Writes are serialized, search responses are sequenced, and replaced/unmounted services cannot publish old results. Remote search is debounced by 300ms. Reconciliation failure marks state stale, disables writes, and requests refresh. Failed actions never claim success. Existing direct-chat controls are disabled for a local block or unknown/stale relationship state; mobile browsing remains available. This UI behavior is not server authorization and does not claim to stop a remote sender.

## Authenticated friends adapter

Implement `FriendsService` in `friendsService.ts` when the backend owner supplies its approved contract, then inject it instead of the demo instance. Keep `mode: 'remote'` even when the service is unavailable. There are no guessed endpoint names or automatic retries of writes.

- Bind the actor to the authenticated session, never to a caller-supplied user ID. Mutation arguments identify targets only. Clear actor-specific caches/subscriptions on sign-out or identity replacement.
- Return an atomic `FriendsSnapshot` describing one service revision. These lists are complete for this small unpaginated client contract. Add explicit cursors/revision reconciliation with the owner before introducing pagination or partial data.
- Authorize and validate every transition on the backend, including concurrent and repeated requests. Define idempotency and whether a blocked conversation may receive/send messages. Client checks are advisory.
- Search must return only permitted `FriendUser` fields plus the requesting actor's relationship and request ID. Omit private profile fields and hidden/unauthorized accounts. Do not reveal another user's block list or who blocked whom.
- Map unauthorized, expired-session, conflict/stale, unavailable and transport errors to safe `FriendsServiceError` codes. Do not forward server response bodies, tokens, or private account details into error messages or logs. An ambiguous write failure must be reconciled by snapshot; do not silently resend it.
- `subscribeToChanges` invalidates confirmed relationships/presence after authorized server events. Polling or the existing realtime owner's adapter may implement it once agreed; no separate socket client is created here. Presence is optional and must come from that service. An omitted presence is Unknown.
- Reject on API failure. Do not substitute fixtures or report success before confirmation. Notifications/real friend requests remain backend-owned.

## Direct messaging boundary

`FriendsConversationAdapter` in `conversationAdapter.ts` opens a direct conversation by recipient ID and returns its existing canonical conversation ID. The current adapter selects only a two-person direct thread containing the current actor and requested recipient. It excludes groups, bots, self, and unrelated actors and never invents IDs or creates duplicate threads.

Message for Ava opens `demo-direct-ava` through the existing `selectConversation` flow, preserving history, drafts, delivery/encryption handling and transport. Accepting Jules does not fabricate a new DM. Message is disabled with an explanation when no DM is connected.

A future live adapter must expose an authenticated, **idempotent get-or-create direct conversation** operation approved by the conversation owner. It must register the returned conversation in the existing store before resolving its ID. The current store has no insertion API; both that registration interface and canonical-recipient uniqueness semantics remain an integration gap. Message transport and key exchange continue through their existing owners and are not part of this adapter.

## Group selection boundary

There is no group-member selection flow to connect on the inspected branches. No replacement group UI is built. The existing group owner should expose a candidate-source input similar to:

```ts
interface GroupFriendCandidateSource {
  listCandidates(groupId: string): Promise<FriendUser[]>;
}
```

Its authenticated implementation can use `FriendsService.listFriends()` as the social candidate input, then intersect it with the group service's visibility, existing membership, blocking and invitation permissions. The source supplies candidates only; the existing group workflow must still request authorization and confirmation before inviting anyone. Friendship never automatically creates membership. The group owner must agree the exact schema, paging and errors before this proposed contract is wired.

## Verification

Focused domain, controller, adapter, component and full-application tests cover public search/self/unknown users; duplicate and invalid transitions; all request directions; removal/block/unblock; safe API failures and stale-state recovery; remote debounce/obsolete responses; shared public profiles/counts/chat state; keyboard tabs/dialog/menu behavior; canonical DM selection and preserved history/drafts. The existing Jest suite, TypeScript check and production build are required. Browser evidence at 1440, 1024 and 390px in Light and Dark is recorded separately under `artifacts/phase6/` when those checks run.

Authenticated remote search/authorization, persisted relationships, real presence, live notifications, new-DM creation, group invitation integration, and recipient key distribution remain external integration work. This feature does not establish multi-user E2EE.
