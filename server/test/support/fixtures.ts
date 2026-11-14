/**
 * TEST-ONLY adapters. They simulate the Database and Security teams' services in memory so the
 * realtime server can be exercised over real sockets. They are not exported from `src/index.ts`
 * and refuse to load in production, so they cannot become a production authentication bypass.
 */
import type {
  HandshakeContext,
  KeyVerification,
  LogFields,
  LogLevel,
  MessageEnvelope,
  MessageStore,
  RealtimeActor,
  RealtimeAuthorizer,
  RealtimeLogger,
  ReceiptOutcome,
  ReceiptRecord,
  RecipientKeyVerifier,
  SessionCheck,
  SessionReference,
  SessionResolution,
  SessionResolver,
  StoreMessageOutcome,
  StoreMessageRequest,
  StoredMessageRef,
} from '../../src/realtime/contracts.ts';

if (process.env.NODE_ENV === 'production') {
  throw new Error('Realtime test fixtures must never be loaded in production.');
}

/** Failure modes injected into fixture methods. `hang` never settles, to exercise deadlines. */
export type FaultMode = 'normal' | 'throw' | 'hang' | 'malformed';

const hang = () => new Promise<never>(() => undefined);

async function faulted<Value>(mode: FaultMode, malformed: unknown, run: () => Value): Promise<Value> {
  if (mode === 'throw') throw new Error('fixture failure with secret detail: password=hunter2');
  if (mode === 'hang') return hang();
  if (mode === 'malformed') return malformed as Value;
  return run();
}

export interface TestSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly displayName: string;
  expiresAt: Date;
}

export class TestSessionResolver implements SessionResolver {
  readonly #byToken = new Map<string, TestSession>();
  readonly #expiredTokens = new Set<string>();
  readonly #missingTokens = new Set<string>();
  readonly contexts: HandshakeContext[] = [];
  readonly sessionChecks = new Map<string, SessionCheck>();
  mode: FaultMode = 'normal';
  checkMode: FaultMode = 'normal';
  checkCalls = 0;
  /** Return this instead of the stored session (for malformed or demo identity cases). */
  override: unknown = undefined;

  add(token: string, session: TestSession): void {
    this.#byToken.set(token, session);
  }

  markExpired(token: string): void {
    this.#expiredTokens.add(token);
  }

  markMissing(token: string): void {
    this.#missingTokens.add(token);
  }

  remove(token: string): void {
    this.#byToken.delete(token);
  }

  async resolveSession(context: HandshakeContext): Promise<SessionResolution> {
    this.contexts.push(context);
    return faulted(this.mode, { status: 'authenticated', session: { userId: 'u1' } }, () => {
      if (this.override !== undefined) return this.override as SessionResolution;
      if (this.#missingTokens.has(context.sessionToken)) return { status: 'missing' };
      if (this.#expiredTokens.has(context.sessionToken)) return { status: 'expired' };
      const session = this.#byToken.get(context.sessionToken);
      if (!session) return { status: 'invalid' };
      return { status: 'authenticated', session: { ...session, expiresAt: new Date(session.expiresAt.getTime()) } };
    });
  }

  async checkSession(reference: SessionReference): Promise<SessionCheck> {
    this.checkCalls += 1;
    return faulted(this.checkMode, { status: 'fine' }, () => {
      const configured = this.sessionChecks.get(reference.sessionId);
      if (configured) return configured;
      const session = [...this.#byToken.values()].find((candidate) => candidate.sessionId === reference.sessionId);
      return session ? { status: 'active', expiresAt: session.expiresAt } : { status: 'revoked' };
    });
  }
}

/** Resolver without the optional `checkSession` method. */
export class MinimalSessionResolver implements SessionResolver {
  readonly #inner: TestSessionResolver;
  constructor(inner: TestSessionResolver) {
    this.#inner = inner;
  }
  resolveSession(context: HandshakeContext): Promise<SessionResolution> {
    return this.#inner.resolveSession(context);
  }
}

export class TestAuthorizer implements RealtimeAuthorizer {
  readonly #memberships = new Map<string, Set<string>>();
  readonly #presenceVisible = new Map<string, Set<string>>();
  readonly #blocks = new Set<string>();
  conversationsMode: FaultMode = 'normal';
  blocksMode: FaultMode = 'normal';
  presenceMode: FaultMode = 'normal';
  /** Overrides the conversation list (for oversized or invalid adapter results). */
  conversationsOverride: unknown = undefined;
  conversationCalls = 0;
  presenceCalls: Array<{ viewer: string; subjects: readonly string[] }> = [];

  grant(userId: string, ...conversationIds: string[]): void {
    const set = this.#memberships.get(userId) ?? new Set<string>();
    for (const id of conversationIds) set.add(id);
    this.#memberships.set(userId, set);
  }

  revoke(userId: string, conversationId: string): void {
    this.#memberships.get(userId)?.delete(conversationId);
  }

  /** Mutual presence visibility (accepted friendship). */
  befriend(first: string, second: string): void {
    for (const [viewer, subject] of [[first, second], [second, first]] as const) {
      const set = this.#presenceVisible.get(viewer) ?? new Set<string>();
      set.add(subject);
      this.#presenceVisible.set(viewer, set);
    }
  }

  unfriend(first: string, second: string): void {
    this.#presenceVisible.get(first)?.delete(second);
    this.#presenceVisible.get(second)?.delete(first);
  }

  /** `blocker` blocks `blocked`. The authorizer reports the pair to both users, as the contract requires. */
  block(blocker: string, blocked: string): void {
    this.#blocks.add(JSON.stringify([blocker, blocked]));
  }

  unblock(blocker: string, blocked: string): void {
    this.#blocks.delete(JSON.stringify([blocker, blocked]));
  }

  async listConversationIds(actor: RealtimeActor): Promise<readonly string[]> {
    this.conversationCalls += 1;
    return faulted(this.conversationsMode, [42], () =>
      (this.conversationsOverride as readonly string[] | undefined) ?? [...(this.#memberships.get(actor.userId) ?? [])]);
  }

  async listBlockedUserIds(actor: RealtimeActor): Promise<readonly string[]> {
    return faulted(this.blocksMode, 'not-a-list', () => {
      const blocked = new Set<string>();
      for (const pair of this.#blocks) {
        const [blocker, target] = JSON.parse(pair) as [string, string];
        if (blocker === actor.userId) blocked.add(target);
        if (target === actor.userId) blocked.add(blocker);
      }
      return [...blocked];
    });
  }

  async filterPresenceSubjects(viewer: RealtimeActor, subjectIds: readonly string[]): Promise<readonly string[]> {
    this.presenceCalls.push({ viewer: viewer.userId, subjects: [...subjectIds] });
    return faulted(this.presenceMode, { all: true }, () => {
      const visible = this.#presenceVisible.get(viewer.userId) ?? new Set<string>();
      return subjectIds.filter((id) => visible.has(id));
    });
  }
}

interface StoredMessage extends StoredMessageRef {
  readonly fingerprint: string;
  readonly storedAt: Date;
}

/** In-memory MessageStore implementing the documented idempotency and receipt contracts. */
export class TestMessageStore implements MessageStore {
  readonly #messages = new Map<string, StoredMessage>();
  readonly #receipts = new Map<string, Date>();
  findMode: FaultMode = 'normal';
  receiptMode: FaultMode = 'normal';
  storeMode: FaultMode = 'normal';
  storeCalls = 0;
  receiptCalls: ReceiptRecord[] = [];
  /** Delay before `storeMessage` settles, to exercise concurrent duplicates. */
  storeDelayMs = 0;

  seed(conversationId: string, messageId: string, senderId: string): void {
    this.#messages.set(JSON.stringify([conversationId, messageId]),
      { conversationId, messageId, senderId, fingerprint: 'seeded', storedAt: new Date() });
  }

  get messageCount(): number {
    return this.#messages.size;
  }

  hasReceipt(conversationId: string, messageId: string, userId: string, status: 'delivered' | 'read'): boolean {
    return this.#receipts.has(JSON.stringify([conversationId, messageId, userId, status]));
  }

  async findMessage(conversationId: string, messageId: string): Promise<StoredMessageRef | null> {
    return faulted(this.findMode, { conversationId: 'other', messageId }, () => {
      const message = this.#messages.get(JSON.stringify([conversationId, messageId]));
      return message ? { conversationId, messageId, senderId: message.senderId } : null;
    });
  }

  async recordReceipt(receipt: ReceiptRecord): Promise<ReceiptOutcome> {
    this.receiptCalls.push(receipt);
    return faulted(this.receiptMode, { outcome: 'created' }, () => {
      const key = JSON.stringify([receipt.conversationId, receipt.messageId, receipt.userId, receipt.status]);
      const existing = this.#receipts.get(key);
      if (existing) return { outcome: 'duplicate', recordedAt: existing };
      const recordedAt = new Date(receipt.observedAt.getTime());
      this.#receipts.set(key, recordedAt);
      return { outcome: 'created', recordedAt };
    });
  }

  async storeMessage(request: StoreMessageRequest): Promise<StoreMessageOutcome> {
    this.storeCalls += 1;
    if (this.storeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.storeDelayMs));
    return faulted(this.storeMode, { outcome: 'created' }, () => {
      const { envelope, fingerprint } = request;
      const key = JSON.stringify([envelope.conversationId, envelope.id]);
      const existing = this.#messages.get(key);
      if (existing) {
        return existing.senderId === envelope.senderId && existing.fingerprint === fingerprint
          ? { outcome: 'duplicate', storedAt: existing.storedAt }
          : { outcome: 'conflict' };
      }
      const storedAt = new Date(request.receivedAt.getTime());
      this.#messages.set(key, { conversationId: envelope.conversationId, messageId: envelope.id, senderId: envelope.senderId, fingerprint, storedAt });
      return { outcome: 'created', storedAt };
    });
  }
}

export class TestKeyVerifier implements RecipientKeyVerifier {
  verified = true;
  mode: FaultMode = 'normal';
  calls = 0;

  async verifyEnvelope(_actor: RealtimeActor, _envelope: MessageEnvelope): Promise<KeyVerification> {
    this.calls += 1;
    return faulted(this.mode, { verified: 'yes' }, () => (this.verified ? { verified: true } : { verified: false }));
  }
}

export class CapturingLogger implements RealtimeLogger {
  readonly entries: Array<{ level: LogLevel; event: string; fields: LogFields }> = [];

  log(level: LogLevel, event: string, fields: LogFields = {}): void {
    this.entries.push({ level, event, fields });
  }

  /** Everything that was logged, serialized, for "never logged" assertions. */
  text(): string {
    return JSON.stringify(this.entries);
  }

  has(event: string): boolean {
    return this.entries.some((entry) => entry.event === event);
  }
}
