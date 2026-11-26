# Protected Attachment Content (T-6A-07, T-6A-08)

**Status:** Contract proposal; residual-risk wording is **DRAFT** for independent review in DB-6C. This document adds no cryptography and enables no feature.

## Declaration and persisted metadata

Each protected upload declares:

| Frame field | Persisted field | Contract |
|---|---|---|
| `algorithm` | `declared_algorithm` | Required string, 1–64 characters. |
| `formatVersion` | `declared_format_version` | Required string, 1–64 characters. |
| `encryptedMetadata` | `encrypted_metadata` | Required opaque string, no more than 16,384 characters. |

The server stores `media_type` as `application/octet-stream` for every protected upload. File name, original media type, and content-derived metadata are carried only inside `encryptedMetadata`; they are not sent in headers, logged, indexed, or persisted in plaintext. Missing declarations/metadata or out-of-range lengths return `400 VALIDATION_ERROR` with the relevant field and write no row or bytes (DB6-R05.3–R05.5, R05.12).

## Server and client rules

- The Attachment_Service treats content bytes and encrypted metadata as opaque. It does not decrypt, parse, preview, thumbnail, scan, or index either.
- The service never receives, requests, stores, logs, or derives a decryption key. DB-6 adds no cryptographic primitive or key/envelope format. SHA-256 integrity digesting and random Storage_Key generation are the only cryptographic operations in this scope.
- The client consumes the existing protected-content format unchanged. At DB-6E it sends ciphertext, encrypted metadata and the declaration only; it sends no plaintext bytes, filename, or original media type outside encrypted metadata, and has no plaintext fallback.
- `NEXT_PUBLIC_ATTACHMENT_API_READY` stays false until the `ATTACHMENTS-PROTECTED` record exists and any later required acceptance record is approved. The server Attachment_API remains disabled for Real_Accounts meanwhile.

## Residual risk — DRAFT for DB-6C review

The server cannot verify that uploaded bytes are ciphertext. A buggy or hostile client can send plaintext in a request with otherwise valid protected-content fields. No sound detector exists without inspecting content, and inspection is forbidden by DB6-R05.1. The remaining controls are client-side ciphertext-only behavior, mandatory declaration and metadata, an external private storage root, and keeping the Attachment_API off for Real_Accounts until the independent `ATTACHMENTS-PROTECTED` review record is accepted. Byte size and upload time remain visible to the server by design (R-02). The independent reviewer must decide whether padding or another traffic-analysis mitigation is needed; this draft is not accepted risk.

## Scope

Applies to DB6-R05.1–R05.13 and the protected-content portion of DB6-R03. It preserves the existing E2EE format and defines no new key management, encryption, or content validation protocol.
