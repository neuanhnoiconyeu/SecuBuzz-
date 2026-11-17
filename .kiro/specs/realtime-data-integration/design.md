# Design: secure realtime integration (Socket.IO, DATA and E2EE v2)

## 1. Audit summary

| Source | Finding that drove the design |
| --- | --- |
| DATA `app.js`, `start.js` | `createApp`/`startServer` return one application object: `auth`, `social`, `conversations`, `keys`, `messaging`, `adapters`. `startServer` also returns the HTTP `server` |
| DATA `auth/adapters.js` | `sessionResolver` already implements the realtime `SessionResolver` (Origin allowlist, secure transport, `checkSession`) |
| DATA `auth/service.js` | `csrfProof(sessionToken, null, token)` ties the token to the session; `verifyCsrf`/`checkSession` are synchronous |
| DATA `messaging/service.js` | `bindStore(context, proof)` is the sanctioned per-connection store; `submit` runs the verifier, then `verifyKeysInTransaction` under `BEGIN IMMEDIATE`; rate budgets are applied in the REST routers only |
| DATA handoffs (`db4b-realtime-integration.md`, `e2ee-realtime-integration.md`) | Names the remaining Kiro work: per-connection binding, v2 socket parsing, DATA authorizer, post-commit reauthorized fan-out, real delivery acks, keys-changed events. Rules out raw credential forwarding and unauthenticated internal endpoints |
| Client (`E2EE_KIRO_HANDOFF.md`, adapter source) | Closed sets of connect and ack error codes; `message:new` parser rejects unknown fields; the socket adapter cannot send or pass `auth.csrfToken` |

## 2. Decisions

| Decision | Alternatives rejected | Reason |
| --- | --- | --- |
| Same process: the bridge takes DATA's application object and mounts on DATA's HTTP server | Separate process proxying REST; importing DATA from `src/`; editing DATA's `start.js` | Only in-process calls carry DATA's authority without forwarding credentials or opening its database; `src/` stays DATA-independent; DATA stays untouched |
| `ConnectionBinder` seam in the realtime core; DATA implementation in `src/data/binder.ts` | Global actor-bound store; trusting `senderId` | DATA requires a per-connection actor and proof; identity comes only from the session |
| Handshake `auth` = exactly `{csrfToken}`; verified with DATA's proof | Cookie only; accept extra keys | CSRF proof is DATA's contract for writes; strict shape blocks identity smuggling |
| v2 only on bound connections | v1 fallback | The task forbids downgrade and plaintext paths |
| Realtime does not verify keys in DATA mode | Run Kiro's verifier in the realtime layer too | DATA already runs it plus the in-transaction recheck; a second verifier could disagree |
| Ack codes stay in the client's closed set | New codes for crypto failures | Client parsers would reject them |
| Fan-out after commit, only for `created`, per-target `canReceive` | Fan-out inside the commit; fan-out on `duplicate` | Never broadcast uncommitted data; a retry must not duplicate delivery; grants can be stale |
| Observe committed HTTP mutations on the shared server | Poll DATA; monkey-patch DATA services; require an event emitter from DATA | DATA has no feed; polling cannot guarantee delivery; patching is fragile. Observation is accurate for this process and honestly bounded |
| Charge DATA's `messaging.rate` for socket writes | Rely on realtime's per-connection buckets | Several sockets would multiply DATA's per-user budget |

## 3. Components

```
attachRealtimeToData(httpServer, application, options)
  assertDataApplication(application)                  shape check, no DATA import
  authorizer = createDataAuthorizer(application)      conversations.list / social.listBlocks / checkSession
                                                      canReceive: conversations.detail
                                                      currentKeyEpoch: keys.state
                                                      presencePreference: social.ownProfile
  attachRealtimeServer(httpServer, {
     allowedOrigins: auth.config.origins, sessionCookieName: auth.config.sessionCookie,
     sessionResolver: adapters.sessionResolver, connectionBinder: createDataConnectionBinder(...),
     resolveTransportSecurity: transportSecurityFor(auth.config), authorizer, timing: {revalidation 15 s} })
  observeDataChanges(httpServer, handle, ...)         logout, social, profile, key mutations
```

Realtime core changes (backward compatible; legacy tests unchanged):

- `contracts.ts`: `ConnectionBinder`, `ConnectionCredentials`, `BoundConnection`, optional authorizer methods `canReceive`, `currentKeyEpoch`, `presencePreference`, `AnyMessageEnvelope`.
- `authentication.ts`: handshake `auth` shape and binder call; transport verdict from `resolveTransportSecurity`; preference load; revoked-session recheck after each adapter.
- `messages.ts`: bound store path, v2 fingerprint, failure classification, async per-target fan-out.
- `receipts.ts`: per-connection store, classification, async re-authorized notification.
- `server.ts`: v2 parsing by connection, presence preference before first publish, `refreshAllAccess`, `notifyKeysChanged`.
- `protocol.ts`: `conversation:keys-changed`, `classifyStoreFailure`.
- `adapterCall.ts`: failures carry only an allowlisted code and field names.

## 4. Flows

Handshake: origin, cookie, secure transport, `resolveSession`, auth shape, `csrfProof`, bound store, grants + blocks + preference in parallel, final revocation recheck, connect.

Send: see `server/docs/realtime-data-integration.md` section 6 (ten steps).

Revocation: `server.on('request')` observer (prepended, so URL and method are captured before Express rewrites them) waits for `finish` with a 2xx status, then reads DATA's own request state (`req.auth`, `req.csrfProof`) and routes:

| Committed request | Effect |
| --- | --- |
| `POST /api/auth/logout` 204 | `revokeSession(proof.sessionId)` |
| block, unblock, friend accept, friend delete, `POST /dm` | debounced `refreshAllAccess` |
| `PATCH /api/users/me` | re-read preference, `setPresencePreference` |
| `POST /api/keys/devices` 201, revoke 200 | `notifyKeysChanged` for each of the actor's conversations |
| `POST /api/conversations/:id/keys/epochs` 201 | `notifyKeysChanged(id)` |

## 5. Failure model

| Failure | Result |
| --- | --- |
| DATA throws or times out at handshake | `REALTIME_UNAVAILABLE`, no grants |
| Binder returns `null` | `UNAUTHORIZED` |
| Store refusal | mapped ack, nothing broadcast |
| Store timeout after the call started | `unavailable`; the commit may exist; retry is idempotent |
| `canReceive` false or failing | delivery withheld, grants of that user refreshed |
| Refresh failure | grants unchanged, logged |
| Key-state read fails or is refused | no event for that account |

## 6. Limitations (accepted, documented)

Single instance; key events not durable; typing and presence use cached grants (tens of ms to 15 s); 1,000 conversations per user; all-user refresh cost; presence preference changes via other processes are not observed; no real-client path until Codex changes the adapter.

## 7. Verification strategy

`server/test/data/` runs the real DATA application on an isolated temporary SQLite file with real `socket.io-client` sockets: handshake and CSRF, revocation (with and without the HTTP observer), authorization, persistence and ack, delivery and receipts, key changes, reconnection, the budget charge, and the combined child process. `server/test/integration/data-binding.test.ts` pins the seam with doubles for cases real DATA cannot produce on demand. Mutation checks confirmed that removing the budget charge, the duplicate-fan-out guard or the delivery re-authorization fails a test.
