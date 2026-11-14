export const AI_TASKS = ['chat', 'summarize', 'rewrite', 'translate', 'action_items', 'explain'] as const;
export type AITask = typeof AI_TASKS[number];
export type AITool = Exclude<AITask, 'chat'>;
export type AIMessageAction = 'chat' | 'summarize' | 'translate' | 'explain';
export const AI_MAX_INPUT = 8_000;
export const AI_MAX_OUTPUT = 12_000;
export const AI_TONES = ['Friendly', 'Professional', 'Concise'] as const;
export const AI_LANGUAGES = ['Spanish', 'French', 'Vietnamese'] as const;

export interface AIRequest {
  task: AITask;
  input: string;
  conversationId?: string;
  tone?: typeof AI_TONES[number];
  targetLanguage?: typeof AI_LANGUAGES[number];
}
export interface AIResponse {
  output: string;
  provider: 'demo' | 'remote';
  kind: 'example' | 'answer' | 'limitation';
}
export interface AIProvider {
  readonly mode: 'demo' | 'remote' | 'unavailable';
  readonly available: boolean;
  readonly supportsStreaming: boolean;
  /** `false` when private Messenger content must never reach this provider (Phase 9B free-tier Gemini). */
  readonly acceptsMessengerContent?: boolean;
  /** Plain-text notice shown before a user consents to remote processing. */
  readonly disclosure?: string;
  run(request: Readonly<AIRequest>, options: { signal: AbortSignal }): Promise<AIResponse>;
  /** Reserved for a future backend adapter; Phase 9A never calls a streaming endpoint. */
  stream?(request: Readonly<AIRequest>, options: { signal: AbortSignal }): AsyncIterable<{ text: string; done: boolean }>;
}
export interface AISelection {
  task: AIMessageAction | 'rewrite';
  input: string;
  conversationId: string;
  kind: 'message' | 'draft';
  messageId?: string;
}
export interface AIEntry extends AISelection { id: number }
export type AIErrorCode = 'unavailable' | 'invalid_input' | 'consent_required' | 'cancelled' | 'timeout' | 'request_failed' | 'invalid_response'
  | 'privacy_restricted' | 'rate_limited' | 'quota_exhausted' | 'provider_unavailable' | 'auth_required' | 'declined';
const messages: Record<AIErrorCode, string> = {
  unavailable: '@Secu is not connected yet. AI tools are unavailable in this session.',
  invalid_input: `Enter between 1 and ${AI_MAX_INPUT.toLocaleString('en-US')} characters and choose a supported option.`,
  consent_required: 'Review and allow remote processing before sharing this text with an AI service.',
  cancelled: 'Request cancelled.',
  timeout: 'This request took too long. You can try again.',
  request_failed: 'The request could not be completed. You can try again.',
  invalid_response: 'The response could not be safely displayed.',
  privacy_restricted: "This content cannot be sent to the current AI provider because of SecuBuzz's privacy restrictions.",
  rate_limited: '@Secu is receiving too many requests. Wait a moment, then try again.',
  quota_exhausted: '@Secu has reached its free AI usage limit.',
  provider_unavailable: '@Secu is temporarily unavailable.',
  auth_required: 'Sign in again to use @Secu.',
  declined: '@Secu couldn’t process this text. Try rephrasing it.',
};
const retryableCodes: ReadonlySet<AIErrorCode> = new Set(['timeout', 'request_failed', 'rate_limited', 'provider_unavailable']);
export class AIError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: AIErrorCode) {
    super(messages[code]); this.name = 'AIError';
    this.retryable = retryableCodes.has(code);
  }
}
export function validAIInput(input: string): boolean {
  return typeof input === 'string' && input.trim().length > 0 && input.length <= AI_MAX_INPUT && !input.includes('\0');
}
export function validateAIRequest(input: AIRequest): AIRequest {
  if (!input || !AI_TASKS.includes(input.task) || !validAIInput(input.input) ||
    (input.conversationId !== undefined && (typeof input.conversationId !== 'string' || !/^[^\s\u0000-\u001f\u007f]{1,256}$/u.test(input.conversationId))) ||
    (input.task === 'rewrite' && !AI_TONES.includes(input.tone!)) ||
    (input.task === 'translate' && !AI_LANGUAGES.includes(input.targetLanguage!))) throw new AIError('invalid_input');
  return { task: input.task, input: input.input,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.task === 'rewrite' ? { tone: input.tone! } : {}),
    ...(input.task === 'translate' ? { targetLanguage: input.targetLanguage! } : {}),
  };
}

export const AI_TOOLS: ReadonlyArray<{ task: AITool; title: string; description: string; example: string }> = [
  { task: 'summarize', title: 'Summarize', description: 'Make room for the main points.',
    example: 'Let’s meet on Friday at 10 AM to review the launch checklist. Maya will bring the test results, and Jules will confirm the release notes.' },
  { task: 'rewrite', title: 'Rewrite', description: 'Find a tone that feels like you.', example: 'Send me the notes when you can.' },
  { task: 'translate', title: 'Translate', description: 'Explore words in another language.', example: 'Hello! How are you?' },
  { task: 'action_items', title: 'Action Items', description: 'Turn supplied notes into next steps.',
    example: 'Maya will share the test results by Thursday. Jules will review the release notes by Friday.' },
  { task: 'explain', title: 'Explain', description: 'Get a simpler way to look at it.', example: 'Two-factor authentication adds another step when you sign in.' },
];
export function aiTaskTitle(task: AITask): string { return task === 'chat' ? '@Secu chat' : AI_TOOLS.find(tool => tool.task === task)!.title; }
