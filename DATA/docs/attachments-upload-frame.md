# Attachment Upload Frame (T-6A-04)

**Status:** OP-03/OA-02 frame approved by the Project Owner on 2026-11-23 for DB-6E client adaptation. The decision and T-6A-24 measurement are recorded in the handoff. No production route is enabled.

## A01 request body

Approved content type: `application/vnd.secubuzz.attachment-frame`. The body is a four-byte unsigned big-endian integer `H`, followed by exactly `H` bytes of UTF-8 JSON, followed by exactly `byteSize` opaque content bytes. `H` is the encoded header byte length, not a character count. Approved maximum header length is 131,072 bytes. The limit is intentionally above HTTP's 16,384-byte aggregate header limit and accommodates the JSON expansion of up to 16,384 encrypted-metadata characters plus framing fields.

The closed JSON object is:

```json
{"conversationId":"…","byteSize":123,"encryptedMetadata":"…","algorithm":"…","formatVersion":"…"}
```

| Field | Type and limit | Meaning |
|---|---|---|
| `conversationId` | string; resolved as an existing canonical conversation identifier | Direct or group conversation; authorization is derived from the authenticated session. |
| `byteSize` | JSON integer, safe and non-negative; per-file maximum is 52,428,800 bytes because the frame carries no category | Exact number of opaque bytes after the JSON header. The server independently counts streamed bytes. |
| `encryptedMetadata` | string, at most 16,384 characters | Opaque protected metadata. Names, original media type, and content-derived metadata belong only inside this value. |
| `algorithm` | string, 1–64 characters | Protected-content declaration, stored separately as `declared_algorithm`. |
| `formatVersion` | string, 1–64 characters | Protected-content declaration, stored separately as `declared_format_version`. |

The frame carries no category, file name, MIME type, key, or plaintext metadata. With no category field, the 50 MiB video limit is the maximum for every upload; smaller category limits are not applied by the server without a later approved contract change. The empty-file hex vector below tests codec framing only and does not decide A01's empty-upload policy.

## Parse and authorization order

The order resolving CI-15 is: read only the fixed prefix and bounded header; validate prefix length, UTF-8 JSON, object shape, field types and descriptor/metadata limits; authenticate session and verify CSRF; check Attachment_API gate; authorize conversation membership/direct-send rule; check archive state; apply the per-file size limit; then check quotas and reservations. No content byte, storage object, database row, or reservation is created before the bounded frame header and security checks succeed. This ordering does not permit an unauthenticated request to make the server buffer the full body.

Declared size above the applicable per-file limit is `413 PAYLOAD_TOO_LARGE` before content is read. A streamed count above the per-file limit is `413`; a count that differs from the declaration while staying within the limit is `400 VALIDATION_ERROR`. This follows DB6-R04.2–R04.3 and is the documented resolution of CI-15. The storage cap must enforce the per-file limit while counting; the service separately verifies exact declared length.

Malformed/truncated prefix or header, unsupported content type, invalid JSON/object, or extra/missing content is refused without a row, reservation, `.part`, or final file. HTTP headers remain below the existing server limit; the frame cap applies only to the body header.

## Byte-exact codec vectors

These examples use compact JSON serialization, UTF-8, a four-byte big-endian header length, and lowercase hexadecimal for the complete frame.

**Empty content framing vector** (`H = 98`, payload length 0):

```text
000000627b22636f6e766572736174696f6e4964223a226331222c226279746553697a65223a302c22656e637279707465644d65746164617461223a22222c22616c676f726974686d223a2274657374222c22666f726d617456657273696f6e223a2231227d
```

**Three-byte content vector** (`H = 99`, payload `abc`):

```text
000000637b22636f6e766572736174696f6e4964223a226331222c226279746553697a65223a332c22656e637279707465644d65746164617461223a226d222c22616c676f726974686d223a2274657374222c22666f726d617456657273696f6e223a2231227d616263
```

DB-6B `attachments/frame.js` and its tests, and DB-6E's client encoder and tests, must use these identical vectors. They test codec bytes; policy validation is tested independently.

## Route compatibility

The frame is sent only to `POST /api/attachments`. `/api/files` exposes only `GET /api/files/search`; the standalone `/api/files` upload/download alias and filename-header transport are retired. DB-6E adapts the existing uploader to ciphertext, encrypted metadata, the protected declaration, and this frame, with no plaintext fallback.
