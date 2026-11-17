# DB-2 operations and deployment

Use Node 24 (verified 24.20.0) and run inside DATA. Dependencies include the native `better-sqlite3` and `argon2` bindings. Use `npm ci` from the committed lockfile; if your package manager blocks native install scripts, approve only the required package scripts after review or use the shipped supported prebuilds. Never disable TLS verification to install dependencies. This Windows environment uses the OS CA trust store when necessary.

```powershell
cd D:\Projects\SecuBuzz-\DATA
npm ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
# If .env already exists, add the documented auth settings without overwriting it.
npm run db:migrate
npm start
```

Tests use unique temporary databases and synthetic credentials:

```powershell
npm test
npm run auth:cleanup  # Operational job: this targets configured DB_PATH, not a test fixture.
```

Do not run cleanup or migration verification against the original database as a test shortcut. Back up and verify an upgrade copy first. The original tracked SQLite database/sidecars are left unchanged by DB-2 implementation verification. Applied migrations 0001 and 0002 are unchanged; only 0003-authentication.sql is added. Startup applies migrations through the DB-1 runner before serving API traffic.

| Setting | Policy |
| --- | --- |
| NODE_ENV | development/test/production only; unknown values fail. Production rejects local HTTP opt-in. |
| HOST / PORT | Default bind 127.0.0.1:5000. Behind a proxy keep the backend bound to a restricted interface. PORT=0 is supported for isolated tests. |
| DB_PATH | Existing DATA-relative default or explicit absolute path. Shared workers must use the same durable file, not :memory: or separate local disks. |
| DB_BUSY_TIMEOUT_MS | Existing bounded SQLite writer timeout; default 5000. Busy auth writes fail safely rather than retrying an ambiguous outcome. |
| AUTH_ALLOWED_ORIGINS | Required comma-separated canonical origins, no paths/credentials/wildcards. Production origins must use HTTPS. Match the public browser origin exactly. |
| AUTH_ALLOW_HTTP_LOCAL | Explicit true only for development/test loopback HTTP. Cookie names lose __Host- and Secure only in this mode. Production loader refuses it. |
| AUTH_SESSION_TTL_SECONDS | Default 28800 (8h), range 300..604800. Absolute lifetime, no sliding renewal. |
| AUTH_TRUST_PROXY_IPS | Optional exact IP addresses of trusted immediate TLS proxies. Defaults empty; no CIDRs, broad hop counts or wildcard trust. Only an exact trusted peer plus X-Forwarded-Proto exactly https attests HTTP transport security. |

Production example settings use `NODE_ENV=production`, `AUTH_ALLOW_HTTP_LOCAL=false`, `AUTH_ALLOWED_ORIGINS=https://<your-public-host>`, and exact trusted proxy peers if TLS is offloaded. Do not copy placeholder hosts into a live deployment. Enforce public HTTPS, restrict access to the backend, and have the trusted proxy overwrite transport headers. Do not mark arbitrary client-supplied forwarded headers as trusted. Public origin/Host and cookies must survive the proxy without rewriting to a guessed external origin.

The actual server uses the socket's direct peer address for rate limits, ignoring X-Forwarded-For even behind a trusted TLS proxy. This prevents spoofed client IP bypass but groups users behind the same proxy/NAT. Source limits must be tuned or replaced by a reviewed trusted-gateway design before scaling; do not turn on generic Express trust proxy.

## Abuse protection and resource limits

SQLite fixed-window counters are transactional and shared across processes using the same file; they survive process restart. Only SHA-256 bucket keys are stored (no raw identifier/IP in rate rows). The replaceable limiter interface is `consume([{key,limit,windowMs}],nowMs) -> {allowed,retryAfterSeconds?}`. It must be synchronous and atomic for the supplied bucket set; refusal changes no counters. Storage errors produce a server error, never an allowed decision.

| Scope | Limit |
| --- | --- |
| Registration source | 5 attempts/hour, including malformed/proof failures. |
| Registration normalized username/email | 5 each/hour after validation. |
| Login source | 20 attempts/15 min, including malformed/proof failures. |
| Login identifier and resolved account | 10 each/15 min; username/email aliases share the account bucket. |
| Bootstrap source | 60/min. |
| Logout source | 60/min. |
| Password work | At most two concurrent operations **per process**, no unbounded queue. |
| Pre-session storage | At most 10000 live challenges per database. |

The counters are globally shared only for workers attached to that same SQLite database. Hash concurrency is process-local; launching more workers increases aggregate KDF memory/CPU capacity. A multi-host deployment with independent databases needs a shared limiter/store; fixed windows also permit boundary bursts. Use upstream request/concurrency controls and benchmark the documented work factor. Email verification, MFA, breach-password screening and account recovery are not supplied by DB-2.

Register/login JSON limit is 8 KiB, password limit 1024 bytes. Compressed JSON and logout bodies are refused. The server uses a 15-second request timeout, 10-second header timeout, 16-KiB header cap and 100-header limit. Responses are no-store, nosniff, no-referrer and frame-blocked by CSP. No raw exceptions, request bodies, cookies, hashes or session/CSRF values are logged. Operators should monitor status/error-code aggregates without adding sensitive request logging.

## Maintenance and current limitations

Schedule `npm run auth:cleanup` to purge old session verifiers (seven-day retention), expired pre-sessions and expired rate windows. Cleanup emits aggregate counts only. Session resolution checks expiry even before cleanup. Preserve protected consistent SQLite backups and test operational restores separately; process interruption tests are not hardware fault testing.

`npm audit --omit=dev --json` reported **zero production advisories** during verification. Full audit reported two moderate development-only nodemon/minimatch advisories (glob-pattern amplification); normal `npm start` does not use nodemon. Do not use the development watcher in production. Dependency remediation for that existing dev-only chain was not bundled into DB-2.

DB-3/4/7 legacy data APIs remain closed in the actual server. Frontend proxy/bootstrap wiring and Kiro composition have not been performed. Production transport was tested with trusted-proxy semantics; DB-2 does not provision a real TLS terminator/certificate or claim live browser deployment validation.
