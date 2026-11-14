import { AIError, AI_TOOLS, validateAIRequest, type AIProvider, type AIRequest, type AIResponse } from './aiModel';
import { readCsrfMetaToken, RemoteAIProvider } from './remoteAIProvider';

export const DEMO_AI_LIMITATION = 'Demo only: no AI model is connected. Your text has not been analyzed or transformed. Use “Try an example” to explore a prepared result.';
const answers = {
  'What can @Secu do?': 'This is an offline demo of @Secu. Explore prepared examples for summaries, rewrites, translations, action items and explanations. I cannot answer arbitrary questions yet.',
  'How is my text used?': 'In this demo, text stays in this page’s memory. No AI service receives it. Only text you explicitly choose is brought from Messenger, and leaving your account clears AI work.',
};

/** Static fixtures only. No network, history lookup, credential, storage or inferred analysis. */
export class DemoAIProvider implements AIProvider {
  readonly mode = 'demo' as const;
  readonly supportsStreaming = false;
  get available() { return process.env.NODE_ENV !== 'production'; }
  constructor(private readonly delayMs = 500) { if (!this.available) throw new AIError('unavailable'); }

  async run(untrusted: Readonly<AIRequest>, { signal }: { signal: AbortSignal }): Promise<AIResponse> {
    if (!this.available) throw new AIError('unavailable');
    const request = validateAIRequest(untrusted);
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(new AIError('cancelled')); return; }
      const abort = () => { clearTimeout(timer); reject(new AIError('cancelled')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, this.delayMs);
      signal.addEventListener('abort', abort, { once: true });
    });
    if (!this.available) throw new AIError('unavailable');
    if (signal.aborted) throw new AIError('cancelled');
    if (request.task === 'chat') {
      const output = answers[request.input.trim() as keyof typeof answers];
      return { output: output ?? DEMO_AI_LIMITATION, provider: 'demo', kind: output ? 'example' : 'limitation' };
    }
    const fixture = AI_TOOLS.find(tool => tool.task === request.task)!;
    if (request.input.trim() !== fixture.example) return { output: DEMO_AI_LIMITATION, provider: 'demo', kind: 'limitation' };
    let output: string;
    switch (request.task) {
      case 'summarize': output = 'Friday, 10 AM: review the launch checklist. Maya brings test results; Jules confirms the release notes.'; break;
      case 'rewrite': output = {
        Friendly: 'Could you send me the notes when you get a chance? Thanks!',
        Professional: 'Please share the notes at your earliest convenience.',
        Concise: 'Please send the notes when available.',
      }[request.tone!]; break;
      case 'translate': output = { Spanish: '¡Hola! ¿Cómo estás?', French: 'Bonjour ! Comment allez-vous ?', Vietnamese: 'Xin chào! Bạn có khỏe không?' }[request.targetLanguage!]; break;
      case 'action_items': output = '• Maya: share the test results by Thursday.\n• Jules: review the release notes by Friday.'; break;
      case 'explain': output = 'Signing in needs your password and another check, such as a code. Having only your password is not enough.'; break;
    }
    return { output, provider: 'demo', kind: 'example' };
  }
}

class UnavailableAIProvider implements AIProvider {
  readonly mode = 'unavailable' as const;
  readonly available = false;
  readonly supportsStreaming = false;
  async run(): Promise<AIResponse> { throw new AIError('unavailable'); }
}

/**
 * Explicit development demo selection, or the Phase 9B backend provider for a real API session
 * when every readiness flag is set. There is no remote-error fallback to the demo.
 */
export function createAIProvider(isDemoSession: boolean): AIProvider {
  if (process.env.NODE_ENV !== 'production' && isDemoSession) return new DemoAIProvider();
  if (!isDemoSession && process.env.NEXT_PUBLIC_AUTH_MODE === 'api' && process.env.NEXT_PUBLIC_AUTH_API_READY === 'true' &&
    process.env.NEXT_PUBLIC_AI_REMOTE_READY === 'true') return new RemoteAIProvider({ getCsrfToken: readCsrfMetaToken });
  return new UnavailableAIProvider();
}
