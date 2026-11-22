/** Ephemeral attention signal, never encrypted message content or persisted history. */
export const BUZZ_SEND_EVENT = 'buzz:send';
export const BUZZ_RECEIVED_EVENT = 'buzz:received';
export const BUZZ_COOLDOWN_MS = 10_000;
export const BUZZ_EFFECT_MS = 500;
export interface BuzzEvent {
  id: string;
  conversationId: string;
  userId: string;
  displayName: string;
  timestamp: string;
}
