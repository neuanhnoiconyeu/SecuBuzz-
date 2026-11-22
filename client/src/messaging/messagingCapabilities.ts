/** Features integrated with a messaging transport, not authorization grants.
 * Session readiness, connectivity, callbacks and per-message eligibility still apply.
 */
export interface MessagingCapabilities {
  readonly sendMessages: boolean;
  readonly retryMessages: boolean;
  readonly emoji: boolean;
  readonly reply: boolean;
  readonly forward: boolean;
  readonly edit: boolean;
  readonly deleteForMe: boolean;
  readonly unsendForEveryone: boolean;
  readonly pin: boolean;
  readonly reactions: boolean;
  readonly attachments: boolean;
  readonly voiceMessages: boolean;
  readonly directCalls: boolean;
  readonly buzz: boolean;
}

export const DEMO_MESSAGING_CAPABILITIES: MessagingCapabilities = Object.freeze({
  sendMessages: true, retryMessages: true, emoji: true,
  reply: true, forward: true, edit: true, deleteForMe: true, unsendForEveryone: true,
  pin: true, reactions: true, attachments: true, voiceMessages: true, directCalls: true, buzz: true,
});

// E2EE v2 integrates text, emoji, encrypted reply/forward content and exact-envelope retries.
// Delete for Me only persists browser-profile preferences; it never removes server data.
// Unsend uses DATA's sender-authorized API and history-confirmed realtime hints.
// An endpoint's existence alone does not make its UI/crypto/realtime contract ready.
// Direct calls stay gated until authenticated LiveKit audio AND video delivery are verified.
export const REAL_ACCOUNT_MESSAGING_CAPABILITIES: MessagingCapabilities = Object.freeze({
  sendMessages: true, retryMessages: true, emoji: true,
  reply: true, forward: true, edit: true, deleteForMe: true, unsendForEveryone: true,
  pin: true, reactions: true, attachments: true, voiceMessages: true, directCalls: false, buzz: false,
});
