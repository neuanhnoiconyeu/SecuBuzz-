
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

### Database Tables
1. Users
2. Contacts
3. Messages
4. SecurityLogs

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
npm install
```

### Run Development Server

```bash
npm run dev
```

### Run Tests

```bash
npm test
```

### Database
SQLite database is initialized automatically
when the server starts.

### Security
- Parameterized SQL queries
- Foreign key constraints
- Client-side encrypted message storage
- Security event logging
- Input validation

Note: Authentication and authorization must be
integrated before public deployment.