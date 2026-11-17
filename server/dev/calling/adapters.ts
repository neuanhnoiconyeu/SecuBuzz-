import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { HandshakeContext, RealtimeActor, RealtimeAuthorizer, SessionCheck, SessionReference, SessionResolution, SessionResolver } from '../../src/realtime/contracts.ts';
import type { DirectCallConversationResolver } from '../../src/calls/config.ts';
import { extractSessionCookie } from '../../src/realtime/cookies.ts';
import './config.ts';
import type { DevelopmentCallingConfig } from './config.ts';

export const DEVELOPMENT_COOKIE = 'secubuzz_dev_call_session';
export const DEVELOPMENT_CONVERSATION_ID = 'calling-dev-alice-bob';
export const DEVELOPMENT_USERS = Object.freeze([
  Object.freeze({ id: 'call-dev-alice', username: 'alice', displayName: 'Alice (calling development)', avatar: 'initials', isDemo: false }),
  Object.freeze({ id: 'call-dev-bob', username: 'bob', displayName: 'Bob (calling development)', avatar: 'initials', isDemo: false }),
] as const);
type DevelopmentUser = typeof DEVELOPMENT_USERS[number];
interface Session { token: string; sessionId: string; csrf: string; user: DevelopmentUser | null; expiresAt: number }
const equal = (first: string, second: string) => timingSafeEqual(createHash('sha256').update(first).digest(), createHash('sha256').update(second).digest());
const random = () => randomBytes(32).toString('base64url');
export const SESSION_TTL_MS = 60 * 60 * 1000;

/** Ephemeral adapters exclusively for this opt-in local harness; no production adapters or fixtures are imported. */
export class DevelopmentCallAdapters implements SessionResolver, RealtimeAuthorizer, DirectCallConversationResolver {
  readonly #sessions = new Map<string, Session>();
  readonly #byId = new Map<string, Session>();
  readonly #passwords: readonly string[];
  readonly #now: () => number;
  constructor(config: DevelopmentCallingConfig, now: () => number = Date.now) {
    this.#passwords = [config.alicePassword, config.bobPassword]; this.#now = now;
  }
  #remove(session: Session): void { this.#sessions.delete(session.token); this.#byId.delete(session.sessionId); }
  session(request: IncomingMessage): Session | null {
    const cookie = extractSessionCookie(request.headers.cookie, DEVELOPMENT_COOKIE);
    if (cookie.status !== 'present') return null;
    const session = this.#sessions.get(cookie.value);
    return session && session.expiresAt > this.#now() ? session : null;
  }
  create(user: DevelopmentUser | null): Session {
    for (const session of this.#sessions.values()) if (session.expiresAt <= this.#now()) this.#remove(session);
    if (this.#sessions.size >= 128) throw new Error('Development session capacity reached.');
    const session: Session = { token: random(), sessionId: random(), csrf: random(), user, expiresAt: this.#now() + SESSION_TTL_MS };
    this.#sessions.set(session.token, session); this.#byId.set(session.sessionId, session); return session;
  }
  credentials(identifier: string, password: string): DevelopmentUser | null {
    const index = DEVELOPMENT_USERS.findIndex(user => user.username === identifier);
    return equal(password, this.#passwords[index] ?? random()) && index >= 0 ? DEVELOPMENT_USERS[index]! : null;
  }
  revoke(sessionId: string): void { const session = this.#byId.get(sessionId); if (session) this.#remove(session); }
  clear(): void { this.#sessions.clear(); this.#byId.clear(); }
  verifyCsrf(request: IncomingMessage, actor?: RealtimeActor): boolean {
    const session = this.session(request), token = request.headers['x-csrf-token'];
    return Boolean(session && typeof token === 'string' && token.length <= 512 && equal(token, session.csrf) &&
      (!actor || session.sessionId === actor.sessionId && session.user?.id === actor.userId));
  }
  #authorized(actor: SessionReference): boolean {
    const session = this.#byId.get(actor.sessionId);
    return Boolean(session && session.expiresAt > this.#now() && session.user?.id === actor.userId);
  }
  async resolveSession(context: HandshakeContext): Promise<SessionResolution> {
    const session = this.#sessions.get(context.sessionToken);
    if (!session) return { status: 'invalid' };
    if (session.expiresAt <= this.#now()) return { status: 'expired' };
    if (!session.user) return { status: 'missing' };
    return { status: 'authenticated', session: { sessionId: session.sessionId, userId: session.user.id,
      displayName: session.user.displayName, expiresAt: new Date(session.expiresAt) } };
  }
  async checkSession(reference: SessionReference): Promise<SessionCheck> {
    const session = this.#byId.get(reference.sessionId);
    if (!session || session.user?.id !== reference.userId) return { status: 'revoked' };
    return session.expiresAt <= this.#now() ? { status: 'expired' } : { status: 'active', expiresAt: new Date(session.expiresAt) };
  }
  async listConversationIds(actor: RealtimeActor): Promise<readonly string[]> { return this.#authorized(actor) ? [DEVELOPMENT_CONVERSATION_ID] : []; }
  async listBlockedUserIds(_actor: RealtimeActor): Promise<readonly string[]> { return []; } // Fixed fixture has no blocked pairs.
  async filterPresenceSubjects(actor: RealtimeActor, subjects: readonly string[]): Promise<readonly string[]> {
    return this.#authorized(actor) ? DEVELOPMENT_USERS.filter(user => user.id !== actor.userId && subjects.includes(user.id)).map(user => user.id) : [];
  }
  async resolveDirectConversation(actor: RealtimeActor, conversationId: string) {
    if (!this.#authorized(actor) || conversationId !== DEVELOPMENT_CONVERSATION_ID) return null;
    return { conversationId, type: 'direct' as const, participants: [
      { userId: DEVELOPMENT_USERS[0].id, displayName: DEVELOPMENT_USERS[0].displayName },
      { userId: DEVELOPMENT_USERS[1].id, displayName: DEVELOPMENT_USERS[1].displayName },
    ] as const };
  }
}
