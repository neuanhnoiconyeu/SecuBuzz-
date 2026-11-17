import type { AuthUser } from '@/auth/authModel';

export type ApiErrorCode = 'unauthorized' | 'forbidden' | 'csrf_invalid' | 'validation' | 'not_found' |
  'conflict' | 'stale_state' | 'rate_limited' | 'unavailable' | 'feature_unavailable' | 'service_unavailable' |
  'invalid_response' | 'cancelled' | 'resource_limit' | 'recipient_keys_changed' | 'recipient_keys_unverified' |
  'recipient_keys_missing' | 'key_service_unavailable' | 'key_proof_invalid' | 'key_conflict' | 'device_limit' | 'idempotency_conflict';
const messages: Record<ApiErrorCode, string> = {
  unauthorized: 'Your session changed or expired. Sign in again.',
  forbidden: 'This action is not permitted. Refresh and try again.',
  csrf_invalid: 'The security check failed. Refresh and try again. Your change was not retried.',
  validation: 'Please check the highlighted fields and try again.',
  not_found: 'This profile or relationship is no longer available to you.',
  conflict: 'This relationship changed. Refresh before trying again.',
  stale_state: 'Your relationships changed during refresh. Try refreshing again.',
  rate_limited: 'Too many requests. Wait before trying again.',
  unavailable: 'The service could not be reached. Check your connection and try again.',
  feature_unavailable: 'Profiles and friends are not enabled on the connected service. Please try again later.',
  service_unavailable: 'The service is temporarily unavailable. Please try again.',
  invalid_response: 'The service returned an unexpected response. Refresh and try again.',
  cancelled: 'This request was canceled.',
  resource_limit: 'This list is too large to load safely. Please try again later.',
  recipient_keys_changed: 'Conversation device keys changed. Refresh secure state before publishing again.',
  recipient_keys_unverified: 'Recipient keys could not be verified. Refresh secure state; the message was not retried.',
  recipient_keys_missing: 'Waiting for recipient keys. Every participant needs an active device.',
  key_service_unavailable: 'Recipient key verification is unavailable. No insecure fallback is available.',
  key_proof_invalid: 'The device or epoch signature or timestamp was rejected.',
  key_conflict: 'This device registration conflicts with an existing record. Refresh device status before retrying. Existing keys were not replaced.',
  device_limit: 'The account has reached its active-device limit.',
  idempotency_conflict: 'This message ID already belongs to different encrypted content. Check history before continuing.',
};

/** Only fixed public messages and allowlisted field names cross this boundary. */
export class ApiError extends Error {
  constructor(public readonly code: ApiErrorCode, public readonly fields: string[] = [], public readonly retryAfter?: number) {
    super(messages[code] + (code === 'rate_limited' && retryAfter ? ` Try again in ${retryAfter} seconds.` : ''));
    this.name = 'ApiError';
  }
}
export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal | undefined;
  status?: 200 | 201 | 204 | readonly (200 | 201)[];
}
export interface SessionApi {
  readonly actor: Pick<AuthUser, 'id' | 'username'>;
  request(path: string, options?: ApiRequest): Promise<unknown>;
  /** Fresh, identity-checked proof for the cookie-authenticated realtime handshake. */
  realtimeAuth?(): Promise<{ csrfToken: string }>;
  invalidateSession?(): void;
  dispose(): void;
}

export function safeApiMessage(failure: unknown, fallback: string): string {
  return failure instanceof ApiError ? failure.message : fallback;
}
