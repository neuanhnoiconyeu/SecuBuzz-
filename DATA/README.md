
# Yahoo! Security Messenger
## Data Engineering Module

### Post-DB-4B recipient-key directory

DATA now provides migration 7, Kiro's six authenticated key APIs and genuine
envelope-v2 recipient-key verification in the existing shared message service.
The verifier is composed by default from persistent public device keys, signed
epochs and opaque HPKE wraps, with a fresh in-transaction recheck. V1 is refused
for verified sending; missing verification infrastructure still fails closed.
This does not implement client device keys or Socket.IO delivery.

Use Node 24.20.0 with the sibling `server/src/e2ee/` public protocol source present.
No new package dependency is required. See the [current handoff and isolated setup](docs/e2ee-key-directory-handoff.md),
[key OpenAPI](docs/e2ee-keys-openapi.json), [frontend contract](docs/e2ee-frontend-integration.md)
and [realtime contract](docs/e2ee-realtime-integration.md). Older phase sections
below describe their original delivery state; the current handoff supersedes
their absent-verifier/v1-only statements.

### Overview
This module provides the database infrastructure and
REST APIs for Yahoo! Security Messenger.

### Technology Stack
- JavaScript (Node.js)
- Express.js
- SQLite
- better-sqlite3
- SQL

### DB-1 Foundation

The database now uses versioned transactional migrations. The twelve roadmap
entities are represented, with legacy Contacts and SecurityLogs preserved.

- [Schema inventory and ERD](docs/schema.md)
- [Migration and operations guide](docs/migrations.md)
- [Repository contracts and phase handoffs](docs/repositories.md)
- [DB-1 implementation and verification report](docs/db1-handoff.md)

### DB-2 Authentication & Sessions

The existing Express backend now provides real registration/login, Argon2id
password hashing, durable cookie sessions, CSRF bootstrap, strict Origin checks,
shared SQLite rate limits and reusable session/CSRF adapters. Legacy accounts are
not automatically credential-enabled. DB-3 supplies profiles/friends below;
groups/messaging authorization, uploads and live social/realtime/AI composition
remain later-phase work.

- [Authentication API contract](docs/auth-api.md) and [OpenAPI](docs/auth-openapi.json)
- [Password/session/CSRF architecture](docs/auth-sessions.md)
- [Frontend and Kiro integration handoff](docs/auth-integration.md)
- [Environment, deployment and operations](docs/auth-operations.md)
- [DB-2 implementation report](docs/db2-handoff.md)

Authentication routes: `GET /api/auth/csrf`, `POST /api/auth/register`,
`POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`.
Bootstrap CSRF before every credential-bearing mutation; registration explicitly
requires login afterward. See the contract for the complete sequence.

### Legacy API contracts (closed in the DB-2 server)

The DAL/router interfaces below remain for compatibility. The actual server
returns 401 without authentication and 503 FEATURE_UNAVAILABLE afterward until
DB-3/4/7 implement object authorization. No unprotected legacy handlers are mounted.

### DB-3 Profiles & Friends

Authenticated profiles, username-prefix discovery, incoming/outgoing requests,
friendships and block/unblock APIs are implemented. Mutations reuse DB-2's
session/CSRF/Origin policy. Transactional revisions allow coherent paginated social
snapshots; historical Contacts/projections do not become authenticated consent.

- [Profiles/friends API](docs/profiles-friends-api.md) and [OpenAPI](docs/profiles-friends-openapi.json)
- [Relationship states and legacy policy](docs/relationships.md)
- [Frontend/Kiro handoff](docs/db3-integration.md)
- [Migration, performance and operations](docs/db3-operations.md)
- [DB-3 verification report](docs/db3-handoff.md)

Frontend Phase 8.8 now integrates DB-3 profiles/friends. Conversations, groups, uploads, live presence
and Gemini are not implemented by DB-3. Remaining legacy user CRUD paths and
messages/logs remain closed; the table below documents their historical contracts.

### DB-4A Conversations Foundation

Authenticated direct-conversation metadata is implemented through
`GET /api/conversations`, `POST /api/conversations/dm` and
`GET /api/conversations/:id`. It reuses the existing unique pair, membership DAL,
DB-2 session/CSRF/Origin and DB-3 friendship/block policy. Migration 5 adds
conversation provenance without rewriting prior versions or historical ciphertext.
There is no new message storage, realtime wiring, group workflow or frontend adapter.

- [Conversations OpenAPI](docs/conversations-openapi.json)
- [Authorization, pagination, repositories and DB-4B integration](docs/db4a-integration.md)
- [DB-4A implementation and verification report](docs/db4a-handoff.md)

### DB-4B Encrypted Messages & Persistence

The same Messages/MessageReceipts store now supports authorized ciphertext submission,
snapshot-cursor history, conversation-scoped wire-ID idempotency, sender tombstones and
eligible read receipts. Encrypted editing is explicitly deferred. Migration 6 is additive;
earlier schema versions and historical bytes remain unchanged.

**Production submission stays fail-closed:** the normal entrypoint supplies no genuine
recipient-key verifier. Structural encrypted-envelope validation is not E2EE attestation;
no environment switch, demo fallback or fixture route enables insecure sending.

- [Messaging OpenAPI](docs/messaging-openapi.json)
- [Envelope compatibility, identities and E2EE gates](docs/db4b-e2ee-storage-contract.md)
- [Frontend contract](docs/db4b-frontend-integration.md)
- [Shared service and Kiro boundary](docs/db4b-realtime-integration.md)
- [DB-4B implementation and verification report](docs/db4b-handoff.md)

#### Users
| Method | Endpoint | Description |
| POST | /api/users | Create user |
| GET | /api/users | Retrieve users |
| GET | /api/users/:id | Retrieve user |
| PATCH | /api/users/:id/status | Update status |
| POST | /api/users/:id/contacts | Add contact |
| GET | /api/users/:id/contacts | Retrieve contacts |

#### Messages
| Method | Endpoint | Description |
| POST | /api/messages | Store encrypted message |
| GET | /api/messages/:id | Retrieve message |
| GET | /api/messages/conversation/:user1/:user2 | Retrieve conversation |
| PATCH | /api/messages/:id/status | Update message status |

#### Security Logs
| Method | Endpoint | Description |
| POST | /api/logs | Create security event |
| GET | /api/logs | Retrieve security events |
| GET | /api/logs/critical | Retrieve critical events |
| GET | /api/logs/report | Generate audit report |

### Installation

```bash
npm ci
```

### Configure and migrate

Use Node 24 (tested on 24.20.0). Copy `.env.example` to `.env` only when no local
environment file exists, then:

```bash
npm run db:migrate
```

Relative `DB_PATH` resolves from DATA/. `DB_BUSY_TIMEOUT_MS` defaults to 5000.
Back up an existing database and verify the upgrade on a copy first. An unsafe
legacy mapping stops and rolls back; see the migration guide. No seed data is
automatically inserted.

Add auth settings from `.env.example` to an existing `.env` without overwriting it.
Local HTTP requires explicit `AUTH_ALLOW_HTTP_LOCAL=true` and loopback Origins;
production requires HTTPS Origins and rejects that override. Missing Origin
configuration fails startup. The app and API must be routed under one browser origin.

### Run Development Server

```bash
npm run dev
```

### Run Tests

```bash
npm test
```

### Database
Pending migrations run automatically before the server starts. The old
`server/database/schema.sql` is a frozen legacy reference; migration SQL is the
current source of truth. Tests use unique isolated temporary databases.

### Security
- Parameterized SQL queries
- Foreign key constraints
- Client-side encrypted message storage
- Security event logging
- Input validation

Authentication is implemented in DB-2 and authorized profile/social APIs in DB-3.
Messaging/group authorization and frontend/Kiro composition remain later work.
