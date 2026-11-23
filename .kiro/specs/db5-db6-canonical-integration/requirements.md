# Requirements Document

## Introduction

This document specifies the canonical integration of DB-5 (Group Chat) and DB-6 (File Sharing) into DATA, the single authoritative persistence layer of SecuBuzz. It replaces the plan to adopt the teammate's standalone implementation (server/api-main.cjs, started by npm run start:api with the default API_PORT 3001, with its own SQLite file and legacy tables). Reusable parts of that implementation are ported into DATA and verified against the canonical schema.

This is phase DB-0/DB-5A. It is a specification only. No source file, migration or database is changed by this document.

### Baseline

- Verified on 2026-11-20: branch chuong-data fast-forwarded from 730e819 to d7cd40a (equal to origin/main after PR #18 merged). The stash and untracked client artifacts are preserved.
- The DATA test suite passes 321 of 321 tests. The Phase 8.8 files are present.
- Migrations 0001 to 0007 exist in DATA/server/database/migrations. The next migration number is 0008.
- Roadmap coverage of the standalone implementation measured by the audit: DB-5 about 64.7 percent (11 of 17 items, 1 unverified); DB-6 about 63.3 percent (9.5 of 15 items). Findings are cited as AF-01 to AF-26 in the Audit Finding Traceability section.
- Reconciled after PR #19 (the Docker development environment): the local branch is fast-forwarded to origin/main dc6c997 (DK-02). PR #19 changed no DATA, server/src, shared, client/src or migration file, so the functional baseline pinned by tests and git gates stays d7cd40a.

### Approved principles

1. Canonical DATA is the single authoritative persistence layer.
2. Conversations, ConversationMembers, Messages and Attachments are reused wherever appropriate.
3. Every schema extension uses the versioned migration runner of DATA.
4. One authenticated application runtime serves all APIs.
5. The existing session and request-validation infrastructure (CSRF, Origin, rate limit) is reused.
6. Incomplete group messaging and file sharing are not enabled for real accounts.
7. Working Phase 8.8 end-to-end encrypted direct messaging is preserved.
8. Valid teammate implementations and tests are reused.
9. Existing DATA records stay backward compatible.
10. Explicit acceptance gates precede enabling each new function.

### Ownership

- Kiro owns database and backend work (DATA, and backend integration in server/ where a phase names it).
- Codex owns frontend work (client/).
- The Project_Owner decides every product policy and approves every acceptance gate. This document records unresolved product policies as OD-nn items and never invents them.

### Phase map

| Phase | Scope |
| --- | --- |
| DB-5B | Group schema, migrations, repositories |
| DB-5C | Group management, membership, roles, invitations |
| DB-5D | Protected group messaging integration and independent security review |
| DB-5E | Realtime integration |
| DB-5F | Frontend |
| DB-5G | Final acceptance of DB-5 |
| DB-6A | Canonical attachment architecture |
| DB-6B | Storage, metadata, migrations |
| DB-6C | Protected attachment integration and security review |
| DB-6D | Message association and lifecycle |
| DB-6E | Frontend |
| DB-6F | Final acceptance of DB-6 |
| DB-7 | Combined regression and publication |

### Conventions

- Every requirement carries an ID in its heading and a metadata block. The Origin line is ORIGINAL when the requirement comes from a roadmap line (named in the block) and PROPOSED when an audit finding or this specification motivates the requirement.
- Criteria that depend on an unresolved decision cite the OD-nn item. Each such criterion defines a provisional behavior that grants the least access, so the system is safe while the decision is open.
- The words "group owner", "admin" and "member" denote roles. The words "Project_Owner" and "owner decision" denote the human decision maker.
- HTTP paths are stated as in the roadmap. Request and response field names use camelCase, as the existing DATA projections do.

## Glossary

- **Project_Owner**: The human owner of the SecuBuzz project who decides product policy and approves gates.
- **Project_Team**: The contributors who implement this work under the Project_Owner: Kiro for database and backend, Codex for frontend.
- **DATA_Application**: The single authenticated Express application created by createApp in DATA/server/app.js and started by npm run start:data.
- **Canonical_DATA**: The DATA SQLite database, its ordered migrations in DATA/server/database/migrations, its repositories and its services.
- **Standalone_Implementation**: The teammate's DB-5 and DB-6 code, namely server/api-main.cjs, its own SQLite file, its legacy tables, its routes, its attachment storage and its tests.
- **Migration_Runner**: The module DATA/server/database/migrate.js that applies ordered SQL migrations in one transaction and records version, name and checksum in SchemaMigrations.
- **Schema_Migration**: A SQL file numbered 0008 or higher that this work adds to DATA/server/database/migrations.
- **Auth_Layer**: The existing DATA session authentication, CSRF proof verification, Origin check (requestAllowed) and injected rate limiter.
- **Group_Conversation**: A Conversations row with kind group and origin authenticated.
- **Direct_Conversation**: A Conversations row with kind direct.
- **Active_Member**: A ConversationMembers row whose left_at is NULL.
- **Group_Extension_Record**: An additive Canonical_DATA record keyed by conversation_id that stores group data absent from Conversations, such as description, history policy and membership revision.
- **Membership_Revision**: A per-group integer that increases on every join, leave, removal and role change.
- **Membership_Interval**: One continuous period in which a user is an Active_Member of a group, bounded by message sequence numbers.
- **History_Policy**: The group setting that determines which earlier messages a member may read.
- **Invitation**: A record that offers a user membership in a group and has the states pending, accepted, declined, cancelled and expired.
- **Read_Position**: The highest message sequence number that a member has reported as read in a group.
- **Group_API**: The HTTP routes under /api/groups.
- **Group_Service**: The DATA service layer that applies group rules. The service follows the pattern of the existing social and conversation services.
- **Group_Repository**: The DATA repository functions for groups, in the style of DATA/server/database/repositories.js.
- **Message_Service**: The DATA shared message-write and history service in DATA/server/messaging/service.js, as generalized by this work to group conversations.
- **Protected_Content**: Ciphertext and encrypted metadata produced by the client under the existing end-to-end encryption design. The server treats Protected_Content as opaque.
- **Attachment_API**: The HTTP routes under /api/attachments and /api/files.
- **Attachment_Service**: The DATA service layer that applies attachment rules.
- **Storage_Provider**: The interface through which the Attachment_Service stores and reads attachment bytes outside SQLite.
- **Storage_Key**: The opaque, server-generated identifier that addresses stored bytes (Attachments.storage_key).
- **Retention_Job**: The scheduled task inside the DATA_Application that cleans abandoned uploads and applies retention rules.
- **Feature_Gate**: The server-side and client-side switches that enable group APIs, group messaging and attachment APIs, together with the evidence required to enable each switch.
- **Gate_Record**: A dated record in the handoff documentation that names the evidence for one gate and the Project_Owner approval.
- **Real_Account**: An account created through DATA authentication for actual use, as opposed to an account inside an isolated test database.
- **Realtime_Bridge**: The realtime server integration in server/src/data/authorizer.ts and its callers.
- **Group_Client**: The frontend code in client/ that presents groups and attachments.
- **Verification_Suite**: The node:test tests in DATA/tests/*.test.js with their helpers in DATA/tests/support, executed by the existing DATA test command.
- **Documentation_Set**: The documents under DATA/docs that this work adds or updates.
- **Docker_Environment**: The INFRA-01 development environment defined by compose.yaml at the repository root, with exactly two services: the backend, which runs npm --prefix server run start:data, and the frontend, which runs the Next.js development server. Its database is DB_PATH=/var/lib/secubuzz/sqlite/database.sqlite on the named volume sqlite-data, and its reserved attachment storage directory is ATTACHMENT_STORAGE_DIR=/var/lib/secubuzz/attachments on a separate named volume. The guide is docs/docker-development.md.
- **Validation_Runner**: The Linux image built from docker/validation.Dockerfile and run without network as node docker/validate.cjs followed by one group name (client, server, data or browser).
- **Disposable_Project**: A Docker Compose project with a unique name, its own volumes and no published ports, created for one test and removed afterwards.
- **Known_Baseline_Failure**: A test that fails at the baseline on a named platform, recorded by test name and platform.

## Requirements

### Requirement 1: Group creation [DB5-R01]

**User Story:** As an authenticated user, I want to create a group conversation, so that I can chat with several people in one persistent space.

- **ID**: DB5-R01
- **Origin**: ORIGINAL (DB-5 checklist "POST /api/groups"); PROPOSED for the client-retry idempotency criterion (AF-11 hardening); PROPOSED for the historyPolicy field of criteria 7, 10, 14 and 15 (OD-05 decided in the DB-5A reconciliation)
- **Roadmap reference**: DB-5 checklist: POST /api/groups; DB-5 Goal: persist groups
- **Audit findings**: AF-01, AF-02, AF-11
- **Dependencies**: DB5-R12, DB5-R13, DB5-R14, ARCH-R01
- **Implementation phase**: DB-5B, DB-5C

#### Acceptance Criteria

1. WHEN an authenticated user submits POST /api/groups with a request that none of criteria 5 to 7, 9, 12 and 15 rejects and that neither criterion 10 nor criterion 11 answers, THE Group_API SHALL create one Group_Conversation and respond 201 with the group projection of DB5-R02 criterion 2.
2. WHEN a group is created, THE Group_Service SHALL insert the Conversations row, the creator's ConversationMembers row with role owner, the Group_Extension_Record and the audit record of DB5-R12 criterion 8 in one BEGIN IMMEDIATE transaction, so that a failure leaves none of the four.
3. WHEN a group is created, THE Group_Service SHALL make the creator the only Active_Member and the only active owner.
4. THE Group_Service SHALL trim leading and trailing whitespace from the name and SHALL accept names of 1 to 100 Unicode code points after trimming.
5. IF the name is missing, is not a string, or is empty or longer than 100 code points after trimming, THEN THE Group_API SHALL respond 400 VALIDATION_ERROR with the field name in the fields list and SHALL create no record.
6. IF a supplied description is neither a string of at most 1000 code points nor null, THEN THE Group_API SHALL respond 400 VALIDATION_ERROR with the field description in the fields list.
7. IF the request body is absent, empty or not a JSON object, or contains a field other than name, description, historyPolicy and the idempotency key, THEN THE Group_API SHALL respond 400 VALIDATION_ERROR, SHALL create no record and SHALL NOT respond 500.
8. IF the session is missing, expired or revoked, THEN THE Group_API SHALL respond with the existing unauthenticated response of the Auth_Layer before validating the body.
9. IF the CSRF proof is missing or not bound to the session, THEN THE Group_API SHALL respond 403 CSRF_INVALID and SHALL create no record.
10. WHERE the client supplies an idempotency key, WHEN the same user repeats POST /api/groups with the same key within 24 hours after the creating request and with the same trimmed name, description and History_Policy (an omitted historyPolicy counts as from_joined), THE Group_Service SHALL return the originally created group with status 200 and SHALL create no second group.
11. WHERE the client supplies an idempotency key, IF the same user repeats the key within 24 hours with a different payload, THEN THE Group_API SHALL respond 409 IDEMPOTENCY_CONFLICT and SHALL change no record.
12. WHERE the client supplies an idempotency key, IF the key is not a string of 1 to 256 characters, THEN THE Group_API SHALL respond 400 VALIDATION_ERROR and SHALL create no record.
13. WHERE the client supplies an idempotency key, WHEN two requests of one user with the same key run concurrently, THE Group_Service SHALL create exactly one group and SHALL answer the other request as criterion 10 or 11 defines.
14. WHEN a group is created, THE Group_Service SHALL store in the Group_Extension_Record a Membership_Revision of 1, a description of null if none is supplied and a History_Policy equal to the supplied historyPolicy or, if none is supplied, equal to from_joined (OD-05 decided: the values are exactly all and from_joined, the default is from_joined).
15. IF a supplied historyPolicy (a null value counts as supplied) is not the string all and not the string from_joined as an exact, case-sensitive match, THEN THE Group_API SHALL respond 400 VALIDATION_ERROR with historyPolicy in the fields list and SHALL create no record.

### Requirement 2: Group metadata, retrieval and listing [DB5-R02]

**User Story:** As a group member, I want to read and (when permitted) change group details and list my groups, so that I can find and manage my conversations.

- **ID**: DB5-R02
- **Origin**: ORIGINAL (DB-5 checklist "GET /api/groups/:id", "PATCH /api/groups/:id"); PROPOSED for member-only paged listing (AF-02, AF-13)
- **Roadmap reference**: DB-5 checklist: GET /api/groups/:id; PATCH /api/groups/:id; DB-5 DoD: only authorized members can view permitted history and perform actions
- **Audit findings**: AF-02, AF-13
- **Dependencies**: DB5-R01, DB5-R06, DB5-R08, DB5-R12
- **Implementation phase**: DB-5B, DB-5C
- **Note**: The refusal of historyPolicy in PATCH /api/groups/:id (criteria 10 and 13) is an owner consequence derived from OD-05; confirmed at the DB-5C API contract approval.

#### Acceptance Criteria

1. THE Group_Service SHALL store the group name in Conversations.title and SHALL store the description, the History_Policy and the Membership_Revision only in the Group_Extension_Record.
2. WHEN an Active_Member submits GET /api/groups/:id, THE Group_API SHALL respond 200 with the group identifier, name, description, History_Policy, Membership_Revision, archived state, creation time, last update time (Conversations.updated_at), active member count and the role of the requester.
3. IF a GET or PATCH /api/groups/:id request names a group that does not exist, a group of which the requester is not an Active_Member, or a Direct_Conversation, THEN THE Group_API SHALL respond with the same 404 NOT_FOUND status, code and fields list in all three cases.
4. WHEN an authenticated user submits GET /api/groups, THE Group_API SHALL return only Group_Conversations of which the requester is an Active_Member, archived ones included, each with the fields of criterion 2, ordered by last update time descending and then by group identifier descending.
5. THE Group_API SHALL page GET /api/groups with the bounds of the existing conversation listing (limit a decimal integer 1 to 50, default 20; cursor a base64url string of at most 2048 characters bound to the requesting user and to this route) and SHALL return no next cursor on the last page.
6. IF a cursor is longer than 2048 characters, is not base64url, does not decode to the cursor structure of GET /api/groups, or was issued to another user, THEN THE Group_API SHALL respond 400 VALIDATION_ERROR with cursor in the fields list.
7. IF a query parameter other than limit and cursor is present, or limit is not a decimal integer from 1 to 50, THEN THE Group_API SHALL respond 400 VALIDATION_ERROR with the parameter name in the fields list.
8. THE Group_API SHALL NOT include any Group_Conversation in the response of GET /api/conversations or of any other existing direct-message endpoint.
9. WHEN the group owner submits PATCH /api/groups/:id with a valid name or description (criterion 14), THE Group_Service SHALL update the stored values and the last update time in one transaction and SHALL respond 200 with the updated group.
10. IF a PATCH /api/groups/:id request body is missing, is not a JSON object, contains none of the fields name, description and historyPolicy (criterion 13 refuses historyPolicy), or contains a field other than name, description, historyPolicy and the Membership_Revision precondition, THEN THE Group_API SHALL respond 400 VALIDATION_ERROR.
11. IF a requester who is an Active_Member but not the group owner submits PATCH /api/groups/:id, THEN THE Group_API SHALL respond 403 FORBIDDEN and SHALL change no record.
12. WHERE the PATCH request carries a Membership_Revision precondition, IF it differs from the stored Membership_Revision, THEN THE Group_API SHALL respond 409 STALE_STATE and SHALL change no record.
13. IF a PATCH /api/groups/:id request contains the field historyPolicy with any value, including the stored History_Policy value, THEN THE Group_API SHALL respond 400 VALIDATION_ERROR with historyPolicy in the fields list and SHALL change no record (OD-05 decided: the History_Policy is chosen at group creation and is immutable afterwards).
14. IF the group owner submits PATCH /api/groups/:id with a name or description that violates DB5-R01 criteria 4 to 6, THEN THE Group_API SHALL respond 400 VALIDATION_ERROR with the field name in the fields list and SHALL change no record.
15. IF a PATCH request fails more than one check, THEN THE Group_API SHALL respond for the first failing check in this order: the checks of DB5-R12, criteria 3 and 11, the archived-group refusal of DB5-R07 criterion 2, criteria 10 and 14, criterion 13, criterion 12.

### Requirement 3: Group membership view and direct add [DB5-R03]

**User Story:** As a group member, I want to see who is in my group, and as an owner or admin I want to add people, so that the group reflects its real participants.

- **ID**: DB5-R03
- **Origin**: ORIGINAL (DB-5 checklist "GET /api/groups/:id/members", "POST /api/groups/:id/members"); PROPOSED for consent, block and elevation controls (AF-06)
- **Roadmap reference**: DB-5 checklist: GET /api/groups/:id/members; POST /api/groups/:id/members; owner/admin/member rules
- **Audit findings**: AF-06
- **Dependencies**: DB5-R01, DB5-R04, DB5-R06, DB5-R08, DB5-R12
- **Implementation phase**: DB-5C

#### Acceptance Criteria

1. WHEN an Active_Member submits GET /api/groups/:id/members, THE Group_API SHALL return the Active_Members with user identifier, username, display name, avatar, role and the joined time of the current Membership_Interval, ordered by joined time and then user identifier, ascending, and paged as DB5-R02 criteria 5 to 7 specify.
2. WHERE the requester is a group owner or admin and the request sets the documented former-members query parameter, THE Group_API SHALL also return former members, each with the time the user left or was removed.
3. IF the group does not exist, the requester is not an Active_Member, or the identifier belongs to a Direct_Conversation, THEN THE Group_API SHALL answer GET and POST /api/groups/:id/members with the identical 404 NOT_FOUND response of DB5-R02 criterion 3.
4. THE Group_API SHALL NOT return e-mail addresses, session data, device keys or credential data of any member in a response to GET or POST /api/groups/:id/members.
5. WHERE direct add is enabled by a later Project_Owner decision that replaces the decided part of OD-01, WHEN an owner or admin submits POST /api/groups/:id/members for an existing user whose account is not disabled and whose credential is enabled, THE Group_Service SHALL add that user as an Active_Member with the role member and respond 201 with the member entry of criterion 1.
6. WHILE direct add is not enabled (Project_Owner decision OD-01, decided in part, keeps direct add disabled so that membership starts only through an accepted Invitation), IF a POST /api/groups/:id/members request passes the Auth_Layer, THEN THE Group_API SHALL respond 503 FEATURE_UNAVAILABLE and SHALL change no record.
7. IF the POST body is missing, is not a JSON object, lacks a valid target user identifier or contains any other field, including a role field, THEN THE Group_API SHALL respond 400 VALIDATION_ERROR naming the fields and SHALL change no record.
8. IF a block exists in either direction between the actor and the target user, THEN THE Group_Service SHALL refuse the addition with the response of criterion 9 and SHALL change no record.
9. IF the target user does not exist, is a legacy user without an enabled credential, or has a disabled account, THEN THE Group_Service SHALL respond 404 NOT_FOUND, identical in all three cases, and SHALL change no record.
10. IF the actor is an Active_Member with the role member, THEN THE Group_API SHALL respond 403 FORBIDDEN and SHALL change no record.
11. IF the target is already an Active_Member, THEN THE Group_API SHALL respond 409 CONFLICT and SHALL change no record.
12. IF the Active_Member count of a group equals or exceeds the maximum of 50 Active_Members per group (Project_Owner decision OD-04, decided; the maximum is supplied as a configuration value and is fail-closed when unset as DB5-R16 criterion 7 specifies), THEN THE Group_Service SHALL refuse every operation that would add an Active_Member with 409 CONFLICT and SHALL change no record.
13. WHEN a user whose ConversationMembers row has left_at set is added, THE Group_Service SHALL reuse that row, clear left_at, set the role member, open a new Membership_Interval under DB5-R08 criterion 4 and apply DB5-R08 to determine visible history.
14. WHEN a user becomes an Active_Member, THE Group_Service SHALL increase the Membership_Revision by exactly 1 and SHALL write one audit event as DB5-R12 criterion 8 specifies, in the same transaction as the membership change.
15. IF a requester with the role member sets the former-members query parameter, THEN THE Group_API SHALL respond 403 FORBIDDEN and SHALL return no member data.
16. WHEN concurrent POST requests for one group would add the same user twice or together exceed the OD-04 maximum, THE Group_Service SHALL commit only the requests that fit, at most one per target user, and SHALL refuse each other request with 409 CONFLICT.
17. IF several refusal conditions of criteria 3 and 6 to 12 apply to one POST request, THEN THE Group_API SHALL respond for the first one in the order of criteria 6, 3, 10, 7, 9, 8, 11, 12.

### Requirement 4: Invitation lifecycle [DB5-R04]

**User Story:** As an owner or admin, I want to invite users and have them accept, so that nobody joins a group without consent and stale invitations cannot corrupt a group.

- **ID**: DB5-R04
- **Origin**: ORIGINAL (DB-5 checklist "member invitations"; DATA docs db1-handoff.md:119-120 and repositories.md:75-76 require DB-5 to define invitation rules); PROPOSED for the re-validation, uniqueness and cancellation rules (AF-03, AF-04, AF-05)
- **Roadmap reference**: DB-5 checklist: define member invitations
- **Audit findings**: AF-03, AF-04, AF-05, AF-06
- **Dependencies**: DB5-R01, DB5-R03, DB5-R05, DB5-R06, DB5-R12, DB5-R14
- **Implementation phase**: DB-5B, DB-5C

#### Acceptance Criteria

1. WHEN a group owner or admin submits an invitation request for an existing active credential-enabled user, THE Group_Service SHALL create a pending Invitation that records group, invitee, inviter, creation time and an expiry time equal to the creation time plus 604,800 seconds (7 days, the expiry duration decided in OD-08), and SHALL respond 201.
2. THE Schema_Migration files SHALL define a database constraint that rejects a second pending Invitation row for the same group and invitee.
3. IF an unexpired pending Invitation already exists for the group and invitee, THEN THE Group_API SHALL respond 409 CONFLICT and SHALL create no second Invitation.
4. IF a block exists in either direction between inviter and invitee, or the invitee is unknown, disabled or without an enabled credential, THEN THE Group_Service SHALL refuse the Invitation with the response of DB5-R03 criterion 9 for an unknown user, without revealing a block.
5. IF the invitee is already an Active_Member, THEN THE Group_API SHALL respond 409 CONFLICT and SHALL create no Invitation.
6. WHEN an authenticated user lists own Invitations, THE Group_API SHALL return only the pending Invitations addressed to that user whose expiry time is later than the server time, showing group name and inviter display name and no member list or message data.
7. WHILE an Invitation is pending, THE Group_Service SHALL treat the invitee as a non-member for every read and write operation of the group.
8. WHEN the invitee accepts a pending Invitation, THE Group_Service SHALL, inside one BEGIN IMMEDIATE transaction, re-validate that the Invitation is unexpired, that the group exists and is not archived, that the inviter is still an Active_Member with a role that DB5-R06 permits to invite, that no block exists between inviter and invitee, that acceptance would not exceed the OD-04 maximum of Active_Members, and that the invitee was not removed after the Invitation was created.
9. IF a re-validation of criterion 8 fails, THEN THE Group_Service SHALL set the Invitation to expired if its expiry time has passed and otherwise to cancelled, SHALL change no membership and SHALL respond 409 CONFLICT.
10. IF the invitee is already an Active_Member when accepting, THEN THE Group_Service SHALL NOT change the role, joined time or left time of that member, SHALL set the Invitation to cancelled and SHALL respond 409 CONFLICT.
11. WHEN an acceptance by a non-member passes the re-validation of criterion 8, THE Group_Service SHALL, in the same transaction, set the Invitation to accepted, create or reactivate the membership with the role member, open a new Membership_Interval, increase the Membership_Revision and respond 200.
12. WHEN a member is removed or leaves a group, THE Group_Service SHALL cancel, in the same transaction, every pending Invitation for the group that is addressed to or issued by that user.
13. WHEN the invitee declines a pending Invitation, THE Group_Service SHALL set the state declined, SHALL change no membership and SHALL respond 204.
14. WHEN the inviter, the group owner or an admin cancels a pending Invitation, THE Group_Service SHALL set the state cancelled and SHALL respond 204.
15. IF the server time is at or after the expiry time of a pending Invitation, THEN THE Group_Service SHALL treat the Invitation as expired without waiting for a background job, so that acceptance and decline respond 409 CONFLICT and a new Invitation for the same group and invitee is permitted.
16. IF a user other than the invitee submits an accept or decline request, or the Invitation does not exist, THEN THE Group_API SHALL respond with an identical 404 NOT_FOUND in both cases and SHALL change no record.
17. THE Group_Service SHALL allow only the transitions from pending to accepted, declined, cancelled and expired, and SHALL NOT change the state of an Invitation after it leaves pending.
18. WHILE a test-injected configuration leaves the maximum pending Invitations per group or the maximum pending Invitations per invitee of the Project_Owner decision OD-08 unset or not a positive whole number, THE Group_Service SHALL respond 503 FEATURE_UNAVAILABLE to an invitation request and SHALL change no record (OD-08: both maxima are unresolved with no default, and a real configuration that leaves either maximum unset stops the DATA_Application before it accepts any request while the Group_API switch is enabled, per DB5-R16 criterion 7; any re-invite delay after a decline is unresolved with no default and no setting).
19. IF the group, or the invitee across all groups, has reached its configured maximum of unexpired pending Invitations, THEN THE Group_API SHALL respond 409 CONFLICT and SHALL create no Invitation.
20. WHEN two identical invitation requests for one group and invitee run concurrently, THE Group_Service SHALL create exactly one Invitation and respond 409 CONFLICT to the other request.
21. IF a user who is not permitted by criterion 1 or 14 submits an invitation or cancel request, THEN THE Group_API SHALL respond 403 FORBIDDEN to an Active_Member and 404 NOT_FOUND to any other user, and SHALL change no record.
22. IF an authorized accept, decline or cancel request finds the Invitation no longer pending when the transaction reads it, including after a concurrent request committed first, THEN THE Group_Service SHALL respond 409 CONFLICT and SHALL change no record.

### Requirement 5: Membership removal and leaving [DB5-R05]

**User Story:** As a group owner or admin, I want to remove members, and as a member I want to leave, so that membership reflects current participation and removed users lose access at once.

- **ID**: DB5-R05
- **Origin**: ORIGINAL (DB-5 checklist "DELETE /api/groups/:id/members/:userId", "POST /api/groups/:id/leave", "removed-member behavior")
- **Roadmap reference**: DB-5 checklist: DELETE /api/groups/:id/members/:userId; POST /api/groups/:id/leave; removed-member behavior
- **Audit findings**: AF-03, AF-14, AF-21, AF-24
- **Dependencies**: DB5-R04, DB5-R06, DB5-R08, DB5-R12
- **Implementation phase**: DB-5C, DB-5E

#### Acceptance Criteria

1. WHEN a group owner submits DELETE /api/groups/:id/members/:userId for an Active_Member with the role admin or member, THE Group_Service SHALL set left_at on the membership row to the server time, close the Membership_Interval and respond 204.
2. WHEN an admin submits a removal request for an Active_Member with the role member, THE Group_Service SHALL remove that member as in criterion 1 and respond 204.
3. IF an admin submits a removal request for an Active_Member with the role admin or owner, THEN THE Group_API SHALL respond 403 FORBIDDEN and SHALL change no record.
4. IF the group owner submits a removal request for a user with the role owner, THEN THE Group_API SHALL respond 409 CONFLICT and SHALL change no record.
5. IF the requester is the group owner or an admin and the target of a removal request is not an Active_Member, THEN THE Group_API SHALL respond 404 NOT_FOUND and SHALL change no record.
6. WHEN an Active_Member without the owner role submits POST /api/groups/:id/leave, THE Group_Service SHALL set left_at, close the Membership_Interval and respond 204 as in criterion 1.
7. WHILE the Project_Owner decision OD-10 is unresolved, IF the group owner submits POST /api/groups/:id/leave, THEN THE Group_API SHALL respond 409 CONFLICT and SHALL change no record.
8. WHEN a removal or leave commits, THE Group_Service SHALL deny that user, for every request that starts after the commit, group metadata, member list, message history, message submission, receipts, read state, and attachment metadata, upload and download (including files that user uploaded), with the 404 NOT_FOUND response of DB5-R02 criterion 3.
9. WHEN a removal or leave commits, THE Group_Service SHALL retain the ConversationMembers row so that historical sender, receipt and attachment references stay valid.
10. WHEN a removal or leave commits, THE Group_Service SHALL, in the same transaction, increase the Membership_Revision by 1, close the Membership_Interval at the highest message sequence of the group (empty when the group has no message) and write the audit record of DB5-R12 criterion 8.
11. WHEN a removal or leave commits, THE Realtime_Bridge SHALL remove that user's subscriptions to the group on every connection before delivering the next event, SHALL refuse a new subscription and SHALL NOT deliver to that user any event committed after the removal.
12. THE Group_Service SHALL read the actor role, the target role and the target membership state inside the write transaction, so that the decision uses the values committed at that moment.
13. THE Group_Service SHALL make the Membership_Revision readable by the protected messaging design of DB-5D, with a value strictly greater after each removal or leave than before, and SHALL define no cryptographic behavior.
14. IF any write of a removal or leave fails, THEN THE Group_Service SHALL roll back every write of that operation, including the Invitation cancellations of DB5-R04 criterion 12.
15. IF the requester of a removal or leave is not an Active_Member of the group, THEN THE Group_API SHALL respond with the 404 NOT_FOUND response of DB5-R02 criterion 3 and SHALL change no record.
16. IF a removal request comes from an Active_Member with the role member, THEN THE Group_API SHALL respond 403 FORBIDDEN and SHALL change no record.
17. WHEN two requests remove or leave the same user concurrently, THE Group_Service SHALL commit one with 204, respond 404 NOT_FOUND to the other and increase the Membership_Revision once.

### Requirement 6: Role management and ownership transfer [DB5-R06]

**User Story:** As a group owner, I want to promote and demote admins and transfer ownership, so that group control can change hands without ever leaving the group ownerless.

- **ID**: DB5-R06
- **Origin**: ORIGINAL (DB-5 checklist "define owner/admin/member rules" and "owner transfer"); PROPOSED for the role-change endpoint (AF-07) and stale-request safety (AF-04)
- **Roadmap reference**: DB-5 checklist: define owner/admin/member rules; owner transfer
- **Audit findings**: AF-04, AF-06, AF-07
- **Dependencies**: DB5-R01, DB5-R05, DB5-R12, DB5-R14
- **Implementation phase**: DB-5B, DB-5C

#### Acceptance Criteria

1. THE Group_Service SHALL permit only the roles owner, admin and member and SHALL store the role in ConversationMembers.role.
2. THE Group_Service SHALL keep exactly one Active_Member with the role owner for every Group_Conversation after every committed transaction.
3. WHEN the group owner submits a role-change request for an Active_Member who is not the owner, naming the role admin or member that the member does not already hold, THE Group_Service SHALL update the role, increase the Membership_Revision by one and write an audit event in one transaction.
4. IF a role-change request names no role, or names any role other than admin or member (including owner), THEN THE Group_API SHALL respond 400 VALIDATION_ERROR with the field role in the fields list and SHALL change no record.
5. IF a role-change request targets the group owner, including the owner's own membership, THEN THE Group_API SHALL respond 409 CONFLICT and SHALL change no record.
6. IF an admin or a member submits a role-change request, THEN THE Group_API SHALL respond 403 FORBIDDEN and SHALL change no record, so that no admin can elevate any user, including the role of that admin.
7. WHEN the group owner submits POST /api/groups/:id/transfer for another Active_Member, THE Group_Service SHALL demote the current owner, promote the target, increase the Membership_Revision by one and write an audit event in one BEGIN IMMEDIATE transaction, so that no committed state has zero owners or two owners.
8. WHEN an ownership transfer is applied under criterion 7, THE Group_Service SHALL set the former owner to the role admin in the same transaction, unless the Project_Owner decision OD-03 selects another role.
9. IF the transfer target is missing, is not an Active_Member of the group, or is the requester, THEN THE Group_API SHALL respond 400 VALIDATION_ERROR and SHALL change no record.
10. IF the requester is an Active_Member without the role owner when the write transaction reads the membership, THEN THE Group_Service SHALL respond 403 FORBIDDEN and SHALL change no record, so that a stale request from a former owner has no effect.
11. WHEN two ownership transfers for one group run concurrently, THE Group_Service SHALL commit exactly one and refuse the other with 403 FORBIDDEN.
12. WHERE a role-change or transfer request carries a Membership_Revision precondition, IF the precondition value differs from the revision that the write transaction reads, THEN THE Group_API SHALL respond 409 STALE_STATE and SHALL change no record.
13. THE Group_Service SHALL apply the role permission matrix of the table below, and SHALL apply each entry marked with an OD-nn item as printed until the Project_Owner records that decision.
14. IF the requester of a role-change or transfer request is not an Active_Member of the group, or the group does not exist, THEN THE Group_API SHALL respond with the identical 404 NOT_FOUND response of DB5-R02 criterion 3 and SHALL change no record.
15. IF the target of a role-change request is not an Active_Member, THEN THE Group_API SHALL respond 404 NOT_FOUND and SHALL change no record.
16. IF a role-change request names the role that the target already holds, THEN THE Group_API SHALL respond 409 CONFLICT and SHALL change no record.
17. WHEN a role-change or transfer request meets more than one refusal condition, THE Group_API SHALL respond with the first applicable of: criterion 14, criteria 6 and 10, criteria 4 and 9, criterion 15, criterion 12, criteria 5 and 16.

| Action | Owner | Admin | Member |
| --- | --- | --- | --- |
| Read group, members, permitted history | allowed | allowed | allowed |
| Change name or description | allowed | refused | refused |
| Change History_Policy | refused (OD-05: chosen at creation only) | refused | refused |
| Invite or add a user (OD-01, OD-02, OD-03) | allowed | allowed | refused |
| Cancel an Invitation | allowed | allowed (OD-03) | refused |
| Remove a member | allowed | allowed | refused |
| Remove an admin | allowed | refused | refused |
| Change a role or transfer ownership | allowed | refused | refused |
| Leave the group | refused until transfer | allowed | allowed |
| Archive the group (DB5-R07) | allowed | refused | refused |

### Requirement 7: Group lifecycle [DB5-R07]

**User Story:** As a group owner, I want to close a group without losing its records, so that conversations can end while history and references stay intact.

- **ID**: DB5-R07
- **Origin**: PROPOSED (DB-5 checklist asks to define group rules; Conversations.archived_at exists; deletion policy is OD-09)
- **Roadmap reference**: DB-5 checklist: define owner/admin/member rules; DB-5 DoD: groups persist after restart
- **Audit findings**: AF-02
- **Dependencies**: DB5-R01, DB5-R06, DB5-R12, DB5-R14
- **Implementation phase**: DB-5B, DB-5C

#### Acceptance Criteria

1. WHEN the group owner submits an archive request for an unarchived group, THE Group_Service SHALL set Conversations.archived_at and write an audit event in one transaction, so that a failed audit write leaves archived_at unchanged.
2. WHILE a Group_Conversation is archived, THE Group_Service SHALL refuse each of message submission, member addition, Invitation creation, role change, ownership transfer, attachment upload and change of name or description with 409 CONFLICT.
3. WHILE a group is archived, THE Group_Service SHALL allow Active_Members to read group metadata with the archived state, the member list and permitted history.
4. WHILE a group is archived, THE Group_Service SHALL retain every membership row, Membership_Interval, Invitation, message and attachment record.
5. IF the Project_Owner decision OD-09 is unresolved, THEN THE Group_API SHALL expose no group deletion route and no unarchive route, and SHALL respond 404 NOT_FOUND to an authenticated DELETE /api/groups/:id.
6. THE Group_Service SHALL NOT delete any row of Conversations, ConversationMembers, Messages, MessageReceipts or Attachments for a Group_Conversation, because the schema restricts deletes and defines no cascades.
7. IF an archive request names a nonexistent group, a Direct_Conversation or a group in which the requester is not an Active_Member, THEN THE Group_API SHALL respond with the identical 404 NOT_FOUND of DB5-R02 criterion 3 and SHALL change no record.
8. IF the account of the active owner is disabled or removed, THEN THE Group_Service SHALL keep ownership unchanged and SHALL NOT transfer ownership automatically until the Project_Owner decision OD-10 is recorded.
9. IF the requester holds the role admin or member when the transaction reads the membership, THEN THE Group_API SHALL respond 403 FORBIDDEN to an archive request and SHALL change no record.
10. IF the group owner submits an archive request for an archived group, THEN THE Group_API SHALL respond 409 CONFLICT, SHALL keep archived_at unchanged and SHALL write no audit event.
11. WHILE a group is archived, WHEN an Active_Member submits POST /api/groups/:id/leave, THE Group_Service SHALL apply DB5-R05 criteria 6 and 7 as for an unarchived group.

### Requirement 8: History visibility and rejoin [DB5-R08]

**User Story:** As a group owner, I want a defined history policy, and as a member I want to see only the history I am entitled to, so that joining, leaving and rejoining never expose messages from periods without membership.

- **ID**: DB5-R08
- **Origin**: ORIGINAL (DB-5 checklist "history visibility and removed-member behavior"; DATA docs require DB-5 to define rejoin and history rules); PROPOSED for interval storage (AF-14)
- **Roadmap reference**: DB-5 checklist: define history visibility and removed-member behavior; DB-5 DoD: only authorized members can view permitted history
- **Audit findings**: AF-14, AF-21
- **Dependencies**: DB5-R01, DB5-R03, DB5-R04, DB5-R05, DB5-R09
- **Implementation phase**: DB-5B, DB-5C, DB-5D

#### Acceptance Criteria

1. THE Group_Service SHALL store exactly one History_Policy for each group in the Group_Extension_Record, with a value that is exactly all or exactly from_joined as in the Standalone_Implementation (Project_Owner decision OD-05, decided), SHALL set it when the group is created and SHALL NOT change it after the group is created.
2. WHEN a group is created without a historyPolicy, THE Group_Service SHALL set the History_Policy of that group to from_joined (the default decided in OD-05).
3. THE Group_Repository SHALL record, for every Membership_Interval, the user, the first sequence (the highest message sequence of the group at the join commit, plus 1) and, once the interval ends, the last sequence (the highest message sequence of the group at the removal or leave commit), both inclusive.
4. WHEN a user joins or rejoins a group, THE Group_Service SHALL open a new Membership_Interval in the same transaction as the membership change and SHALL NOT overwrite or reset the boundaries of an earlier interval.
5. WHEN a member requests group history, THE Message_Service SHALL compute the permitted ranges of criterion 12 in the same query that selects the page, so that a page holds the requested page size whenever that many permitted messages remain and no item, next-page indication or cursor refers to a sequence outside the permitted ranges.
6. THE Message_Service SHALL NOT return any message whose sequence is higher than the last sequence of one Membership_Interval of the requester and lower than the first sequence of the next one, regardless of the History_Policy.
7. WHILE the Project_Owner decision OD-06 is unresolved, THE Message_Service SHALL include in the permitted ranges of a rejoined member the sequences of every earlier Membership_Interval of that member and of the current one.
8. THE DATA_Application SHALL apply the permitted ranges of criterion 12 to single-message retrieval, receipts, read state, unread counts, attachment metadata, attachment download, attachment search and realtime replay.
9. FOR ALL sequences of join, leave, rejoin and message-send events generated with a recorded seed, THE Message_Service SHALL return to each Active_Member exactly the messages sent while that user was an Active_Member and, under the policy all, the messages sent before that user's first join.
10. IF a removed user requests group history, THEN THE Group_API SHALL respond 404 NOT_FOUND and SHALL return no message, including messages of the user's earlier Membership_Intervals.
11. THE Documentation_Set SHALL state that server-side visibility rules do not replace key-based confidentiality of Protected_Content, which DB-5D reviews separately.
12. THE Message_Service SHALL define the permitted ranges of a requester as the sequences inside the requester's Membership_Intervals, an open interval having no upper bound, and, under the policy all, also the sequences lower than the first sequence of the requester's earliest Membership_Interval.
13. IF a requested single message or attachment lies outside the permitted ranges of the requester, THEN THE Group_API and THE Attachment_API SHALL respond with the same 404 NOT_FOUND response as for an identifier that does not exist.
14. WHEN the permitted ranges of an Active_Member contain no message, THE Group_API SHALL answer a history request with 200 and an empty page without next-page indication.

### Requirement 9: Message persistence interfaces and pagination [DB5-R09]

**User Story:** As a group member, I want group messages to use the same stored, ordered, idempotent message path as direct messages, so that history is reliable and no second message model exists.

- **ID**: DB5-R09
- **Origin**: ORIGINAL (DB-5 checklist "reuse conversation/message storage and avoid a separate conflicting group-message model"; DB-4 requires one shared message-write service); PROPOSED for gating (AF-08, AF-09, AF-24)
- **Roadmap reference**: DB-5 checklist: reuse conversation/message storage; DB-4: one shared message-write service, stable IDs, client idempotency IDs, cursor pagination, membership checks, ciphertext and envelope storage
- **Audit findings**: AF-02, AF-08, AF-09, AF-10, AF-24
- **Dependencies**: DB5-R08, DB5-R12, DB5-R14, DB5-R16, ARCH-R02
- **Implementation phase**: DB-5B, DB-5D, DB-5E

#### Acceptance Criteria

1. THE Message_Service SHALL store group messages in the canonical Messages table with the group conversation_id, receiver_id NULL and a per-conversation message_seq.
2. IF a requester is not an Active_Member of a Group_Conversation, THEN THE Message_Service SHALL respond 404 NOT_FOUND to every read or write of its messages and SHALL change no record.
3. WHEN an Active_Member submits a message whose client message identifier (1 to 256 characters) is already stored in the conversation for the same sender with an identical fingerprint, THE Message_Service SHALL return the stored message as a duplicate and SHALL store nothing.
4. IF the client message identifier is already stored in the conversation for another sender or with a different fingerprint, THEN THE Message_Service SHALL respond 409 IDEMPOTENCY_CONFLICT and SHALL store nothing.
5. WHEN a message is stored, THE Message_Service SHALL assign, inside the write transaction, a message_seq equal to the highest stored message_seq of the conversation plus 1, or 1 for the first message.
6. WHEN a member requests group history, THE Message_Service SHALL return pages in descending message_seq of 20 items by default and at most 50, each page except the last with a context-bound cursor that carries the high-water message_seq of the first page, so that messages stored after the first page do not enter later pages of the same traversal.
7. FOR ALL valid cursor payloads, THE Message_Service SHALL decode an encoded cursor to the original payload (round-trip property).
8. IF the re-check inside the write transaction finds that the sender is not an Active_Member or the group is archived, THEN THE Message_Service SHALL respond 404 NOT_FOUND to a non-member and otherwise 409 CONFLICT, and SHALL store nothing.
9. IF group messaging is not enabled by the Feature_Gate, THEN THE Group_API SHALL respond 503 FEATURE_UNAVAILABLE to every authenticated group message write and SHALL store nothing.
10. IF the submitted content is not an envelope that passes the existing envelope validation, THEN THE Message_Service SHALL respond 400 VALIDATION_ERROR (403 FORBIDDEN if the envelope names another sender) and SHALL store nothing, so that plaintext is not stored.
11. IF no group recipient-key verifier is registered, the verifier is marked test-only in a production configuration, or the verifier fails or gives no answer within 2000 ms, THEN THE Message_Service SHALL respond 503 RECIPIENT_KEYS_UNAVAILABLE and SHALL store nothing.
12. IF the registered verifier does not confirm that the envelope is protected for every active recipient device of the Active_Members other than the sender, THEN THE Message_Service SHALL respond 403 RECIPIENT_KEYS_UNVERIFIED and SHALL store nothing.
13. THE Message_Service SHALL expose for group conversations the trusted store, find and record-receipt interfaces that the Realtime_Bridge uses for direct conversations, and SHALL apply criteria 2, 8 and 10 to 12 to the store interface, so that the Realtime_Bridge holds no persistence of its own.
14. THE Message_Service SHALL NOT define a new key-distribution format, envelope format or cryptographic operation in this work, because DB-5D reviews protected group messaging separately (Project_Owner decision OD-19).
15. THE Group_Repository SHALL NOT create a second message table or a group_id column on Messages.
16. THE Message_Service SHALL keep the visibility decisions and responses for every Direct_Conversation unchanged, as the fixtures of ARCH-R02 verify.
17. IF a history request has an unknown query parameter, a limit outside 1 to 50, or a cursor that is altered or issued for another user or conversation, THEN THE Group_API SHALL respond 400 VALIDATION_ERROR and SHALL return no message.
18. IF a write fails several checks, THEN THE Message_Service SHALL report the first failure in this order: Feature_Gate, envelope validation, membership and archive state, recipient-key verifier, idempotency.

### Requirement 10: Read state and unread counts [DB5-R10]

**User Story:** As a group member, I want my read position and unread count per group, so that I can see what I have not read.

- **ID**: DB5-R10
- **Origin**: PROPOSED (AF-10: no group read or delivery state exists); extends DB-4 receipts to groups
- **Roadmap reference**: DB-4: membership checks, stable IDs; DB-5 checklist: reuse conversation/message storage
- **Audit findings**: AF-10
- **Dependencies**: DB5-R08, DB5-R09, DB5-R12
- **Implementation phase**: DB-5B, DB-5D

#### Acceptance Criteria

1. THE Group_Repository SHALL store at most one Read_Position for each pair of group and member.
2. WHEN an Active_Member reports a read position n for a group, THE Group_Service SHALL set the Read_Position to the larger of the stored value and n, so that concurrent reports never lower it, and SHALL respond with the stored value.
3. WHEN a read position n less than or equal to the stored value is reported, THE Group_Service SHALL leave the stored value unchanged and SHALL respond with the stored value (idempotence).
4. IF n is not an integer from 0 to the highest message_seq stored for the group or, when n is greater than 0, lies outside the permitted ranges of the member (DB5-R08 criterion 12), THEN THE Group_API SHALL respond 400 VALIDATION_ERROR and SHALL change no record.
5. WHEN a member lists groups, THE Group_API SHALL include for each group the unread count, computed as the number of messages that are permitted (DB5-R08 criterion 12), are not tombstoned, have a sequence greater than the Read_Position (0 when none is stored) and have a sender other than the requester.
6. IF the requester is not an Active_Member of a group, THEN THE Group_API SHALL respond 404 NOT_FOUND to a request to report or read a Read_Position or receipt of that group and SHALL change no record.
7. WHILE the Project_Owner decision OD-12 is unresolved, THE Group_API SHALL return no Read_Position or receipt of any other member.
8. WHERE the Project_Owner decision OD-12 selects visible receipts, THE Group_API SHALL return per-message read information only to Active_Members of the group.
9. WHERE the design stores delivery or read state in MessageReceipts, THE Group_Service SHALL create at most one receipt for each message, observer and state, only for the authenticated member as observer, only for a permitted message (DB5-R08 criterion 12) sent by another member.
10. WHERE the design stores state in MessageReceipts, IF a receipt is requested for a message that is unknown in the group, not permitted (DB5-R08 criterion 12) or sent by the requester, THEN THE Group_API SHALL respond 404 NOT_FOUND and SHALL create no receipt.

### Requirement 11: Restart persistence [DB5-R11]

**User Story:** As a user, I want my groups and their state to survive a server restart, so that a restart never loses conversations.

- **ID**: DB5-R11
- **Origin**: ORIGINAL (DB-5 DoD: groups persist after restart)
- **Roadmap reference**: DB-5 DoD: groups persist after restart
- **Audit findings**: AF-25, AF-26
- **Dependencies**: DB5-R01, DB5-R04, DB5-R08, DB5-R09, DB5-R14
- **Implementation phase**: DB-5B, DB-5C, DB-5G

#### Acceptance Criteria

1. WHEN the DATA_Application stops and starts again on the same database file, THE Group_API SHALL return field values equal to those returned before the stop for groups, memberships, roles, Invitations that did not expire during the stop, History_Policy values, Read_Positions, Membership_Revision values and messages with sequence numbers.
2. WHEN the DATA_Application starts and SchemaMigrations records every migration file, THE Migration_Runner SHALL apply no migration and SHALL leave SchemaMigrations unchanged.
3. WHEN an invitee accepts an Invitation whose expiry time passed while the DATA_Application was stopped, THE Group_Service SHALL refuse the acceptance with 409 CONFLICT (DB5-R04) and SHALL create no membership.
4. THE Group_Service SHALL keep all membership, role and Invitation state in Canonical_DATA, so that each user and action yields the same allow or refuse result before and after a restart.
5. IF a write transaction fails or the DATA_Application terminates before commit, THEN THE Group_Repository SHALL leave no change of that transaction in the database.
6. THE Verification_Suite SHALL run restart tests only on a database file in a new temporary directory per test, and SHALL NOT open DATA/server/database/database.sqlite.
7. WHEN the DATA_Application process is terminated without graceful shutdown after the Group_API responded with success to a write request, THE Group_API SHALL return that change after the next start.

### Requirement 12: Authorization, session and request validation [DB5-R12]

**User Story:** As a user, I want every group action authenticated, request-validated and authorized at write time, so that no one can act on a group without the right.

- **ID**: DB5-R12
- **Origin**: ORIGINAL (DB-5 DoD: only authorized members perform actions; approved principle 5); PROPOSED for the single-chain enforcement (AF-12)
- **Roadmap reference**: DB-5 DoD: only authorized members can view permitted history and perform actions
- **Audit findings**: AF-03, AF-04, AF-12
- **Dependencies**: ARCH-R01
- **Implementation phase**: DB-5C

#### Acceptance Criteria

1. WHEN a request reaches a Group_API route, THE Group_API SHALL authenticate the session through the Auth_Layer before any group code runs.
2. IF an authenticated request to a Group_API route uses any method other than GET and HEAD and carries no CSRF proof that the Auth_Layer verifies as bound to its session, THEN THE Group_API SHALL respond 403 CSRF_INVALID and SHALL change no record.
3. IF a request to a group route fails the Origin check of the Auth_Layer, THEN THE DATA_Application SHALL respond 403 FORBIDDEN before any group code runs.
4. IF the injected rate limiter reports a limit exceeded, THEN THE Group_API SHALL respond 429 RATE_LIMITED with the retry delay in seconds, using separate per-user and per-source buckets for reads (GET) and for mutations (POST, PATCH, DELETE).
5. THE Group_Service SHALL read membership, role, group state, block state and Invitation state inside the BEGIN IMMEDIATE write transaction that applies the change and SHALL authorize the change from those values only.
6. THE Group_Service SHALL take the actor only from the authenticated session and SHALL treat any user identifier in a request body or path as a target only.
7. IF a user submits the identifier of a group, Invitation or attachment that the user may not access, THEN THE DATA_Application SHALL respond with the same 404 NOT_FOUND as for an unknown identifier.
8. WHEN a state-changing operation commits, THE Group_Service SHALL write in the same transaction an audit record holding only the event code, actor identifier, group identifier and any target identifier, and no name, description, message content or file content.
9. IF the audit record cannot be written, THEN THE Group_Service SHALL roll back the operation so that no record changes, and THE Group_API SHALL respond 500 INTERNAL_ERROR.
10. THE DATA_Application SHALL serve every group and attachment route only behind the Auth_Layer, even when AUTH_MIDDLEWARE_MODULE of the Standalone_Implementation is set.
11. IF a request to a Group_API route that accepts a JSON body has a non-JSON content type, THEN THE Group_API SHALL respond 400 VALIDATION_ERROR and SHALL change no record, except that THE Group_API SHALL keep its existing 415 UNSUPPORTED_MEDIA_TYPE response to a request that fails with a body-parser encoding or charset error.
12. IF the session is missing, expired or revoked, THEN THE Group_API SHALL respond with the existing unauthenticated response of the Auth_Layer.
13. IF the state read inside the write transaction shows that the actor is not an Active_Member or lacks the required role, THEN THE Group_API SHALL change no record and SHALL respond 404 NOT_FOUND to a non-member or 403 FORBIDDEN to a member.
14. IF a request body exceeds the existing JSON body size limit, THEN THE Group_API SHALL respond with the existing oversized-body response and SHALL change no record.

### Requirement 13: Error handling and API contract [DB5-R13]

**User Story:** As a client developer, I want a documented, consistent API contract with safe errors, so that the frontend and tests can rely on it.

- **ID**: DB5-R13
- **Origin**: ORIGINAL (DB-5 deliverable "group API contract"; handoff checklist "endpoint list + OpenAPI examples, authorization rules + error codes"); PROPOSED for error hardening (AF-11, AF-13, AF-19)
- **Roadmap reference**: DB-5 Deliverables: group API contract; Handoff checklist
- **Audit findings**: AF-11, AF-13, AF-19
- **Dependencies**: DB5-R01, DB5-R12
- **Implementation phase**: DB-5C, DB-5G

#### Acceptance Criteria

1. THE Group_API SHALL return every error as a JSON object with the members code (a string) and fields (an array of field-name strings, empty when no field applies), as the existing DATA services do.
2. THE Group_API SHALL map failures to the status and code pairs 400 VALIDATION_ERROR, 403 FORBIDDEN, 403 CSRF_INVALID, 404 NOT_FOUND, 409 CONFLICT, 409 STALE_STATE, 409 IDEMPOTENCY_CONFLICT, 415 UNSUPPORTED_MEDIA_TYPE, 429 RATE_LIMITED, 500 INTERNAL_ERROR, 503 FEATURE_UNAVAILABLE and 503 SERVICE_UNAVAILABLE, and to the unauthenticated response of the Auth_Layer, with every additional code listed in the contract documents of the Documentation_Set (criterion 6) before use.
3. IF an unexpected internal error occurs, THEN THE Group_API SHALL respond 500 INTERNAL_ERROR with an empty fields list and SHALL NOT include a stack trace, SQL text, constraint name, absolute path or database location.
4. IF a route that requires a JSON body receives a missing, empty, malformed JSON or non-object body, THEN THE Group_API SHALL respond 400 VALIDATION_ERROR and SHALL NOT respond 500.
5. WHEN the database raises a unique, check, foreign key or trigger error, THE Group_Service SHALL map a unique or trigger error to 409 CONFLICT and a check or foreign key error to 400 VALIDATION_ERROR, and SHALL NOT forward the database message.
6. THE Documentation_Set SHALL include DATA/docs/groups-api.md and DATA/docs/groups-openapi.json that list every route under /api/groups with its request schema, response schema, minimum role, error status and code, and an example.
7. THE Verification_Suite SHALL fail when a mounted group route is missing from the OpenAPI document, and SHALL validate every documented example against its schema.
8. THE Documentation_Set SHALL include a handoff document that lists merged code, the endpoint list with examples, authorization rules and error codes, migration instructions and environment variables, test commands and results, and known gaps.
9. THE Group_API SHALL use camelCase field names (lower-case first letter, no underscore) consistent with the existing DATA projections.
10. IF a Group_API request ends with status 400 or higher, THEN THE Group_Service SHALL leave the group, membership and message records unchanged by that request, except for the one write permitted with the status 409 CONFLICT, which is the Invitation state change and its audit row that DB5-R04 criteria 9 and 10 require.
11. THE Verification_Suite SHALL fail when a Group_API test receives a status and code pair that the contract does not list for that route.
12. IF a database operation fails because the database is busy, locked or unavailable, THEN THE Group_API SHALL respond 503 SERVICE_UNAVAILABLE with an empty fields list and no database location.

### Requirement 14: Migration compatibility [DB5-R14]

**User Story:** As a maintainer, I want group schema changes delivered as safe, additive, versioned migrations, so that existing databases upgrade without data loss.

- **ID**: DB5-R14
- **Origin**: ORIGINAL (DB-1 DoD: fresh and repeat migrations succeed, constraints reject duplicates; approved principle 3); PROPOSED for upgrade validation on populated databases; PROPOSED for the trigger-body exception of criterion 5 (CI-06, DC-07) and for criteria 17 and 20 to 24 (Docker_Environment constraints of the DB-5A reconciliation: DK-03, DK-04, DK-05, DK-07, COMP-10)
- **Roadmap reference**: DB-1 DoD: fresh and repeat migrations succeed; constraints reject duplicates; Handoff checklist: migration instructions
- **Audit findings**: AF-02, AF-05
- **Dependencies**: ARCH-R01, ARCH-R02
- **Implementation phase**: DB-5B

#### Acceptance Criteria

1. THE Migration_Runner SHALL apply the group schema in Schema_Migration files numbered consecutively from 0008 and named in the form of 0007-recipient-keys.sql (four digits, hyphen, lowercase name, .sql).
2. IF the checksum of any of the files 0001 to 0007 differs from its checksum recorded at baseline d7cd40a, THEN THE Verification_Suite SHALL fail.
3. THE Schema_Migration files SHALL add only tables, indexes, triggers and nullable or defaulted columns, and SHALL NOT delete any existing row or change a stored value of any existing row.
4. IF a Schema_Migration rebuilds an existing canonical table, THEN THE Verification_Suite SHALL prove that row count, pre-existing column values, indexes, triggers and foreign keys of that table are identical before and after, as the migration 0007 verification does.
5. THE Schema_Migration files SHALL NOT contain a BEGIN, COMMIT, ROLLBACK, VACUUM, ATTACH or PRAGMA statement outside the body of a trigger, where the body of a trigger is the BEGIN ... END block of a CREATE TRIGGER statement.
6. WHEN the Migration_Runner runs on an empty database, THE Migration_Runner SHALL record one SchemaMigrations row per migration file in version order and SHALL finish with a foreign key check that returns zero rows.
7. WHEN the Migration_Runner runs on a database at version 7 with at least one row of each kind of legacy data, authenticated direct conversations, messages, key directory rows, social data and attachments, THE Migration_Runner SHALL preserve every existing row with identical values in every pre-existing column.
8. THE Verification_Suite SHALL show that the schema created from an empty database and the schema upgraded from version 7 contain the same tables, columns (name, type, nullability, default), indexes, triggers and foreign keys.
9. WHEN the Migration_Runner runs on a database already at the highest version, THE Migration_Runner SHALL apply zero migrations and SHALL leave every SchemaMigrations row and every data row unchanged.
10. IF a statement in the pending batch fails, THEN THE Migration_Runner SHALL roll back the whole batch, SHALL raise an error that names the failing migration file, and SHALL leave ledger, schema and rows as before the run.
11. THE Schema_Migration files SHALL define every new foreign key with ON DELETE RESTRICT and SHALL NOT use ON DELETE CASCADE, SET NULL or SET DEFAULT.
12. THE Schema_Migration files SHALL define constraints that make the database reject, with a constraint error, a second pending Invitation for one group and invitee, a second Read_Position for one group and member, and a second open Membership_Interval (no end bound) for one group and member.
13. THE Schema_Migration files SHALL create one Group_Extension_Record with the History_Policy from_joined, the narrower value of DB5-R08, for every existing Conversations row of kind group, whatever its origin.
14. THE Group_Repository SHALL be the only runtime module that contains group SQL, and SHALL pass every value to SQL as a bound parameter, never by string concatenation.
15. WHEN a Schema_Migration is added, THE Documentation_Set SHALL update DATA/docs/schema.md and DATA/docs/migrations.md with its version, file name and every object it adds.
16. THE Documentation_Set SHALL state that a database migrated to 0008 or higher cannot start under code without that migration, because the Migration_Runner rejects extra ledger rows.
17. THE Verification_Suite SHALL run the migration tests of this requirement only on isolated temporary databases, each created for one test and removed afterwards, SHALL use for criterion 10 a failing migration file located in a temporary directory, and SHALL NOT open DATA/server/database/database.sqlite or the database file on the volumes of a running Docker_Environment project.
18. IF a Group_API request names a Conversations row of kind group whose origin is not authenticated, THEN THE Group_API SHALL respond with the identical 404 NOT_FOUND response of DB5-R02, SHALL change no record and SHALL list no such row.
19. WHILE the Project_Owner decision OD-20 is unresolved, THE Migration_Runner SHALL migrate no data of the Standalone_Implementation into Canonical_DATA and SHALL NOT open its SQLite file.
20. THE Documentation_Set SHALL state, as a precondition of running the Migration_Runner on an existing database, that a copy of the database file together with its write-ahead log and shared-memory files has been taken while no process has the database open or, for a database on the volumes of a Docker_Environment project, that the cold backup of criterion 23 has been taken in place of that copy.
21. WHERE a migration test needs a container, THE Verification_Suite SHALL run that test only in a Disposable_Project and SHALL NOT run it on the volumes of the running Docker_Environment project or on a live database, meaning either database file named in criterion 17.
22. WHILE a Schema_Migration file is a draft (present in the working tree and not yet committed), THE Project_Team SHALL NOT start or keep running Docker Compose Watch for any Docker_Environment project whose volumes hold data to keep (any data other than synthetic fixtures and the contents of a Disposable_Project).
23. WHEN the Project_Team is about to start code that contains a new Schema_Migration for the first time against data to keep (as defined in criterion 22) on the volumes of a Docker_Environment project, THE Project_Team SHALL, before that start, stop every process that writes to either volume and then archive both complete volume roots (the database volume sqlite-data with its write-ahead log and shared-memory files, and the attachment storage volume) by the cold-backup procedure of docs/docker-development.md, and SHALL NOT accept a copy of a live database file alone as that backup.
24. WHEN the Project_Team rehearses a Schema_Migration, THE Project_Team SHALL run the rehearsal only on synthetic fixtures or on an isolated copy of the cold backup of criterion 23 restored into fresh volumes of a Disposable_Project, and SHALL NOT run it on a live database (as defined in criterion 21).

### Requirement 15: Functional and integration testing [DB5-R15]

**User Story:** As a maintainer, I want an executable test matrix for groups and attachments, so that every rule is verified and regressions are caught.

- **ID**: DB5-R15
- **Origin**: ORIGINAL (DB-5 deliverable "role and membership tests"; DB-6 deliverable "file authorization tests"); PROPOSED for stale-request, concurrency and regression coverage (AF-03, AF-04, AF-05, AF-25); PROPOSED for the amendments of criteria 10 and 11 and for criteria 14 to 16 (DB-5A reconciliation: DK-01, OP-06, CI-01, CI-09)
- **Roadmap reference**: DB-5 Deliverables: role and membership tests; DB-6 Deliverables: file authorization tests; Handoff checklist: test commands + results
- **Audit findings**: AF-03, AF-04, AF-05, AF-25, AF-26
- **Dependencies**: DB5-R01 to DB5-R14, DB6-R01 to DB6-R05, ARCH-R02, ARCH-R03
- **Implementation phase**: DB-5B, DB-5C, DB-5D, DB-5G, DB-6B, DB-6C, DB-6D, DB-6E, DB-6F

#### Acceptance Criteria

1. THE Verification_Suite SHALL include node:test files in DATA/tests that use the helpers in DATA/tests/support and run each file on its own temporary database and storage directory.
2. THE Verification_Suite SHALL execute every Group_API route as each actor class (unauthenticated, non-member, pending invitee, member, admin, owner, removed member) and SHALL assert for every denied case the status and code defined by DB5-R13 and the Auth_Layer and that no database row changed.
3. THE Verification_Suite SHALL include one regression test per finding AF-03, AF-04 and AF-05, named with its identifier, that reproduces the scenario in the Audit Finding Traceability section and asserts 409 CONFLICT, unchanged memberships and roles, exactly one active owner and at most one pending Invitation per group and invitee.
4. THE Verification_Suite SHALL test that an Active_Member who sends a Direct_Conversation identifier to a Group_API route, or a Group_Conversation identifier to a direct conversation route, receives 404 NOT_FOUND and changes no row.
5. THE Verification_Suite SHALL run concurrent transfers, concurrent invitations, concurrent accept and remove, and concurrent leave and transfer, each with 2 requests in flight at once and repeated 20 times, and SHALL assert after each run exactly one active owner.
6. THE Verification_Suite SHALL run at least 100 randomized sequences of 50 operations, SHALL print the seed of each sequence, and SHALL assert after every operation that no Invitation left a terminal state (DB5-R04 criterion 17), that exactly one active owner exists and that each user reads only the messages DB5-R08 permits.
7. THE Verification_Suite SHALL test restart persistence (DB5-R11 criteria 1 to 5), attachment restart (DB6-R04 criterion 9), fresh migration (DB5-R14 criterion 6), upgrade migration (DB5-R14 criteria 7 and 8) and repeat migration (DB5-R14 criterion 9).
8. WHILE a Feature_Gate switch is disabled, THE Verification_Suite SHALL assert, for the Group_API, group messaging and the Attachment_API, that an authenticated request receives 503 FEATURE_UNAVAILABLE and that no database row or stored file changes.
9. THE Verification_Suite SHALL test attachment upload, metadata, download, search and delete as each actor class of criterion 2 and as a blocked direct participant, and SHALL assert for every denied case the status and code of DB6-R03 and that no row or stored file changes.
10. WHEN a phase from DB-5B to DB-7 ends, THE Verification_Suite SHALL run the complete DATA suite in the Validation_Runner as the gate of record, reporting at least 321 passing, 0 failing and 0 skipped tests, with a run of the same suite on a Windows host recorded in the Documentation_Set as additional evidence.
11. THE Verification_Suite SHALL include guard tests that fail on any changed line of an existing baseline test other than the appending of the new migration file names or version numbers, in the same commit as the migration, to exactly seven assertions that list the applied migrations (auth-migrations.test.js (the applied list), conversations-migrations.test.js, e2ee-migrations.test.js (two places), messaging-migrations.test.js, migrations.test.js and social-migrations.test.js), so that a comparison with baseline d7cd40a shows no removed test, no added skip marker and no removed or relaxed assertion (OP-06 decided). A separate later owner-approved exception permits only `DATA/tests/support/auth.js` to match the exact SHA-256 `0d7996a8bef3be2703bfbb40dfe3c170efb3571a9bfdd6077832de2ef50bcc6f` from approved Task 2.24 commit `85730dd442a570a0b4756847ce34f9300ecfb71f`; the original d7cd40a manifest digest `e9910b540e2078a34ff77763c95a00090a02a9d323fe239ecb40a96e69ac08d7` remains recorded and unchanged. No other `auth.js` digest or baseline file has an exception.
12. THE Documentation_Set SHALL record, for every ported teammate test, the canonical test that replaces it, as ARCH-R03 requires.
13. WHEN a phase ends, THE Documentation_Set SHALL record in the handoff document the test command, the counts of passing, failing and skipped tests and the date of each Verification_Suite run in that phase.
14. THE Documentation_Set SHALL record in the handoff document each Known_Baseline_Failure by test name and platform, including the two tests of client/src/components/ai/__tests__/messengerAI.test.tsx that fail only on Windows at the baseline: "a prepared rewrite replaces a draft only after review and confirmation, never sends it" and "draft changes invalidate a pending replacement instead of overwriting newer text".
15. IF the Project_Team skips, edits, excludes or silences a Known_Baseline_Failure, or a test fails that is not on the recorded list of Known_Baseline_Failure entries, THEN THE Verification_Suite SHALL fail the gate of the phase.
16. WHERE a storage assertion depends on the platform (file mode, symbolic links or link-based rename), THE Verification_Suite SHALL branch on the platform and assert the expectation of that platform in a test that is not skipped.

### Requirement 16: Feature readiness gates [DB5-R16]

**User Story:** As the Project_Owner, I want each new function disabled until its evidence is accepted, so that incomplete group messaging or file sharing never reaches real accounts.

- **ID**: DB5-R16
- **Origin**: PROPOSED (approved principles 6 and 10; AF-08, AF-23, AF-24, AF-25)
- **Roadmap reference**: DB-5 DoD: only authorized members can view permitted history and perform actions; DB-6 DoD
- **Audit findings**: AF-01, AF-08, AF-23, AF-24, AF-25
- **Dependencies**: DB5-R09, DB5-R12, DB6-R05, ARCH-R01
- **Implementation phase**: DB-5C, DB-5D, DB-5E, DB-5F, DB-5G

#### Acceptance Criteria

1. THE Feature_Gate SHALL provide independent server switches for the Group_API, for group messaging and for the Attachment_API, each read at DATA_Application start from a documented environment variable and each disabled unless that variable holds the documented enabling value.
2. WHILE the Group_API switch is disabled, THE DATA_Application SHALL answer every /api/groups request that the Auth_Layer accepts, except the feature-status response of criterion 13, with 503 FEATURE_UNAVAILABLE and SHALL read and change no group data.
3. WHILE group messaging is disabled, THE Group_API SHALL respond 503 FEATURE_UNAVAILABLE to every group message write and SHALL store nothing.
4. WHILE the Attachment_API switch is disabled, THE DATA_Application SHALL answer every /api/attachments and /api/files request that the Auth_Layer accepts with 503 FEATURE_UNAVAILABLE and SHALL read and change no attachment record or stored bytes.
5. WHERE a test harness enables a switch for an isolated database, THE Feature_Gate SHALL allow the function for that database only.
6. IF the group messaging switch is enabled outside a test harness and no group recipient-key verifier is registered or the registered one is marked test-only, THEN THE DATA_Application SHALL respond 503 RECIPIENT_KEYS_UNAVAILABLE to every group message write and SHALL store nothing.
7. IF, at DATA_Application start, the Group_API switch is enabled while the setting of the maximum Active_Members per group (OD-04, decided value 50, still a required configuration value), the setting of the maximum pending Invitations per group (OD-08, unresolved, no default) or the setting of the maximum pending Invitations per invitee (OD-08, unresolved, no default) is unset, or the Attachment_API switch is enabled while the setting of OD-14 or the setting of OD-15 is unset, THEN THE DATA_Application SHALL exit before accepting any request and SHALL name each missing setting without revealing secrets.
8. THE Feature_Gate SHALL require one Gate_Record per stage before the stage is enabled for Real_Accounts: group management (evidence: DB-5C tests passing and the documented API contract), group messaging (evidence: the DB-5D independent security review, including the OD-19 decision, accepted by the Project_Owner), realtime group delivery (evidence: DB-5E tests passing), and frontend enablement (evidence: DB-5F tests passing).
9. WHILE the server reports the Group_API disabled or the client group switch is disabled, THE Group_Client SHALL show no group screen and no group navigation entry to Real_Accounts.
10. WHILE the server reports group messaging disabled, THE Group_Client SHALL NOT present a group message composer to Real_Accounts.
11. THE Group_Client SHALL contain no Next.js rewrite for /api/groups before phase DB-5F and none for /api/attachments or /api/files before phase DB-6E.
12. WHEN an enabled switch is turned off by changing its environment variable and restarting the DATA_Application, THE Feature_Gate SHALL restore the 503 FEATURE_UNAVAILABLE behavior and SHALL leave every record, stored attachment byte and SchemaMigrations row unchanged.
13. WHEN an authenticated user requests the documented feature-status response, THE Group_API SHALL respond 200 with an enabled or disabled value for each of the three functions in every switch state and SHALL report group messaging as enabled only while the Group_API switch is also enabled.
14. IF a client switch is unset, or the feature-status response cannot be obtained or does not match the documented response, THEN THE Group_Client SHALL treat all three functions as disabled for Real_Accounts.

### Requirement 17: Canonical attachment metadata and association [DB6-R01]

**User Story:** As a conversation member, I want attachments stored in the canonical attachment record and tied to a conversation and message, so that authorization and history rules apply to files.

- **ID**: DB6-R01
- **Origin**: ORIGINAL (DB-6 checklist "metadata schema"); PROPOSED for the association and integrity fields (AF-16)
- **Roadmap reference**: DB-6 checklist: attachment storage abstraction and metadata schema
- **Audit findings**: AF-16
- **Dependencies**: DB5-R14, ARCH-R01, ARCH-R03
- **Implementation phase**: DB-6A, DB-6B, DB-6D

#### Acceptance Criteria

1. THE Attachment_Service SHALL store all attachment metadata in the canonical Attachments table, and THE Attachment_Service SHALL NOT use a second attachment table or a second database.
2. THE Schema_Migration SHALL add to Attachments, as nullable or defaulted columns, an integrity digest of the stored bytes, an expiry time for pending attachments (duration from OD-14), a deletion time and a deletion state (bytes not purged or purged), and SHALL leave every existing column value unchanged.
3. WHEN an attachment is created, THE Attachment_Service SHALL set conversation_id to one Direct_Conversation or Group_Conversation in which the uploader is an Active_Member, SHALL set uploaded_by to the uploader, and SHALL NOT change either value afterward.
4. WHEN the uploader of a pending, unexpired attachment sends an authenticated association request naming a committed message that the same user sent in the same conversation, THE Attachment_Service SHALL set message_id and the status ready in one transaction.
5. IF an association request names an attachment that is missing, not pending, has an expiry time not after the current time, is in another conversation, was uploaded by another user or is already associated, or names a message not committed in that conversation, THEN THE Attachment_Service SHALL respond 404 NOT_FOUND for a missing attachment, another conversation or another uploader and 409 CONFLICT otherwise, and SHALL change no record, including the other attachments in the request.
6. IF a status change other than pending to ready, pending to deleted or ready to deleted is requested, THEN THE Attachment_Service SHALL respond 409 CONFLICT and SHALL leave the record unchanged, so that deleted is terminal.
7. WHILE an attachment is pending, THE Attachment_API SHALL return its metadata only to the uploader, SHALL answer any other requester with 404 NOT_FOUND, and SHALL refuse every download request.
8. THE Attachment_API SHALL return the identifier, conversation identifier, message identifier (null while pending), uploader identifier, byte size, status, creation time, integrity digest and encrypted metadata, and SHALL NOT return the storage_key or any filesystem location.
9. WHERE the Project_Owner decision OD-21 selects an association field outside the encrypted message content, WHEN a message names attachment identifiers in that field, THE Attachment_Service SHALL check each identifier under criteria 4 and 5, SHALL bind the identifiers to the message fingerprint, and SHALL commit the message and its associations in one transaction or neither.
10. WHILE no Project_Owner decision OD-20 requires a migration, THE Attachment_Service SHALL NOT copy rows of the Standalone_Implementation attachment table into Attachments or modify the standalone database file.
11. WHEN an attachment changes to deleted, THE Attachment_Service SHALL set the deletion time to the current time and the deletion state to bytes not purged in the same transaction.

### Requirement 18: Storage abstraction and private storage boundary [DB6-R02]

**User Story:** As an operator, I want attachment bytes stored outside SQLite in a private store behind an interface, so that storage can change without touching authorization rules.

- **ID**: DB6-R02
- **Origin**: ORIGINAL (DB-6 checklist "attachment storage abstraction, bytes outside SQLite where practical"); PROPOSED for the path and traversal controls (AF-19)
- **Roadmap reference**: DB-6 checklist: attachment storage abstraction (bytes outside SQLite where practical); DB-6 Deliverables: storage contract
- **Audit findings**: AF-19, AF-26
- **Dependencies**: DB6-R01, ARCH-R03
- **Implementation phase**: DB-6A, DB-6B

#### Acceptance Criteria

1. THE Storage_Provider interface SHALL define write from a stream, read as a stream, delete and existence check operations addressed only by a Storage_Key, and usage statistics returning the stored byte total and file count.
2. THE Storage_Provider implementation of DB-6B SHALL store bytes in a configured directory, not in SQLite, whose real path is outside the repository working tree and any statically served directory.
3. THE Attachment_Service SHALL generate each Storage_Key from at least 128 random bits, written as 32 to 128 characters of a-z and 0-9, and SHALL NOT derive it from user-supplied text or a content digest.
4. THE Storage_Provider SHALL derive each file path only from a Storage_Key of the form in criterion 3 inside the configured root, and SHALL refuse with an error any other key and any key that resolves outside the root through separators, parent references, absolute forms, reserved device names, alternate data stream syntax or symbolic links.
5. WHEN an upload stream starts, THE Storage_Provider SHALL write the bytes to a temporary .part file and enforce the size limit of DB6-R04 on the streamed byte count.
6. IF a stream aborts, exceeds the size limit, fails with an I/O error or finds a file already at the final Storage_Key path, THEN THE Storage_Provider SHALL delete the temporary file, leave any existing file unchanged and return an error.
7. THE Storage_Provider SHALL NOT return an absolute filesystem path or the configured root in any result or error.
8. IF the storage root is unset, is not a writable directory, or violates criterion 2, THEN THE Feature_Gate SHALL keep the Attachment_API disabled, so that DB5-R16 criterion 4 applies.
9. WHERE the platform supports file permissions, THE Storage_Provider SHALL create stored and temporary files readable only by the server process account (mode 0600 on POSIX).
10. IF the storage backend is unavailable (root inaccessible, stored bytes missing or I/O error), THEN THE Attachment_API SHALL respond 503 SERVICE_UNAVAILABLE with no filesystem path, as DB6-R03 criterion 16 specifies, and SHALL change no attachment record.
11. THE Verification_Suite SHALL run one shared contract test of criteria 1, 4 to 7 and 13 against every Storage_Provider implementation, including ported tests of the Standalone_Implementation streaming logic.
12. THE DATA_Application SHALL NOT mount a static file route on the storage root or on a directory that contains it.
13. WHEN an upload stream ends successfully, THE Storage_Provider SHALL compute and return the SHA-256 digest of the streamed bytes and rename the temporary file to the final Storage_Key path without replacing an existing file.
14. IF the Storage_Provider returns a write error, THEN THE Attachment_Service SHALL leave no attachment record in the status ready for that upload.
15. THE Attachment_Service SHALL pass to the Storage_Provider only a Storage_Key, a byte stream and the size limit.

### Requirement 19: Upload, download, search, cleanup and retention lifecycle [DB6-R03]

**User Story:** As a conversation member, I want to upload, find and download files that I am allowed to access, and I want abandoned or deleted files cleaned up, so that storage stays consistent and private.

- **ID**: DB6-R03
- **Origin**: ORIGINAL (DB-6 checklist: POST /api/attachments; GET /api/attachments/:id; GET /api/attachments/:id/download; GET /api/files/search; authorize upload, download and search; handle partial uploads and retention and deletion); PROPOSED for scheduling and relationship checks (AF-17, AF-21)
- **Roadmap reference**: DB-6 checklist: POST /api/attachments; GET /api/attachments/:id; GET /api/attachments/:id/download; GET /api/files/search; authorize upload/download/search; handle partial uploads and retention/deletion
- **Audit findings**: AF-17, AF-18, AF-19, AF-20, AF-21, AF-22
- **Dependencies**: DB6-R01, DB6-R02, DB5-R08, DB5-R12, DB5-R16
- **Implementation phase**: DB-6B, DB-6D

#### Acceptance Criteria

1. WHEN an Active_Member of a conversation submits POST /api/attachments with a byte stream, the conversation identifier, the declared byte size and the encrypted metadata, THE Attachment_Service SHALL store the bytes through the Storage_Provider, create a pending Attachments record with the expiry time set by OD-14, and respond 201 with the metadata of DB6-R01.
2. IF the conversation is direct and a block exists in either direction between the participants, or the participants fail the existing rule for sending direct messages, THEN THE Attachment_Service SHALL respond 403 FORBIDDEN, as the direct message path does, and SHALL store nothing.
3. IF the uploader is not an Active_Member of the conversation, including a removed group member, THEN THE Attachment_API SHALL respond 404 NOT_FOUND and SHALL store nothing.
4. WHEN an Active_Member requests GET /api/attachments/:id for a ready attachment whose associated message lies inside the permitted ranges of DB5-R08, or for a pending attachment that the requester uploaded, THE Attachment_API SHALL respond 200 with the metadata of DB6-R01.
5. WHEN an Active_Member requests GET /api/attachments/:id/download for a ready attachment, THE Attachment_API SHALL re-check membership, attachment state and permitted ranges before sending the first byte, and SHALL then stream the stored bytes.
6. THE Attachment_API SHALL send each download with Content-Type application/octet-stream, Content-Disposition attachment, X-Content-Type-Options nosniff and Cache-Control no-store.
7. IF the stored bytes are missing or differ in length from the recorded byte_size when a download starts, THEN THE Attachment_API SHALL respond 503 SERVICE_UNAVAILABLE before sending any attachment byte, and THE Attachment_Service SHALL write an audit event.
8. IF a removed group member requests any attachment of the group, including an attachment that this member uploaded, THEN THE Attachment_API SHALL respond 404 NOT_FOUND.
9. WHEN an Active_Member submits GET /api/files/search, THE Attachment_API SHALL return only ready attachments of conversations in which the requester is an Active_Member and that lie inside the permitted ranges of DB5-R08, newest first by creation time, in pages of 1 to 50 items (default 20) with cursors bound to the requester and the filters.
10. THE Attachment_API SHALL accept as search filters only the conversation, the uploader, a byte size range and a creation time range, and SHALL accept a media type class only WHERE the Project_Owner decision OD-17 permits that disclosure.
11. IF a search request filters by file name or by content, THEN THE Attachment_API SHALL respond 400 VALIDATION_ERROR, because the server holds only Protected_Content and indexes no private plaintext.
12. WHEN an Active_Member who uploaded a pending or ready attachment requests its deletion, THE Attachment_Service SHALL set the status deleted and the deletion time, SHALL remove the stored bytes and SHALL keep the metadata record.
13. WHEN the Retention_Job runs, THE Retention_Job SHALL mark as deleted every pending attachment whose expiry time has passed, after confirming in the marking transaction that it is still pending, and SHALL delete its bytes.
14. WHEN the DATA_Application starts, THE Retention_Job SHALL remove each temporary file older than the pending upload expiry of OD-14 and SHALL report in the server log the counts of non-deleted records without bytes and of bytes without records.
15. THE Retention_Job SHALL run on a schedule inside the DATA_Application with the interval and the retention periods set by the Project_Owner decision OD-14.
16. IF a storage or database failure occurs during an Attachment_API operation, THEN THE Attachment_API SHALL respond 503 SERVICE_UNAVAILABLE with an empty fields list, no filesystem path and no operating system error text, and SHALL commit no Attachments change and keep no bytes of a failed upload.
17. WHEN an upload commits, a download sends its last byte or a deletion commits, THE Attachment_Service SHALL write an audit event with the event code, actor identifier (empty for the Retention_Job), conversation identifier and attachment identifier, and SHALL NOT include file names or content.
18. WHILE the Project_Owner decisions OD-07, OD-13 and OD-18 are unresolved, THE Attachment_Service SHALL permit deletion of an attachment by its uploader only and SHALL keep a ready attachment available to the remaining Active_Members after a message tombstone, after the uploader's membership ends and after the group is archived.
19. IF a metadata, download or deletion request is not permitted by criterion 4, 5 or 12 respectively, including a request for an unknown attachment identifier, THEN THE Attachment_API SHALL respond 404 NOT_FOUND with one response for every cause, SHALL change no record and SHALL send no attachment byte.
20. IF a search request has a filter that criterion 10 does not permit, a range whose minimum exceeds its maximum, a limit outside 1 to 50, or a cursor that is malformed or was issued for another requester or filter set, THEN THE Attachment_API SHALL respond 400 VALIDATION_ERROR.
21. IF a state-changing Attachment_API request lacks a CSRF proof bound to the session, THEN THE Attachment_API SHALL respond 403 CSRF_INVALID and SHALL change nothing.
22. IF a Retention_Job run fails, THEN THE Retention_Job SHALL leave unprocessed attachments unchanged, keep the DATA_Application running and retry them at the next run.

### Requirement 20: Size limits, quotas and restart availability [DB6-R04]

**User Story:** As an operator, I want enforced size limits, quotas and rate limits, and files that stay available after a restart, so that storage use is bounded and uploads are reliable.

- **ID**: DB6-R04
- **Origin**: ORIGINAL (DB-6 checklist "validate size/type"; DB-6 DoD: upload to metadata search to authorized download works after restart); PROPOSED for quotas (AF-20)
- **Roadmap reference**: DB-6 checklist: validate size/type; DB-6 DoD: upload -> metadata search -> authorized download works after restart
- **Audit findings**: AF-20, AF-25
- **Dependencies**: DB6-R01, DB6-R02, DB6-R03, DB5-R12
- **Implementation phase**: DB-6B, DB-6F

#### Acceptance Criteria

1. THE Attachment_Service SHALL enforce the size limits of shared/attachmentPolicy.ts (per file: image 5 MB, document 10 MB, audio 20 MB, archive 25 MB, video 50 MB; per message: 5 files, 100 MB in total; 1 MB = 1,048,576 bytes), and THE Verification_Suite SHALL fail when a server limit differs from the client policy value.
2. IF the declared byte size, or the streamed byte count while the stream is read, exceeds the per-file limit of the category named in the required descriptors (52,428,800 bytes when no category is named), THEN THE Attachment_API SHALL respond 413 PAYLOAD_TOO_LARGE and read no further bytes.
3. IF the streamed byte count differs from the declared byte size and does not exceed the per-file limit, THEN THE Attachment_API SHALL respond 400 VALIDATION_ERROR.
4. WHEN the Attachment_Service creates a pending attachment, THE Attachment_Service SHALL check and count its declared size against the per-user and per-conversation byte quotas in one transaction, so that concurrent uploads cannot exceed a quota, and SHALL count only attachments in status pending or ready.
5. IF an upload would raise per-user or per-conversation usage above a byte quota set by the Project_Owner decision OD-15, THEN THE Attachment_API SHALL respond 409 QUOTA_EXCEEDED.
6. IF starting an upload would make the upload rate, or the number of uploads in progress (streams started and not yet ended), of a user or source exceed the limit of OD-15, THEN THE Attachment_API SHALL respond 429 RATE_LIMITED with a retry delay of at least 1 second.
7. IF a user holds the number of pending attachments set by OD-15 when the user starts an upload, THEN THE Attachment_API SHALL respond 409 QUOTA_EXCEEDED.
8. WHEN the DATA_Application restarts on the same database file and storage directory, THE Attachment_API SHALL return for every ready attachment the same metadata, the same search results and bytes whose SHA-256 digest equals the recorded integrity digest.
9. THE Verification_Suite SHALL run the sequence upload, association with a message, metadata search, authorized download, restart, search and download on an isolated temporary database and storage directory, and SHALL assert equal results before and after the restart.
10. THE Attachment_API SHALL process uploads and downloads as streams and SHALL NOT hold more than 1,048,576 bytes of a file in memory at one time.
11. IF an association would give a message more than 5 attachments or more than 100 MB in total, THEN THE Attachment_Service SHALL refuse it with 400 VALIDATION_ERROR and change no record.
12. IF an upload is refused under this requirement, aborts or fails, THEN THE Attachment_Service SHALL leave no Attachments record, stored file, temporary file or counted quota usage for it.

### Requirement 21: Protected attachment compatibility gate [DB6-R05]

**User Story:** As a user, I want attachments to stay end-to-end protected, so that the server stores only ciphertext and never reads my files.

- **ID**: DB6-R05
- **Origin**: ORIGINAL (DB-6 checklist: for E2EE attachments keep ciphertext and metadata and never silently decrypt or index private plaintext); PROPOSED for the enablement gate (AF-15, AF-18)
- **Roadmap reference**: DB-6 checklist: for E2EE attachments keep ciphertext and metadata, never silently decrypt or index private plaintext
- **Audit findings**: AF-15, AF-18, AF-23
- **Dependencies**: DB6-R01, DB6-R02, DB5-R16, ARCH-R02
- **Implementation phase**: DB-6A, DB-6C, DB-6E

#### Acceptance Criteria

1. THE Attachment_Service SHALL treat attachment bytes and encrypted_metadata as opaque Protected_Content, SHALL NOT decrypt, parse, preview, thumbnail, scan or index them, and SHALL read attachment bytes only to store, count and digest them and to return them unchanged.
2. THE Attachment_Service SHALL NOT receive, request, store, log or derive any decryption key.
3. WHILE the Project_Owner decision OD-16 is unresolved or does not permit plaintext attachments, IF an upload from any account lacks the protected-content declaration or the encrypted metadata, THEN THE Attachment_API SHALL respond 400 VALIDATION_ERROR and SHALL store nothing.
4. THE Attachment_Service SHALL store file name, original media type and content-derived metadata only inside encrypted_metadata, and SHALL store application/octet-stream in media_type for every protected upload.
5. THE Attachment_Service SHALL store the declared algorithm identifier and format version, each 1 to 64 characters, outside encrypted_metadata as the non-secret descriptors that form the protected-content declaration.
6. THE Documentation_Set SHALL state that the server cannot verify that uploaded bytes are ciphertext, and SHALL record this residual risk for the DB-6C security review.
7. IF the Project_Owner decision OD-16 permits plaintext attachments and an upload carries no protected-content declaration, THEN THE Attachment_API SHALL respond 400 VALIDATION_ERROR and SHALL store nothing when the declared media type is not on the OD-16 allowlist or does not match the first 512 bytes of the content.
8. WHILE no Gate_Record records a DB-6C independent security review report accepted by the Project_Owner, THE Feature_Gate SHALL keep the Attachment_API switch disabled for Real_Accounts.
9. WHILE the Attachment_API switch is disabled, THE Group_Client SHALL keep NEXT_PUBLIC_ATTACHMENT_API_READY at false and SHALL send no POST /api/attachments request for a Real_Account.
10. WHEN the Group_Client uploads a file for a Real_Account, THE Group_Client SHALL send ciphertext and encrypted metadata with the protected-content declaration and SHALL NOT send the plaintext bytes, the file name or the original media type outside the encrypted metadata.
11. THE Attachment_Service SHALL NOT introduce a cryptographic primitive, key format or protocol in DB-6A or DB-6B apart from the SHA-256 digest of DB6-R02 criterion 13, and SHALL consume the existing client protected-content format as it is.
12. IF the declared algorithm identifier or format version is empty or longer than 64 characters, or the encrypted metadata is longer than 16384 characters, THEN THE Attachment_API SHALL respond 400 VALIDATION_ERROR with the field name in the fields list and SHALL store nothing.
13. IF the Group_Client cannot produce ciphertext and encrypted metadata for a file, THEN THE Group_Client SHALL send no upload request for that file, SHALL NOT fall back to a plaintext upload and SHALL show an upload failure for that file.

### Requirement 22: Single authoritative persistence and unified runtime [ARCH-R01]

**User Story:** As a maintainer, I want one database, one process and one authentication system, so that data and authorization cannot diverge.

- **ID**: ARCH-R01
- **Origin**: PROPOSED (approved principles 1, 4 and 5; AF-01, AF-02, AF-12); PROPOSED for the naming of the Standalone_Implementation host and of the Docker_Environment address in criterion 9 (DB-5A reconciliation, COMP-10)
- **Roadmap reference**: DB-5 checklist: reuse conversation/message storage and avoid a separate conflicting group-message model
- **Audit findings**: AF-01, AF-02, AF-12, AF-16
- **Dependencies**: none
- **Implementation phase**: DB-5B, DB-5C, DB-6A, DB-7

#### Acceptance Criteria

1. THE DATA_Application SHALL be the only server process that persists groups, memberships, Invitations, group messages and attachments.
2. THE DATA_Application SHALL open only the Canonical_DATA database through the existing connection modules and SHALL create no other SQLite file at startup or during any request.
3. THE DATA_Application SHALL mount the group router from DB-5C and the attachment router from DB-6B inside createApp in DATA/server/app.js, after the existing Origin check and before the final NOT_FOUND handler.
4. THE DATA_Application SHALL pass the auth service, the database and the injected rate limiter as factory arguments to the Group_Service and the Attachment_Service, as it does for the existing services, and SHALL return both services from createApp.
5. THE Group_API and the Attachment_API SHALL authenticate every request through the Auth_Layer and SHALL NOT use another authentication module, another session store or the AUTH_MIDDLEWARE_MODULE variable.
6. THE Group_Repository SHALL call the existing repository functions for conversations, members, messages, receipts, attachments and audit instead of duplicating their SQL, and SHALL add each new function to the repository layer only.
7. THE Realtime_Bridge SHALL read and write group data only through the Message_Service and the Group_Service membership interface and SHALL NOT open a SQLite connection.
8. WHILE a router is not mounted (group router before DB-5C, attachment router before DB-6B), THE DATA_Application SHALL answer every request to that router's path prefix (/api/groups; /api/attachments and /api/files) with the 404 NOT_FOUND that any unmatched /api path receives, for every HTTP method.
9. THE Documentation_Set SHALL state in the handoff document that the Standalone_Implementation host, identified by the file server/api-main.cjs, the script npm run start:api and the API_PORT variable and not by a port number alone, is not a supported runtime, that npm run start:data starts the only supported server, and that in the Docker_Environment port 3001 is the browser-facing address of the application and not of the Standalone_Implementation.
10. WHEN npm run start:data starts the DATA_Application, THE DATA_Application SHALL serve all mounted routes from one process on one listening port and SHALL NOT start or proxy to the Standalone_Implementation.
11. THE Verification_Suite SHALL show that, after all Schema_Migrations are applied, Messages has no group_id column and no table duplicates Conversations, ConversationMembers, Messages or Attachments.

### Requirement 23: Phase 8.8 and existing DATA preservation [ARCH-R02]

**User Story:** As a user, I want direct messaging and every existing DATA function to work exactly as before, so that new features cannot break working encrypted messaging.

- **ID**: ARCH-R02
- **Origin**: PROPOSED (approved principles 7 and 9; AF-24, AF-25); PROPOSED for the exception of criterion 1 (OP-06, CI-01)
- **Roadmap reference**: DB-4: one shared message-write service; DB-1 DoD: repeat migrations succeed
- **Audit findings**: AF-02, AF-24, AF-25
- **Dependencies**: DB5-R14
- **Implementation phase**: DB-5B, DB-5G, DB-6F, DB-7

#### Acceptance Criteria

1. WHEN a phase from DB-5B to DB-7 ends, THE Verification_Suite SHALL show that all 321 DATA tests of baseline d7cd40a pass in the Validation_Runner, with none deleted, skipped or edited, except for the seven assertions that list the applied migrations and that DB5-R15 criterion 11 permits to change by appending the new migration file names or version numbers in the same commit as the Schema_Migration (OP-06 decided; CI-01), and the separate later owner-approved exact-hash exception for `DATA/tests/support/auth.js` recorded above. Its original baseline hash remains immutable in the manifest; only the approved Task 2.24 hash is accepted, and every other `auth.js` or baseline-file change fails.
2. WHEN an authenticated user requests GET /api/conversations, THE DATA_Application SHALL return only Direct_Conversations with exactly two participants, in the unchanged response shape that client/src/security/e2ee/api.ts parses.
3. WHEN a phase from DB-5B to DB-7 ends, THE Verification_Suite SHALL replay the fixtures recorded at baseline d7cd40a for direct message send, history, receipts, lifecycle and key-directory routes and SHALL fail on any difference in status, response fields or error code, except server-generated identifiers and timestamps.
4. THE DATA_Application SHALL give each direct message envelope and key-directory request the outcome and error code of baseline d7cd40a and SHALL NOT change the end-to-end encryption protocol.
5. WHEN the Migration_Runner upgrades a database from version 7, THE Migration_Runner SHALL leave the rows of Messages, MessageReceipts, DeviceKeys, ConversationKeyEpochs and ConversationKeyWraps identical in every column that exists at version 7.
6. WHEN a direct-message event passes through the Realtime_Bridge, THE Realtime_Bridge SHALL authorize and deliver it with the same event name, payload fields and recipients as at baseline d7cd40a, whether group events are enabled or not.
7. WHEN DB-7 starts, THE Verification_Suite SHALL run the DATA suite, the realtime server suite and the client suites on one commit and SHALL record in the handoff document each suite's command, passed, failed and skipped counts and result.
8. WHEN the Project_Owner approves publication at DB-7, THE Documentation_Set SHALL list the gate and evidence of every Gate_Record before the branch is published.
9. IF a suite run under criterion 7 reports a failed test or ends without a result, THEN THE Project_Team SHALL NOT request publication approval.
10. WHILE the Group_API switch or the group messaging switch is disabled, THE Realtime_Bridge SHALL emit no group event.

### Requirement 24: Reuse and deprecation of standalone implementations [ARCH-R03]

**User Story:** As the Project_Owner, I want valid teammate work reused and the standalone code retired in a controlled way, so that effort is preserved and no second runtime remains.

- **ID**: ARCH-R03
- **Origin**: PROPOSED (approved principle 8; AF-01, AF-16, AF-26)
- **Roadmap reference**: DB-5 checklist and DB-6 checklist (reuse); Handoff checklist: known gaps
- **Audit findings**: AF-01, AF-16, AF-26
- **Dependencies**: DB5-R15, ARCH-R01
- **Implementation phase**: DB-5B, DB-6A, DB-7

#### Acceptance Criteria

1. THE Documentation_Set SHALL include an inventory that lists at least these artifacts of the Standalone_Implementation: the streaming size-limited write with .part, hash, rename and cleanup, the role checks, the history-visibility query, the soft delete, the restart persistence tests, the 14 server tests (server/test/db5_db6.test.cjs, server/test/integration/attachments.test.ts) and the 76 client attachment tests.
2. THE Documentation_Set SHALL record in the inventory, for each artifact, exactly one disposition (reuse as is, adapt, replace or retire), a non-empty reason and at least one requirement ID that the artifact serves or that supersedes it.
3. THE Documentation_Set SHALL mark as retired in the inventory the rebuild of legacy Messages with group_id and the standalone attachment table, because the canonical schema supersedes them.
4. WHEN code of the Standalone_Implementation is ported into Canonical_DATA, THE Verification_Suite SHALL contain in the same phase a passing test that reproduces the observable behavior of each standalone server test covering that code, against the canonical schema.
5. WHILE the DB-5G gate or the DB-6F gate has no Gate_Record, THE Project_Team SHALL NOT modify, rename or delete server/api-main.cjs, the standalone tables, routes or tests.
6. WHEN the DB-5G gate and the DB-6F gate each have a Gate_Record, THE Documentation_Set SHALL mark the Standalone_Implementation as deprecated, citing both Gate_Records.
7. THE Project_Team SHALL record the original author and the source file of each artifact marked reuse as is or adapt in its inventory entry or in the porting commit message.
8. THE Documentation_Set SHALL state in the handoff document that approved DB-5 and DB-6 server code lives in DATA/ and that server/ keeps the realtime and end-to-end encryption protocol code.
9. WHILE phase DB-6E has not started, THE Project_Team SHALL NOT modify, rename, skip or delete any of the 76 client attachment tests listed in the inventory.
10. WHEN a standalone server test is ported, THE Documentation_Set SHALL record in the inventory the Verification_Suite test that replaces it.
11. IF a standalone server test contradicts a requirement of this document, THEN THE Verification_Suite SHALL port the test with the behavior of that requirement.
12. WHILE the Project_Owner decision OD-20 is unresolved, THE Project_Team SHALL NOT copy any row of the standalone SQLite file into Canonical_DATA or modify that file.
13. THE Project_Team SHALL NOT delete any code or test of the Standalone_Implementation in phases DB-5B to DB-7.

## Non-Functional Requirements

These requirements apply to every requirement above. The targets are PROPOSED and are measured by the Verification_Suite.

1. NFR-01 (atomicity, applies to DB5-R01 to DB5-R10, DB6-R01 to DB6-R04): THE Group_Service and THE Attachment_Service SHALL commit every state-changing operation, including its audit record, in one transaction or SHALL commit nothing.
2. NFR-02 (latency, applies to DB5-R02, DB5-R03, DB5-R09): WHEN the Verification_Suite measures GET /api/groups, GET /api/groups/:id/members and one history page on a fixture of 100 groups for one user, 200 members in the largest group and 10000 messages in one group on a local database, THE Group_API SHALL answer at the 95th percentile within 200 ms.
3. NFR-03 (indexing, applies to DB5-R02, DB5-R08, DB6-R03): THE Verification_Suite SHALL show with EXPLAIN QUERY PLAN that the documented list, history and search queries use an index and do not scan the whole of Messages, ConversationMembers or Attachments.
4. NFR-04 (direct isolation, applies to ARCH-R02): THE Verification_Suite SHALL show that the query plans of direct message history do not change after the group migrations.
5. NFR-05 (memory, applies to DB6-R02, DB6-R04): WHILE the Attachment_API handles an upload or download, THE Attachment_API SHALL use memory bounded by a constant chunk size independent of the file size.
6. NFR-06 (privacy of logs, applies to all): THE DATA_Application SHALL NOT write plaintext, ciphertext, keys, tokens, file names or absolute filesystem paths to logs, audit records or error responses.
7. NFR-07 (determinism, applies to DB5-R15): THE Verification_Suite SHALL use an injected clock, temporary directories and no network access, and SHALL pass on Windows and on Linux path conventions.
8. NFR-08 (response headers, applies to DB5-R12, DB6-R03): THE DATA_Application SHALL send the existing no-store, nosniff and content-security headers on every group and attachment response.
9. NFR-09 (dependencies, applies to all): THE Project_Team SHALL add a runtime dependency only when the handoff document records the package, the reason and the version.

## Compatibility Requirements

1. COMP-01: THE Verification_Suite SHALL keep at least 321 passing DATA tests in every phase (ARCH-R02).
2. COMP-02: THE DATA_Application SHALL keep the request and response shapes of every existing endpoint unchanged, and the existing OpenAPI documents SHALL change only by additions.
3. COMP-03: THE Canonical_DATA SHALL keep every existing row, including legacy rows and their origin flags, readable by the existing services (DB5-R14).
4. COMP-04: THE Schema_Migration files SHALL run on the SQLite engine, the better-sqlite3 version and the Node.js version that the repository already uses.
5. COMP-05: THE Documentation_Set SHALL describe rollback as restoring the pre-migration database copy, and SHALL describe disabling a switch as the rollback of function without data loss (DB5-R14, DB5-R16).
6. COMP-06: THE Group_Client SHALL keep the strict direct-message parser of GET /api/conversations unchanged and SHALL use the separate /api/groups namespace for groups.
7. COMP-07: THE Realtime_Bridge SHALL treat group events as additive messages that existing clients ignore without error.
8. COMP-08: THE DATA_Application SHALL keep every existing environment variable name and meaning, and SHALL document each new variable with a default that leaves the function disabled.
9. COMP-09: THE Storage_Provider SHALL handle Windows and POSIX paths and SHALL refuse Windows reserved device names and alternate data stream syntax in keys.
10. COMP-10: THE DATA_Application SHALL run unchanged under the Docker_Environment: one backend process started by npm --prefix server run start:data; the database file (DB_PATH) and the attachment storage directory (ATTACHMENT_STORAGE_DIR) on persistent named volumes; the attachment storage directory outside the working tree and not served statically; a non-root user; every new function disabled by default under the shipped compose configuration; and no new service, container, published port, volume, Dockerfile or Compose change required by DB-5 or DB-6 (PROPOSED; DB5-R14 criteria 21 to 24, DB5-R16, DB6-R02).

## Roadmap Traceability

| Roadmap line | Requirement IDs |
| --- | --- |
| DB-5 Goal: persist groups, membership and role permissions | DB5-R01, DB5-R02, DB5-R03, DB5-R05, DB5-R06, DB5-R11 |
| POST /api/groups | DB5-R01 |
| GET /api/groups/:id | DB5-R02 |
| PATCH /api/groups/:id | DB5-R02, DB5-R08 |
| GET /api/groups/:id/members | DB5-R03 |
| POST /api/groups/:id/members | DB5-R03, DB5-R04 |
| DELETE /api/groups/:id/members/:userId | DB5-R05 |
| POST /api/groups/:id/leave | DB5-R05 |
| Define owner/admin/member rules | DB5-R06, DB5-R03, DB5-R05 |
| Define member invitations | DB5-R04 |
| Define owner transfer | DB5-R06 |
| Define history visibility | DB5-R08 |
| Define removed-member behavior | DB5-R05, DB5-R08 |
| Reuse conversation/message storage; avoid a conflicting group-message model | DB5-R09, DB5-R14, ARCH-R01 |
| DB-5 Deliverable: group API contract | DB5-R13 |
| DB-5 Deliverable: role and membership tests | DB5-R15 |
| DB-5 DoD: groups persist after restart | DB5-R11 |
| DB-5 DoD: only authorized members view permitted history and act | DB5-R08, DB5-R12, DB5-R15, DB5-R16 |
| DB-6 Goal: secure attachment persistence and metadata-based Smart Files | DB6-R01, DB6-R02, DB6-R03, DB6-R04, DB6-R05 |
| Attachment storage abstraction (bytes outside SQLite where practical) | DB6-R02 |
| Metadata schema | DB6-R01 |
| POST /api/attachments | DB6-R03 |
| GET /api/attachments/:id | DB6-R03, DB6-R01 |
| GET /api/attachments/:id/download | DB6-R03 |
| GET /api/files/search | DB6-R03 |
| Validate size/type | DB6-R04, DB6-R05 |
| Authorize upload/download/search | DB6-R03, DB5-R12 |
| Handle partial uploads and retention/deletion | DB6-R03 |
| E2EE attachments: keep ciphertext and metadata; never silently decrypt or index private plaintext | DB6-R05 |
| DB-6 Deliverable: storage contract and endpoints | DB6-R02, DB6-R03 |
| DB-6 Deliverable: file authorization tests | DB5-R15 |
| DB-6 DoD: upload, metadata search, authorized download after restart | DB6-R04, DB6-R03 |
| Handoff checklist: merged code, endpoint list and OpenAPI, authorization rules and error codes, migration instructions and environment variables, test commands and results, known gaps | DB5-R13, DB5-R14, DB5-R15, ARCH-R02 |
| DB-1 DoD: fresh and repeat migrations succeed; constraints reject duplicates | DB5-R14 |
| DB-4: one shared message-write service, stable IDs, idempotency IDs, cursor pagination, membership checks, ciphertext and envelope storage | DB5-R09, DB5-R10 |
| DATA docs (db1-handoff.md:119-120, repositories.md:75-76): DB-5 owner, invitation, leave, removal, rejoin and history rules | DB5-R04, DB5-R05, DB5-R06, DB5-R08 |
| DATA docs (db1-handoff.md:119-120, repositories.md:75-76): DB-6 byte store, validation, access control, upload, download, search, retention | DB6-R02, DB6-R03, DB6-R04 |
| INFRA-01 Docker development environment (docs/docker-development.md; PROPOSED row added in the DB-5A reconciliation): migration testing in a Disposable_Project, Compose Watch rule, cold backup, rehearsal on a copy, Validation_Runner gate, Known_Baseline_Failure record, platform-dependent storage assertions, runtime compatibility, port naming | DB5-R14, DB5-R15, ARCH-R01, COMP-10 |

## Audit Finding Traceability

| Finding | Summary | Requirement IDs |
| --- | --- | --- |
| AF-01 | Standalone host not mounted in the real runtime and fails against a DATA database | ARCH-R01, ARCH-R03, DB5-R16 |
| AF-02 | DB-5 rebuilds legacy Messages with group_id instead of using DATA conversations | DB5-R09, DB5-R14, ARCH-R01, ARCH-R03 |
| AF-03 | Invitation issued before removal accepted after removal restores the member (P0) | DB5-R04, DB5-R05, DB5-R15 |
| AF-04 | Stale invitation accepted by the current owner leaves zero owners (P0) | DB5-R04, DB5-R06, DB5-R12, DB5-R15 |
| AF-05 | Duplicate pending invitations allowed | DB5-R04, DB5-R14, DB5-R15 |
| AF-06 | Direct add bypasses consent, friendship and block rules; admin can add admin | DB5-R03, DB5-R04, DB5-R06 |
| AF-07 | No role-change endpoint | DB5-R06 |
| AF-08 | Group message endpoint stores any string as ciphertext | DB5-R09, DB5-R16 |
| AF-09 | No client message ID or idempotency; no cursor or sequence | DB5-R09 |
| AF-10 | No group read or delivery state | DB5-R10, DB5-R09 |
| AF-11 | POST /api/groups without a body returns 500 | DB5-R01, DB5-R13 |
| AF-12 | Host enforces no session, CSRF or Origin | DB5-R12, ARCH-R01 |
| AF-13 | No group API contract or OpenAPI | DB5-R13, DB5-R02 |
| AF-14 | Re-adding a member resets joined_at; history policy undefined | DB5-R08, DB5-R05 |
| AF-15 | Attachments stored in plaintext; client requires null encryption algorithm | DB6-R05 |
| AF-16 | Attachments lack conversation and message association; table name collides | DB6-R01, ARCH-R01, ARCH-R03 |
| AF-17 | Direct upload has no friendship or block check | DB6-R03 |
| AF-18 | Declared MIME not checked against bytes | DB6-R05, DB6-R03 |
| AF-19 | Storage failures leak absolute filesystem paths | DB6-R02, DB6-R03, DB5-R13 |
| AF-20 | No per-user quota or upload rate limit | DB6-R04 |
| AF-21 | Removed member keeps access to own uploads | DB6-R03, DB5-R05, DB5-R08 |
| AF-22 | Retention cleanup is a manual script | DB6-R03 |
| AF-23 | No real-account group UI; attachment flag false; rewrites missing | DB5-R16, DB6-R05 |
| AF-24 | Realtime bridge and E2EE protocol are direct-message only | DB5-R09, DB5-R05, DB5-R16, ARCH-R02 |
| AF-25 | Integrated end-to-end verification blocked | DB5-R15, DB5-R16, DB6-R04, ARCH-R02 |
| AF-26 | Reusable teammate code and tests | DB6-R02, DB5-R15, ARCH-R03 |

## Unresolved Owner Decisions

Each item below needs a recorded Project_Owner decision before the named requirement is enabled for Real_Accounts. The last column states the provisional behavior that applies until the decision exists. DB5-R16 criterion 7 prevents enabling a switch while a required setting is unset. A last-column entry that starts with DECIDED or DECIDED IN PART records a decision approved in the DB-5A reconciliation; what remains open in that row keeps its provisional behavior.

| ID | Decision needed | Affected requirements | Provisional safe behavior until decided |
| --- | --- | --- | --- |
| OD-01 | Consent model for adding members: invitation only, or owner/admin direct add; whether friendship with the inviter is required | DB5-R03, DB5-R04 | DECIDED IN PART: direct add stays disabled as an owner decision (503 FEATURE_UNAVAILABLE) and membership starts only through an accepted Invitation. STILL OPEN: whether friendship with the inviter is required; until decided, block rules always apply and there is no friendship rule beyond blocks |
| OD-02 | Which roles may invite or add: owner and admin only, or any member | DB5-R03, DB5-R04 | Owner and admin only |
| OD-03 | Admin permissions (edit metadata, cancel others' Invitations, remove admins, delete others' attachments) and the role of the former owner after a transfer | DB5-R03, DB5-R05, DB5-R06, DB6-R03 | Matrix in DB5-R06; former owner becomes admin |
| OD-04 | Maximum active members per group | DB5-R03, DB5-R04, DB5-R16 | DECIDED: the maximum is 50 active members per group, supplied as a configuration value; the Group_API cannot be enabled while that setting is unset (fail-closed, DB5-R16 criterion 7) |
| OD-05 | History policy options, default for new groups, who may change the policy, and whether a change applies to earlier messages | DB5-R02, DB5-R08, DB5-R16 | DECIDED: the values are exactly all and from_joined; the default is from_joined; the policy is chosen at group creation (POST /api/groups, optional historyPolicy) and is immutable afterwards (PATCH /api/groups/:id answers 400 VALIDATION_ERROR to historyPolicy) |
| OD-06 | Rejoin behavior: visibility of the gap while removed, and of messages from earlier Membership_Intervals | DB5-R05, DB5-R08 | Gap never visible; messages from the member's own earlier intervals stay visible; no access beyond what the member already had |
| OD-07 | Visibility to remaining members of content authored by a departed member, and whether a departed member may delete own content | DB5-R05, DB5-R08, DB6-R03 | Authored messages and files stay visible to remaining members; no deletion by the departed member |
| OD-08 | Invitation expiry duration, maximum pending Invitations per group and per invitee, and any re-invite delay after a decline | DB5-R04, DB5-R16 | DECIDED IN PART: the Invitation expiry is 7 days (604,800 seconds). STILL UNRESOLVED, no default: the maximum pending Invitations per group, the maximum pending Invitations per invitee and any re-invite delay after a decline; the Group_API cannot be enabled while the two maximum settings are unset (DB5-R16 criterion 7) |
| OD-09 | Group deletion versus archive-only, unarchive, and retention of data after archive | DB5-R07 | Archive supported; no deletion route; no unarchive route; no data removed |
| OD-10 | Owner departure: automatic transfer, handling of a disabled or removed owner account, orphan groups | DB5-R05, DB5-R06, DB5-R07 | The owner cannot leave; no automatic transfer |
| OD-11 | Behavior when two existing co-members block each other | DB5-R03, DB5-R04 | Blocks only prevent adding, inviting and accepting between the pair; existing co-membership is unchanged |
| OD-12 | Exposure of read state: private per-member position, or receipts visible to other members | DB5-R10 | Private per-member position; no other member's position returned |
| OD-13 | Moderation: who may tombstone another member's message or delete another member's attachment | DB5-R09, DB6-R03 | Sender or uploader only |
| OD-14 | Attachment retention: pending upload expiry, purge delay after deletion, Retention_Job interval | DB6-R01, DB6-R03 | No default; the Attachment_API cannot be enabled while unset; ready attachments are not purged automatically |
| OD-15 | Quota and limit values: per-user bytes, per-conversation bytes, pending count, upload rate, concurrent uploads, and confirmation of the client size policy as the server limit | DB6-R04 | Size limits equal the client policy; the Attachment_API cannot be enabled while quotas are unset |
| OD-16 | Whether plaintext attachments are ever permitted, the media type allowlist, and content scanning | DB6-R05 | Plaintext refused; no scanning; no allowlist |
| OD-17 | Scope of server-side file search over encrypted metadata, including disclosure of a media type class | DB6-R03, DB6-R05 | Filters limited to conversation, uploader, size range and time range; file name and content search refused |
| OD-18 | Attachment access after message tombstone, after the uploader's removal, and after group archive | DB6-R03 | Remaining members keep access; removed members lose access; tombstone does not delete attachments |
| OD-19 | Group key model for protected group messaging (selection and review) | DB5-R09, DB5-R16 | None selected; group messaging stays disabled |
| OD-20 | Whether any data of the Standalone_Implementation database must be migrated into DATA | DB5-R14, DB6-R01, ARCH-R03 | No data migrated; the standalone file stays untouched |
| OD-21 | Whether the server may see which attachments belong to which message (association outside the encrypted content), or only a separate authenticated association request | DB6-R01, DB6-R05 | Association by an explicit authenticated request that references a committed message; DB-6C review decides the final form |

### Decisions recorded in the DB-5A reconciliation

The Project_Owner approved the decisions below after the Docker development environment (PR #19) was merged. Each row names the criteria that apply it. Every OD item not listed here stays in the table above, unchanged and visible, with its provisional behavior.

| ID | Recorded decision | Applied in |
| --- | --- | --- |
| OD-01 (part) | Direct add of members stays disabled and answers 503 FEATURE_UNAVAILABLE; membership starts only through an accepted Invitation. Whether friendship with the inviter is required stays open, with the default of no friendship rule beyond blocks. | DB5-R03 criteria 5 and 6 |
| OD-04 | The maximum number of active members per group is 50, supplied as a configuration value. The Group_API still cannot start with its switch enabled while that value is unset (fail-closed). | DB5-R03 criterion 12; DB5-R16 criterion 7 |
| OD-05 | The History_Policy values are exactly all and from_joined; the default is from_joined; the policy is chosen at group creation and is immutable afterwards. Consequence: POST /api/groups accepts an optional historyPolicy (any other value gives 400 VALIDATION_ERROR); PATCH /api/groups/:id accepts no historyPolicy and answers 400 VALIDATION_ERROR with the field named and no record changed; the role matrix refuses a policy change for every role. This consequence is derived from OD-05; confirmed at the DB-5C API contract approval. | DB5-R01 criteria 1, 7, 10, 14 and 15; DB5-R02 criteria 10 and 13; DB5-R06 role matrix; DB5-R07 criterion 2; DB5-R08 criteria 1 and 2 |
| OD-08 (part) | The Invitation expiry is 7 days (604,800 seconds). The maximum pending Invitations per group, the maximum pending Invitations per invitee and any re-invite delay after a decline stay unresolved with no default; the Group_API cannot start with its switch enabled until the two maximum settings exist. | DB5-R04 criteria 1 and 18; DB5-R16 criterion 7 |
| OP-06 | Exactly seven migration-ledger literals in baseline tests may change when a migration is added, in the same commit as the migration, with guard tests that fail on any other changed baseline line. | DB5-R15 criterion 11; ARCH-R02 criterion 1 |

Later owner-approved baseline exception (separate from OP-06): only `DATA/tests/support/auth.js` may use the exact Task 2.24 SHA-256 `0d7996a8bef3be2703bfbb40dfe3c170efb3571a9bfdd6077832de2ef50bcc6f` from commit `85730dd442a570a0b4756847ce34f9300ecfb71f`. The immutable d7cd40a manifest retains the original hash `e9910b540e2078a34ff77763c95a00090a02a9d323fe239ecb40a96e69ac08d7`. All other `auth.js` hashes and all other baseline tests and support files remain strictly checked.
| DK-01 | The Validation_Runner (Docker Linux) is the primary regression gate. The two known Windows client failures are recorded separately as Known_Baseline_Failure entries and are never suppressed. | DB5-R15 criteria 10, 14, 15 and 16 |
| DK-02 | The local branch is fast-forwarded to origin/main dc6c997, preserving local changes and stashes. | Baseline section |
| DK-03 | Migration testing uses isolated Disposable_Project projects and volumes. | DB5-R14 criteria 17, 21 and 24 |
| DK-04 | Docker Compose Watch is disabled while Schema_Migration files are drafts. | DB5-R14 criterion 22; Explicit Exclusions 11 |
| DK-05 | The existing Docker cold-backup procedure is used. | DB5-R14 criteria 20 and 23 |
| DK-06 | The optional database backup helper (task T-5B-34) is dropped. | No requirement; DB5-R14 criterion 23 names the existing procedure |
| DK-07 | The rehearsal on a copy (task T-5B-35) uses synthetic fixtures or an isolated cold-backup copy, never the live database. | DB5-R14 criterion 24 |

Group messaging and protected attachments stay disabled until their security designs (DB-5D, DB-6C) and the owner Gate_Records are approved (DB5-R16 criteria 6 and 8; DB6-R05 criterion 8).

### Amendments awaiting owner approval at their phase

These are requirement amendments awaiting owner approval at their phase. The criteria named below are unchanged in this document. Each row records an amendment that the Project_Owner has not yet approved and the phase at which the approval is due.

| ID | Source | Criteria concerned | Pending amendment | Approval phase |
| --- | --- | --- | --- | --- |
| OA-01 | CI-02, OP-05 | DB6-R03 criterion 2; DB5-R15 criterion 9 | Blocked direct pair: the baseline direct path answers 404 NOT_FOUND for a block and 403 FORBIDDEN for a pair that are not friends, while the criteria say 403 for a block. The text stays unchanged until the Project_Owner approves the amendment. | DB-6A |
| OA-02 | CI-03, OP-03 | DB6-R03 criterion 1; DB6-R05 criterion 12 | Upload frame wording: one POST with a byte stream and up to 16384 characters of encrypted metadata cannot carry the metadata in request headers. The wording stays unchanged until the wire format of the upload frame is approved. | DB-6A |
| OA-03 | CI-10, OP-13 | DB5-R15 criterion 11; ARCH-R03 criterion 9 | Exception for adapting the 76 client attachment tests at DB-6E against the rule that no baseline test is weakened, with a stricter replacement for each changed assertion. | DB-6E |
| OA-04 | CI-11, OP-12 | DB5-R16 criteria 8 and 11; DB6-R05 criterion 8 | A marker for "before DB-5F" in DB5-R16 criterion 11, and the decision which Gate_Records enable the Attachment_API (the requirements name only the DB-6C security review record, and no stage covers DB-6D or DB-6E). | DB-5F and DB-6E (marker); DB-6F (records) |

## Explicit Exclusions

1. No implementation in DB-0/DB-5A. This document changes no source file, migration or database.
2. No new cryptographic protocol, key format or envelope format. Protected group messaging (DB-5D) and protected file handling (DB-6C) are separate review gates.
3. No enabling of incomplete group messaging or file sharing for Real_Accounts.
4. No second database, second server process or second authentication system.
5. No modification of published migrations 0001 to 0007.
6. No change to Phase 8.8 behavior, including direct messaging, the key directory and the strict direct-message contract of GET /api/conversations.
7. No deletion of the Standalone_Implementation code or tests.
8. No frontend work in DB-5B and DB-5C.
9. No public rooms, mentions, group avatars or bots.
10. No change to unrelated DATA modules.
11. No new Docker services, ports or Compose changes, and no use of Docker Compose Watch while a Schema_Migration is a draft.
