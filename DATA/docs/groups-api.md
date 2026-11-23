# Group API

The Group API is a local, feature-gated interface. The server obtains the actor only from the authenticated session. State-changing requests require a session-bound CSRF proof. Responses use camelCase JSON, `Cache-Control: no-store`, and errors shaped as `{ "code": "...", "fields": [] }`. Unknown groups and groups not visible to the caller share the same `404 NOT_FOUND` response.

## Routes

`GET /api/groups/feature-status` (G26) requires a session and returns exactly `groupApi`, `groupMessaging`, and `attachmentApi` booleans; it remains available while features are disabled.

| ID | Method and path | Request | Minimum role / visibility | Success | Additional errors |
|---|---|---|---|---|---|
| G01 | `POST /api/groups` | `name`, optional `description`, optional `historyPolicy`, `idempotencyKey` | authenticated | 201; idempotent replay 200 | 400, 409 `IDEMPOTENCY_CONFLICT` |
| G02 | `GET /api/groups` | optional paging query | active member | 200 | 400 |
| G03 | `GET /api/groups/:id` | none | active member | 200 | 404 |
| G04 | `PATCH /api/groups/:id` | `name`, `description`, `membershipRevision`; `historyPolicy` is forbidden | owner | 200 | 400, 404, 409 |
| G05 | `GET /api/groups/:id/members` | optional `former=true` | member; owner/admin for former members | 200 | 400, 403, 404 |
| G06 | `POST /api/groups/:id/members` | `userId` | admin | 201 when test-injected direct-add feature allows it | default 503; 404, 409 |
| G07 | `DELETE /api/groups/:id/members/:userId` | none | owner/admin; admin removes members only | 204 | 403, 404, 409 |
| G08 | `PATCH /api/groups/:id/members/:userId` | `role`, `membershipRevision` | owner | 200 | 403, 404, 409 |
| G09 | `POST /api/groups/:id/leave` | none | active member; owner cannot leave | 204 | 403, 404, 409 |
| G10 | `POST /api/groups/:id/transfer` | `userId`, `membershipRevision` | owner | 200 | 403, 404, 409 |
| G11 | `POST /api/groups/:id/archive` | none | owner | 200 | 403, 404, 409 |
| G12 | `POST /api/groups/:id/invitations` | `userId` | owner/admin | 201 | 403, 404, 409 |
| G13 | `GET /api/groups/:id/invitations` | optional paging query | owner/admin | 200 | 403, 404 |
| G14 | `DELETE /api/groups/:id/invitations/:invitationId` | none | inviter, owner or admin | 204 | 403, 404, 409 |
| G15 | `GET /api/groups/invitations` | optional paging query | invitation recipient | 200 | 400 |
| G16 | `POST /api/groups/invitations/:invitationId/accept` | none | invitation recipient | 200 | 404, 409 |
| G17 | `POST /api/groups/invitations/:invitationId/decline` | none | invitation recipient | 204 | 404, 409 |

Common errors are `401 UNAUTHENTICATED` / `SESSION_EXPIRED`, `403 FORBIDDEN` / `CSRF_INVALID`, `400 VALIDATION_ERROR`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `429 RATE_LIMITED`, `500 INTERNAL_ERROR`, and `503 FEATURE_UNAVAILABLE` / `SERVICE_UNAVAILABLE`. A malformed body with an unsupported charset is rejected as 415 before JSON syntax validation. G04 rejects `historyPolicy` with 400 `VALIDATION_ERROR` and names it in `fields`; no PATCH role can change history policy. G06 stays unavailable by default and can be enabled only through the permitted test injection.

## Projections and policy

The common error pairs in the route table apply to every route; `CSRF_INVALID` applies only to state-changing methods. Additional route-specific pairs are:

| ID | Success pairs | Additional pairs |
|---|---|---|
| G01 | 201 success, 200 success | 409 `IDEMPOTENCY_CONFLICT` |
| G02 | 200 success | none |
| G03 | 200 success | 404 `NOT_FOUND` |
| G04 | 200 success | 404 `NOT_FOUND`; 409 `CONFLICT`, `STALE_STATE` |
| G05 | 200 success | 404 `NOT_FOUND` |
| G06 | 201 success | 404 `NOT_FOUND`; 409 `CONFLICT` |
| G07 | 204 success | 404 `NOT_FOUND`; 409 `CONFLICT` |
| G08 | 200 success | 404 `NOT_FOUND`; 409 `CONFLICT`, `STALE_STATE` |
| G09 | 204 success | 404 `NOT_FOUND`; 409 `CONFLICT` |
| G10 | 200 success | 404 `NOT_FOUND`; 409 `CONFLICT`, `STALE_STATE` |
| G11 | 200 success | 404 `NOT_FOUND`; 409 `CONFLICT` |
| G12 | 201 success | 404 `NOT_FOUND`; 409 `CONFLICT` |
| G13 | 200 success | 404 `NOT_FOUND` |
| G14 | 204 success | 404 `NOT_FOUND`; 409 `CONFLICT` |
| G15 | 200 success | none |
| G16 | 200 success | 404 `NOT_FOUND`; 409 `CONFLICT` |
| G17 | 204 success | 404 `NOT_FOUND`; 409 `CONFLICT` |
| G26 | 200 success | none |

## Request and response schemas with examples

The machine-readable schemas and executable examples are in [`groups-openapi.json`](groups-openapi.json). The schema names below are the OpenAPI component names; query parameters are `limit` and `cursor` where paging applies, plus `former` for G05.

| ID | Request schema / example | Response schema / example |
|---|---|---|
| G01 | `CreateGroupRequest`: `{ "name": "Project group", "description": "Planning", "historyPolicy": "all", "idempotencyKey": "create-project-1" }` | `{ "group": GroupProjection }` |
| G02 | No body; `limit=20` | `GroupPage`: `{ "items": [GroupSummary], "nextCursor": null }` |
| G03 | No body | `{ "group": GroupProjection }` |
| G04 | `UpdateGroupRequest`: `{ "name": "Updated group", "membershipRevision": 1 }` | `{ "group": GroupProjection }` |
| G05 | No body; `former=true` is manager-only | `MemberPage`: `{ "items": [MemberProjection], "nextCursor": null }` |
| G06 | `MemberRequest`: `{ "userId": "user-2" }` | `MemberEnvelope`: `{ "member": MemberProjection }` |
| G07 | No body | 204 with an empty body |
| G08 | `RoleRequest`: `{ "role": "admin", "membershipRevision": 1 }` | `MemberEnvelope`: `{ "member": MemberProjection }` |
| G09 | No body | 204 with an empty body |
| G10 | `TransferRequest`: `{ "userId": "user-2", "membershipRevision": 1 }` | `{ "group": GroupProjection }` |
| G11 | No body | `{ "group": GroupProjection }` |
| G12 | `InvitationRequest`: `{ "userId": "user-2" }` | `InvitationEnvelope`: `{ "invitation": ManagerInvitation }` |
| G13 | No body; `limit=20` | `ManagerInvitationPage`: `{ "items": [ManagerInvitation], "nextCursor": null }` |
| G14 | No body | 204 with an empty body |
| G15 | No body; `limit=20` | `OwnInvitationPage`: `{ "items": [OwnInvitation], "nextCursor": null }` |
| G16 | No body | `{ "group": GroupProjection }` |
| G17 | No body | 204 with an empty body |
| G26 | No body | `FeatureStatus`: `{ "groupApi": false, "groupMessaging": false, "attachmentApi": false }` |

`GroupProjection` contains `historyPolicy`; G02 adds `unreadCount`. G05 omits former-member `leftAt` unless `former=true`; G13 and G15 use distinct manager and invitee projections. The OpenAPI conformance suite validates request, success and error examples with `support/schema-check.js`.

Group projections use `historyPolicy` and `membershipRevision`; member and invitation projections expose only their documented public fields. G01 accepts `historyPolicy: "all"` or `"from_joined"`; omission means `"from_joined"`. The policy is immutable after creation and included in the idempotency fingerprint (label v2). Invitation expiry is a fixed 604,800 seconds. There is no delete or unarchive route. Archived groups retain reads and allow a member to leave; other mutations are refused. Direct add answers 503 outside its explicit test injection.

## Configuration and local testing

`GROUP_MAX_MEMBERS` is required when enabled; the approved value is 50. `GROUP_MAX_PENDING_INVITATIONS_PER_GROUP` and `GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE` are required settings with no defaults. The Project Owner approved policy/configuration values of 20 per group and 10 per invitee; these values are not populated by this example or applied to production configuration. Missing or invalid settings fail closed. There is no `GROUP_INVITATION_TTL_SECONDS` setting. Group API and messaging switches default to false; no committed environment file enables them. Gate identifiers use `GR-<stage>-<date>` and a production acknowledgement, when configured, is format-checked as `GR-[A-Z0-9-]{3,48}`.

In the Docker development environment all requests reach DATA from the shared source `127.0.0.1`; per-source rate-limit buckets are therefore shared among local browser users, while per-user buckets remain separate. The configurable per-source defaults are 240 reads/minute, 120 mutations/minute, 60 invitation creations/hour, and 60 group creations/hour. Forwarded headers are not trusted. Enable a feature for manual testing only with a temporary override file outside the repository; do not edit `compose.yaml`. DATA changes reach a running container through `docker compose up --build` or Compose Watch, but never use Compose Watch while a migration file is a draft. Before the first start containing a new migration against data to keep, make the cold backup of both volumes using the procedure in `docs/docker-development.md`.

## DB-5D verifier contract

The frozen verifier interface is `verifyEnvelope(actor, envelope, {conversationId, recipientIds, membershipRevision, fingerprint})`. It has a 2000 ms deadline and a 32-call concurrency cap. `testOnly` is refused in production. Group messaging remains disabled until its security design and Gate_Record are approved.
