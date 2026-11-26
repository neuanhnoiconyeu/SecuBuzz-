# V2.3: encrypted media forwarding

Work stays on `bon-fullstack`; existing V2.1/V2.2 work remains uncommitted.

## Behavior and scope

The existing message menu and Forward dialog now support authenticated encrypted
images, videos, PDFs, general permitted files and voice messages. Captions,
filenames, canonical MIME types, byte sizes and protected voice duration survive.
The shared attachment cards, image preview/lightbox, video playback, downloads
and voice player are reused. Demo forwarding and all other message actions remain
unchanged; authenticated editing still excludes attachments/voice.

Each destination is a currently authorized two-participant direct conversation.
The controller rechecks the source conversation and its verified, active history
row before forwarding media. Missing/unreadable/unsent sources, malformed or
misbound manifests, demo URLs and unsupported media references fail closed.
Source downloads go through the existing authenticated attachment reader, which
checks ciphertext digest, AES-GCM authentication, protected metadata and file
signature. Voice forwarding also verifies actual decoded duration.

Plaintext bytes exist only in client memory. Each destination gets a new instance
of the existing encrypted attachment uploader: fresh file keys, IVs, attachment
IDs, message ID, ciphertext and destination-bound AES-GCM additional data. No
source file key or public source URL is reused. The existing session selects the
destination's verified epoch and encrypts the new manifests inside its V2 message.
Binary requests contain only ciphertext; filenames, MIME types and file keys
remain inside protected message content. DATA still owns session identity,
CSRF, membership, upload limits, batch association and download authorization.

## Retry, failure and cleanup contract

- Upload jobs retain the same File objects, uploader and exact ciphertext while
  the dialog is open. A lost upload response retries the same encrypted object.
  Completed files are not uploaded again when a later file fails.
- Before building a new batch, the existing forwarding flow reconciles its
  encrypted operation ID in destination history and the session's pending V2
  envelope. A committed or uncertain send is recovered rather than recreated.
  Media reconciliation verifies the destination/sender/message binding, original
  caption/file metadata, protected voice reference and fresh file identities/keys.
  Other participants' operations and unrelated pending composer drafts are ignored
  or rejected. Per-destination locks prevent concurrent duplicate submissions.
- Optional notes remain separate encrypted messages. A failed note reports partial
  completion, and retries resume only the unfinished note. Success is reported
  after every selected destination and required note has been confirmed.
- The shared dialog shows safe source/upload/destination errors. Closing or
  unmounting releases plaintext file references and aborts owned media requests.
  Known uploads are handed to the existing discard API. That API cannot delete
  sealed/committed batches; uncertain sends remain protected and existing staging
  retention handles abandoned ciphertext. Completed jobs release their buffers.
- A forwarded copy has an independent message/storage association. Unsend of the
  source invalidates source downloads, while an already forwarded copy remains
  available. Unsend of the forwarded message invalidates its own downloads.

## Contracts requiring review

No Database migration, DATA/backend API, storage schema, session/CSRF rule,
cryptographic primitive, V2 envelope or calling implementation changed.

The inner application-content decoder now accepts the existing `forwarded: true`
and `{id, part: 'message'}` operation metadata alongside validated attachment
manifests in content versions 2 and 3. Attachment-bearing `part: 'note'`, missing
forward operations, reply/forward combinations, invalid voice references and
cross-message/conversation/sender manifest bindings remain rejected. This removes
the earlier deliberate UI/content gate only after adding fresh destination
encryption. Security review should check this additive content-validation change,
retry reconciliation and resource ownership. Older frontend builds intentionally
reject forwarded-media content; both users need the updated frontend. Text and
ordinary historical attachment/voice content remain compatible.

A1 rollback protection remains unresolved and unchanged. These checks do not
constitute production security clearance.

## Files changed

- `client/src/messaging/authenticatedForwarding.ts`
- `client/src/messaging/authenticatedContent.ts`
- `client/src/components/messenger/SecureConversationPanel.tsx`
- `client/src/components/messenger/ForwardDialog.tsx`
- `client/src/messaging/__tests__/authenticatedMediaForwarding.test.ts`
- `client/src/messaging/__tests__/encryptedAttachmentCrypto.test.ts`
- `client/src/components/messenger/__tests__/ForwardDialog.test.tsx`
- `server/test/integration/encrypted-attachments.test.ts`
- This document.

TypeScript also regenerates the already tracked `client/tsconfig.tsbuildinfo`;
it remains generated metadata, not source/staging input. Browser fixtures,
temporary databases, profiles and build output remain under ignored paths.

## Validation and limits

- Relevant frontend regression: **567 passed, 0 failed, 53 suites**. Covers shared
  actions, encrypted files/voice, content/presentation, forwarding, notifications,
  calling/history and the preserved workspace UI. After the final buffer-release
  adjustment and an additional re-forwarding case, focused forwarding regression
  passed **44 tests, 0 failed, 4 suites**. These overlap the broader run and are
  not an additional 44 distinct tests.
- Backend/DATA integration: **25 passed, 0 failed**, covering encrypted storage,
  real authenticated E2EE realtime delivery, membership/CSRF, limits, corruption,
  interrupted transfers, idempotency and Unsend. The new three-account regression
  sends into a different conversation, verifies recipient decryption, denies
  cross-conversation downloads and verifies independent source/copy Unsend.
- Actual browser acceptance: **36 checks passed, 0 failed**, both in the disposable
  test-service run and the final **primary Docker localhost:3001 run** (the same
  scenarios, not 72 different tests). Each used three disposable authenticated accounts so the
  source and destination have different participant sets. The existing real UI
  forwarded a five-file batch (PNG, valid VP8 WebM, PDF, DOCX binary fixture and TXT)
  and a newly recorded voice message into a different direct conversation.
  Recipient downloads preserved exact filenames and bytes; the image rendered,
  video decoded frames and the recipient voice player advanced during playback.
  Fresh file-key fingerprints, ciphertext, message/attachment IDs and conversation
  bindings differed; unauthorized source/destination downloads were refused.
  History reload restored forwarded media; no duplicate forwards, observed message
  plaintext transport leaks or browser runtime exceptions occurred.
- The initial passing run used disposable DATA/Next processes with canonical
  isolated databases. The final run used the existing default Docker Compose
  project directly. Both used separate browser contexts and synthetic microphone
  capture; their test sessions were logged out and browsers closed afterwards.
  The primary run added three disposable accounts, two direct conversations,
  five encrypted messages (including one optional note) and twelve new encrypted
  attachment objects through normal authenticated APIs. Those synthetic records
  remain. No pre-existing account, message, host database, user key, stash or Docker
  volume was deleted, restored, reset or migrated. No services were recreated.
- Primary Docker verification: **13 checks passed, 0 failed**, in a separate
  actual-bundle UI fixture, with no
  authenticated API mutations. It verifies authenticated eligibility, keyboard
  Forward activation and the same shared recipient dialog for all five media
  categories. This synthetic UI check is separate from the successful real-account
  primary Docker transfer run described above.
- Final client and backend TypeScript checks, ESLint and the isolated production
  build passed. Existing Next.js guidance about the extending TypeScript build
  configuration remains advisory; no configuration was changed for testing.
- Limits remain the existing application file/type/count/aggregate limits plus
  DATA's encrypted storage cap. Playback depends on existing browser codec support;
  downloads remain available where existing previews are unsupported. Tests verify
  byte preservation, not opening documents in native Office applications.
- Transfers require downloading/decrypting and uploading a fresh encrypted copy;
  this is not a server-side file-reference copy. If a browser is closed before a
  batch has a durable pending message, its in-memory upload job cannot resume;
  staged ciphertext expires through the existing retention contract. The user can
  start a new forward, and no message is created solely by uploading a batch.
- Forwarding does not recover missing historical E2EE keys, expired media or
  revoked source/destination access. These remain explicit failure conditions.

Evidence: `.cache/v23-browser-8b015870/evidence.json` (disposable test services),
`.cache/v23-browser-ea528ce7/evidence.json` (primary Docker),
`.cache/v23-docker-ui/evidence.json`, and
`.cache/v23-{frontend,focused-final,backend-final,types-final,backend-types,lint-final,build-final}.log`.
The first unit-test attempts exposed Node/jsdom ArrayBuffer realm/assertion issues
in new test fixtures; correcting the fixtures required no runtime workaround.
Initial browser menu clicks raced attachment layout/scroll or targeted an unhovered
synthetic toolbar. Keyboard activation and reduced motion verified the supported
shared UI without force-clicking, disabling security or changing menu behavior.
