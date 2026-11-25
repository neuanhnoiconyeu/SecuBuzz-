# Block/unblock conversation regression

Verified on 2026-11-24 on `bon-fullstack`, with HEAD `58e0da0` unchanged.

## Root cause and existing authorization policy

DATA already distinguishes history visibility from permission to interact:
blocked direct conversations are omitted from the member's conversation list;
unblocking restores their visibility with `interactionAllowed: false`. Blocking
removes friendship. A new, explicitly accepted friend request is required before
either participant can send again. This policy remains unchanged.

The frontend treated `interactionAllowed: false` as complete revocation, discarded
history and tried to prepare new messages against a read-only conversation.
Permission errors were then labeled "Key verification failed", while the empty
message list said "No messages yet". The original records remained in storage.
An additional reproduced race let a late pre-block history response or denial
consume the post-unblock recovery request.

## Fix and affected files

Runtime changes are limited to four frontend files:

- `client/src/realtime/SecureRealtimeWorkspace.ts`: distinguish readable listed
  conversations from interaction grants; retain/reload verified read-only history;
  discard blocked or obsolete responses and retry recovery for the current access
  generation. Socket room grants, writes and live interaction checks stay gated.
- `client/src/components/messenger/SecureConversationPanel.tsx`: load history via
  the existing verification pipeline without preparing a send in read-only mode;
  explain friendship renewal; disable server actions and pending-message retries
  without interaction permission. Distinguish loading, empty, unavailable,
  permission/service failure and genuine key-verification states.
- `client/src/components/messenger/MessageList.tsx`: accept an optional explicit
  empty/error/loading presentation; preserve the default demo presentation.
- `client/src/components/messenger/RealMessengerWorkspace.tsx`: refresh conversation
  permissions after local friendship/block state changes.

Regression coverage is added in:

- `client/src/realtime/__tests__/SecureRealtimeWorkspace.test.ts`
- `client/src/components/messenger/__tests__/SecureConversationPanel.device.test.tsx`
- `server/test/data/block-unblock.test.ts`

The backend integration test uses disposable DATA databases and synthetic devices,
tests both blocking directions, unchanged original database rows, read-only access,
denied sends, explicit friendship renewal and encrypted realtime recovery.
The obsolete unit fixture that equated read-only access with blocking now models
DATA's actual blocked response (conversation omitted).

## Final verification

| Verification | Result |
| --- | --- |
| Frontend realtime, E2EE, Messenger, friends, notification, forwarding and auth integration suites | 655 passed, 0 failed; 47 suites |
| Backend/DATA block lifecycle, authorization and reconnect suites | 19 passed, 0 failed |
| DATA conversations, messaging, social and E2EE HTTP/security suites | 118 passed, 0 failed |
| Isolated two-browser lifecycle | 33 checks passed, 0 failed |
| Primary Docker two-browser lifecycle at `http://localhost:3001` | 33 checks passed, 0 failed |
| Frontend and backend TypeScript | Passed |
| Frontend ESLint | Passed; no warnings/errors |
| Production build using `npm.cmd run build:verify` | Passed |
| `git diff --check` | Passed |

The frontend run includes existing Edit, Unsend, Reply, Forward, Pins, Reactions,
notifications and media-forwarding regression coverage. These are relevant suite
results, not a claim that every repository suite was rerun. The production build
prints the existing advisory about automatically adding the Next.js TypeScript
plugin to an extended configuration; compilation and type validation succeed.

Browser automation used two separate Chromium contexts and newly registered test
accounts. Actual Friends UI actions exercised block, unblock and a newly accepted
friend request. Both accounts reloaded and decrypted both original messages while
read-only, then exchanged encrypted messages in both directions after renewal and
again after reload. The final conversation contains five messages; its original
two ciphertext records, device identifiers and key epoch are unchanged.

A client-only tampered signed-key response for a synthetic account still caused
verification failure and disabled sending. Restoring the valid response recovered
without re-enrollment, key resets or accepting changed keys. Inspection of the
test's network requests found no synthetic message plaintext in transport/storage
requests. Browser runtime errors: zero. Calls/media delivery were not retested by
this lifecycle scenario.

Local evidence is retained under ignored `.cache` paths: `block-frontend-final.log`,
`block-backend-final.log`, `block-data.log`, `block-types-final.log`,
`block-backend-types.log`, `block-lint-final.log`, `block-build.log`,
`block-browser-045aa8ec/evidence.json` (isolated) and
`block-browser-d24dbcf2/evidence.json` (primary Docker). Temporary harnesses and
evidence are not source changes proposed for staging.

## Reproduction and expected recovery

1. Use two disposable accounts in separate browser profiles at the same application
   origin. Enroll normally, accept friendship, open a direct chat and exchange text.
2. Block either account in Friends. Both accounts lose history API access and
   sending permission. Stored message records remain intact.
3. Unblock using Blocked Users. Open the conversation in both profiles: original
   messages decrypt, the read-only explanation appears and sending remains disabled.
4. Reload both profiles. History remains available without device re-enrollment.
5. Send a fresh friend request and have the other account accept it. Refresh the
   conversation if necessary; normal key verification and encrypted sending resume.

## Preservation and limits

No backend API, DATA authorization, database schema/migration, E2EE protocol,
watermark, device key or calling implementation was changed. Existing V2.1/V2.2/
V2.3 work was checked against the pre-fix file hashes; no unrelated file was
removed or rewritten. TypeScript updated the generated `client/tsconfig.tsbuildinfo`;
it remains uncommitted. The Git index remains empty.

The existing Docker project, named volumes, legacy environment and stash were not
reset or replaced. The primary browser test adds only its two new synthetic
accounts and their conversation/messages, and signs out its own sessions.

Peer relationship changes still use the existing conversation-update/15-second
refresh mechanism. Read-only history does not grant interaction-only APIs such as
encrypted binary downloads, pins, reactions or calls. Missing historical browser
keys cannot be recovered by unblocking. Genuine key changes still require the
existing explicit review. A1 remains the separately documented unresolved High/P1
rollback finding; this fix provides no security clearance for A1.
