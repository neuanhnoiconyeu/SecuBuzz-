# Chat attachments

The paperclip and chat drag-and-drop area accept PDF, Word (`.doc`, `.docx`), Excel, PowerPoint, JPG/JPEG, PNG, GIF, WebP, SVG, AVIF, BMP, MP4/M4V, WebM, MOV, MP3, WAV, OGG, M4A, TXT, RTF, CSV, ZIP, RAR, and 7Z. Selected files appear above the composer with thumbnails, type icons, sizes, previews, and remove controls. Sent/received attachment cards provide image lightboxes, video/audio players, PDF previews, and downloads. Playback depends on browser codecs; the original file remains downloadable.

Client limits live in `shared/attachmentPolicy.ts`: 5 files per message; images 5 MB, documents 10 MB, audio 20 MB, archives 25 MB, video 50 MB; 100 MB combined per message. `shared/attachmentSignatures.ts` checks basic format headers during client selection and authenticated downloads. DB6 independently enforces its existing MIME policy and configured upload size cap (25 MB by default). The encrypted message decoder also enforces attachment count and total size.

## Current availability

The development demo stores actual file Blobs in the `files` object store of the `secubuzz-local-attachments-v1` IndexedDB database. Attachment message snapshots live in `messages`. Both use composite keys containing the demo identity, conversation ID, and file/message ID. Files are never encoded into localStorage. Temporary object URLs are generated for previews/downloads and revoked when their owners leave; stored records contain durable IDs rather than stale blob URLs.

Reloading requires signing into the same demo persona again because demo authentication itself remains memory-only. Its attachment messages and downloads then restore. Different demo personas and conversations have separate storage scopes. This is local browser data, not authenticated account storage or E2EE: local metadata/captions are stored as plaintext demo snapshots, and anyone with access to the browser profile can inspect its site storage. Clearing site data removes the files. The visible “Saved on this device” labels do not imply delivery to another user.

Messages with local attachments retain optional captions, edits, pins/reactions, and deletion state. Deleting their final message reference releases the stored file; forwarding copies the file into the target conversation's scope. Abandoned staged saves are discarded when possible. Ordinary text messages, scripted replies, and recorded voice messages retain their existing in-memory behavior; this change does not persist an entire chat archive or voice recordings.

Remote files use the existing DB6 API in `server/src/routes/attachment.cjs`, mounted by `server/src/api-app.cjs` and `server/api-main.cjs`. DB6 is the only persisted attachment backend. The competing JSON/`.uploads` implementation and its realtime exports/mount have been retired; the standalone realtime process returns 404 for attachment paths. Production authentication and the existing realtime message-store/recipient-key integrations still need their owning services.

## Manual tests in the browser demo

1. In `client/`, run `npm install` and `npm run dev`, then open `/login` and select **Continue as Demo User**. Use the same persona after each reload.
2. Open SecureBot or another demo conversation. Click the paperclip or drag files anywhere into the chat. Check thumbnails/type icons and sizes, then remove a file before sending. The Send button stays disabled while files are checked or saved.
3. Send one file with no text, several files together, and files with a caption. Confirm the attachment cards belong to that conversation and message. The local notice and “Saved on this device” labels should remain visible.

| Files to try | Expected behavior |
| --- | --- |
| JPG/JPEG, PNG, GIF, WebP | Thumbnail before/after sending; click it for a lightbox; Escape or Close returns keyboard focus; download the original. |
| SVG | Static, sanitized thumbnail/lightbox; scripts, HTML, event handlers, CSS, and external resources are removed from the preview. Download retains the original file. SVG is never injected as inline page markup or put into an iframe. |
| MP4, WebM, MOV | Draft video thumbnail/player when supported; native play, seek, volume, fullscreen, and download controls in chat. Unsupported codecs show a preview error with a download option. |
| PDF | Document card; Preview opens the browser PDF viewer with Open PDF and Download original links. The preview rechecks the header and uses an `application/pdf` Blob. Native viewer availability varies by browser; the open/download fallback remains available. |
| DOC/DOCX, TXT, RTF | Document card, filename/size, and original download. These files are not executed or rendered as HTML. |
| XLS/XLSX/CSV | Spreadsheet icon and original download. |
| PPT/PPTX | Presentation icon and original download. |
| ZIP/RAR/7Z | Archive icon and original download; archives are never extracted or executed by the app. |
| MP3/WAV/OGG/M4A | Additional supported formats: native audio player and download, subject to browser codec support. |

4. Reload, select the same demo persona, and reopen the conversation. Confirm captions/files return and downloads still contain the original bytes. Switch conversation or use **Try Nova Demo User** to verify that histories are isolated. Forward a saved file to another local conversation, delete the original, and confirm the forwarded copy still downloads.
5. Try an oversized file, more than five files, a renamed non-image with `.png`, and a broken PDF. The existing selection/draft must remain intact, with an actionable error. Rejecting an invalid batch must not partially add files. Disable site storage to check the save error; no server upload or localStorage fallback should occur.

Native PDF previews deliberately use the browser's existing viewer rather than an extra iframe sandbox, which can prevent PDFs from loading. See [MDN: embedding PDFs](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#embedding_pdfs). Only verified PDF Blobs enter that frame; SVG uses static image rendering instead.

## Implementation files

- `shared/attachmentPolicy.ts`, `shared/attachmentSignatures.ts`: configurable formats, limits, filename handling, and format checks.
- `client/src/messaging/localAttachmentStore.ts`, `attachmentFiles.ts`, `attachmentUrls.ts`: IndexedDB files/message associations, SVG preview processing, and URL ownership.
- `client/src/hooks/useAttachmentDrafts.ts`, `useAttachmentSource.ts`, `useLocalAttachmentHistory.ts`, `useChatFileDrop.ts`: selection/saving, file resolution, restored message history, and drag-and-drop.
- `MessageComposer.tsx`, `YahooChatWindow.tsx`, `MessageList.tsx`, `useConversationMessages.ts`: extend the existing flow without replacing the messenger.
- `AttachmentIcon.tsx`, `MessageAttachmentView.tsx`, `AttachmentPreviewDialog.tsx`, `attachments.css`: themed responsive cards, media playback, accessible previews, and downloads.
- `client/next.config.js`: allows local blob reads/PDF frames while disabling object embeds. Client/server test files cover storage, validation, isolation, previews, uploads, and existing messaging behavior. `fake-indexeddb` is a test-only dependency.

## DB6 API integration

Install the `server/` dependencies and run the existing API entry point from that directory:

```powershell
npm.cmd install
node --env-file-if-exists=.env api-main.cjs
```

The existing `AUTH_MIDDLEWARE_MODULE` must identify the verified caller as `req.user.user_id` (or `req.user.id`). Without that middleware, the DB6 host returns 503. This attachment integration does not supply or change production authentication, CSRF enforcement, relationship rules, or Database code. The frontend continues to send the existing session-bound `X-CSRF-Token` from `meta[name="secubuzz-csrf-token"]`; the host retains responsibility for its HTTP security middleware.

Route `/api/attachments`, `/api/attachments/*`, and, if used, `/api/files/*` to the DB6 API on the **same origin** as Next.js. Preserve query strings, cookies, Origin, Content-Length, Content-Type, X-CSRF-Token, X-File-Name and X-File-Name-Encoding. Upload bodies are raw bytes, not JSON or multipart; do not add a body parser that consumes them. Keep existing DB6 storage/environment configuration and API middleware. Do not also mount a realtime attachment handler.

`server/api-main.cjs` wraps the existing API app with `createDb6AttachmentTransport` from `server/src/attachments/db6Transport.ts`. Custom hosts using `createApiApp()` must apply the same transport wrapper before invoking the API app. It owns no routes, reads no file bytes, and changes no authentication, SQL, storage or retention rules. It only adapts explicit filename encoding and download headers. Run `npm run start:api` from `server/` to use the supplied composition.

Remote chat requires an explicit `attachmentTarget` on `YahooChatWindow`, supplied from authoritative conversation data:

```ts
// A group uses its real DB6 group_id:
const attachmentTarget = { type: 'group', groupId: group.group_id } as const;
// A direct conversation uses its intended peer, never its opaque conversation ID:
const directTarget = { type: 'direct', recipientUserId: peer.user_id } as const;
```

`MessengerApp` maps non-demo group/direct conversation records to these targets. A real chat without a target keeps uploads unavailable; bot/demo labels are never treated as database IDs. After real authentication, routing, targets, and message delivery are verified, set `NEXT_PUBLIC_ATTACHMENT_API_READY=true` and rebuild/restart the client. This flag alone supplies none of those dependencies. Local demo attachments continue using their existing IndexedDB uploader regardless of the flag.

## HTTP contract and format mapping

| Operation | DB6 contract |
| --- | --- |
| Upload to a group | `POST /api/attachments?group_id=<id>` |
| Upload to a direct peer | `POST /api/attachments?recipient_user_id=<id>` |
| Upload body/headers | Raw bytes, percent-encoded `X-File-Name` with `X-File-Name-Encoding: percent-utf8`, and an accepted `Content-Type`; cookie session and the host's CSRF header |
| Upload result | Flat row including `attachment_id`, `original_name`, `mime_type`, `size_bytes`, and group/recipient scope |
| Metadata | `GET /api/attachments/:id`; JSON, never file bytes |
| Download | `GET /api/attachments/:id/download`; authorized bytes with download disposition |
| Delete/search | Existing DB6 soft-delete endpoint and metadata-search routes; no replacement implementation |

`client/src/messaging/db6Attachments.ts` maps the flat row into `{ id, name, type, mimeType, sizeBytes, url }`. It verifies the response's scope, filename, size and plaintext status against the upload and derives the canonical download URL itself. Server storage keys and response-provided URLs never become message fields. Older exact `/api/attachments/:id` message references normalize to `/:id/download`; they never request metadata as media.

PDF, JPEG, PNG, GIF, TXT and ZIP use MIME types already accepted by DB6. Word, other Office files, video, audio, SVG and other supported formats use DB6's existing `application/octet-stream` transport. Their original name and validated canonical MIME/kind remain in the message reference. No encryption headers are fabricated: binary transport does **not** mean file E2EE. Existing encrypted DB6 records are not treated as plaintext attachments.

The client percent-encodes `X-File-Name` for browser-safe headers and marks it explicitly with `X-File-Name-Encoding: percent-utf8`. The transport wrapper decodes it exactly once before DB6 sees it, so `original_name` contains the actual human-readable filename and existing DB6 search works with spaces, literal percent signs and Unicode. Unmarked legacy headers remain literal: a filename containing `%20` is never silently changed into a space. Malformed marked values are rejected before any upload is stored. The 180-character DB6 cap applies to the decoded name, not the longer wire encoding.

Downloads keep DB6 authorization and file streaming, while the wrapper formats `Content-Disposition` with an ASCII fallback and UTF-8 `filename*` so Unicode names do not cause invalid-header errors. The UI's named download also checks DB6 again at click time and uses a temporary Blob URL. Previously stored rows are not rewritten automatically; any data migration for files uploaded by an older encoded-name client must be handled deliberately by the Database owner.

DB6 serves files with attachment disposition and may use generic MIME, so image/video/audio/PDF previews fetch authenticated download bytes and create temporary Blobs with the validated MIME. SVG previews retain the existing sanitizer. PDF previews retain header validation and the native viewer. Media seeks within the downloaded Blob; this integration does not add server byte-range routes. Word and other document downloads remain lazy. Blob URLs are revoked when their owner unmounts; remote files never enter the demo IndexedDB store.

## Authorization, storage and retention

All persisted writes and reads run through the existing DB6 router, private file storage, SQLite metadata, and authorization checks. Direct recipient access, active group membership, group history visibility, expiry, soft deletion and physical cleanup are unchanged. The existing `server/src/db5db6/cleanup.cjs` job remains responsible for removal; removing a draft does not silently delete a persisted DB6 file or change retention policy. Existing successfully saved `.uploads` data is not migrated or deleted automatically.

DB6's `MAX_ATTACHMENT_BYTES` remains authoritative (25 MB by default), including for video selected under the client's 50 MB limit. Larger files fail with an actionable error while the draft remains available. Operators may configure the existing DB6 cap deliberately; no limit is bypassed by the adapter.

Saving finishes before submitting the message. A failed upload keeps the draft; a rejected message reuses its already uploaded reference. Captions/references remain inside the existing authenticated message ciphertext and file bytes never travel through Socket.IO. Plaintext DB6 file bytes remain readable by the server. Remote forwarding to another conversation still requires another upload there.

## Verification

- Client tests cover DB6 request/response mapping, malformed responses, supported formats, spaces/percent/Unicode filenames, previews, download-time authorization failures, Blob cleanup, composed chat wiring, and separation from demo IndexedDB.
- `server/test/integration/attachments.test.ts` loads the actual frontend uploader/reader against the unchanged DB6 API plus its transport wrapper with temporary SQLite/private storage and test-only authentication. It covers filename storage/search/download round trips, legacy headers, malformed encoding, direct/group scope, file formats, membership/history rules, upload caps, expiry, soft deletion, and the existing cleanup job.
- Run `npm.cmd run test:attachments` from `server/` for the frontend/DB6 integration test plus the existing Database regression. Both also run in the default server test command.
- Run client Jest attachment/composer/history tests and client/server type checks. Use `--incremental false` for the client type check when avoiding generated build metadata.
- Historical demo browser evidence remains in [browser results](../artifacts/advanced-attachments/browser-results.json), [PDF preview](../artifacts/advanced-attachments/pdf-preview.png), and [mobile screenshot](../artifacts/advanced-attachments/mobile.png). Those screenshots do not establish production DB6 authentication or deployment readiness.
