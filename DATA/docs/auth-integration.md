# DB-2 frontend, realtime and Phase 9B handoff

No files under `client/` or Kiro-owned `server/` were modified. DB-2's adapter tests validate the published dependency shapes; no live Socket.IO, Next.js account flow or Gemini integration is claimed.

## Frontend owner (Codex)

The existing `client/src/auth/httpAuthService.ts` accepts the implemented paths and shapes: register returns `{status:'requires-login'}`, login/me return `{user:{id,username,displayName,avatar,isDemo:false}}`, logout returns 204. Error fields/code are top-level and only approved names are included. Unknown/legacy/disabled login failures share 401; registration conflicts share 409.

Required future changes, owned by Codex:

1. Route `/api/auth/*` to the DATA backend under the **same public origin** as the Next.js app. Do not add cross-origin credentialed fetch or point the current same-origin adapter at port 5000 directly from a port-3000 page. Preserve Cookie, Origin, Content-Type, X-CSRF-Token and Set-Cookie through the proxy, and keep responses uncacheable.
2. Update `client/src/auth/authService.ts`'s HttpAuthService `getCsrfToken` callback to GET `/api/auth/csrf` with `credentials:'same-origin'`, `mode:'same-origin'`, `cache:'no-store'`, `redirect:'error'`; validate the 200 `{csrfToken,expiresAt}` response, return the token, and fail closed on error. The existing static meta reader is insufficient across guest/login/logout transitions unless a trusted server bootstrap refreshes it correctly.
3. Obtain the proof before **every** credential-bearing mutation using that callback. Guest register consumes its proof; login requires a fresh bootstrap; logout requires the authenticated proof. Never hard-code a token or expose the HttpOnly bearer. Return to the existing explicit login screen after registration, without automatic password replay.
4. Align form hints/validation with the documented username/email/password/display-name rules. The backend requires 15 code points for new passwords; the provisional frontend currently only requires a password value. Keep passwords untrimmed and do not add a demo fallback.
5. After owner verification, set `NEXT_PUBLIC_AUTH_MODE=api` and `NEXT_PUBLIC_AUTH_API_READY=true` and rebuild. Real account Messenger/profile/friends providers remain separate DB-3/4 integration work; the current real-account workspace remains an honest unavailable-services screen.
6. Test signup → login → restore after refresh → logout → rejected protected request through the actual browser proxy. Recheck CSP/cookies and use HTTPS in production. DB-2's real HTTP tests are not this unperformed browser integration.

No frontend flags were changed by DB-2. Fetches should retain the adapter's deadline and safe failure behavior; never automatically retry an account/session mutation whose outcome is ambiguous. Current frontend maps 429/5xx to unavailable; a richer retry message is a future UI decision.

## Database owner reusable middleware

`createAuthService({db,config,now?,passwordHasher?,limiter?})` uses the same migrated, caller-owned SQLite connection and DB-1 repositories. Production should use the default real hasher/SQLite limiter; injected dependencies are for trusted composition and tests.

`createAuthMiddleware(service)` exposes:

- `requireAuth(req,res,next)`: reads only the configured cookie, validates SQLite state and attaches a frozen, non-enumerable `req.auth = {userId,sessionId,user,expiresAt:Date}`. It attaches no bearer/CSRF verifier/private account data. Missing/invalid/revoked → 401 UNAUTHENTICATED; known expired → 401 SESSION_EXPIRED. Database failure is a sanitized server error, never authenticated success.
- `requireCsrf(req,res,next)`: verifies session/pre-session proof from X-CSRF-Token and records a trusted proof reference for transactional mutations. It must follow the transport/Origin gate; it is not a replacement for object ownership checks.

Use both authentication and object-level authorization on later APIs. The DATA app intentionally returns FEATURE_UNAVAILABLE for legacy data routes; do not remount the raw legacy handlers as an integration shortcut.

## Realtime owner (Kiro)

Construct and inject the shared adapters without duplicating password/session verification:

```js
const { createAuthAdapters } = require('./DATA/server/auth/adapters');
const { sessionResolver, csrfVerifier } = createAuthAdapters(authService);
// Future Kiro-owned composition:
// attachRealtimeServer(httpServer, { sessionCookieName: authService.config.sessionCookie,
//   sessionResolver, authorizer, messageStore, recipientKeyVerifier, ...options });
```

`sessionResolver.resolveSession(context)` matches `server/src/realtime/contracts.ts`:

```ts
type Resolution =
  | {status:'authenticated'; session:{sessionId:string; userId:string; displayName:string; expiresAt:Date}}
  | {status:'missing'|'invalid'|'expired'};
resolveSession(context: {
  sessionToken:string; origin:string; remoteAddress:string; userAgent:string|null;
  secure:boolean; receivedAt:Date;
}): Promise<Resolution>;
checkSession(reference:{sessionId:string;userId:string}): Promise<
  {status:'active';expiresAt:Date} | {status:'expired'|'revoked'}
>;
```

The sessionId is an internal UUID, never the cookie. Resolution validates configured Origin, transport, active account/version, expiry/revocation and demo exclusions. Time comes from the server clock, not context.receivedAt. Malformed/unknown/revoked/foreign identities return invalid; missing returns missing; known expiry returns expired. Kiro maps those to AUTH_REQUIRED, UNAUTHORIZED and SESSION_EXPIRED respectively. Pass the configured cookie name explicitly: Kiro's current default `secubuzz_session` differs from the production `__Host-` name.

Existing socket authentication must end at expiresAt. Enable periodic checkSession revalidation (for example every 15 seconds) to catch logout/disable/revocation in any process, and recheck authority before protected actions. Local composition can additionally notify Kiro's `revokeSession(sessionId)` after logout; DB-2 does not attach that hook or claim immediate disconnection of existing sockets. Do not log the context bearer. One successful handshake must not become indefinite authority.

The published context.secure flag means **direct TLS**. The adapter fails closed on false in production: an HTTP Origin allowlist is not proof of trusted TLS termination. If realtime/AI terminates TLS in a proxy, the owning composition must attest transport from a restricted trusted-proxy boundary or use TLS to Node. Do not set secure=true from arbitrary forwarded input. The DATA HTTP app's trusted-proxy check does not silently alter Kiro's narrower context contract.

For existing environment-based Kiro configuration, the cookie settings are `REALTIME_SESSION_COOKIE` and `AI_SESSION_COOKIE`. Production must use `__Host-secubuzz_session`; explicit local HTTP uses `secubuzz_session`. These Kiro-owned environment files were not edited by DB-2.

RealtimeAuthorizer, durable MessageStore, RecipientKeyVerifier, message-ID scope/fingerprint agreement and object permissions remain later DB-3/4 or Security work. None were activated.

## Gemini Phase 9B owner (Kiro)

The same sessionResolver is available to the mountable AI HTTP handler. `csrfVerifier.verify({sessionId,userId,token})` returns boolean (compatible with AiCsrfVerifier's boolean/Promise return). It returns true only for a valid, active matching session/user and its session-bound proof; expired/revoked/wrong-user/wrong-token returns false. Database throws are deliberately left to Kiro's existing adapter deadline/fail-closed handling.

Future owning composition must pass both adapters and `sessionCookieName` through the appropriate AI config, keep same-origin Cookie/Origin/X-CSRF-Token, and mount the handler **before** DATA's JSON body parser/generic request handlers. The current DATA app mounts no AI handler. HTTP auth errors and AI errors remain separate contracts; Kiro's existing handler maps invalid sessions/proofs to its own codes.

DB-7/8 must still deliver the durable shared AiUsageStore, consent nonce/quota semantics and final composition/proxy/workspace integration. Project/model quota, billing/free-tier verification and Security's recipient-key work remain with their owners. **AI_REMOTE_ENABLED was not changed, no real Gemini request was made, and Phase 9B live use is not declared unblocked.**
