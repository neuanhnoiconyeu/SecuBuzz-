# Yahoo! Security Messenger 2.0
## Expanded Full-Stack Development Roadmap

**Status:** Planning document only. No product implementation is authorized by this roadmap.
**Prepared:** 2026-11-03
**Primary application owner:** Frontend, application services, API integration, AI Hub and orchestration

## 1. Purpose and planning assumptions

This roadmap expands the existing Yahoo! Security Messenger into a retro-modern social messaging platform while preserving its Yahoo Messenger / Windows XP identity, Web Crypto work, BUZZ! interaction and Kiro security-agent direction. NES.css is a visual accent in the design system, not a replacement for the product identity.

It covers the application work owned by this developer: Next.js client, user experience, client state, application business rules, API integration, non-persistence application services, realtime client, AI Hub and application-level agent orchestration. It does not assign database, persistence, realtime-server or Kiro-infrastructure implementation to this owner.

Estimates below are application-owner effort for one experienced full-time developer. They exclude other teammates' work, cross-team wait time, security review, provider procurement and release operations. They are planning ranges, not commitments. One engineer-week is five working days.

## 2. Repository baseline inspected

- The client is a Next.js 14 App Router app using React 18, TypeScript 5, Tailwind CSS 3, Jest and NES.css. The `next` dependency is declared as `^14.0.0`; the current installed build reports Next.js 14.2.35.
- The current app page composes one `YahooChatWindow`. It has local demo messages, a send callback and a BUZZ callback; it is not yet connected to a real application API or realtime server.
- `client/src/utils/crypto.ts` implements Web Crypto AES-GCM key generation, encryption, decryption, and raw-key export/import. It does not by itself establish an interoperable multi-user key exchange, authenticated identity binding, secure persistent key recovery or forward secrecy.
- Jest is configured and the repository has a crypto test file. The old implementation checklist claims 70+ tests; that count is not confirmed by this inspection. Property-based testing is a stated project requirement, but `fast-check` is not currently declared.
- The `server/src` tree contains placeholders and a SQLite schema, but no server `package.json`, route implementation or agent runtime is present in this checkout. The schema and its implementation remain owned by the database teammate.
- `.kiro/specs/security.md`, `IMPLEMENTATION_CHECKLIST.md`, `README.md` and `client/DEVELOPMENT.md` describe the earlier scope. The security specification calls for ChaCha20-Poly1305 while the current utility uses AES-GCM; it also describes server-side content inspection that would conflict with true E2EE if the server never receives plaintext. These are requirements to reconcile with the security and infrastructure owners before integration, not permission to change their implementation.
- There is no implemented auth, profile, friends, conversation persistence, group, upload, AI Hub or workflow API in the inspected application.

## 3. Ownership and integration boundaries

| Area | Application owner | Teammate / service owner | Boundary |
|---|---|---|---|
| Web UI, responsive design system, accessibility | Owns design, React components, client state and browser interactions | Reviews product and accessibility decisions as agreed | Next.js UI calls typed application adapters; presentation does not own persistence. |
| Application services and BFF routes | Owns application-level composition, input parsing, authorization checks at the app boundary and routes that do not overlap existing server ownership | Realtime/server teammate owns the existing backend server and realtime transport | Agree route placement and deployment before adding a route. Do not create a second server or duplicate existing endpoints. |
| SQLite, schema, migrations, DAL/ORM, CRUD persistence, data at rest, database security logs | Consumes documented service/API contracts only | Database teammate owns all of these | Do not edit database schemas, migrations, DAL/ORM, persistence code or database configuration. |
| Realtime server and Kiro infrastructure | Owns realtime client integration, app-facing orchestration UI and application-level routing/policy composition | Existing realtime/Kiro teammate owns server transport, infrastructure and existing Kiro runtime | Use the teammate's transport, auth and agent contracts. Do not stand up competing Socket.IO or Kiro runtimes. |
| AI provider access | Owns app-level provider adapter and user-facing consent only after an approved provider contract exists | Infrastructure/security owners approve secrets, deployment, data handling and agent execution boundary | Never put provider secrets in browser code or `NEXT_PUBLIC_*`; do not send E2EE plaintext to an agent without explicit, scoped user consent and security approval. |

### Non-negotiable design and security constraints

1. Preserve working crypto utilities, keyboard send behavior, BUZZ animation/sound, and security-agent capability as the app grows.
2. A message envelope sent to another service contains ciphertext and cryptographic metadata, not plaintext. No server-side content moderation or AI summarization of E2EE plaintext is implied by the word "agent".
3. Any feature that must use plaintext (translation, summaries, smart replies, content moderation) is opt-in, clearly scoped, and reviewed for the exact client/provider boundary. The UX must disclose which text is shared and with whom.
4. Server data and external services are never represented by hard-coded fake success in production. Storybook, tests and local demo mode may use isolated fixtures labelled as fixtures.
5. API examples below are proposed contracts, not final endpoint names. They require owner agreement and versioned OpenAPI/AsyncAPI or equivalent documents before the corresponding client feature starts.

## 4. Phase sequence, dependencies and app-owner estimates

| Phase | Scope | Depends on | Complexity | App-owner estimate |
|---|---|---|---:|---:|
| 1 | Retro-modern design system | Baseline decisions and visual review | M | 1-2 weeks |
| 2 | Main messenger experience | Phase 1; conversation and realtime contracts for live data | L | 2-4 weeks |
| 3 | User and profile experience | Phase 1; auth/session and profile contracts | L | 2-4 weeks |
| 4 | Friends and social system | Phases 2-3; social and presence contracts | L | 2-4 weeks |
| 5 | Advanced private messaging | Phases 2-3; approved E2EE protocol; message/realtime contracts | XL | 3-6 weeks |
| 6 | Group chat and community | Phases 3-5; group membership, role and realtime contracts | XL | 3-6 weeks |
| 7 | AI Hub and bot marketplace | Phases 2-3; agent catalog and run contracts | L | 2-4 weeks |
| 8 | Multi-agent orchestration | Phase 7; existing Kiro runtime/tool/approval contract | XL | 4-8 weeks |
| 9 | AI social intelligence | Phases 5, 7 and 8; explicit AI data-consent design | XL | 3-6 weeks |
| 10 | AI automation and workflows | Phases 6, 8 and 9; task/poll/workflow tool contracts | XL | 4-8 weeks |
| 11 | Security and application hardening | Starts in Phase 1; release gate after all shipped work | L, continuous | 2-4 weeks plus ongoing |
| 12 | Integration and release | All selected release-scope phases and teammate contracts | L | 2-4 weeks |

The full scope is approximately **30-60 application-owner engineer-weeks**, before external-owner work and integration wait time. A practical first release should stop after the core authenticated one-to-one messaging path (Phases 1-5 plus the Phase 11 release gates) and schedule groups and AI as separately approved releases.

## Frontend and application-service responsibility by phase

| Phase | Frontend responsibility | Application-service/backend responsibility | Teammate/service responsibility |
|---|---|---|---|
| 1 | Build responsive shells, shared controls, tokens, loading/error/empty patterns and keyboard behavior. | No new backend service; establish typed API/client boundaries and design-system conventions. | Review product direction, security implications and component accessibility. |
| 2 | Build navigation, conversation list, chat, composer, unread state and reconnect feedback. | Own typed conversation API adapter, client reconciliation and only non-persistent BFF composition that does not duplicate the existing server. | Supply conversation/message persistence endpoints and realtime transport/events. |
| 3 | Build auth screens, profile forms, session states and privacy controls. | Integrate existing auth/session and profile APIs; own app-level route gating and form schemas, not credential storage or auth persistence. | Supply auth/session behavior and profile service contract. |
| 4 | Build discovery, requests, favorites, categories, block controls and presence display. | Own API adapter, request-state mapping, validation and UX orchestration; no direct writes to persistence. | Supply social graph services and privacy-filtered presence. |
| 5 | Build message actions, local encrypted search, attachment UX and crypto-state/error UX. | Own client crypto adapter, envelope parsing, API composition and non-persistent business rules; never store messages directly. | Ratify crypto protocol; transport ciphertext; own message and attachment persistence. |
| 6 | Build group, member, invitation, mention, room and moderation screens. | Own group API adapter and non-authoritative UI policy checks; never become the source of truth for role or membership. | Supply membership/role persistence, room events and group-key lifecycle. |
| 7 | Build AI Hub, agent profiles, add/invite flows, permissions and run history UI. | Own `AgentGateway` adapter and app-level capability-to-UI mapping; no competing registry/runtime. | Supply authoritative Kiro/agent registry and run APIs. |
| 8 | Build task review, approval, execution timeline, cancel/retry and error states. | Own app `AgentRouter`/`TaskDispatcher` policy composition, idempotency propagation and approval gating. | Execute tools/agents in existing Kiro infrastructure and emit authoritative run events. |
| 9 | Build smart actions, preview, consent, scope selection, memory settings and disclosure UX. | Own provider adapter, request minimization and opt-in application orchestration on the server side. | Approve provider, retention, model/data-region behavior and any persistence contract. |
| 10 | Build task/poll/workflow editor, run preview, approval and notifications UI. | Own versioned workflow request validation and orchestration through approved service interfaces; no direct task/workflow persistence. | Supply MCP tool registry and task/poll/workflow service contracts and execution. |
| 11 | Harden labels, focus, privacy/error displays, upload UX and security settings. | Harden route input/output validation, authorization integration, safe logging and secret boundaries for app-owned handlers. | Validate persistence, server authorization, transport, Kiro isolation and operational controls in their own layers. |
| 12 | Run cross-browser journeys, release UX, onboarding and user-facing docs. | Own end-to-end app integration, feature flags, deployment configuration and app rollback notes. | Provide stable contract versions, test environment, service monitoring and owner sign-off. |

## 5. Detailed phase plans

### Phase 1 - Retro-modern design system

**Goal:** Make the visual language reusable without losing Yahoo Messenger / Windows XP recognition. Use NES.css selectively for pixel controls, status, avatars and BUZZ moments; do not force every screen into the same pixel treatment.

**Application work:** Audit the current light NES prototype; define XP blue, warm gray, pixel accent, type scale, spacing, border, focus, motion and contrast tokens; establish responsive page shell, navigation, dialogs, menus, lists and empty/loading/error states; create accessible button, input, badge, avatar and container wrappers; add compact/comfortable density and reduced-motion behavior.

**Other-owner work:** No database or realtime implementation. Product/team review selects reference screens and resolves the retro visual direction.

**Deliverables:** Token sheet in Tailwind/CSS variables; component inventory; responsive app shell; Storybook or equivalent component examples only if the team accepts that dependency; design/accessibility decision log.

**Acceptance criteria:** Core components render at 320px, 768px and 1280px widths without horizontal page overflow; all controls are keyboard reachable with visible focus; automated contrast checks meet WCAG AA for normal text or have a documented exception for decorative pixel art; reduced-motion mode disables nonessential shake/transition; no repeated control style is implemented in feature pages outside the design-system layer.

### Phase 2 - Main messenger experience

**Goal:** Replace the single demo screen with the core conversation workspace.

**Application work:** Three-column desktop shell with responsive drawer/tab behavior on narrow screens; nav, conversation list, chat view and composer; local conversation selection; conversation search against permitted metadata; unread and delivery state; message virtualization only if measured volume requires it; keyboard navigation and existing Enter/Shift+Enter behavior; BUZZ event feedback.

**Other-owner work:** Realtime teammate documents conversation list, message-history, send/ack, ordering, reconnect, unread and presence semantics. Database teammate exposes read/write message services via the agreed API; no client-to-database access.

**Deliverables:** `AppShell`, `ConversationList`, `ConversationView`, `MessageList`, `MessageComposer`; API adapter; pending/offline/reconnecting/error states; event-to-view-state mapping.

**Acceptance criteria:** The UI can select a conversation, paginate its history, send once with a stable client idempotency key, reconcile a server acknowledgement, reconnect without duplicate bubbles, and display unread counts from the agreed contract; search only searches data the user is permitted to see; 320px layout remains usable without a three-column squeeze.

### Phase 3 - User and profile experience

**Goal:** Integrate existing authentication and expose user-controlled identity and privacy settings.

**Application work:** Sign-in/sign-out/expired-session screens using the existing auth mechanism; display name, nickname, avatar preview/crop, Online/Offline/Away/Busy/Invisible selection, custom status, profile edit form and privacy controls; handle unauthorized and unavailable states without leaking tokens.

**Other-owner work:** Auth owner confirms session mechanism, CSRF behavior, refresh/revocation, 2FA and account recovery. Database teammate provides profile read/update contract. Realtime teammate defines presence updates/events.

**Deliverables:** Session-aware route guard and API adapter; profile/presence pages and form validation; user-facing permission and privacy settings.

**Acceptance criteria:** Signed-out users cannot view protected conversations; expired/revoked sessions return the user to sign-in and clear client state; profile edits validate client-side and are revalidated by the service; no session or refresh token is stored in localStorage; status values are constrained to the service contract.

### Phase 4 - Friends and social system

**Goal:** Add discovery, friendship state and presence-aware navigation.

**Application work:** Search users with debounce and pagination; send/cancel/accept/reject requests; remove, block/unblock and favorite; friend categories and recent conversations; presence labels and privacy-aware availability; confirm destructive actions.

**Other-owner work:** Database teammate supplies social state services; realtime teammate supplies versioned presence events and defines whether presence is hidden for blocked/invisible users.

**Deliverables:** Search and request screens; friend list/category UI; block/favorite actions; state-machine mapping for request status and presence.

**Acceptance criteria:** Every visible action maps to an authorized API operation and shows pending/success/failure; blocked users cannot initiate new conversation according to server response; presence updates do not create duplicate users or conversations; paginated search does not expose private account fields.

### Phase 5 - Advanced private messaging

**Goal:** Turn the current local crypto demo into an interoperable private-messaging client, then add advanced message actions.

**Application work:** Before implementation, document the wire envelope, authenticated identity/key binding, key lifecycle/recovery, per-device identity, replay/idempotency behavior and supported algorithm. Keep cryptographic operations behind a typed client crypto adapter. Add quote/reply, edit/delete semantics, reactions, forward, pin, typing/read state, search and context menus in approved slices. Add encrypted file attachments, image/video previews and voice-message recording/playback only after the encrypted upload/download contract, supported media types and retention behavior are approved. Keep search over E2EE text local to the client unless an explicitly authorized privacy design says otherwise.

**Other-owner work:** Security/realtime owners ratify the protocol and test vectors; the realtime server relays ciphertext and metadata; database teammate persists envelopes/metadata under their own schema and exposes retrieval APIs. They must not receive message plaintext or private keys. Existing security-spec algorithm claims are reconciled before protocol freeze.

**Deliverables:** Versioned E2EE envelope and threat model; crypto adapter; interoperable encrypt/decrypt test vectors; message action UI; local search/index policy; encrypted attachment contract if included.

**Acceptance criteria:** Two independently initialized clients can exchange a test-vector message; the service/realtime test fixture observes only the agreed encrypted envelope; tampered ciphertext and invalid IV/key version fail closed; duplicate send/reconnect does not create duplicate messages; edit/delete distinguishes "for me" from "for everyone" and matches server semantics; read/typing metadata behavior is documented as a privacy choice; no E2EE or forward-secrecy claim ships beyond verified protocol properties.

### Phase 6 - Group chat and community

**Goal:** Add group lifecycle, roles and public-room UX after the group service and cryptographic model exist.

**Application work:** Create/rename/archive groups; group profile/avatar; invitations; admin/moderator/member UI; member removal/role management; @mentions; announcements; group media; group search and public room discovery. Group encryption UX must show membership/key changes and rekey state.

**Other-owner work:** Database teammate owns group tables, membership persistence, permissions and message storage. Realtime/Kiro teammate supplies room subscription, membership update and group event contracts. Security owner approves group key distribution and removal behavior.

**Deliverables:** Group settings/member screens; invitation flows; moderation affordances; group event subscription adapter; approved group key lifecycle integration.

**Acceptance criteria:** Unauthorized member/admin actions are rejected by the service and reflected in UI; removed members stop receiving future group envelopes according to the approved key protocol; invitation/acceptance and membership-change events converge after reconnect; @mentions resolve only within current group membership; group media never bypasses the encrypted upload rules.

### Phase 7 - AI Hub and bot marketplace

**Goal:** Provide a discoverable, permission-aware interface to existing and approved AI agents.

**Application work:** AI Hub dashboard, categories, bot cards/profiles, add/remove bot as a contact, private bot conversation, group invitation flow, configuration and per-bot permissions/history. Include SecureBot, AuditorBot, SentinelBot, BuzzGuard, TranslatorBot, ResearchBot, SummaryBot and TaskBot as catalog entries only when each has a real service contract and capability description. Preserve the existing Kiro security agents; do not create lookalike rules engines in the client.

**Other-owner work:** Kiro owner supplies registry, capabilities, version/status, auth scope, run and cancellation contracts. AI/provider owner confirms allowed models, data regions, retention, logging and secret injection.

**Deliverables:** Agent catalog UI; capability/permission manifest type; private and group bot conversation entry points; provider-agnostic `AgentGateway` adapter.

**Acceptance criteria:** Catalog entries are sourced from an authoritative registry or explicitly marked local development fixtures; an unavailable/unimplemented agent cannot appear as ready; users can inspect permissions before adding/inviting; bot history is scoped by user/group authorization; E2EE plaintext is excluded unless the user grants a specific, revocable disclosure.

### Phase 8 - Multi-agent orchestration

**Goal:** Own application-level routing and approvals while delegating agent execution and Kiro infrastructure to the existing owner.

**Application work:** Define app task types, intent-to-agent routing policy, task dispatch adapter, least-privilege permission manifest, approval queue, execution timeline, timeout/cancel/retry UX, resumable run state and safe error handling. Tool registry in the UI is a view of the authoritative server registry, not a second executable tool store.

**Other-owner work:** Kiro owner defines registry/execution/tool contracts, signed actor context, event stream, idempotency, cancellation, failure semantics, rate limits and audit responsibility. Security owner approves which tasks can execute automatically vs require human approval.

**Deliverables:** App-owned `AgentRouter`/`TaskDispatcher` policy module behind interfaces; run/approval UI; normalized agent event stream; audit correlation identifiers.

**Acceptance criteria:** Every run has actor, scope, consent/approval state, idempotency key and correlation id; disallowed tools never dispatch; high-impact actions pause for human approval; cancel and timeout have explicit terminal states; retries cannot silently duplicate side effects; client cannot fabricate registry capabilities or elevate agent permissions.

### Phase 9 - AI social intelligence

**Goal:** Add useful AI actions with clear disclosure and data minimization.

**Application work:** Smart reply, rewrite, translate, group summaries, natural-language search, opt-in memory, task extraction and decision tracking. Keep on-device/client-only transforms separate from provider calls. Provide per-feature consent, selected-message scope, preview-before-send and delete/export controls for AI memory.

**Other-owner work:** AI service owner documents model, retention, training use, region, prompt limits and failure budget. Security owner reviews E2EE disclosure boundaries. Persistence teammate owns any approved AI-history persistence contract.

**Deliverables:** Feature-level AI action menu; consent and scope UI; redaction/minimization adapter; AI history and memory settings if persistence is approved.

**Acceptance criteria:** No AI request is issued before user action/consent; payload contains only selected/approved context; UI distinguishes generated draft from sent message; memory is off by default until approved, inspectable and deletable; errors and low-confidence results do not auto-send or mutate conversation records.

### Phase 10 - AI automation and workflows

**Goal:** Let users turn approved conversation context into reviewable, bounded workflows.

**Application work:** Create tasks from messages, reminders, polls, workflow builder, MCP tool selection, multi-agent workflow composition, approval-gated execution and notifications. Expose a preview of affected objects and side effects before launch. Use allowlisted tools and scoped credentials held server-side.

**Other-owner work:** Kiro/tool owner provides MCP server registry, input/output schemas, permission scopes, side-effect classification and idempotency/cancel operations. Database teammate provides task/poll/workflow service contracts; no direct persistence from client or Next app layer.

**Deliverables:** Workflow definition UI/schema; task/poll forms; approval and run history; notification preference integration; tool catalogue adapter.

**Acceptance criteria:** Workflow schema is versioned and validated on both sides; each node has capability, scope, timeout and failure behavior; write/communication actions require preview and approval unless policy explicitly permits otherwise; secret values never reach browser state/logs; workflow runs can be cancelled and audited end-to-end.

### Phase 11 - Security and application hardening

**Goal:** Reduce application risk continuously; release only against explicit security gates.

**Application work:** Runtime schema validation at every trust boundary; route-level authorization; CSRF/session handling; safe output rendering; dependency/SCA and secret scanning; content security policy review for required AI/realtime endpoints; upload type/size validation in UI plus service-side confirmation; privacy controls; error redaction; accessible interactions; measured performance and bundle analysis; E2EE verification and key-loss UX.

**Other-owner work:** Database owner validates persistence authorization/at-rest behavior; realtime/Kiro owner validates transport auth, abuse/rate controls and agent isolation; security owner leads threat model and incident response. Client validation never substitutes for server validation.

**Deliverables:** Threat model and abuse cases; security controls matrix; SAST/SCA findings triage; security test suite; privacy/data-flow map; go/no-go checklist.

**Acceptance criteria:** No open critical/high finding without an explicit risk owner and waiver; API access-control tests cover object-level authorization; plaintext, tokens and secrets are absent from routine logs; automated and manual WCAG checks cover core journeys; rate-limit and hostile-input cases return stable errors; documented crypto interoperability/tamper tests pass; no production secret is shipped in client bundle.

### Phase 12 - Integration and release

**Goal:** Release an integrated, supportable slice with no ownership ambiguity.

**Application work:** Integrate only approved contracts; run unit, contract, integration, browser, realtime, E2EE and workflow tests; verify build and deployment configuration; prepare demo data clearly separate from real users; document setup, feature flags, known limits, support and rollback.

**Other-owner work:** Database and realtime/Kiro owners provide deployed contract versions, test environments, operational dashboards, migration/change windows and incident contacts. Each owner signs off their boundary.

**Deliverables:** Release candidate; end-to-end demo script; operator/user docs; contract/version matrix; release and rollback notes; known-issues list.

**Acceptance criteria:** Fresh environment can install/build using the committed dependency manifest; critical user journeys pass in supported browsers; service contract tests pass against the agreed environment; security and accessibility gates are signed; no critical stub/mock path is enabled in production; release/rollback owner and monitoring signals are recorded.

## 6. API and event contracts required from teammates

Endpoint and event names are illustrative. Owners should agree one versioned OpenAPI description for HTTP and AsyncAPI or an equivalent event table before client implementation.

### Common contract rules

- Versioned base path and explicit compatibility/deprecation policy.
- Opaque IDs, stable pagination cursor semantics and server timestamps; never use display names as identity.
- Common error body, correlation ID, retryability, field-level validation errors and auth/permission failure semantics.
- Idempotency key for message sends, friend requests, group mutations, agent runs and workflow side effects.
- Auth/session transport, CSRF, refresh/revocation behavior, rate limits, upload limits and maximum payload size documented.
- No database row/table contract exposed to the browser. API objects are application/domain DTOs.

### Requested HTTP service surfaces

| Contract | Example operations | Required owner details |
|---|---|---|
| Session/auth and profile | `GET /v1/me`, `PATCH /v1/me/profile`, `POST /v1/auth/logout` | Existing login/session mechanism, cookie/token handling, 2FA/recovery, profile fields, avatar limits, privacy and revocation semantics. No new auth schema is proposed here. |
| Social graph | `GET /v1/users?query=&cursor=`, `POST /v1/friend-requests`, `POST /v1/friend-requests/{id}/accept`, `POST /v1/users/{id}/block` | Request state machine, search visibility, idempotency, block semantics, favorites/categories ownership and privacy. |
| Conversations/messages | `GET /v1/conversations`, `GET /v1/conversations/{id}/messages?cursor=`, `POST /v1/conversations/{id}/messages` | Access checks, stable ordering, cursor, send ack, deduplication, ciphertext envelope/version, delivery/read semantics, retention, edit/delete and reaction behavior. |
| Groups/rooms | `POST /v1/groups`, `GET /v1/groups/{id}`, membership/role/invite operations | Role matrix, invite lifecycle, membership event ordering, room discovery privacy, archive/delete semantics, group key-version notification. |
| Attachments | `POST /v1/attachments/upload-intents`, completion/status/download-intent operations | Size/type limits, encrypted-blob transport, malware scanning boundary, expiry, authorization, deletion, signed URL handling, retention. The service validates files; browser checks are only UX. |
| AI/Kiro gateway | Registry read, `POST /v1/agent-runs`, approval, cancel, run-history/read operations | Authoritative agent/tool registry, allowed scopes, context policy, human-approval rules, event stream/replay, idempotency, cancellation, error states and retention. Kiro owner retains runtime ownership. |
| Tasks/polls/workflows | Task, poll, workflow definition/run operations | Domain ownership, access control, idempotency, side effects, scheduling/cancel semantics, notifications and persistence contract. |

### Realtime event contract

The realtime owner supplies handshake/auth and event semantics for: `message.created`, `message.acknowledged`, `conversation.updated`, `typing.changed`, `receipt.updated`, `presence.changed`, `friend_request.updated`, `group.membership_changed`, `security.alert`, and `agent_run.updated`. Every event needs a version, event ID, actor/scope, server time, replay/resume behavior and privacy rule. The client must tolerate duplicate, late and out-of-order events. Confirm Socket.IO only if that is the server's chosen transport; if it is Socket.IO, select a client version compatible with the server version.

### E2EE message envelope proposal

The security/realtime owners must ratify fields and algorithm before Phase 5. A conceptual envelope is:

```ts
type EncryptedMessageEnvelope = {
  conversationId: string;
  clientMessageId: string; // idempotency/reconciliation
  protocolVersion: string;
  algorithm: string;       // agreed by crypto review; not inferred by the server
  keyVersion: string;
  iv: string;
  ciphertext: string;
  createdAtClient?: string;
};
```

The server returns a stable message ID, server timestamp and delivery state. The final contract must also define sender/device identity binding, recipient key distribution, replay protection, group rekey, key recovery, and whether any metadata is visible to services. Never add plaintext as a convenience field.

## 7. Recommended dependencies and adoption gates

Keep existing Next.js 14, React 18, TypeScript, Tailwind, Jest, NES.css and Web Crypto API. Add one dependency only when its phase reaches the corresponding need.

| Need | Recommendation | Gate / reason |
|---|---|---|
| Reusable accessible primitives | shadcn/ui, adding selected components rather than a full visual reset | Phase 1; use only where it improves keyboard/accessibility behavior and can be styled to Yahoo/XP. It supports existing-project setup for Next.js. [Official installation docs](https://ui.shadcn.com/docs/installation) |
| Icons | `lucide-react` | Phase 1; tree-shake individual icons and give icon-only controls accessible names. [Official React guide](https://lucide.dev/guide/react/) |
| Shared HTTP validation | `zod` | Phase 3+ when DTOs are agreed; client schemas are UX and parsing, never server authorization. [Official Zod docs](https://zod.dev/) |
| Server-state cache | `@tanstack/react-query` | Phase 2 only if pagination, retries, stale state and mutation reconciliation justify it; avoid using it as an unrelated global state store. [Official overview](https://tanstack.com/query/latest/docs/framework/react/overview) |
| Realtime browser transport | `socket.io-client` only if the teammate confirms Socket.IO | Phase 2; match the server protocol/version, do not add a competing server. [Official client docs](https://socket.io/docs/v4/client-initialization/) |
| Property-based testing | `fast-check` | Phase 5 crypto/envelope invariants and Phase 8 workflow state machines; integrate with current Jest before considering a new runner. [Official introduction](https://fast-check.dev/docs/introduction/) |
| Browser journey and accessibility tests | `@playwright/test` and `@axe-core/playwright` | Phase 12; keep Jest for unit tests, add browser tooling only when the first real API journey is ready. Automated axe checks complement manual assistive-technology review. [Playwright accessibility docs](https://playwright.dev/docs/accessibility-testing) |
| AI provider SDK | None until provider, data terms and server boundary are selected | Build an app-owned adapter first. Provider SDK and credentials belong in server-side approved infrastructure, not the browser bundle. |

Do not add a global state library, upload framework, workflow engine, vector database or multiple UI kits up front. Revisit only after a measurable application need and owner review.

## 8. Testing and quality strategy

1. **Unit:** pure reducers, UI state machines, DTO parsing, API adapters, crypto envelope handling and permission gates. Preserve existing crypto round-trip/tamper tests; add property-based properties for round trips, malformed inputs, IV uniqueness invariants and message ordering where appropriate.
2. **Contract:** validate HTTP and realtime DTOs against the versioned teammate contract; include compatibility and error cases. Keep a contract fixture from the service owner, not handwritten production mocks.
3. **Integration:** browser/API auth, message send/ack/reconnect, social state, group membership, agent run/approval/cancel and upload lifecycle against test services or agreed contract test servers.
4. **End-to-end:** sign-in, discover/add friend, send/receive encrypted message, reconnect, BUZZ alert, group invite, privacy denial, approval-required tool and workflow cancel. Use isolated test accounts and no real user content.
5. **Security:** wrong-user object access, expired/revoked sessions, CSRF, payload validation, XSS rendering, rate-limit response, upload MIME/size bypass attempts, ciphertext tamper/replay, key-version mismatch, prompt/context injection and tool permission escalation.
6. **Accessibility/performance:** keyboard-only core flow, screen-reader names/announcements, zoom/reflow, contrast, reduced motion; measure actual large conversation scrolling, bundle size and realtime latency before optimizing.
7. **Release gates:** lint, type-check, unit/contract suites, production build, critical browser journeys, dependency/security review, owner contract sign-off and rollback rehearsal. AI-output quality is evaluated with deterministic criteria and safety review, not exact prose matching.

## 9. Prioritized implementation order

### Cross-team preflight (before feature coding)

1. Confirm product visual direction: Yahoo/Windows XP identity is the product anchor; NES.css remains selective. Agree a reference desktop and narrow-screen view.
2. Hold a contract workshop with the database and realtime/Kiro teammates. Assign one owner per auth, messaging, social, groups, attachment, agent and event surface.
3. Resolve the E2EE algorithm/protocol mismatch with the security owner. Define what agents may see and explicitly remove any assumed server-side plaintext scanning from the product plan unless the user chooses an opt-in plaintext path.
4. Agree versioning, error, idempotency, pagination, auth and test-environment conventions; publish contract documents.
5. Establish a baseline CI/release gate and identify the real supported deployment target.

### Recommended staged delivery

1. **Foundation:** Phase 1 design system; Phase 11 threat-model/accessibility/build gates start in parallel.
2. **Core shell:** Phase 2 UI with fixture data only in explicitly labelled local/demo mode, then connect after API/event contracts are available.
3. **Identity:** Phase 3 existing authentication/profile; do not add a second auth stack.
4. **Private core:** Phase 4 basic discovery/friends and Phase 5 verified one-to-one E2EE send/receive. Ship an internal MVP only after service interop and security gates pass.
5. **Community:** Phase 6 groups after membership authorization and group-key lifecycle are validated.
6. **Agent access:** Phase 7 catalog and permissions; then Phase 8 execution/approval orchestration against the existing Kiro runtime.
7. **AI features:** Phase 9 consent-scoped intelligence; Phase 10 bounded workflows after side-effect contracts exist.
8. **Release:** Phase 11 final hardening and Phase 12 release against the selected scope. Groups and AI can be deferred without blocking a secure one-to-one MVP.

## 10. Planning decision log

- This document does not authorize implementation. Start coding a roadmap phase only after the user approves that phase and its scope.
- Existing database schema/configuration and persistence implementation remain owned by the database teammate and are out of scope for application-owner changes.
- Existing realtime server and Kiro infrastructure remain owned by their teammate; this roadmap owns the client integration and application orchestration surface only.
- API names, DTOs and agent capabilities in this document are proposals pending owner review.
- The cryptographic algorithm and key lifecycle are not declared production-ready by this plan. Current AES-GCM utility is a useful primitive, not a complete multi-user E2EE protocol.
- The existing single-page UI, local demo data and `onSendMessage` callback are not represented as a production backend.
