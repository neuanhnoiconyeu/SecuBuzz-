
# Yahoo! Security Messenger
## Data Engineering Module

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

DB-1 supplies persistence foundations. Authentication/session issuance,
authorization, full friend/group workflows, uploads and realtime/AI integration
remain later-phase work. Existing API endpoints below retain their signatures.

### API Endpoints

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

Note: Authentication and authorization must be
integrated before public deployment.
