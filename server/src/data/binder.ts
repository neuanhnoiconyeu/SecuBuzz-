import type {
  BoundConnection,
  ConnectionBinder,
  ConnectionCredentials,
  MessageStore,
  ReceiptOutcome,
  ReceiptRecord,
  RealtimeActor,
  StoreMessageOutcome,
  StoreMessageRequest,
  StoredMessageRef,
} from '../realtime/contracts.ts';
import { dataContext, dataErrorCode, type DataApplication, type DataContext } from './types.ts';

/**
 * DATA charges its per-user and per-source write budget in its REST routers, not inside the service
 * methods that `bindStore` exposes. A socket write must be charged too, or opening several sockets
 * would multiply the budget DATA grants a user. An exhausted budget throws DATA's own `RATE_LIMITED`.
 */
function metered(store: MessageStore, application: DataApplication, context: DataContext, source: string): MessageStore {
  const { messaging } = application;
  return {
    findMessage(conversationId: string, messageId: string): Promise<StoredMessageRef | null> {
      return store.findMessage(conversationId, messageId);
    },
    async recordReceipt(receipt: ReceiptRecord): Promise<ReceiptOutcome> {
      messaging.rate('read', context, source);
      return store.recordReceipt(receipt);
    },
    async storeMessage(request: StoreMessageRequest): Promise<StoreMessageOutcome> {
      messaging.rate('submit', context, source);
      return store.storeMessage(request);
    },
  };
}

/**
 * Binds one authenticated socket to DATA authority.
 *
 * The session cookie already resolved to `actor`. The handshake CSRF token is verified by DATA's own
 * `auth.csrfProof` against THAT session, and the proof's session and user must equal the actor, so a
 * token from another account or session is never accepted. The returned store is DATA's
 * `messaging.bindStore(context, proof)`: DATA re-verifies the session and the proof on every call, so
 * a logout or revocation stops writes even while the socket is open.
 *
 * A missing, malformed or foreign token returns `null` (the handshake is rejected as UNAUTHORIZED).
 * Any other failure throws, which fails the handshake closed as REALTIME_UNAVAILABLE.
 */
export function createDataConnectionBinder(application: DataApplication): ConnectionBinder {
  return {
    async bind(actor: RealtimeActor, credentials: ConnectionCredentials): Promise<BoundConnection | null> {
      if (credentials.csrfToken === null) return null;
      let proof: ReturnType<DataApplication['auth']['csrfProof']>;
      try {
        proof = application.auth.csrfProof(credentials.sessionToken, null, credentials.csrfToken);
      } catch (error) {
        if (dataErrorCode(error) === 'CSRF_INVALID') return null;
        throw error;
      }
      if (proof.type !== 'session') return null;
      const session = proof as { sessionId?: unknown; userId?: unknown };
      if (session.sessionId !== actor.sessionId || session.userId !== actor.userId) return null;
      const context = dataContext(actor);
      const store = application.messaging.bindStore(context, proof as Parameters<DataApplication['messaging']['bindStore']>[1]);
      return { store: metered(store, application, context, credentials.remoteAddress || 'unknown') };
    },
  };
}
