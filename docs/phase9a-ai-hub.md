# Phase 9A — AI Hub and @Secu frontend foundation

Implemented in `D:\Projects\SecuBuzz-` on `chuong-fullstack`, starting at `4578429` (merged Phase 8.7C). This is a frontend foundation with an honest offline demo. No real AI API, backend adapter, production message persistence, security agent or recipient-key feature was added.

## Workspace and UI

AI Hub is a fourth section of the existing authenticated Messenger workspace, alongside Chats, Friends and Security. There is no duplicate page/navigation system or new auth route. `#ai-hub` can select the section in an already authenticated workspace; the existing authentication return-destination allowlist was not changed.

The landing page includes a prominent @Secu entry, five working tool cards, current-context recent tasks, an explicit provider status and a privacy notice. It reuses Yahoo artwork, the existing Midnight Charcoal/Yahoo Purple tokens, Bungee display headings, Space Grotesk text, shared buttons/dialogs and Light/Dark/System appearance. The assistant illustration uses CSS and existing Lucide icons, with no new font or image downloads.

@Secu has user/assistant bubbles, starter questions, a labeled composer, Enter to submit, Shift+Enter for a newline, IME protection, empty/invalid-input disabling, loading/cancel controls, recoverable retry, reset and bounded session history. New replies scroll only when the reader is near the bottom; otherwise a Jump to latest control appears. Reset clears that notice. Output renders as React text, not HTML or interpreted Markdown.

Each productivity workflow has supplied-text validation, submit/loading/cancel/error states, an output panel and copy feedback. Clipboard failure shows fixed safe feedback. Rewrite offers Friendly/Professional/Concise tones; Translate offers Spanish/French/Vietnamese prepared examples. Recent task controls reopen retained results without rerunning them.

## Architecture and files

| File | Responsibility |
| --- | --- |
| `client/src/ai/aiModel.ts` | Task/request/response/provider/selection types, limits, validation, safe errors, tool catalog |
| `client/src/ai/demoAIProvider.ts` | Static offline fixtures and explicit demo/unavailable factory |
| `client/src/ai/executeAIRequest.ts` | Cancellation, deadlines, future remote-consent guard, request/response projection |
| `client/src/ai/useAIWorkspace.ts` | One active operation, stale-result guards, bounded history/recent tasks, retry/reset |
| `client/src/components/ai/AIHub.tsx` | Landing, assistant/tool workspaces, input/source review, availability and output/copy states |
| `client/src/components/ai/AIChatHistory.tsx` | Safe chat rendering and reader-controlled scrolling |
| `client/src/styles/ai.css` | Theme-token-based responsive styling and spacing for the fourth navigation item |
| `client/src/components/messenger/MainNavigation.tsx` | AI Hub section entry |
| `client/src/components/messenger/MessengerApp.tsx` | Session/context ownership, explicit handoffs, draft-review dialog and guarded replacement |
| `client/src/components/YahooChatWindow.tsx` | Resolves a chosen message ID locally and projects only the supported text/context |
| `client/src/components/messenger/MessageList.tsx` | Ask/Summarize/Translate/Explain opt-in actions in the existing compact overflow menu |
| `client/src/components/messenger/MessageComposer.tsx` | Rewrite-draft entry; existing send/attachment/voice/BUZZ behavior retained |
| `client/src/app/layout.tsx` | Imports the AI stylesheet; auth/theme providers unchanged |

New tests live in `client/src/ai/__tests__/` and `client/src/components/ai/__tests__/`. This document is the only documentation file added or modified for this phase.

Two existing client compatibility problems discovered during validation were repaired narrowly:

- `client/tsconfig.json` used `ignoreDeprecations: "6.0"`, rejected by the declared TypeScript 5 dependency and installed 5.9.3 compiler. It now uses `"5.0"`; no dependencies were installed or changed.
- Main's composer called plain-text `onSend(content, undefined)`, conflicting with its existing one-argument regression test/contract. It now uses `onSend(content)` without extras, and `onSend(content, extras)` for attachments/voice. Existing tests were not weakened or rewritten.

## Provider-neutral contract

```ts
type AITask = 'chat' | 'summarize' | 'rewrite' | 'translate' | 'action_items' | 'explain';

interface AIRequest {
  task: AITask;
  input: string;
  conversationId?: string;
  targetLanguage?: 'Spanish' | 'French' | 'Vietnamese';
  tone?: 'Friendly' | 'Professional' | 'Concise';
}

interface AIResponse {
  output: string;
  provider: 'demo' | 'remote';
  kind: 'example' | 'answer' | 'limitation';
}
```

`AIProvider` reports mode (`demo`, `remote`, `unavailable`), availability and streaming capability. `run(request, {signal})` is the active interface. An optional typed `stream` signature is reserved for Phase 9B; no streaming provider, streaming UI, endpoint or stream-consumption path is implemented or claimed.

`executeAIRequest` projects allowed fields into a detached, frozen request, validates tone/language/context and bounds text to 8,000 input / 12,000 output UTF-16 code units. It validates provider identity and output kind, rejects unexpected response fields and drops private exception messages. A demo response cannot claim to be a model answer. Errors use fixed messages and typed codes: unavailable, invalid input, consent required, cancelled, timeout, request failed and invalid response.

Each operation has an AbortSignal and a 15-second deadline. The execution boundary rejects even if a future provider ignores cancellation. Component generation checks additionally discard stale responses. There is one active request, no offline request queue, no automatic retry and at most three explicit attempts per recoverable operation. A retry reuses its submitted snapshot and chat bubble. Invalid input/response, unavailable provider and cancellation are not retryable.

A future provider reporting `remote` is denied without explicit per-request consent. The UI has a conditional consent control for that future mode and consumes consent on submit/retry; changing input or selecting new content resets it. This is a frontend privacy contract, not backend authorization. There is no remote adapter today, and production readiness flags do not select a demo fallback.

## Honest demo behavior

`createAIProvider(isDemoSession)` selects the demo only outside production and only for an explicit demo session. Production and non-demo sessions obtain an unavailable provider. The demo also rechecks its production boundary when executing. A failed remote request never activates it.

The demo makes no network, storage, history, analytics or logging calls. It returns:

- Fixed disclosures for the starter questions “What can @Secu do?” and “How is my text used?”
- Prepared outputs only when the supplied text matches the relevant catalog example, with fixed tone/language variants where supported.
- A clear notice for other text: no model is connected and the text has not been analyzed or transformed.

“Try an example” only fills the input. Submission remains a separate action. These fixtures do not provide arbitrary summarization, rewriting, translation, task extraction or reasoning, and are always labeled as prepared demo examples or limitations.

## Messenger integration and review

The existing message overflow menu gains Ask @Secu, Summarize selected message, Translate selected message and Explain selected message. These actions are available only for supported, non-deleted text within the size limit. Security notices, system messages, unsupported media and oversized messages do not receive AI actions. Existing Pin/Edit/Delete/Reply/reaction behavior and keyboard-managed popovers remain intact.

The menu passes a task and the chosen message ID. `YahooChatWindow` resolves that ID in the active conversation and projects only its text and opaque context into a handoff. No message array, encryption payload, key, attachment, voice blob, reply chain or unrelated history reaches the AI workspace/provider. The user reviews the prefilled text and explicitly submits; opening AI Hub or receiving a message does not run AI.

Rewrite draft follows the same opt-in path. A usable result for an unchanged, chosen draft can open the shared Review your draft dialog. It shows the current draft and proposed replacement. Keep original leaves it untouched. Replace draft rechecks conversation, original text and chat controls before updating only that draft, returns to Chats and focuses the composer. It never sends a message. A changed draft disables replacement and explains the conflict.

Arbitrary demo input returns a limitation and cannot become a draft replacement. Choosing a separate prepared example clears the Messenger source association, so an unrelated example cannot masquerade as a rewrite of the user's original draft. The positive review path is demonstrable by placing the catalog's rewrite example in a Messenger draft first.

## Privacy and lifetime

- AI state is component-local memory, not localStorage/sessionStorage, database persistence or a second Messenger message store.
- The existing authenticated workspace owns the feature. Logout/account replacement unmounts it without changing authentication implementation. Cleanup aborts pending work and invalidates late responses.
- AI workspace state is also keyed to the selected Messenger conversation. Switching conversations clears AI history, supplied context and task results instead of exposing another chat's work. Ordinary navigation within the same conversation preserves AI session state, while leaving AI Hub cancels pending operations. Messenger drafts/history remain independent.
- History is limited to 60 chat bubbles and 20 recent tasks; the landing page shows the latest six. There is one pending operation and no automatic/background AI access.
- Sensitive input/output is never logged or sent to analytics. React text rendering keeps untrusted markup inert; copied text is an explicit user action.
- Existing friendship/chat controls, encryption indicators, real-send gating, realtime readiness and theme preferences remain intact.

## Verification

No repository tests or authentication/crypto/server implementation were altered for validation. TypeScript and build were also executed in a fresh ignored copy using the same source/configuration and existing node_modules. This avoids interference with existing development output.

| Command | Result |
| --- | --- |
| `npm run type-check` | Passed after the TypeScript-version setting correction |
| `npm run lint` | Passed; existing native-image warnings in MessageComposer and MessageList |
| `npm test -- --runInBand --testTimeout=15000` | Passed: 624 tests / 55 suites, 76.801 seconds |
| `npm run build` | Passed after final changes; six static pages, no new route |
| `git diff --check` | Passed; new untracked source/documentation also checked for whitespace errors |

The original default-timeout run surfaced the composer arity mismatch above and an existing auth/workspace integration test exceeding five seconds on this machine. The callback mismatch is fixed. The integration test passes with a 15-second CLI allowance; assertions and repository Jest configuration remain unchanged. The initial TypeScript failure was TS5103 for the pre-existing `ignoreDeprecations: "6.0"` value.

New tests cover all five tool workflows, honest arbitrary-input limitations, production/demo denial, offline operation, bounded validation/results, remote-consent policy through an injected test-only provider, safe errors, timeout/abort, retry bounds, late-response prevention, history bounds, chat keyboard/IME/reset, safe output rendering, copy success/failure, selected-message actions, draft confirmation/conflict, no automatic send, account/conversation isolation and reader-preserving scrolling. Existing Messenger/auth/friends/profile/themes/realtime/crypto suites remain included in the full run.

Chrome automation executed against an isolated development copy at 1440×1000, 1024×900 and 390×844 in Light, Dark and System modes: **547 assertions passed**. It exercised all five examples per combination, empty input, chat Enter/Shift+Enter, cancel/reset, recent tasks, retained Messenger drafts, source opt-in, draft review/confirmation, context switching, logout and identity replacement. Network observations recorded no remote AI, Socket.IO or third-party requests; no application runtime/hydration errors occurred. Production browser checks passed **5 assertions**, confirming guarded routes expose no demo/AI fallback. A final mobile-only pass after navigation-spacing polish passed **34 assertions** across all three themes, including overflow, chat and logout checks. The final provider-label refinement was additionally validated by the injected remote-provider consent/label component test; no remote adapter or request was introduced.

The first browser attempt stopped after 45 passed checks because its temporary keyboard-test expression contained an unescaped newline. The corrected runner and its evidence are separate; application code and repository tests were not changed for that harness error. Existing development image-priority warnings are unrelated to AI functionality.

Browser scripts, logs, screenshots and safety fingerprints are retained under ignored `tmp/phase9a-f774ea60331c4a049a05060b45090b23/`. They are local test artifacts, not product source or published assets. Browser verification used fresh profiles and cleaned up only its owned processes/ports.

## Scope preservation and Phase 9B handoff

Initial state: `chuong-fullstack`, HEAD `4578429`, three commits ahead of its upstream, with six pre-existing local deletions. Phase 8.7C was already committed/merged; its security and realtime implementation is retained. The existing `stash@{0}` (`fd19c4b…`, eight deletion changes) is not applied, popped or modified. No reset, stash, merge, rebase, checkout, commit or push is part of Phase 9A.

Server realtime/database/middleware/routes, `DATA/`, `.kiro/`, authentication, crypto/key management and production persistence are outside the patch. Existing deleted files remain deleted. Ownership/hash verification is recorded with the temporary baseline.

The existing real-account workspace still states that Messenger APIs are unavailable; this phase does not bypass or modify that authentication/integration boundary. AI Hub is reachable through the current demo Messenger, while its production-unavailable presentation is covered in component tests. Production browser tests confirm the existing auth guard. Exposing the Hub to real accounts belongs to an approved integration of that workspace.

Phase 9B still needs a secure backend AI service, authenticated request authorization, explicit remote-processing/privacy policy, server-enforced consent/limits, owner-approved context permissions, provider credentials held only on the backend, redacted diagnostics and any real streaming protocol. No Amazon Bedrock, Nebius, OpenAI or Gemini adapter is present. No real message send, E2EE key distribution or Phase 10 agent is enabled by this work.
