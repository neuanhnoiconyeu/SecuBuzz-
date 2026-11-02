# Yahoo! Security Messenger

**A 2000s Retro DevSecOps Communication Platform with AI-Powered Intelligence**

Kiroween Hackathon 2026 | Resurrection Track | Frankenstein Track

---

## Project Overview

Yahoo! Security Messenger resurrects the golden era of early-2000s messaging nostalgia while infusing it with cutting-edge AI-powered DevSecOps capabilities. The application combines the iconic Windows XP aesthetic with modern end-to-end encryption, real-time threat detection, and autonomous Kiro AI agents that continuously audit, monitor, and protect secure communication channels.

This is a love letter to dial-up internet culture, reimagined through the lens of contemporary cybersecurity—where retro UI meets intelligent threat intelligence.

---

## Core Features

### 🎨 Retro Windows XP UI
- Faithful recreation of early-2000s Windows XP aesthetic
- Classic blue gradient backdrops, beveled buttons, and iconic notification sounds
- Nostalgic contact list with buddy status indicators
- BUZZ! notification system inspired by Windows Messenger alerts

### 🔐 End-to-End Encryption (E2EE)
- All messages encrypted using industry-standard encryption (TLS 1.3 + application-level encryption)
- Perfect forward secrecy with key rotation mechanisms
- User-friendly passphrase management with secure storage
- Message authentication and tamper detection

### 🤖 Kiro AI Agents
- **auditor_bot**: Continuously scans message logs and security events for policy violations and anomalies
- **sentinel_bot**: Real-time threat detection and pattern analysis; identifies suspicious behavior and coordinated attacks
- **buzz_guard**: Proactive alert orchestrator that triggers the classic BUZZ! notification for critical security events

### 📢 BUZZ! Proactive Alert System
- Iconic notification sound with high-priority security event escalation
- Multi-channel alerting (in-app, email, dashboard)
- Customizable alert thresholds and severity levels
- Historical alert log and incident tracking

### 📊 Security Dashboard
- Real-time monitoring of active connections and message flow
- Audit logs with full compliance tracking
- Agent activity logs and decision transparency
- Threat timeline and incident correlation

---

## Team Allocation

| Role | Team Member | Responsibilities |
|------|-------------|-----------------|
| **Security & E2EE/UI** | Lọ | Encryption architecture, Windows XP UI implementation, security hardening |
| **Database & Schema** | Teammate 1 | SQLite database design, schema optimization, query performance tuning |
| **Fullstack & Real-time/Kiro Integration** | Bon/XJP | Node.js backend, Socket.io real-time communication, Kiro agent integration |

---

## Tech Stack

- **Frontend**: React with Tailwind CSS for styling
- **Real-time Communication**: Socket.io for WebSocket-based messaging
- **Backend**: Node.js with Express.js
- **Database**: SQLite for persistent storage
- **Encryption**: TLS 1.3, libsodium for cryptographic operations
- **AI & Automation**: Kiro Engine with custom AI agents (auditor_bot, sentinel_bot, buzz_guard)
- **DevOps**: Docker for containerization, GitHub Actions for CI/CD

---

## Kiroween Compliance Checklist

- [x] **Resurrection Track**: Classic early-2000s aesthetic and UX faithfully recreated
- [x] **Frankenstein Track**: Modern AI agents grafted onto retro foundation
- [x] **Kiro Integration**: Autonomous agents (auditor_bot, sentinel_bot) embedded in security layer
- [x] **Security-First**: E2EE messaging with continuous automated auditing
- [x] **Real-time Capability**: Socket.io for live messaging and alert propagation
- [x] **Professional Polish**: Complete architecture, security specifications, and team organization

---

## Quick Start

### Prerequisites
- Node.js 18+
- SQLite 3
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/neuanhnoiconyeu/SecuBuzz-.git
cd SecuBuzz-

# Install server dependencies
cd server
npm install

# Install client dependencies
cd ../client
npm install
```

### Development

```bash
# Start the database
cd server
npm run db:init

# In separate terminal: Start the backend server
npm run dev

# In another terminal: Start the React frontend
cd client
npm start
```

The application will be available at `http://localhost:3000`.

---

## Architecture

### Client-Server Communication
- **Transport**: Socket.io over WebSocket with TLS encryption
- **Protocol**: JSON-based message serialization
- **Authentication**: OAuth 2.0 with session tokens

### Security Layer
- Message encryption happens client-side before transmission
- Server validates message signatures without accessing plaintext
- Kiro agents audit encrypted metadata and behavioral patterns
- End-to-end key exchange via Diffie-Hellman

### Kiro Agent Pipeline
1. **auditor_bot**: Runs compliance checks every 5 minutes
2. **sentinel_bot**: Analyzes anomalies in real-time (sub-second latency)
3. **buzz_guard**: Aggregates alerts and triggers notifications

---

## Project Structure

```
yahoo-security-messenger/
├── .kiro/
│   └── specs/
│       └── security.md          # Security rules and agent specifications
├── client/                       # React frontend
│   ├── src/
│   ├── public/
│   └── package.json
├── server/                       # Node.js backend
│   ├── src/
│   │   ├── database/
│   │   │   └── schema.sql       # SQLite schema
│   │   ├── routes/
│   │   ├── agents/
│   │   └── index.js
│   └── package.json
├── README.md                     # This file
├── LICENSE                       # MIT License
└── .gitignore
```

---

## License

MIT License - See LICENSE file for details.

---

## Contact & Hackathon Info

**Event**: Kiroween Hackathon 2026  
**Tracks**: Resurrection | Frankenstein  
**Team**: Yahoo! Security Messenger Contributors

For questions or contributions, please open an issue or contact the team.

---

**Remember**: With great nostalgia comes great responsibility. Stay secure! 🔐✨
