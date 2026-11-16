# Tasks: secure realtime integration (Socket.IO, DATA and E2EE v2)

Items are checked only after their tests pass. Real-client two-browser verification is outside Kiro's ownership.

- [x] 1. Contract audit (client, DATA, Kiro docs and source) and baseline (397 tests, hash snapshot)
  - _Requirements: 10.1_
- [x] 2. Realtime core extensions
  - [x] 2.1 Binder seam, credentials, optional authorizer methods, v2 request type
    - _Requirements: 1.2, 1.7, 4.4_
  - [x] 2.2 Handshake: auth shape, binder call, transport verdict, preference, revocation recheck
    - _Requirements: 1.1-1.6, 6.4_
  - [x] 2.3 Messages: bound store, v2 fingerprint, classification, post-commit re-authorized fan-out
    - _Requirements: 4.1-4.6, 5.1, 5.2, 3.4_
  - [x] 2.4 Receipts through the bound store with re-authorized notification
    - _Requirements: 3.3, 6.2_
  - [x] 2.5 Server handle: `refreshAllAccess`, `notifyKeysChanged`, v2 parsing by connection
    - _Requirements: 3.2, 7.1, 7.2_
- [x] 3. DATA bridge (`server/src/data/`)
  - [x] 3.1 Duck-typed DATA application and attach-time validation
    - _Requirements: 9.2_
  - [x] 3.2 Authorizer, binder (with DATA write budget), transport verdict
    - _Requirements: 1.2, 1.6, 3.1, 3.3, 4.7_
  - [x] 3.3 Observer for logout, social, profile and key mutations
    - _Requirements: 2.1, 3.2, 7.1_
  - [x] 3.4 Composition (`attachRealtimeToData`), combined process (`npm run start:data`), `./data` export
    - _Requirements: 9.2_
- [x] 4. Tests
  - [x] 4.1 Real-DATA suites: authentication, authorization, messaging, keys, reconnect, process, boundaries
    - _Requirements: 10.1_
  - [x] 4.2 Seam tests with doubles; legacy suites unchanged
    - _Requirements: 9.3, 10.1_
  - [x] 4.3 Replaced the stale DATA seam test (DATA now ships key tables)
  - [x] 4.4 Mutation checks on budget, duplicate fan-out, delivery re-authorization
- [x] 5. Documentation: `server/docs/realtime-data-integration.md`, `server/docs/client-realtime-handoff.md`, README
  - _Requirements: 10.2_
- [x] 6. Final verification: type check, full server suite, DATA suite, ownership and hash checks
- [ ] 7. Real two-browser verification through the client (blocked: client adapter lacks `auth.csrfToken`, v2 parsing, send and keys-changed; see client handoff)
- [ ] 8. Optional DATA follow-ups: durable change feed, "blocked by" lookup (not required)
