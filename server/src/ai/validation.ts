/**
 * Strict parsing of AI API request bodies. Unknown keys fail closed, so a client cannot add an
 * identity, a model, a provider, sampling settings or a demo flag. Rules match
 * `client/src/ai/aiModel.ts` and are slightly stricter about control characters.
 */
import { hasOnlyKeys, isIdentifier, isPlainObject } from '../realtime/validation.ts';
import { AI_LANGUAGES, AI_TASKS, AI_TONES, type AiLanguage, type AiTask, type AiTone } from './protocol.ts';

export interface AiGenerationRequest {
  readonly task: AiTask;
  readonly input: string;
  readonly tone?: AiTone;
  readonly targetLanguage?: AiLanguage;
  /** Present only for Messenger handoffs, which the privacy rules always refuse. */
  readonly conversationId?: string;
}

export interface AiGenerationBody {
  readonly request: AiGenerationRequest;
  /** `null` when absent; the service answers AI_CONSENT_REQUIRED. */
  readonly consentToken: string | null;
}

export interface AiConsentBody {
  readonly disclosureVersion: string;
  readonly payloadDigest: string;
}

export type ParseResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly code: 'AI_INVALID_REQUEST' | 'AI_INPUT_TOO_LARGE'; readonly reason: string };

/** NUL, other C0 controls except tab, newline and carriage return, and DEL. */
const DISALLOWED_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const LONE_SURROGATE = /\p{Cs}/u;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const VERSION = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const TOKEN = /^[A-Za-z0-9._-]{1,2048}$/;

function invalid(reason: string): ParseResult<never> {
  return { ok: false, code: 'AI_INVALID_REQUEST', reason };
}

function includes<Value extends string>(values: readonly Value[], value: unknown): value is Value {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** `{ request: { task, input, tone?, targetLanguage?, conversationId? }, consentToken? }`. */
export function parseGenerationBody(body: unknown, maxInputChars: number): ParseResult<AiGenerationBody> {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ['request', 'consentToken'])) return invalid('body_shape');
  const request = body.request;
  if (!isPlainObject(request) || !hasOnlyKeys(request, ['task', 'input', 'tone', 'targetLanguage', 'conversationId'])) {
    return invalid('request_shape');
  }
  if (!includes(AI_TASKS, request.task)) return invalid('task');
  const input = request.input;
  if (typeof input !== 'string' || input.trim().length === 0) return invalid('input_empty');
  if (input.length > maxInputChars) return { ok: false, code: 'AI_INPUT_TOO_LARGE', reason: 'input_length' };
  if (DISALLOWED_TEXT.test(input) || LONE_SURROGATE.test(input)) return invalid('input_characters');

  const task = request.task;
  let tone: AiTone | undefined;
  let targetLanguage: AiLanguage | undefined;
  if (task === 'rewrite') {
    if (!includes(AI_TONES, request.tone)) return invalid('tone');
    tone = request.tone;
  } else if (request.tone !== undefined) return invalid('tone_unexpected');
  if (task === 'translate') {
    if (!includes(AI_LANGUAGES, request.targetLanguage)) return invalid('language');
    targetLanguage = request.targetLanguage;
  } else if (request.targetLanguage !== undefined) return invalid('language_unexpected');
  if (request.conversationId !== undefined && !isIdentifier(request.conversationId)) return invalid('conversation_id');

  const token = body.consentToken;
  if (token !== undefined && (typeof token !== 'string' || !TOKEN.test(token))) return invalid('consent_token');
  return {
    ok: true,
    value: {
      request: {
        task,
        input,
        ...(tone ? { tone } : {}),
        ...(targetLanguage ? { targetLanguage } : {}),
        ...(typeof request.conversationId === 'string' ? { conversationId: request.conversationId } : {}),
      },
      consentToken: typeof token === 'string' ? token : null,
    },
  };
}

/** `{ disclosureVersion, payloadDigest }`. The version is compared with the current disclosure later. */
export function parseConsentBody(body: unknown): ParseResult<AiConsentBody> {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ['disclosureVersion', 'payloadDigest'])) return invalid('body_shape');
  if (typeof body.disclosureVersion !== 'string' || !VERSION.test(body.disclosureVersion)) return invalid('disclosure_version');
  if (typeof body.payloadDigest !== 'string' || !DIGEST.test(body.payloadDigest)) return invalid('payload_digest');
  return { ok: true, value: { disclosureVersion: body.disclosureVersion, payloadDigest: body.payloadDigest } };
}
