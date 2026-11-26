# DB-6 Storage Provider Contract (T-6A-02, T-6A-03)

**Status:** Proposed for DB-6A owner review. This document defines the canonical target; it does not implement or enable attachment storage.

## Boundary and operations

`Storage_Provider` handles opaque bytes outside SQLite. Its API accepts a generated `Storage_Key`, streams and bounded numeric options only. Results and errors never include an absolute path, storage root, operating-system error text, user filename, plaintext content, or key material. Closed public error codes are `STORAGE_KEY`, `STORAGE_EXISTS`, `STORAGE_SIZE`, `STORAGE_MISSING`, and `STORAGE_IO`; internal causes may be retained only for sanitized server diagnostics under the logging rules.

| Operation | Input | Result and required behavior |
|---|---|---|
| `write(key, readable, { maxBytes })` | Storage_Key, readable byte stream, positive per-file cap | Write `<key>.part` with exclusive create (`wx`) and mode `0600`; count and hash bytes while streaming; reject over-cap input; compute SHA-256; finalize atomically without replacing an existing final key; remove temporary data on every failure. Return `{ byteCount, sha256 }`. |
| `read(key)` | Storage_Key | Refuse links and non-regular files; return `{ stream, byteCount }` without loading the file into memory. |
| `stat(key)` | Storage_Key | Return byte length or `null` when missing. |
| `exists(key)` | Storage_Key | Return a boolean. |
| `delete(key)` | Storage_Key | Remove bytes; return `false` when absent, otherwise `true`. |
| `usage()` | none | Return `{ bytes, files }` for provider-managed final objects only. |
| `sweepTemporary(olderThanMs)` | non-negative age | Remove stale `.part` objects; report a count, never paths. |
| `listKeys()` | none | Return valid final Storage_Keys only; used for orphan accounting, never expose paths. |

`write` and `read` stream with a 64 KiB high-water mark. The implementation and tests must demonstrate memory bounded by at most 1,048,576 bytes independent of payload size (DB6-R04.10, NFR-05). `sweepTemporary` and `listKeys` are explicit additions for startup cleanup and orphan reporting; they are not part of the original DB6-R02.1 operation list.

## Storage_Key and path safety

- Generate 24 random bytes independently of user input and content and encode them as 48 lowercase hexadecimal characters (`^[a-z0-9]{32,128}$`); SHA-256 content digests are not identifiers.
- Resolve a key only beneath the real configured root. Reject separators, parent references, absolute and drive-letter forms, colon/alternate-data-stream syntax, trailing dots or spaces, Windows device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, case-insensitive), and links. Verify the resolved parent is exactly the root.
- Use a temporary `.part` created with `wx`, restrictive modes, digest while streaming, and atomic no-replace finalization. An existing final object remains byte-for-byte unchanged. On abort, size excess, I/O failure, or collision, remove only this write's temporary object and return a closed sanitized error.
- Where supported, directories are mode `0700` and files mode `0600`; the Windows contract branches on platform and asserts the platform's real behavior rather than skipping.
- Probe hard-link/no-replace support at the configured root. Verify the operation on Linux and Windows and on any additional filesystem the Project_Owner names. If unsupported, document and review a safe fallback before implementation; do not silently replace with an overwrite-capable rename.

## Root, readiness, and Docker_Environment

`ATTACHMENT_STORAGE_DIR` must be an absolute path whose real path is outside the repository working tree and every statically served directory. No static route may expose it. An absent, unwritable, in-repository, or otherwise unsafe root keeps the Attachment_API disabled. Storage errors return `503 SERVICE_UNAVAILABLE` with no path or OS text and leave no committed attachment row for a failed upload.

In the existing Docker_Environment the reserved path is `/var/lib/secubuzz/attachments` on the `private-storage` named volume, owned by UID 1000 (`node`) with mode `0700` on Linux. The volume is not seeded from the repository. `sqlite-data` and `private-storage` must be cold-backed-up and restored together; one-sided restoration is detectable only through the startup orphan counts. Quota usage consumes Docker disk-image space, so a full image must fail closed as `503 SERVICE_UNAVAILABLE`. No Dockerfile, Compose service, port, or volume change is part of DB-6.

New source, fixtures, and temporary files must avoid `.dockerignore` names and extensions (G7). Compose Watch must not run against data-to-keep while migration 0009 is a draft.

## Requirement mapping

| Contract rule | Criteria |
|---|---|
| Opaque provider operations and closed sanitized errors | DB6-R02.1, R02.9, R02.12 |
| Random key format, validation, containment, links, and no-replace finalization | DB6-R02.2-R02.7, R02.13, R02.15; R-10; CI-28 |
| Streaming chunk and bounded memory | DB6-R04.10; NFR-05 |
| Root readiness and no static serving | DB6-R02.2, R02.10; DB6-R05.8 |
| Failed-write cleanup and no committed row on storage failure | DB6-R02.8, R02.9; DB6-R04.12 |
| Docker volume ownership, backup pair, quota disk use, and no Compose changes | COMP-09, COMP-10; DB6-R02.2, R02.10 |
| Test portability, registry completeness, and platform assertions | DB6-R02.11, R02.13; DB5-R15.16; CI-28 |

## Contract tests

The same `attachments-storage-contract.test.js` suite runs against every registered provider. A provider factory placed under `attachments/storage/` but omitted from `support/storage-providers.js` is a test failure. The suite and P-33 cover:

- 100 generated hostile keys per class plus fixed traversal, absolute, drive, ADS, reserved-device, trailing-dot/space, separator, and link cases.
- Stream abort at a seeded byte, injected I/O failure, size cap, and existing-final collision; every failure leaves no `.part` file and never replaces existing bytes.
- Independent byte count and SHA-256 oracle; no absolute path, root, or OS error text in results/errors.
- Mode `0600` where supported, symlink refusal, and no-replace finalization as platform-branching tests; none is skipped.
- Large generated stream memory sampling for NFR-05.

The Windows host is additional evidence; Linux Validation_Runner is the gate of record. The standalone streaming cases B-03 and B-13 are replaced by opaque byte round trips and size/partial-write assertions here; B-02's “stored once” checks move to the canonical HTTP tests.

## Provenance and requirements

This contract maps to DB6-R02.1–R02.15, DB6-R04.10, COMP-09/10, NFR-05, ADR-08, R-10 and CI-28. It is a design contract only until DB-6B implementation and its tests are accepted.
