# DB-2 authentication API contract

Canonical machine-readable contract: [auth-openapi.json](auth-openapi.json). Routes are served by the existing Express backend (`DATA/server.js`, `server/app.js`). Credentials and bearer tokens are never included in JSON responses. AuthUser is exactly `{id, username, displayName, avatar, isDemo:false}`; private email and password hashes live separately.

| Method/path | Request | Success |
| --- | --- | --- |
| GET `/api/auth/csrf` | Same-origin request with cookies; no body | 200 `{csrfToken, expiresAt}`. A guest gets an HttpOnly pre-session cookie; an authenticated caller gets a proof bound to their existing session. |
| POST `/api/auth/register` | `{username,email,password,displayName?}`, Origin and `X-CSRF-Token` | 201 `{status:"requires-login"}`. Creates a real user/profile/private credential atomically; **does not sign in**. Guest proof is consumed. |
| POST `/api/auth/login` | `{identifier,password}`, Origin and `X-CSRF-Token` | 200 `{user:AuthUser}` and a new HttpOnly session cookie. Identifier is username or email. Guest proof is consumed; any authenticated browser session used for the login is revoked and replaced. |
| GET `/api/auth/me` | Session cookie; no claimed user ID | 200 `{user:AuthUser}` or 401. Every request checks SQLite, expiry, revocation, account status and credential version. |
| POST `/api/auth/logout` | No body; Origin and `X-CSRF-Token` | 204; revokes this session and clears session/pre-session cookies. Other browser sessions remain valid. With no valid session, a fresh guest bootstrap proof allows a safe 204 retry. Missing/invalid proof is always 403 and does not revoke anything. |

No refresh endpoint exists: sessions have a fixed absolute lifetime. Login is the explicit way to obtain a new session. Successful authenticated activity does not silently extend expiry.

## Validation and errors

- Username: trimmed, lowercased ASCII, 3..30 characters; starts with a letter/digit, then letters/digits/`.`/`_`/`-`. Reserved local/demo-style names are rejected. Uniqueness is case-insensitive, including reservation of legacy usernames.
- Email: trimmed/lowercased, ASCII conventional mailbox/domain syntax, at most 254 characters and 64 before `@`; no provider-specific dot/plus rewriting. Email ownership is **not verified** by DB-2 and must not authorize recovery/claim operations.
- Password: registration requires 15 Unicode code points, maximum 1024 UTF-8 bytes. No trimming, Unicode normalization, composition rules, or truncation. Malformed UTF-16 surrogate input is rejected. Login accepts 1..1024 bytes so historical hashes can be verified; no public password-change/recovery endpoint is added.
- Display name: optional, defaults to normalized username; trimmed, 1..40 Unicode code points, no control characters.
- Register/login require a JSON object and reject unknown properties, including userId/isDemo/role overrides. Maximum body is 8192 bytes; compressed bodies are refused. Logout has no body and rejects nonempty/chunked payloads.

Errors are JSON `{code,fields:[]}`; validation may list only approved field names. There are no raw server messages, SQL, credential values or stack traces. Codes/statuses:

| HTTP | Codes | Meaning |
| --- | --- | --- |
| 400 | VALIDATION_ERROR | Invalid fields/JSON or a nonempty logout body. |
| 401 | INVALID_CREDENTIALS, UNAUTHENTICATED, SESSION_EXPIRED | Login failure; absent/invalid/revoked session; known expired session. Wrong, unknown, legacy and disabled credentials share the identical INVALID_CREDENTIALS response. |
| 403 | CSRF_INVALID, FORBIDDEN | Incorrect/missing/expired proof, unsafe Origin or transport. |
| 409 | CONFLICT | Generic account-unavailable response; never identifies username versus email. A registration outcome can still indicate that an account cannot be created; this is not a claim of eliminating all signup enumeration. |
| 413 / 415 | PAYLOAD_TOO_LARGE / UNSUPPORTED_MEDIA_TYPE | Body or content-type limits. |
| 429 | RATE_LIMITED | Source/account limit or hash concurrency/capacity exhaustion. Rate-limit refusals include Retry-After; capacity exhaustion may not. |
| 500 / 503 | INTERNAL_ERROR / SERVICE_UNAVAILABLE | Sanitized unexpected/database-busy failure. No automatic write retry. |

DB-3 now mounts the authorized profile/search/friends/block routes described in [its API contract](profiles-friends-api.md). The remaining legacy `/api/users` CRUD paths, `/api/messages` and `/api/logs` stay closed (401 unauthenticated, 503 FEATURE_UNAVAILABLE after authentication; mutations additionally require CSRF). Their legacy DAL/router modules remain for compatibility tests, but the actual server does not mount their unprotected handlers. Health checks `/` and `/healthz` return only `{status:"ok"}`. Auth endpoint shapes and policy are unchanged.

## Browser request sequence

1. GET `/api/auth/csrf` using same-origin fetch, cookies enabled, `cache:'no-store'`, `mode:'same-origin'`, `redirect:'error'`.
2. POST register with the returned proof in `X-CSRF-Token`. The browser supplies Origin automatically. Receive `requires-login`; never replay the password automatically.
3. Bootstrap again before login because the successful guest registration consumed its proof. POST login; the response sets an HttpOnly bearer cookie.
4. GET `/api/auth/me` to restore/check the authoritative identity. After process restart the same valid cookie continues to work.
5. Bootstrap before the next mutation (including logout); this returns the session-bound proof. Do not keep the former guest proof.
6. POST logout, clear local identity after confirmed 204, then bootstrap again before a later login/register. After expiry, a new guest bootstrap is required for a safe logout retry.

The proof is not the bearer token and cannot authenticate `/me`. Keep proofs in memory or inject a fresh meta token for the correct session. Never use a public environment variable, localStorage or a hard-coded token. No credentialed CORS headers are emitted; the app and API must be routed under one origin. Missing mutation Origin is rejected, even with a valid proof. Same-origin GET bootstrap can use browser Fetch Metadata/Referer/allowlisted target Host when Origin is absent.
