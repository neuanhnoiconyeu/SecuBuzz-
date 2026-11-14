import { AIError, AI_MAX_OUTPUT, validateAIRequest, type AIProvider, type AIRequest, type AIResponse } from './aiModel';

/** Owns deadlines even when a future provider ignores abort; rejects all unknown response fields. */
export async function executeAIRequest(provider: AIProvider, untrusted: AIRequest,
  { signal, remoteConsent = false, timeoutMs = 15_000 }: { signal: AbortSignal; remoteConsent?: boolean; timeoutMs?: number }): Promise<AIResponse> {
  const request = Object.freeze(validateAIRequest(untrusted));
  if (!provider.available || provider.mode === 'unavailable') throw new AIError('unavailable');
  if (provider.mode === 'remote' && remoteConsent !== true) throw new AIError('consent_required');
  if (signal.aborted) throw new AIError('cancelled');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  try {
    const cancellation = new Promise<never>((_resolve, reject) => {
      abort = () => { controller.abort(); reject(new AIError('cancelled')); };
      signal.addEventListener('abort', abort, { once: true });
      const deadline = Number.isFinite(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60_000 ? timeoutMs : 15_000;
      timer = setTimeout(() => { controller.abort(); reject(new AIError('timeout')); }, deadline);
    });
    const response: unknown = await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new AIError('cancelled');
      return provider.run(request, { signal: controller.signal });
    }), cancellation]);
    if (signal.aborted) throw new AIError('cancelled');
    if (!response || typeof response !== 'object' || Array.isArray(response) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(response)) ||
      Reflect.ownKeys(response).some(key => typeof key !== 'string' || !['output', 'provider', 'kind'].includes(key))) throw new AIError('invalid_response');
    const value = response as Record<string, unknown>;
    if (value.provider !== provider.mode || typeof value.output !== 'string' || !value.output.trim() || value.output.length > AI_MAX_OUTPUT ||
      value.output.includes('\0') || !['example', 'answer', 'limitation'].includes(value.kind as string) ||
      (provider.mode === 'demo' && value.kind === 'answer')) throw new AIError('invalid_response');
    return { output: value.output, provider: value.provider as AIResponse['provider'], kind: value.kind as AIResponse['kind'] };
  } catch (error) {
    throw error instanceof AIError ? error : new AIError('request_failed');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
