# Requirements: authenticated recipient-key verification (post DB-4B)

## Introduction

DB-4B stores encrypted direct messages but refuses every submission with `503 RECIPIENT_KEYS_UNAVAILABLE`, because no component can attest that a message was encrypted for the intended recipient's authenticated keys. The realtime server refuses `message:send` with `recipient_keys_unavailable` for the same reason.

This work defines a device-key protocol for two-party direct messages and implements the server-side verification that DB-4B's shared write service and the realtime server can call. It is an integration task after DB-4B. It does not rename Phase 9A, 9B or 10, and it does not implement group keys, attachments, AI features or a new database.

Ownership for this task: Kiro owns `server/`. `client/` (Codex) and `DATA/` (Database Team) are read-only. Changes they need are specified as handoffs.

Production message submission must stay blocked until key persistence (DATA), client key management (Codex) and verification (Kiro) all exist and are tested together.

## Glossary

- **Account**: a DB-2 credential-enabled user, identified by `userId` from the authenticated session.
- **Device**: one browser profile of one account with its own persistent key pairs. Identified by a random `deviceId`.
- **Device key**: a device's ECDSA P-256 signing public key and ECDH P-256 agreement public key, registered with a self-signature. Identified by `deviceKeyId`, a SHA-256 over both public keys.
- **Epoch**: one AES-256-GCM conversation key for one direct conversation, wrapped (HPKE) for every active device of both participants and signed by the creating device. Identified by a random `keyId` and a per-conversation `epoch` number.
- **Key directory**: the authoritative persisted records of device keys and epochs. Owned by the Database Team.
- **Verifier**: the Kiro component that decides `{verified: true}` or `{verified: false}` for one encrypted envelope from the directory state.
- **Envelope v2**: the version-1 message envelope plus `encryption.keyId`, bound into AES-GCM additional authenticated data.

## Requirements

### Requirement 1: Device key registration and ownership

**User Story:** As a user, I want each of my browsers to register its own public keys under my account only, so that nobody can attach their keys to my identity.

#### Acceptance Criteria

1. THE System SHALL accept a device key only for the `userId` of the authenticated session; a user ID in the request body SHALL NOT be accepted.
2. THE System SHALL require a self-signature by the device signing key over a canonical statement that binds `userId`, `deviceId`, `keyVersion`, `createdAt` and both public keys.
3. WHEN the signature is invalid, a public key is not a valid uncompressed P-256 point, the two public keys are equal, or the request has unknown fields, THE System SHALL refuse the registration.
4. WHEN the same `deviceKeyId` is already registered to another user, device or version, or was superseded or revoked, THE System SHALL refuse it.
5. WHEN a `deviceId` belongs to another user or has been revoked, THE System SHALL refuse it.
6. WHEN `keyVersion` is not greater than every existing version of that device, THE System SHALL refuse it as a replay.
7. WHEN `createdAt` differs from server time by more than 5 minutes for a new registration, THE System SHALL refuse it.
8. WHEN an identical registration is repeated, THE System SHALL return the existing record without changes.
9. THE System SHALL allow at most 10 active devices per user.
10. THE System SHALL store public keys only; private keys SHALL never be accepted.

### Requirement 2: Revocation and rotation

**User Story:** As a user, I want to revoke a lost browser, so that it cannot read messages sent after the revocation.

#### Acceptance Criteria

1. THE System SHALL let only the owning account revoke its device, and revocation SHALL be permanent for that `deviceId`.
2. WHEN a device registers a higher `keyVersion`, THE System SHALL mark the older version superseded.
3. WHEN any participant's set of active device keys changes, THE System SHALL treat every existing epoch of the conversation as stale until a new epoch covers the new set.

### Requirement 3: Recipient-key discovery

**User Story:** As a sender, I want to fetch my contact's current device keys only for a conversation I may use, so that keys are not exposed to unrelated accounts.

#### Acceptance Criteria

1. THE System SHALL return device keys and epochs of a conversation only to its current authorized participants (DB-4A membership, blocks in either direction).
2. THE System SHALL return the self-signature with every device key so that clients can verify it.
3. THE client SHALL pin each peer's device keys on first use and warn when they change.

### Requirement 4: Conversation-key delivery

**User Story:** As a sender, I want to deliver a conversation key to my contact's devices without the server learning it, so that only they can decrypt my messages.

#### Acceptance Criteria

1. THE client SHALL wrap the 32-byte epoch key for each recipient device with HPKE (RFC 9180, base mode, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM) and an `info` value that binds conversation, epoch and both device identities.
2. THE creator device SHALL sign the epoch statement, which covers every wrapped key.
3. THE System SHALL accept an epoch only from an active device of the authenticated actor, only with number `current + 1` and `previousKeyId` equal to the current epoch, and only when its recipients equal exactly the active devices of both participants.
4. THE System SHALL treat an identical repeated publication as a duplicate and a different publication with an existing `keyId` as a conflict.
5. THE System SHALL never receive or store an unwrapped conversation key.

### Requirement 5: Envelope binding

**User Story:** As a recipient, I want each message to state which epoch key encrypted it, so that the server and my client can check it was the current key.

#### Acceptance Criteria

1. THE envelope v2 SHALL add `encryption.keyId` and SHALL authenticate it in the AES-GCM additional data together with the version-1 metadata.
2. THE envelope v2 fingerprint SHALL include `keyId`; the version-1 fingerprint SHALL stay byte-for-byte unchanged.
3. THE System SHALL reject unknown fields, plaintext, demo markers, non-canonical base64, IVs other than 12 bytes and ciphertext of 16 bytes or less.

### Requirement 6: Verification decision

**User Story:** As the platform, I want a send accepted only when its key matches the authoritative recipient-key state, so that no message is stored for unverified recipients.

#### Acceptance Criteria

1. THE Verifier SHALL return `{verified: true}` only WHEN all of the following hold: the envelope is v2; the actor is the sender and a participant; DATA's recipient IDs equal the other participants; the epoch exists in that conversation and is the current epoch; its creator is an active device of a participant; its signature and every active device's self-signature verify; every participant has an active device; and the epoch's recipients equal exactly the active devices.
2. THE Verifier SHALL return `{verified: false}` for any other envelope, including every version-1 envelope.
3. WHEN DATA supplies a fingerprint, THE Verifier SHALL refuse a mismatch with its own v2 fingerprint.
4. WHEN the key directory throws, times out or returns malformed data, THE Verifier SHALL fail closed by throwing, which DATA maps to `503 RECIPIENT_KEYS_UNAVAILABLE` and the realtime server maps to `unavailable`.
5. THE Verifier SHALL refuse construction without a directory, and SHALL refuse a test-only directory in production.
6. THE Verifier SHALL provide a synchronous check that DATA can run inside its write transaction so that a revocation during verification cannot let a message commit.
7. THE Verifier SHALL NOT log keys, signatures, ciphertext, user IDs, session IDs or conversation IDs.

### Requirement 7: Fail-closed production state

**User Story:** As the security owner, I want production sending to stay disabled until every guarantee exists, so that a missing piece never becomes silent success.

#### Acceptance Criteria

1. THE System SHALL keep `503 RECIPIENT_KEYS_UNAVAILABLE` in DATA's normal entrypoint until DATA persists the key directory and injects the Verifier.
2. THE System SHALL NOT add any environment flag, mock result, development bypass or readiness flag that enables sending.
3. THE realtime server SHALL keep refusing `message:send` until a per-actor message store and envelope v2 support are integrated.

### Requirement 8: Authorization boundaries

**User Story:** As a user, I want every key and message operation bound to my real session and current relationship, so that a stolen ID or an old socket cannot act for me.

#### Acceptance Criteria

1. THE System SHALL authenticate every key operation through the DB-2 session and CSRF proof, and SHALL NOT create a second authentication system.
2. THE System SHALL check membership, friendship and blocks again inside the write transaction after any asynchronous verification.
3. THE System SHALL NOT treat a socket room, a cached grant or a client claim as authorization for key access.

### Requirement 9: Cross-owner handoffs

**User Story:** As the integrating teams, we want exact contracts, so that DATA and the client can implement their parts without guessing.

#### Acceptance Criteria

1. THE documentation SHALL specify DATA tables, endpoints, schemas, error codes, transaction rules and the directory adapter.
2. THE documentation SHALL specify the client key lifecycle, canonical byte formats and HPKE parameters.
3. THE repository SHALL provide test vectors and a reusable directory contract suite.

### Requirement 10: Testing

**User Story:** As a maintainer, I want security behavior proven by tests, so that regressions fail loudly.

#### Acceptance Criteria

1. THE tests SHALL cover registration, substitution, identity mismatch, unknown and revoked keys, invalid versions, expired sessions, blocks, revoked membership, concurrent updates, replay, malformed envelopes, missing verification, directory unavailability, restart, and absence of secrets in logs and storage.
2. THE tests SHALL run a two-account flow with independent device keys and real WebCrypto operations, and an unauthorized third account.
3. THE tests SHALL exercise the real DATA application with real DB-2 accounts and the real DB-4B write pipeline wherever DATA supports it, and SHALL report what DATA does not yet support.
4. THE final report SHALL distinguish completed server-side verification from pending cross-owner end-to-end verification.
