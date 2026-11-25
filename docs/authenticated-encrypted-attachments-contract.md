# Phase 8: encrypted file delivery requires owning-team contracts

**Historical audit. Phase 8B now implements the authenticated composition and private file
protocol described in [the implementation and team review contract](authenticated-encrypted-attachments.md).
The findings below describe the pre-8B gaps and the legacy plaintext/standalone DB6 paths.**

At the end of the original Phase 8 audit, authenticated attachments remained disabled in
`REAL_ACCOUNT_MESSAGING_CAPABILITIES`. That audit added boundary/regression tests without enabling
an upload path or adding a migration. Phase 8B resolves these gaps through the composition linked above.

## Implementation inspected before Phase 8B

| Source | Pre-8B behavior / gap |
| --- | --- |
| `MessageComposer.tsx`, `useAttachmentDrafts.ts` | Reusable selection/drop, validation, previews, staged upload/discard and retry caching. Real mode is text-only and rejects attachment extras. |
| `MessageAttachmentView.tsx`, `AttachmentPreviewDialog.tsx`, `AttachmentDownloadLink.tsx`, `useAttachmentSource.ts` | Existing image/lightbox, video, PDF and original-document downloads. Remote bytes are treated as plaintext; no file decryption or key context exists. |
| `client/src/messaging/attachmentUpload.ts` | Uploads the original `File` as the raw request body, with its name/MIME in headers. Reads a static meta CSRF token, rather than the active DATA session API. This uploader must not be connected to real E2EE conversations. |
| `client/src/messaging/db6Attachments.ts` | Deliberately accepts only DB6 rows with `encryption_algorithm === null`. Encrypted DB6 rows are not a supported plaintext file reference. |
| `client/src/messaging/attachmentDownload.ts` | Checks file length/signature but does not decrypt or verify an AEAD file tag. Ciphertext cannot be rendered directly as a file Blob. |
| `server/api-main.cjs`, `server/src/api-app.cjs`, `server/src/middleware/requireAuth.cjs` | DB6 requires an injected `AUTH_MIDDLEWARE_MODULE` producing trusted `req.user.user_id`. No adapter gives 503. DATA instead supplies `req.auth` and `req.csrfProof`; neither is automatically consumed by DB6. The checked local configuration contains no DB6 adapter setting. |
| `server/src/routes/attachment.cjs` | Stores opaque binary and optional encryption fields; encrypted uploads hide the original name. It does not validate an approved algorithm/IV/tag/key-manifest format, enforce DATA conversations/blocks, bind a file to a DATA message, or enforce CSRF itself. Those guarantees would have to come from a verified host/contract. |
| `server/src/db5db6/db.cjs` versus DATA migrations/repositories | Separate databases, user foreign keys and incompatible Attachments/Messages schemas. Existing DATA account IDs are not DB6 account rows. Pointing DB6 at DATA's SQLite file is not a supported integration. |
| `client/authProxy.cjs`, `HttpAuthService.createSessionApi` | No authenticated attachment rewrites or binary request/response contract. The shared DATA request API accepts JSON bodies/results and rejects attachment paths. |
| `client/src/security/e2ee/messages.ts`, `session.ts` | Approved V2 text encryption, nonce reservation, signed key epochs and exact-envelope retry. Text is limited to 49,136 UTF-8 bytes. There is no encrypted binary/chunk/file-key protocol. Increasing text limits or base64-embedding large files would not reuse DB6 safely. |
| `client/src/messaging/authenticatedContent.ts` | The current version supports text, Reply and Forward metadata. File manifests/key descriptors are not accepted. A compatible protected content version is needed. |

DB6's `x-encryption-algorithm` flag means it stores supplied opaque bytes; it does **not** prove that
the client encrypted a file, authenticated its metadata, or delivered its key safely. Existing DB6
tests use test authentication and do not establish a production DATA authentication bridge.

## Contracts identified for implementation

1. **Database/auth integration:** a trusted DATA-to-DB6 composition with an explicit account-identity
   mapping and migration/provisioning policy. Preserve both databases and existing accounts; do not
   seed test users, copy credentials, infer identities from names, or accept identity headers.
   Verify session, Origin/transport policy and CSRF through existing DATA services. Enforce current
   conversation membership/interaction and ownership before upload/download and revalidate before
   finalizing a streamed write. Protect direct DB6 access as well as proxied requests.
2. **Security:** approve a versioned binary/file-manifest format: algorithm, fresh per-file keys,
   nonce/tag sizes and framing, domain-separated AAD binding the file to its sender/conversation
   and stable reference, authenticated sizes/digests/MIME/name, and any chunking rules. Define key
   protection inside the existing encrypted V2 content, recipient-device/epoch behavior, historical
   recovery and corruption rejection. Keys, original names and sensitive metadata must not appear
   in upload headers, URLs, logs or plaintext API fields. Keep existing message/key validators intact.
3. **Database/storage:** authoritative file-to-message association using stable storage/wire IDs,
   verified uploader and conversation scope. Define staged/ready/deleted states, durable upload IDs,
   digest/length checks, idempotent completion, uncertain-outcome retries, abandoned-upload expiry
   and crash recovery. Resolve DATA's existing attachment ledger versus DB6's binary ledger without
   creating a second attachment backend or sharing incompatible SQLite schemas.
4. **Retention:** connect Unsend to immediate download invalidation and DB6's soft-delete/physical
   cleanup contract, including offline clients and orphaned uploads. Do not discard a staged blob
   while its encrypted message may already have committed. Previously downloaded/decrypted files
   cannot be recalled from another participant's device.
5. **Fullstack after those contracts ship:** extend the identity-checked transport for bounded binary
   upload/download, proxy only the canonical DB6 routes, and reuse the current composer and cards.
   Add a strict protected manifest decoder and a session-owned decrypting attachment loader. Verify
   AEAD/digest/size before exposing any preview/download Blob, then reuse format checks and SVG
   sanitization. Revoke Blob URLs on replacement/navigation/sign-out. Preserve Demo IndexedDB and
   keep media forwarding disabled until destination-specific encrypted delivery is implemented.

The shared UI allows five files and 100 MB total, with videos up to 50 MB. DB6's default raw upload
cap is 25 MB. Owners must specify a compatible limit including ciphertext/tag overhead; this phase
does not change environment settings or silently lower/raise existing limits.

## Validation scope

`server/test/integration/authenticated-attachment-boundary.test.ts` uses two genuine DATA sessions,
isolated DB6 storage and synthetic opaque bytes. It proves default DB6 refusal, that DATA `req.auth`
alone is not a DB6 identity, and that mapping an authenticated ID alone still fails DB6's account
contract without creating files or records. Its deliberately incomplete test-only probe is not a
production adapter and never provisions accounts or bypasses foreign keys.

Frontend boundary tests keep real attachment capabilities disabled, prevent an existing demo draft
from invoking the plaintext uploader after a capability switch, reject encrypted DB6 rows from the
plaintext mapper, reject unsupported key manifests from display/verification, and keep binary routes
outside the JSON transport. Existing demo attachment, DB6 storage, UI rendering, E2EE text and
messaging regressions remain applicable.

The original audit did **not** implement or verify successful encrypted-file transfer/decryption,
reload/reconnect or message-bound Unsend. The linked Phase 8B implementation records the new
protocol, additive migration 0010 and subsequent end-to-end verification. Migrations 0008 and 0009
and the existing encrypted message protections remain unchanged.
