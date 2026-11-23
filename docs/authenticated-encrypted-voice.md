# Phase 9: authenticated encrypted voice

Voice uses the existing `useVoiceRecording`, composer controls/preview, native audio playback UI,
`AuthenticatedAttachments`, protected V2 messaging and Phase 8B storage/lifecycle. Demo voice keeps
its existing browser-only URL behavior. Authenticated voice sends recorded Blob bytes through
client encryption; it never fetches a demo Blob URL as a delivery mechanism or sends a local URL.

## Security contract for review

The outer message envelope remains **E2EE V2**. Its nonce reservation, signed epochs, device and
recipient validation, session identity, CSRF and conversation authorization are unchanged.

Private application content uses **JSON version 3** in the existing reserved content prefix. It
contains the Phase 8B `attachments` set and exactly one voice designation:

`voice: {v:1, attachmentId:<UUID v4>, durationSeconds:<finite number greater than 0 and at most 300>}`.

Version 3 requires this designation, a matching audio file in the protected attachment set, and
the existing sender/conversation/wire-message binding. Versions 1 and 2 remain readable. Older
clients reject version 3 rather than displaying key manifests. Reply is supported; media Forward
and Edit remain disabled. Other files can accompany a recording within the existing five-file /
100 MiB total limit; the recording counts as one file.

The recording uses the **unchanged Phase 8B file manifest v1 and AES-256-GCM/AAD contract**. There
is no new crypto algorithm, encryption endpoint, media-key upload, storage ledger or wire type.
The voice designation/duration are authenticated inside V2 content, not exposed in upload fields.
Storage sees only its existing routing identifiers and ciphertext size/hash, not audio, MIME,
duration or media keys. `audio/webm` recordings use the `.weba` audio extension in the shared policy;
recorded MP4, Ogg and WAV audio use their existing audio rules.

Before upload, `OfflineAudioContext.decodeAudioData` validates actual decodable audio, mono/stereo,
duration up to **five minutes** and size up to **20 MiB**, also subject to the authenticated server
file cap. Duration comes from decoded audio, not a client-supplied timer. Before a recipient sees
a playback URL, Phase 8B verifies the manifest, scope, length, ciphertext hash, GCM tag and file
signature, then voice validation checks decoded duration against the protected value (0.5-second
codec tolerance, with the five-minute decoded cap enforced independently). Unsupported/invalid
audio fails closed with feedback. Decoding is browser-local and does not require audio output or
microphone access on the recipient.

## Lifecycle and persistence

- The recorder retains the Blob for encryption alongside its preview URL. Demo sends still receive
  only the original URL/duration metadata. Authenticated sends receive an encrypted file reference.
- Real recordings have bounded duration/chunk size. Stop, cancel, errors, delayed permissions and
  unmount/navigation retain the existing microphone generation guards and track cleanup.
- Preview removal/acceptance/unmount revoke URLs. Verified received audio uses the existing Blob
  ownership hook; replacement/unmount pauses the encrypted player, detaches its source and revokes
  URLs. No original sender URL is used for recipient playback.
- Preparing a recording caches the File by recording Blob. Uncertain upload retries reuse the exact
  ciphertext, file ID and key. The existing sealed batch and encrypted pending-envelope mechanism
  handles lost message confirmations without duplicate messages. Failed sends preserve the preview.
- A failed voice download has an explicit retry control. Retrying uses the identity-checked loader
  again and repeats decryption, integrity and duration validation before exposing a playback URL.
- The existing DATA message association and Unsend trigger govern voice exactly like files.
  Download access is invalidated when a message is unsent; retained ciphertext is purged by the
  Phase 8B job. Already decrypted/downloaded audio cannot be recalled from a recipient's device.
- Reload, login and reconnect use existing encrypted history and the enrolled browser's keys.
  Enrolling a new browser does not recover older keys/recordings automatically.

## Database and backend review

**No new migration or DATA/backend authorization/storage code is required by Phase 9.** Migrations
0008, 0009 and 0010 and existing protection triggers are unchanged. Voice retains outer wire type
`text`, so existing sender-authorized Unsend, pinning and reactions continue to use their tested
contracts. The shared audio policy, protected-content v3 decoder and client media validation are
the security-sensitive additions requiring review. Calling and Edit infrastructure are untouched.

## Verification and limitations

Focused tests cover actual-duration validation, invalid MIME/bytes/size/duration, unsupported
decoding, encrypted retry identity, protected references, recorder limits, demo preservation,
unmount cancellation and player resource cleanup. Backend integration uses two real enrolled DATA
accounts, E2EE V2, a deterministic PCM recording, production file crypto, realtime/history and
authorized Unsend over existing storage.

`client/scripts/verify-client-realtime.cjs --voice-only` uses separate authenticated Chrome contexts,
real browser recording APIs and a **synthetic browser microphone**, not a physical user microphone.
It checks preview, recipient playback/seeking and exact decrypted bytes, ciphertext-only upload,
permission denial, unsupported APIs, corruption, reload/login/reconnect/offline recovery, lost
upload/message responses, cancellation/navigation and Unsend.

Browser codec/Web Audio support is required; the acceptance browser is Chrome on Windows. Transfers
are whole recordings, not resumable streams; the existing server timeout/cap still applies. No
speech transcription, media forwarding, calling or Edit integration is added.

Final Phase 9 validation: **1,332 frontend tests / 125 suites, 566 backend tests and 324 DATA tests
passed**. The two-account synthetic-microphone Chrome run passed **49 voice checks**, and the
Phase 8B browser regression passed **47 file-attachment checks**. Both reported zero plaintext
messaging leaks and zero runtime exceptions. Frontend/backend TypeScript and frontend lint passed.
Recordings, native playback/seeking and exact decrypted bytes were verified automatically; physical
microphones and other browser/codec combinations were not manually tested. All accounts/databases
used for acceptance were isolated from the existing development accounts and database.
