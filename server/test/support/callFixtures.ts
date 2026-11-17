import type { DirectCallConversationResolver } from '../../src/calls/config.ts';
import type { RealtimeActor } from '../../src/realtime/contracts.ts';

if (process.env.NODE_ENV === 'production') throw new Error('Call test fixtures must never be loaded in production.');

/** Test-only read adapter; production must inject its real direct conversation service. */
export class TestDirectCallResolver implements DirectCallConversationResolver {
  readonly entries = new Map<string, unknown>();
  readonly actors: RealtimeActor[] = [];
  mode: 'normal' | 'throw' | 'hang' = 'normal';
  beforeResolve: (() => Promise<void>) | null = null;
  add(conversationId: string, first: string, second: string): void {
    this.entries.set(conversationId, { conversationId, type: 'direct', participants: [
      { userId: first, displayName: `Directory ${first}` }, { userId: second, displayName: `Directory ${second}` },
    ] });
  }
  async resolveDirectConversation(actor: RealtimeActor, conversationId: string): ReturnType<DirectCallConversationResolver['resolveDirectConversation']> {
    this.actors.push(actor);
    if (this.mode === 'throw') throw new Error('private directory failure: secret=do-not-return');
    if (this.mode === 'hang') return new Promise(() => {});
    if (this.beforeResolve) await this.beforeResolve();
    return (this.entries.get(conversationId) ?? null) as Awaited<ReturnType<DirectCallConversationResolver['resolveDirectConversation']>>;
  }
}
