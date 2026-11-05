# Yahoo! Security Messenger

**A 2000s Retro DevSecOps Communication Platform with AI-Powered Intelligence**

Kiroween Hackathon 2026 | Resurrection Track | Frankenstein Track

---

## Project Overview

Yahoo! Security Messenger is a Yahoo Messenger-inspired frontend with a Retro Modern visual system and a local SecureBot conversation demo. The product vision includes realtime communication and security tooling, but those services are not implemented in this checkout.

This is a love letter to dial-up internet culture, reimagined through the lens of contemporary cybersecurity—where retro UI meets intelligent threat intelligence.

---

**Current implementation status:** The client keeps conversation state in browser memory and uses a local demo transport. Browser-side AES-GCM is a demonstration primitive; there is no multi-user key exchange, remote delivery, server persistence, live presence service, or connected Kiro agent.

## Product Vision (Planned)

The items below describe project goals, not functionality currently available in the client.

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

## Current Client and Planned Integrations

- **Current frontend**: Next.js App Router, React, TypeScript, Tailwind CSS, NES.css accents, Lucide icons, and Web Crypto for the browser demo.
- **Planned integrations**: Realtime transport, backend APIs, database persistence, production E2EE key management, and Kiro agents require their respective owner-provided contracts and implementations.

---

## Kiroween Compliance Checklist

- [x] **Resurrection Track**: Classic early-2000s aesthetic and UX faithfully recreated
- [ ] **Frankenstein Track**: Modern AI agents grafted onto retro foundation
- [ ] **Kiro Integration**: Autonomous agents embedded in the security layer
- [ ] **Security-First**: Production E2EE and continuous automated auditing
- [ ] **Real-time Capability**: Live messaging and alert propagation
- [ ] **Professional Polish**: Complete integrated architecture and release readiness

---

## Quick Start

### Prerequisites
- Node.js 18+
- npm 9+

### Run the frontend demo

```bash
# Clone the repository
git clone https://github.com/neuanhnoiconyeu/SecuBuzz-.git
cd SecuBuzz-

# Install and start the current frontend demo
cd client
npm install
npm run dev
```

The frontend is available at `http://localhost:3000`. No backend, database, or remote message delivery is started by this command.

---

## Architecture

### Current frontend architecture
- The App Router page hosts the SecureBot conversation and a local system log.
- Typed message state is isolated in `client/src/hooks/useConversationMessages.ts`; domain message contracts are in `client/src/messaging/messageModel.ts`.
- `localDemoTransport` resolves locally to exercise message state transitions and emits one fixed, clearly labeled SecureBot mock reply after each accepted text message. It does not call an AI service, inspect/decrypt the message, send to another user, or persist data.
- The current Web Crypto AES-GCM key is generated in the browser for this demo only. It does not establish interoperable multi-user E2EE.

### Future realtime adapter points
The `MessagingTransport` interface is the client boundary for connecting/reconnecting to or disconnecting from a conversation, sending encrypted messages, receiving messages and delivery status, updating presence, and receiving security alerts. A Socket.IO client should be added only after the Realtime teammate confirms event names, payloads, authentication behavior, and a compatible protocol version.

---

## Project Structure

The directory diagram below includes planned backend components. In this checkout, `server/` contains only `src/database/schema.sql`; it has no backend package, routes, or realtime runtime.

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

## Frontend Design System

The client uses a Retro Modern direction: Yahoo Messenger and Windows XP details remain recognizable, while spacing, typography, input states, focus, and responsive behavior follow modern accessibility conventions. Yahoo purple is the primary brand color; NES.css is limited to deliberate retro accents.

### Styling and tokens

- CSS variables in `client/src/app/globals.css` are the source of truth for brand/status colors, surfaces, typography, spacing, radii, shadows, z-index layers, and transition durations.
- `client/tailwind.config.ts` maps the shared color, typography, radius, shadow, stacking, and duration tokens for Tailwind utilities.
- Tailwind CSS remains the primary styling system. NES.css is used only through explicit retro variants; avoid applying NES classes globally.
- Lucide React provides the interface icon set. Keep icon sizes consistent and label icon-only controls accessibly.

### Shared UI components

Typed components are exported from `client/src/components/ui`: `Button`, `TextInput`, `TextArea`, `Dialog`, `DropdownMenu`, `Tooltip`, `Avatar`, `Badge`, and `Surface`. Feature components should compose these controls rather than duplicate their state, focus, validation, or variant styling.

Use native semantic elements where possible. Dialogs use the browser dialog element; dropdowns support arrow, Home/End, Escape, and Tab behavior. Inputs expose labels and linked hint/error/success text. Respect reduced-motion settings and keep visible keyboard focus.

### Frontend conventions

- Keep feature behavior in feature components and reusable visual behavior in `components/ui`.
- Prefer local React state for local UI. Add no global store until a concrete cross-feature need exists.
- Validate untrusted API data at application boundaries when API contracts are introduced. Client validation is not authorization.
- Add focused React Testing Library coverage for shared component semantics, keyboard states, validation and disabled/loading behavior.

## Phase 2 — Main Messenger Experience

The current SecureBot screen uses reusable message components, a conversation-scoped state hook, and an adapter-based transport boundary.

### Message model and rendering

- `client/src/messaging/messageModel.ts` defines conversation and sender IDs, display name, text content, ISO timestamp, `text` / `system` / `security_alert` type, `sending` / `sent` / `delivered` / `failed` state, and optional AES-GCM demo metadata.
- `client/src/components/messenger/MessageList.tsx` renders incoming and outgoing bubbles, system notices, security alerts, readable times, local encryption indicators, delivery states, and retry actions. It groups nearby consecutive text messages from the same sender.
- Conversations start empty. The interface does not insert sample messages. It follows new messages when the reader is near the bottom and offers a jump control when new messages arrive while scrolled up.

### Composer behavior

- Enter sends non-empty text; Shift+Enter retains the browser's newline behavior.
- The composer rejects whitespace-only input, indicates pending sends, clears a draft only after local transport acceptance, and keeps the draft on a failed send.
- BUZZ! remains a separate user action, is locked while its current animation/callback runs, and does not publish a realtime event in this phase.

### Demo transport and integration limits

- `client/src/hooks/useConversationMessages.ts` owns per-conversation message state; `client/src/messaging/messageState.ts` contains pure append, deduplication, ID generation, and delivery-state updates.
- `client/src/messaging/transport.ts` defines connect/disconnect, encrypted send envelope, incoming message, delivery status, presence, security alert, and connection-status hooks. `client/src/messaging/localDemoTransport.ts` is the current local adapter.
- The demo adapter resolves an encrypted envelope locally without contacting a service, then emits a fixed mock reply labeled as a demo response. Chat content is held in the current page's React state and is lost on refresh. “Accepted by local demo” does not mean delivered to another person.
- AES-GCM runs in this browser using a demo key. Key exchange, remote delivery, server/database persistence, authenticated sender identity, and multi-user E2EE are not implemented.
- Add a Socket.IO client only after the Realtime teammate provides and confirms the event and authentication contract. The transport interface is the intended integration point; no Socket.IO dependency or server was added in Phase 2.

## Phase 3 — Client-side message protection

- `client/src/utils/crypto.ts` uses browser Web Crypto AES-256-GCM with a 96-bit random nonce and a 128-bit authentication tag. The returned versioned payload identifies `AES-256-GCM` and Base64 encoding; the ciphertext includes the GCM tag. Conversation ID, message ID, sender ID/name, timestamp, and message type are authenticated as additional data. Web Crypto provides the AES-GCM operation and key handling ([W3C Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/)); GCM requires nonce uniqueness for each key ([NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final)).
- Generated keys are non-extractable and held only in an in-memory, conversation-scoped key manager. They are not persisted, exported, or shared; page reload loses them. A key manager coalesces concurrent key creation, and replacing a key replaces its manager entry. Nonces come from Web Crypto's secure random generator and are tracked by `CryptoKey` identity in a `WeakMap`; a detected collision is retried. Random nonces remain probabilistic, so this is not a mathematical uniqueness guarantee, and the tracker covers this JavaScript realm only.
- Message sending encrypts before adding the message to local state or calling a transport. Outbound transport envelopes contain metadata and ciphertext only. Incoming encrypted envelopes are authenticated and decrypted using the received envelope's metadata before display; a missing local key or authentication failure discards the message and produces a generic security alert. Plaintext from the local demo is accepted only when the transport declares `local-demo`, and it is labeled as a demo reply.
- The UI reports local encryption readiness separately from recipient-key availability and authenticated key exchange. Recipient public-key exchange, sender identity authentication, key persistence/recovery, remote decryption, and multi-user end-to-end encryption are not implemented. The ephemeral local key cannot be used by another participant, so the app does not claim E2EE.
- A future key exchange or key persistence feature needs a reviewed protocol and threat model. Do not add raw key export or treat local encryption as protection from the application runtime, browser extensions, or a compromised device.

## Phase 4 — Application navigation and conversation foundation

- The client uses `client/src/conversations/conversationModel.ts` for backend-neutral conversation metadata and `client/src/hooks/useMessengerConversations.ts` for active selection, local unread counts, per-conversation drafts, and activity previews. Duplicate conversation IDs are removed when initial demo data is normalized.
- The Chats workspace includes local examples for SecureBot (`bot`), Ava Morgan (`direct`), and Security Study Group (`group`). These are interface examples, not real users. Conversation and message state is held in React memory and is lost on refresh; there is no persistence.
- The conversation sidebar switches the active chat. The existing conversation-scoped message hook retains messages by conversation ID and subscribes to the loaded local demo conversation IDs. Drafts remain in application state while switching views. Incoming local demo messages for inactive conversations increment only that conversation's unread count; selecting it clears the count.
- SecureBot returns a fixed scripted demo response. Direct and group demo entries accept local encrypted messages for interface testing but do not fabricate a recipient or delivery response. Their UI explains that no other user receives those messages.
- `client/src/conversations/conversationModel.ts` defines `ConversationDataProvider` methods for loading, creating, updating, and loading messages. It also defines a domain-level realtime provider boundary for message, conversation, unread/read, and presence updates. These are interfaces only; they do not define database schemas or Socket.IO event names. Existing `MessagingTransport` remains the client message boundary.
- Local unread counts, previews, and drafts are in-memory only. Real user presence, remote delivery, database/API persistence, complete Friends or group workflows, AI Hub workflows, and multi-user E2EE are not implemented.
