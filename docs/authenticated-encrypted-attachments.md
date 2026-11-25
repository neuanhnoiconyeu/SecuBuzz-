# Phase 8B: authenticated encrypted attachments

Phase 9 adds [encrypted voice recording and playback](authenticated-encrypted-voice.md) over this
same storage, encryption and message-association contract, without another migration or endpoint.

The implementation reuses the Messenger composer, selection/drop hooks, cards, image lightbox,
video/audio players, PDF preview and document downloads. Demo IndexedDB files and the legacy
plaintext DB6 client are separate. Authenticated attachments never use that plaintext uploader.

## Deployment and authority

The Next proxy sends canonical `/api/attachments` routes to the same DATA host as authentication
and messaging. DATA verifies its existing session, Origin/transport policy, CSRF on mutations,
active conversation membership and interaction/block permissions. Identity comes from `req.auth`;
no client account header, DB6 user mirroring, credential copying or shared incompatible databases
are used. Authorization and the session-bound proof are checked again after streaming.

DATA uses **DB6's existing private binary storage implementation**, exposed through the additive
`createAttachmentStorage` factory. It uses DATA's existing `Attachments` ledger, with its existing
conversation/member/message foreign keys. This is an authenticated composition over DB6 storage,
not a connection to the standalone legacy DB6 HTTP host or its separate account ledger. The
legacy host still fails closed without its trusted authentication middleware.

Restart DATA/realtime and Next after deployment. The existing DATA migration runner applies 0010;
the implementation tests migrations only on isolated databases and does not migrate the local
development SQLite file during verification. Default encrypted storage is `encrypted-attachments`
beside DATA's SQLite file. `E2EE_ATTACHMENT_STORAGE_DIR` can explicitly select a private persistent
directory. Do not serve that directory statically, share it with the legacy ledger, or use a
temporary production directory. Back up the DATA ledger and its binary directory together.

## Cryptographic contract requiring Security review

Each file gets a fresh random 256-bit key and 96-bit IV. Web Crypto AES-256-GCM uses a 128-bit tag;
stored/uploaded bytes are ciphertext followed by the tag. There is no plaintext fallback or
server-side decryption. A file key is used for one encryption only; retries reuse the exact
ciphertext, IV, identifier and key rather than encrypting again with the same nonce.

The strict private manifest has exactly these fields:

`v:1, id, conversationId, messageId, senderId, name, mimeType, size, key, iv, sha256`.

Keys and IVs are canonical unpadded base64url (32 and 12 bytes); `sha256` is lowercase SHA-256 of
the ciphertext/tag. File IDs and wire message IDs are UUID v4. Names, canonical MIME and size use
the shared attachment policy. The complete set permits five distinct files and 100 MiB plaintext
in total. Mixed sender/conversation/message scopes and unsupported media forwarding are rejected.

Canonical AES-GCM additionalData is UTF-8 JSON of:

`["SecuBuzz:encrypted-file",1,conversationId,messageId,senderId,id,name,mimeType,size,iv]`.

The key and ciphertext digest are excluded from AAD to avoid a circular ciphertext dependency;
both are authenticated by the containing V2 message. Before returning a Blob, the recipient
validates the manifest, checks ciphertext length equals plaintext size plus 16, checks SHA-256,
verifies the GCM tag/AAD, and verifies decrypted size and supported format signature. SVG previews
retain the existing sanitizer. Format signatures do not establish that a downloaded file is safe
or malware-free.

Application content uses JSON `v:2` inside the **existing reserved message-content prefix**, with
text, optional Reply reference and private attachment manifests. The outer encrypted message
envelope remains V2, with unchanged nonce reservation, signed key epochs, device/recipient checks
and AAD. Existing content-v1 text/Reply/Forward messages remain readable. Older clients reject the
new content version; a new prefix must not be used because older decoders could display it as
plaintext, including keys. Presentation additionally checks every file's binding against its
authenticated enclosing message. Files have the same device/history recovery limitations as
their containing encrypted messages.

Storage receives no filename, original MIME, plaintext file digest, plaintext file bytes or file
keys. The server necessarily sees actor, conversation, message/file IDs, ciphertext length/hash,
operation timing and lifecycle state. File manifests/keys exist in decrypted client memory; only
encrypted pending message envelopes are persisted through the existing browser key store.

## Database and lifecycle contract requiring Database review

Migration **0010-encrypted-attachments.sql** is additive. Migrations 0008 and 0009 are unchanged.
It adds protocol version, stable wire message ID, ciphertext digest, staging expiry and purge time
to the existing `Attachments` table; adds indexes and `EncryptedAttachmentBatches`; and adds
eligibility/immutability/Unsend triggers. Existing message storage, envelope immutability triggers,
keys, pin and reaction protections are preserved.

1. Bounded opaque bytes stream into DB6 private storage. A verified actor's staged row is inserted
   only after reauthorization. A duplicate file ID must have the same owner/scope/hash/length.
2. The client seals the exact set before constructing/persisting its encrypted message. A sealed
   batch cannot be extended or discarded by navigation cleanup. This protects uncertain sends.
3. Existing REST or authenticated realtime submission commits message associations and marks
   the batch/files committed/ready in the **same DATA transaction**. Downloads require an active
   matching message plus current participant/interaction authorization. Unsealed/expired batches
   cannot be submitted as attachment messages.
4. Exact-envelope message retries retain the existing pending-message reconciliation. Lost upload
   responses reuse ciphertext and file IDs. A failed post-confirmation history refresh cannot turn
   a confirmed send/retry into a second message submission.
5. Unsend's existing authorized message update atomically marks associated files deleted and the
   batch revoked. Subsequent downloads fail immediately, including after offline recovery/reload.
   Already delivered bytes or decrypted local copies cannot be recalled; an already authorized
   in-progress download can finish.
6. Unsealed drafts can be discarded. Staged/sealed abandoned uploads expire after seven days;
   committed active files do not use that staging expiry. A server-owned minute timer and upload
   cleanup remove revoked/expired bytes, retain tombstone IDs and record purges. Only old,
   unreferenced UUID files/partial files in this dedicated namespace are swept. Requests interrupted
   while streaming remove their `.part` files without inserting a row.

The server keeps the existing default **25 MiB ciphertext cap** (plaintext cap minus 16 bytes).
`MAX_ATTACHMENT_BYTES` can configure the DATA storage cap up to the client ceiling of 50 MiB plus
16; the UI checks the server's authenticated limit and explains encryption overhead. Transfers are
whole-file, memory-bounded operations, not resumable/chunked uploads. Five files and 100 MiB per
message, plus a bounded per-user staging quota and existing rate limits, remain enforced.

## Verification

- `server/test/integration/encrypted-attachments.test.ts`: real DATA sessions, enrolled devices,
  V2 encrypted realtime/history, production client file crypto/transfer manager, exact-byte
  decryption, deduplication, CSRF/outsider denial, corrupt ciphertext, Unsend, session revocation
  after streaming, size limits, expiry/purge and interrupted-stream cleanup; isolated databases.
- `client/scripts/verify-client-realtime.cjs --attachments-only`: separate Chrome account contexts,
  real Next proxy/DATA/Socket.IO, real PNG/lightbox, deterministic playable VP8 WebM, PDF preview,
  valid DOCX and all four exact-byte downloads. Also reload, login recovery, reconnect, offline
  receipt, lost upload/message confirmations, and Unsend. Request-body instrumentation and storage
  tests verify ciphertext-only uploads; the deterministic fixture avoids headless recording's
  header-only output.
- Focused frontend tests cover manifest/AEAD scope and corruption, bounded identity-checked binary
  transport, no legacy plaintext-loader fallback, and stable/revoked Blob lifetimes.
- Migration tests preserve earlier rows, columns, foreign keys and all original security triggers.

Voice recording, Calling, Edit, group media and media Forward are not integrated by this phase.
No user accounts, keys or messages are deleted by verification. Test evidence is under ignored
`.cache` / `client/tmp` paths and is not part of the source change.

Final Phase 8B validation: **1,311 frontend tests / 123 suites, 565 backend tests, 324 DATA tests,
and 47 Chrome checks passed**. Frontend/backend TypeScript and frontend lint passed. Backend totals
include five encrypted-attachment integration tests; Chrome reported zero plaintext messaging leaks
and zero runtime exceptions. Verification used isolated accounts/databases, not the local development
accounts or SQLite file.
