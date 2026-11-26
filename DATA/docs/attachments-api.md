# Canonical Attachment API (T-6A-06, T-6A-09, T-6A-18)

**Status:** Proposed DB-6A contract. The Project Owner approved OA-01, OA-02 and the DB-6A policy values below. OD-21 remains provisional pending DB-6C review. This document does not edit the canonical requirements or enable routes.

All routes use the authenticated DATA session and standard JSON error shape `{ code, fields }`. Mutations require session-bound CSRF proof. A disabled Attachment_API returns `503 FEATURE_UNAVAILABLE` before database/storage access. A01 reads at most the bounded frame header described in `attachments-upload-frame.md`; it reads no content bytes and creates no row/reservation before authorization and gate checks. Authorization uses session identity only.

## Routes A01–A06

| ID | Method and path | Authorization | Request | Success response | Route-specific errors and lifecycle |
|---|---|---|---|---|---|
| A01 | `POST /api/attachments` | Active member of the named conversation; direct conversation must satisfy its direct-send rule | One ADR-09 framed body | `201 { attachment }`, status `pending` | `400 VALIDATION_ERROR` for malformed frame, size mismatch, or missing/invalid protected declaration; `404 NOT_FOUND` for a block in either direction, `403 FORBIDDEN` for an unblocked non-friend; `404 NOT_FOUND` for inaccessible conversation/member; `409 CONFLICT` for archived group; `409 QUOTA_EXCEEDED`; `413 PAYLOAD_TOO_LARGE`; `429 RATE_LIMITED` with `Retry-After`; `503 SERVICE_UNAVAILABLE` for storage/database failure. No retry idempotency: a new request creates a new pending record. |
| A02 | `POST /api/attachments/associations` | Authenticated uploader | JSON `{ conversationId, messageId, attachmentIds: [1..5] }` | `200 { attachments }`; all become `ready` atomically | All attachments must be pending, unexpired, same conversation/uploader, unassociated, and name a committed message sent by that uploader. Existing associations count toward the 5-file/100 MiB whole-message limit in the same transaction (approved OP-02 limit). `400` for invalid count/size; `404` for missing/other-conversation/other-uploader; `409 CONFLICT` for stale lifecycle, expiry, existing association, or uncommitted message. Retry after success is `409`. Archived-group association is `409`. Form remains provisional until OD-21 review. |
| A03 | `GET /api/attachments/:id` | Uploader for `pending`; active member within permitted history ranges for `ready` | none | `200 { attachment }` | One uniform `404 NOT_FOUND` for unknown or unauthorized. Pending metadata is visible only to its uploader; pending downloads are never allowed. |
| A04 | `GET /api/attachments/:id/download` | Active member within permitted ranges; attachment must be `ready` | none | `200` opaque bytes | Before the first byte, re-check membership, lifecycle, range and stored byte length. Missing or wrong-length bytes produce `503 SERVICE_UNAVAILABLE` and an audit event. Inaccessible/unknown attachment is the same `404`. Headers: `Content-Type: application/octet-stream`, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, and exact `Content-Length`. |
| A05 | `DELETE /api/attachments/:id` | Uploader only under the approved OD-18 policy | none | `204`; retain metadata with `status=deleted`, deletion time and purge state | `404` for unknown/not permitted; repeat is `404`. Bytes are removed; metadata remains. Uploader deletion remains allowed for an archived group under the approved access policy; this does not grant access to bytes or metadata. |
| A06 | `GET /api/files/search?conversationId&uploadedBy&minBytes&maxBytes&createdAfter&createdBefore&limit&cursor` | Active member; results constrained by membership and permitted history ranges | Query only; default limit 20, range 1–50 | `200 { items, nextCursor }`; ready rows newest-first | Unknown filters, filename/content filters, invalid ranges, invalid limit, malformed/foreign cursor: `400 VALIDATION_ERROR`. Only conversation, uploader, byte-size range and creation-time range are allowed. `/api/files` has no upload or download alias; only `GET /api/files/search` is defined. |

Attachment response projection is `{ id, conversationId, messageId, uploadedBy, byteSize, status, createdAt, expiresAt, integrityDigest, algorithm, formatVersion, encryptedMetadata }` (`messageId` and `expiresAt` may be null while pending). Never return `storage_key`, a filesystem path, or storage-root detail. Error responses never include filenames, content, SQL, paths, or operating-system text. Every state-changing operation, including audit insertion, commits atomically or rolls back; storage compensation removes bytes/reservations after failure.

### Direct pair rule — owner-approved OA-01 / DC-02

`DB6-R03.2` currently specifies `403 FORBIDDEN` when a direct pair is blocked or fails the direct-message rule. The existing direct-message path instead returns `404 NOT_FOUND` for a block and `403 FORBIDDEN` when the pair are not friends. **Owner-approved amendment (2026-11-23):** preserve that established behavior for attachments: a block in either direction returns 404, and a non-friend pair without a block returns 403. A 404 does not reveal the block. Baseline evidence: `DATA/tests/messaging-security.test.js` (blocked pair cases around lines 51–58) and `DATA/tests/conversations-security.test.js` (direct visibility case around line 73). DB6-R03.2 and DB5-R15.9 retain their published wording pending a separate requirements edit. The attachment security tests must use the approved baseline literals.

## Decisions and defaults (not owner decisions)

The owner confirmed OD-14 through OD-18 and OD-20 for DB-6A. OD-21 is provisional until DB-6C. OP-02 limits are approved. Numerical policy values require explicit configuration.

| Decision | Provisional behavior in force | Settings/code affected | Switch impact / phase |
|---|---|---|---|
| OD-14 | Owner-approved policy: pending TTL 86400 s, purge delay 86400 s from eligibility, scan interval 3600 s. Expired rows become inaccessible immediately; ready attachments are not automatically purged | `ATTACHMENT_PENDING_TTL_SECONDS`, `ATTACHMENT_PURGE_DELAY_SECONDS`, `ATTACHMENT_RETENTION_INTERVAL_SECONDS` | Explicit configuration required before activation; no automatic production defaults |
| OD-15 | Owner-approved OD-15 / OP-04 policy (2026-11-23): `ATTACHMENT_QUOTA_USER_BYTES=1073741824`, `ATTACHMENT_QUOTA_CONVERSATION_BYTES=5368709120`, `ATTACHMENT_MAX_PENDING_PER_USER=10`, `ATTACHMENT_UPLOADS_PER_HOUR=30`, `ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_USER=2`, `ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_SOURCE=5`, `ATTACHMENT_UPLOAD_TIMEOUT_SECONDS=120`. These settings require explicit configuration. The existing process timeout is 15 s; a future raised timeout applies process-wide while enabled. See the 4.673 s proxy measurement in the handoff for buffering and timeout evidence. Under DB6-R04.4 and design P-34, reserve against pending and ready bytes plus live reservation bytes in one immediate transaction; atomically replace a reservation at finalize without double-counting. Release each reservation and concurrency slot exactly once on its applicable completion, refusal, abort or expiry path. Pending TTL remains 86400 s. Derive source identity only under trusted proxy configuration: the existing Docker project uses the socket peer 127.0.0.1, one shared bucket, without trusting forwarded headers. Preserve canonical authorization and refusal order. | A01 reservations | Explicit configuration required before activation |
| OD-16 | Plaintext refused; no allowlist or content scanner | attachment validation | Confirmed for DB-6B; final review at DB-6C |
| OD-17 | Conversation/uploader/size/time filters only; no filename/content search or media-type class | A06 query contract | DB-6C decision; media class would require a later migration |
| OD-18 | Remaining members retain access after tombstone/uploader departure/archive; removed members lose access; only uploader deletes | A03–A05 authorization | DB-6C decision and DB-6D hardening |
| OD-19 | No group key model selected; group messaging remains disabled | DB-5D group message verifier | Not an attachment default; independent security gate |
| OD-20 | No standalone attachment rows are copied and standalone database is not opened or changed | migration/import scope | Shared decision with T-5G-02; must be recorded before final inventory |
| OD-21 | Provisional explicit authenticated A02 after the message commits | association endpoint and transaction | DB-6B/6D may use this form; final review at DB-6C |

| Open point | Current proposal/default | Decision phase |
|---|---|---|
| OP-02 | Approved: five attachments and 104857600 bytes across the entire message, including earlier associations. Check both limits atomically for concurrent requests | Association form reviewed at DB-6C |
| OP-03 | ADR-09 frame approved under OA-02 | DB-6E client adaptation |
| OP-04 | Owner approved 120 seconds when explicitly configured; current process stays at 15 seconds | DB-6A decision; see measured T-6A-24 |
| OP-05 | Existing direct path: 404 for blocks, 403 for non-friends; approved DC-02 text above | DB-6A |
| OP-08 | Approved: reservations expire at the pending TTL, including after a crash. Release each expired reservation exactly once | DB-6A with OD-14 |
| OP-10 | Independent reviewer not yet named | Before DB-6C review |
| OP-12 | Proposed requirement: both `ATTACHMENTS-PROTECTED` and `DB6-ACCEPTANCE` before attachment switch/client readiness for Real_Accounts | DB-6D/DB-6F |
| OP-13 | Client test adaptation requires owner acknowledgement and stricter replacement assertions | DB-6E |

## OA-01–OA-04 requirement amendments awaiting their phase

| Amendment | Criteria | Text currently in force | Proposed handling / approval phase |
|---|---|---|---|
| OA-01 (CI-02, OP-05) | DB6-R03.2, DB5-R15.9 | Requirement says 403 for blocked pair; direct implementation uses 404 for block and 403 for non-friends | Approved DC-02 above; owner decision recorded; requirements remain unchanged until separately amended |
| OA-02 (CI-03, OP-03) | DB6-R03.1, DB6-R05.12 | Single request carrying opaque content and bounded metadata | Owner approved ADR-09 frame; separate requirements edit pending |
| OA-03 (CI-10, OP-13) | DB5-R15.11, ARCH-R03.9 | The 76 plaintext-contract client tests remain frozen | Acknowledge exception and preserve stricter replacements at DB-6E |
| OA-04 (CI-11, OP-12) | DB5-R16.8/11, DB6-R05.8 | Gate requirements conflict on which records enable attachment routes and readiness | Owner acknowledgement at DB-5F/DB-6E; record set settled at DB-6F |

See the DB-6A decision log in `db5-db6-handoff.md`: T-6A-05 covers OA-02, T-6A-10 covers OA-01, T-6A-11/12 cover retention and quotas, and T-6A-13 through T-6A-17 cover OD-16, OD-17, OD-18, OD-20 and OD-21 respectively. Approved policy values require explicit configuration before use.
