import type { KeyEpochSummary, PresencePreference, RealtimeActor, RealtimeAuthorizer } from '../realtime/contracts.ts';
import { dataContext, dataErrorCode, isDataDenial, type DataApplication, type DataContext } from './types.ts';

const PAGE_LIMIT = '50';
/** A page loop must end even if DATA misbehaves. 50 per page × 400 pages is far above any realtime limit. */
const MAX_PAGES = 400;
const PREFERENCES: ReadonlySet<unknown> = new Set(['available', 'away', 'busy', 'invisible']);
const IDENTIFIER = /^[A-Za-z0-9._:@-]{1,256}$/;

export interface DataAuthorizerOptions {
  /** Must equal the realtime `limits.maxConversationsPerUser`. One more entry is returned so the server fails closed. */
  readonly maxConversations?: number;
  readonly maxBlockedUsers?: number;
}

/** Throws a plain error so the realtime adapter wrapper reports `error` without exposing details. */
function unexpected(what: string): never {
  throw new Error(`DATA returned an unexpected ${what}.`);
}

function parseKeyEpoch(value: unknown): KeyEpochSummary | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return unexpected('current epoch');
  const { keyId, epoch } = value as { keyId?: unknown; epoch?: unknown };
  if (typeof keyId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(keyId) || typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) {
    return unexpected('current epoch');
  }
  return { keyId, epoch };
}

/**
 * Membership, relationship and key-state decisions answered by DATA's own services. Every method
 * calls DATA with the actor's session, so a revoked or expired session is refused by DATA itself and
 * no decision here relies on cached state. DATA's reads are synchronous; they are wrapped by the
 * realtime adapter deadline.
 */
export function createDataAuthorizer(application: DataApplication, options: DataAuthorizerOptions = {}): RealtimeAuthorizer {
  const { auth, conversations, social, keys } = application;
  const maxConversations = options.maxConversations ?? 1_000;
  const maxBlockedUsers = options.maxBlockedUsers ?? 5_000;

  function activeSession(context: DataContext): boolean {
    return auth.checkSession({ sessionId: context.sessionId, userId: context.userId }).status === 'active';
  }

  function collectIds<Item extends { readonly id: string }>(
    load: (cursor: string | undefined) => { readonly items: readonly Item[]; readonly nextCursor: string | null },
    keep: (item: Item) => boolean,
    cap: number,
  ): string[] {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = load(cursor);
      if (!Array.isArray(result.items)) return unexpected('page');
      for (const item of result.items) {
        if (typeof item?.id !== 'string' || !IDENTIFIER.test(item.id)) return unexpected('identifier');
        if (keep(item)) ids.push(item.id);
      }
      // One past the cap is enough for the realtime server to refuse the snapshot instead of truncating it.
      if (ids.length > cap) return ids;
      if (result.nextCursor === null) return ids;
      if (typeof result.nextCursor !== 'string') return unexpected('cursor');
      cursor = result.nextCursor;
    }
    return unexpected('page count');
  }

  return {
    async listConversationIds(actor: RealtimeActor): Promise<readonly string[]> {
      const context = dataContext(actor);
      // Only conversations the actor may interact in: an unfriended or blocked pair gets no room.
      return collectIds(
        (cursor) => conversations.list(context, cursor === undefined ? { limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, cursor }),
        (item) => (item as { interactionAllowed?: unknown }).interactionAllowed === true,
        maxConversations,
      );
    },

    /**
     * The actor's OWN blocks. DATA exposes no "who blocked me" list. The other direction is covered by
     * DATA hiding a blocked conversation from `conversations.list` (so no room is granted) and by
     * `canReceive`, which asks DATA again immediately before each delivery.
     */
    async listBlockedUserIds(actor: RealtimeActor): Promise<readonly string[]> {
      const context = dataContext(actor);
      for (let attempt = 0; ; attempt += 1) {
        try {
          return collectIds(
            (cursor) => social.listBlocks(context, cursor === undefined ? { limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, cursor }),
            () => true,
            maxBlockedUsers,
          );
        } catch (error) {
          // The block list changed while it was being paged; start over from a consistent revision.
          if (dataErrorCode(error) === 'STALE_STATE' && attempt < 2) continue;
          throw error;
        }
      }
    },

    /** Accepted friends that are active and in no block relationship (either direction) with the viewer. */
    async filterPresenceSubjects(viewer: RealtimeActor, subjectIds: readonly string[]): Promise<readonly string[]> {
      if (!activeSession(dataContext(viewer))) return [];
      const { repository } = social;
      return subjectIds.filter((id) => id !== viewer.userId && Boolean(repository.active(id)) &&
        Boolean(repository.friendship(viewer.userId, id)) && !repository.isBlocked(viewer.userId, id));
    },

    async canReceive(actor: RealtimeActor, conversationId: string): Promise<boolean> {
      const context = dataContext(actor);
      if (!activeSession(context)) return false;
      try {
        return conversations.detail(context, conversationId).conversation.interactionAllowed === true;
      } catch (error) {
        // A refusal is a definite "no". Anything else (database busy, bug) is thrown so it is logged
        // as an authorization failure; delivery is withheld either way and history reconciles.
        if (isDataDenial(error)) return false;
        throw error;
      }
    },

    async currentKeyEpoch(actor: RealtimeActor, conversationId: string): Promise<KeyEpochSummary | null | undefined> {
      try {
        const state = keys.state(dataContext(actor), conversationId, {});
        return parseKeyEpoch(state.currentEpoch);
      } catch (error) {
        // DATA refuses this account (not a member, session ended): it must receive no key event.
        if (isDataDenial(error)) return undefined;
        throw error;
      }
    },

    async presencePreference(actor: RealtimeActor): Promise<PresencePreference | null> {
      const { profile } = social.ownProfile(dataContext(actor));
      const value = profile?.presencePreference;
      if (!PREFERENCES.has(value)) return unexpected('presence preference');
      return value as PresencePreference;
    },
  };
}
