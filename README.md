# Yahoo! Security Messenger 2.0

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

- Semantic tokens have one owner: `styles/themes.css` defines colors and shadows, `styles/typography.css` defines fonts and type roles, and `styles/motion.css` defines motion. `app/globals.css` consumes them and owns component layout, spacing, radii, and stacking.
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

## Phase 5 — User profile and local identity

- Open the profile from the avatar and identity button in the top Messenger navigation. The profile window shows the display name, demo username, immutable user ID, custom status, avatar, and local presence preference. Its settings support Save, Cancel, validation feedback, Escape to close, and focus return to the opening control.
- `client/src/profiles/profileModel.ts` separates immutable identity (`id`, `username`, `isDemo`) from editable fields. The default identity is `local-user` / `@demo-explorer`, with the display name “Demo Explorer.” It is explicitly a demo identity, not a registered or authenticated account. Editing the display name does not change the user ID or username.
- Display names are required and limited to 40 Unicode code points after trimming. Custom statuses are optional and limited to 160 Unicode code points after trimming. Both reject C0/C1 control characters. Avatars use an allowlist of built-in Initials, Smile, Star, Rocket, and Cat presets; there are no uploads or remote image URLs.
- Available, Busy, Away, and Invisible are local presence preferences. The navigation and profile window reflect the selected preference. No Socket.IO presence events or visibility changes are broadcast.
- `LocalDemoProfileService` in `client/src/profiles/profileService.ts` owns an in-memory profile and notifies subscribers with isolated snapshots. `useCurrentProfile` manages loading, saves, duplicate submission protection, and safe errors. A fresh app session creates a fresh local service; refreshing the page resets profile changes. No profile data is stored in localStorage, sessionStorage, or a database.
- Navigation identity and own-message display labels use the current profile. New message envelopes use the current display name; existing authenticated sender metadata stays intact for message retry/decryption. Conversation participant IDs, contact identities, and encryption key identities are not rewritten by profile edits.
- A future Database/API adapter can implement `ProfileService.getCurrentProfile()`, `updateProfile()`, `setPresencePreference()`, and `subscribeToProfileChanges()`. The teammate's authenticated API contract must supply the stable user ID, read-only username, editable-field validation, authoritative profile response, and error semantics. This phase defines no API endpoints, persistence, account registration, username availability checks, password settings, or authentication backend.

## Messenger interface — V2

- The messenger uses one shared window with compact retro chrome, top navigation, an inline profile entry, and two integrated conversation/chat panes. Messages and conversation lists scroll within their regions. Mobile uses a full-width list/chat view; Back to conversations opens the list, and selecting a conversation returns focus to the chat heading.
- **Search conversations** filters existing local conversation names and types without changing the active conversation or its draft. Queries ignore surrounding whitespace and case. Clear search or Escape restores all rows. Search is held in page memory only.
- The chat uses one contact/security header, purple outgoing bubbles, and sender/delivery metadata outside the bubbles. The compact composer grows from one line up to 112px, then scrolls internally. Enter sends, Shift+Enter inserts a newline, and BUZZ retains its existing sound and shake behavior. Local demo disclaimers remain visible.
- Conversation headers show local encryption readiness and the E2EE limitation. Open **Security details** with a click, Enter, or Space to inspect AES-GCM, recipient-key, key-exchange, and demo limitations. These disclosures do not establish multi-user E2EE.
- Profile dialogs keep their header and action footer visible while the form body scrolls. Shared `Dialog` supports an optional `footer`; submit actions outside a form use the native HTML `form` attribute.
- **System log** starts collapsed to prioritize chat space. Open it to inspect the existing local event log. Purple branding, restrained retro accents, shared focus colors, and reduced-motion preferences remain the design conventions.

Actual V2 baseline/updated screenshots and browser evidence are in `artifacts/ui-redesign-v2/`. Open `comparison.html` there to compare desktop, laptop, and mobile captures. The small window-control glyphs are decorative; this remains a web application.

## Brand identity and logo usage

The product name is **Yahoo! Security Messenger 2.0**. `BrandLogo` and `BrandIcon` in `client/src/components/branding` provide full, compact, and icon-only variants with `sm`, `md`, and `lg` sizes. Informative variants have an accessible name; use `decorative` when a parent control or adjacent text already supplies it. Next.js serves responsive optimized images while preserving the source assets. Preserve image proportions and the supplied artwork. Dark Mode applies a restrained CSS tonal adjustment to the full wordmark for readability; its transparent source asset, geometry, lettering, and icon remain unchanged.

The compact navigation logo already has HTML text beside the original purple icon. Its **Yahoo! Security** name uses Bungee 400; **Messenger 2.0** remains a smaller Space Grotesk subtitle. The desktop-style title bar uses Bungee for both text spans, forming the full application title at 12px. Branding shares the existing display family rather than loading another font or altering image lettering. The title stays on one line, with an ellipsis fallback in very narrow windows; the established icon-only mobile navigation and accessible home-link name are preserved.

| Variant | Artwork and use |
| --- | --- |
| Full | The unchanged `public/branding/yahoo-security-logo-source.png`, including the original lettering, subtitle, chat symbol, and shield. Use on welcome/empty-state surfaces; `--brand-artwork-filter` adapts its dark lettering to Charcoal without adding a rectangular backing. |
| Compact | The detailed transparent icon with a short readable product label. Use in the window header and desktop application navigation. |
| Icon | The detailed transparent chat/security symbol for mobile navigation and small application identity areas. The simplified true-vector `favicon.svg` is intended for favicon-sized rendering. |

Favicon PNGs are supplied at 16px and 32px, with a 180px Apple touch icon. They are rendered from the authored vector; they are not renamed or embedded raster SVGs. The original source and detailed icon are raster artwork. Asset dimensions, source checksum, provenance, limitations, and the exact built-in image-generation edit prompt are documented in [ASSETS.md](client/public/branding/ASSETS.md).

Future Friends and AI Hub screens should keep the compact/icon application identity in shared navigation and retain their own section labels. Future authentication and About views can use the full variant. Application branding never replaces user/contact avatars, and the shield artwork does not indicate that multi-user E2EE is established.

Branding before/after screenshots and browser evidence are in `artifacts/branding/`.

## Appearance and adaptive themes

Open **Your profile → Appearance** to select **Light**, **Dark**, or **System**. Appearance applies immediately and is independent of profile Edit/Save/Cancel. Light retains the Yahoo lavender palette; Dark uses layered Midnight Charcoal surfaces with restrained purple accents. The selected native radio, border, icon, and text make the preference visible without relying on color alone.

`client/src/theme` owns the preference, resolved theme, update action, browser-storage helpers, and pre-hydration initialization. The root layout mounts one `ThemeProvider`. `useTheme()` exposes `preference`, `resolvedTheme`, and `setPreference`; components use semantic variables rather than branching on the active theme. The default is System. A synchronous head script resolves the theme before paint; only the root HTML attributes it changes receive hydration-warning suppression. Component markup retains normal hydration checking.

Only the non-sensitive string `light`, `dark`, or `system` is persisted under localStorage key `secubuzz-theme`. Invalid/missing values fall back to System. Blocked/full storage does not prevent in-session changes, but persistence requires available browser storage. System follows live `prefers-color-scheme` changes; explicit Light/Dark preferences take precedence. Media listeners are removed on provider cleanup. The browser's `color-scheme` and theme-color metadata follow the resolved theme.

`client/src/styles/themes.css` centralizes both palettes, including surfaces, incoming/outgoing bubbles, text, inputs, focus rings, status colors, shadows, and ambient gradients. `globals.css` owns component geometry and consumes these tokens; Tailwind's existing semantic color utilities resolve through the same variables. The theme changes colors in place without remounting messages, drafts, dialogs, or ambient elements. Dark text-reading surfaces stay still; empty conversations retain slow purple lighting. Reduced-motion preferences keep both themes static while preserving focus and state feedback.

Conversation activity timestamps use a stable initial placeholder with reserved space, then format the existing timestamp in the browser after hydration. This prevents server/client clock and locale differences from triggering hydration recovery; conversation data and activity ordering are unchanged.

Current baseline and themed screenshots, browser evidence, and motion captures are in `artifacts/charcoal-theme/`. Existing crypto, key management, transport, profile identity behavior, and security labels remain unchanged. This theme does not establish recipient key distribution or multi-user E2EE.

## Typography: Bungee × Space Grotesk

Space Grotesk is the primary interface font. Bungee defines the display hierarchy through the shared `.display-heading` class: **Messages**, **Security**, conversation titles, empty states, modal titles, profile/settings headings, and security section headings. The compact branding name, full title-bar text, and **BUZZ!** share that same Bungee family and weight declaration. The lettering embedded inside the logo artwork is unchanged.

| Role | Family / weight | Size |
| --- | --- | --- |
| Page display | Bungee 400 | Messages 24px / Security 26px; mobile 22px / 24px |
| Navigation wordmark | Bungee 400 | 16px / 15px on compact desktop widths |
| Title-bar application name | Bungee 400 | 12px |
| Navigation branding subtitle | Space Grotesk 500 | 12px |
| Conversation heading | Bungee 400 | 20px desktop / 18px mobile |
| Empty-state heading | Bungee 400 | 22px desktop / 20px mobile |
| Modal title | Bungee 400 | 20px desktop / 18px mobile |
| Profile / security section heading | Bungee 400 | 18px desktop / 16px mobile |
| Conversation name | Space Grotesk 600 | 15px |
| Message body | Space Grotesk 400 | 15px, line-height 1.6 |
| Input / composer | Space Grotesk 400 | 16px; compact search 14px |
| Navigation / button | Space Grotesk 600 | 14px |
| Caption / helper | Space Grotesk 400–500 | At least 12px |
| BUZZ label | Bungee 400 | 13px desktop / 12px mobile |

`--font-display` and `--font-body` resolve the Next.js variables from `src/app/fonts.ts`. `src/styles/typography.css` centralizes the `display`, `heading`, `body`, `label`, `caption`, `button`, and `buzz` roles; Tailwind's font families and role sizes consume the same tokens. `.display-heading` uses context modifiers for page, conversation, empty, modal, and section sizes. Legacy base/retro aliases point to these families rather than loading another font. Bungee display roles explicitly use weight 400 with synthetic styling disabled. Heading levels, accessible names, focus refs, and long-name wrapping are preserved. Navigation, sidebar conversation names, chat bodies, form/control labels (including Appearance and Avatar legends), inputs, descriptions, security explanations, system logs, errors, helper text, and regular buttons remain in Space Grotesk. Message wrapping, palette, theme state, and animation rules are preserved.

Both official, unmodified Google Fonts binaries are bundled through `next/font/local`: one Bungee Regular face and one Space Grotesk variable face covering application weights 400–700. They are preloaded once with `font-display: swap` and fallback metrics. Builds and page loads need no Google font-CDN access; the former Press Start 2P link and duplicate preconnects are removed. See the [font provenance, checksums, coverage, and OFL licenses](client/src/assets/fonts/README.md). The complete published glyph sets include Latin Extended and Vietnamese; other scripts and emoji use installed system fallbacks.

The mobile BUZZ button retains its existing action, location, and 44px minimum height. Its minimum width is 56px so the actual 12px Bungee glyphs fit without clipping. Important captions no longer fall to 9–11px. Responsive font and overflow checks, native 200% browser zoom evidence, and Light/Dark comparison screenshots are recorded in `artifacts/typography/`. Very long names retain their existing ellipsis or wrapping behavior and accessible names.

The heading consistency pass reuses those same loaded fonts; it adds no font files or font requests. Current heading screenshots and focused browser evidence are in `artifacts/heading-consistency/`.

The subsequent branding typography pass is limited to text styling and title-bar fit. Its Light/Dark desktop/mobile captures and actual-font checks are in `artifacts/brand-typography/`. Original logo artwork, font assets, heading styles, and application behavior remain intact.

## Motion conventions

- `client/src/styles/motion.css` owns reusable durations, easing curves, distances, and keyframes. The root layout imports it before global component styling; existing `--duration-*` variables and Tailwind utilities map to these tokens.

| Motion | Token | Duration |
| --- | --- | --- |
| Fast interaction | `--motion-fast` | 120ms |
| Standard / message entry | `--motion-standard` / `--motion-entry` | 200ms |
| Dialog | `--motion-dialog` | 240ms |
| Ambient fields | `--motion-ambient` / `--motion-ambient-slow` | 28s / 36s |
| Empty logo floating | `--motion-float` | 12s |
| BUZZ | `--motion-buzz` | 500ms |

- Moving lavender fields, a static fine texture, and a soft brand halo live inside **empty** conversations. The fields and surrounding shell use gradient falloff rather than animated blur. As soon as messages appear, the empty atmosphere is removed and the opaque reading surface stays still. Mobile keeps one quieter, slower empty-state field and disables shell movement and logo floating. Existing logo assets are unchanged.
- New text messages fade and move up 5px over 200ms. `useMessageEntryMotion` is presentation-only: initial/history messages, conversation remounts, prepends, previously seen IDs, and status/retry/name changes do not replay. Hidden or reduced-motion arrivals are consumed without deferring an entrance. Animation-end cleanup has a 300ms fallback, which must remain longer than the CSS entry duration.
- Conversation changes transition only the contact identity group; message history and native security disclosure nodes are not animated as a group. Unread updates replace only the displayed number. Counts capped at `99+` do not replay when their visible label stays unchanged. Selected avatars gain a decorative check while keeping the native radio control and existing validation/focus behavior.
- Sending retains the existing promise and draft behavior. Only an accepted submission shows a check mark and announces “Message submitted.” The acknowledgement clears on editing or another submission; it does not claim remote delivery.
- Navigation, local preference colors, validation feedback, and composer focus states use restrained transitions. Textarea growth remains immediate and bounded; no height animation is added while typing. BUZZ briefly shakes the chat pane by at most 3px and keeps the existing local sound/callback behavior. The button and header retain a static color cue in reduced-motion mode; no remote delivery is implied.
- Security details and System Log fade/translate in both directions using native `::details-content` transitions when supported. Closing flips the native open state immediately and makes retained content inert, excluding it from focus and accessibility until the visual exit completes. Enhancement requires `::details-content`, discrete transitions, and CSS `interactivity: inert`; unsupported browsers and reduced-motion users get instant native toggling. No height/grid animation, JavaScript state delay, or deferred unmount is used. See [CSS interactivity](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/interactivity).
- Supporting browsers give native dialogs a 240ms opacity/6px transition using `@starting-style` and discrete `display`/`overlay` transitions. Closing, focus return, and reopening are immediate; no JavaScript close delay or deferred unmount was added. Closed exit visuals ignore pointer input. Older engines retain immediate native behavior. See [native dialog animation guidance](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog#animating_dialogs).
- `prefers-reduced-motion: reduce` removes animations and transitions, including dialog backdrops and decorative effects. Check marks, status text, focus indicators, loading/disabled states, and the BUZZ color cue remain available. Hover movement is limited to fine-pointer devices with normal-motion preferences.

Current before/after captures, natural-time ambient recordings, interaction recordings, and browser evidence are in `artifacts/master-motion/`. Earlier motion evidence remains in `artifacts/motion/`. No animation library, continuous JavaScript animation loop, animated blur filter, or blanket `will-change` promotion was added to the application.

## Phase 6: Friends System

Friends adds searchable lists, public username discovery, incoming/sent requests, accept/decline/cancel, removal confirmations, block/unblock, and public profile dialogs. The existing shell, Bungee headings, Space Grotesk controls, themes, animations, and chat behavior are reused. Ava's Message action opens the existing DM without replacing its history or draft.

The current service is explicitly a **local demo**: fictional people, page-memory relationships, unknown presence, and local-only blocking. Changes reset on refresh. No real friend request is sent, and API failure never falls back to fixtures. Authenticated social endpoints, new-DM creation and group-member selection are not available in the inspected repository/teammate branch. See [service contracts and integration audit](client/src/friends/INTEGRATION.md) for the exact boundaries and remaining owner work. Browser verification evidence is stored in `artifacts/phase6/`.

## Phase 8.5: Authentication UI and sessions

Start `npm run dev` in `client`, then open `/login`. Use **Continue as Demo User** or **Try Nova Demo User** for temporary synthetic sessions. Login/Sign Up reuse existing branding and themes; Profile includes Sign Out. The protected Messenger mounts only after identity resolves, with separate profile/friends/messages/drafts/key-manager/transport instances for every session. Refresh ends the demo session. No passwords or auth tokens are persisted.

Production disables demo authentication and shows an honest unavailable-service state until an approved cookie/CSRF API is configured. API failures never activate demo data, and real accounts do not receive fictional Messenger fixtures. See the [authentication integration and database-team handoff](client/src/auth/INTEGRATION.md) for endpoints, payloads, response shapes, policy decisions, configuration, and limitations. Screenshots and browser evidence are in `artifacts/phase8-5/`.

## Phase 8.7A: Realtime client integration

Development demo sessions now use one session-owned realtime client through the existing message hook. Open **System Log → Realtime demo controls** to simulate DM/group incoming messages, typing, Ava's presence, failed sends, going offline, and reconnecting. Connected/typing/presence/delivery/read indicators explicitly describe simulated activity. Message history, unread counts, previews, drafts, and Phase 7 local actions keep using the existing application state. Refresh ends the demo session.

The separate Socket.IO client adapter uses an API-authenticated identity and a proposed cookie-session contract. It stays disabled until `NEXT_PUBLIC_REALTIME_CONTRACT_READY=true` and an approved HTTPS URL are configured alongside real authentication. No matching Socket.IO server or recipient key exchange is present in this repository. **Real message sending remains disabled**; local AES-GCM keys do not establish multi-user E2EE. Real accounts receive no demo conversations. Connection failure never selects a mock.

See the [Realtime/Kiro handoff contract](docs/realtime-client-contract.md) for event schemas, acknowledgement and retry rules, authorization, lifecycle, configuration, and missing backend/group dependencies. Validation and browser evidence are recorded in `artifacts/phase8-7a/`.
