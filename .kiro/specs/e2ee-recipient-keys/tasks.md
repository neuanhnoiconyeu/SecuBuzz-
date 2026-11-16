# Tasks: authenticated recipient-key verification (post DB-4B)

Items are checked only after their tests pass. No task enables production sending.

- [x] 1. Audit and architecture assessment
  - [x] 1.1 Inspect git state, DB-2/DB-4A/DB-4B contracts, client crypto and key manager, realtime messaging; record findings (design §1)
  - [x] 1.2 Baselines: server 334/334, DATA 288/288
  - _Requirements: 9.1, 9.2_

- [x] 2. Protocol library (`server/src/e2ee/`)
  - [x] 2.1 Protocol constants, canonical encodings, P-256 key validation, signatures, statements
    - _Requirements: 1.2, 1.3, 1.10, 4.1, 4.2_
  - [x] 2.2 Envelope v2 parser, fingerprint and AAD; v1 unchanged
    - _Requirements: 5.1, 5.2, 5.3_
  - [x] 2.3 Registration and revocation rules
    - _Requirements: 1.1–1.9, 2.1, 2.2_
  - [x] 2.4 Epoch publication rules
    - _Requirements: 2.3, 4.3, 4.4_
  - [x] 2.5 Evaluator, synchronous recheck and verifier with fail-closed behavior
    - _Requirements: 6.1–6.7, 7.2_
  - [x] 2.6 Public entry point and `./e2ee` package export
    - _Requirements: 9.3_

- [x] 3. Tests (`server/test/e2ee/`)
  - [x] 3.1 Test-only HPKE checked against RFC 9180 A.3.1; independent WebCrypto device simulator
    - _Requirements: 4.1, 10.2_
  - [x] 3.2 Unit tests for primitives, envelope, rules and verifier
    - _Requirements: 10.1_
  - [x] 3.3 Reusable directory contract suite with the in-memory reference
    - _Requirements: 9.3, 10.1_
  - [x] 3.4 Two-account flow with Charlie, multi-device, rotation, revocation, restart, substitution limitation
    - _Requirements: 10.2_
  - [x] 3.5 Real DATA seam test (real accounts, DB-4B pipeline, fail-closed paths)
    - _Requirements: 7.1, 8.1, 8.2, 10.3_
  - [x] 3.6 Realtime remains fail-closed with the genuine verifier
    - _Requirements: 7.3_
  - [x] 3.7 Interop vector file and boundary tests
    - _Requirements: 9.3_

- [x] 4. Documentation
  - [x] 4.1 `docs/e2ee-recipient-key-integration.md` with DATA and Codex handoffs and Socket.IO requirements
    - _Requirements: 9.1, 9.2, 10.4_
  - [x] 4.2 `server/README.md` layout entry

- [ ] 5. Cross-owner work (not Kiro-owned; blocks production)
  - [ ] 5.1 DATA: migration 7, key endpoints, v2 storage, in-transaction recheck, directory adapter, wiring, contract suite
  - [ ] 5.2 Codex: device keys, HPKE, remote key manager, envelope v2, key-change UX, proxy paths, vector tests
  - [ ] 5.3 Kiro next step: Socket.IO per-actor store binding, v2 on sockets, DATA authorizer, key-change events
  - [ ] 5.4 Two-browser end-to-end test with real accounts, then a security review before lifting `RECIPIENT_KEYS_UNAVAILABLE`
