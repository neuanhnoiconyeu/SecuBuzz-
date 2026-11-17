import type { RoomServiceClient } from 'livekit-server-sdk';
import type { DirectCallMediaLifecycle } from '../calls/config.ts';
import { directCallRoomName, type LiveKitConfig } from './config.ts';

export type DirectCallRoomService = Pick<RoomServiceClient, 'createRoom' | 'deleteRoom'>;
/** Shared creation and deletion guards prevent a slow create from resurrecting an ended call. */
export function createDirectCallMediaLifecycle(config: LiveKitConfig, service?: DirectCallRoomService): DirectCallMediaLifecycle {
  const rooms = service ?? config.createRoomService();
  const entries = new Map<string, { ended: boolean; prepared: Promise<void>; cleanup: Promise<void> | null }>();
  const remove = async (callId: string) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await rooms.deleteRoom(directCallRoomName(callId)); return; }
      catch (failure) {
        if (failure && typeof failure === 'object' && 'code' in failure && failure.code === 'not_found') return;
        if (attempt === 2) throw new Error('Private call room cleanup failed.');
      }
    }
  };
  return {
    prepare(callId) {
      const existing = entries.get(callId);
      if (existing) return existing.ended ? Promise.reject(new Error('Call ended.')) : existing.prepared;
      const entry = { ended: false, prepared: Promise.resolve(), cleanup: null as Promise<void> | null };
      entries.set(callId, entry);
      entry.prepared = (async () => {
        await rooms.createRoom({ name: directCallRoomName(callId), maxParticipants: 2, emptyTimeout: 30, departureTimeout: 15 });
        if (entry.ended) { await remove(callId); throw new Error('Call ended.'); }
      })();
      return entry.prepared;
    },
    finish(callId) {
      const entry = entries.get(callId);
      if (!entry) return Promise.resolve();
      entry.ended = true;
      if (!entry.cleanup) entry.cleanup = (async () => {
        // Delete immediately to stop current participants, and again after a pending create settles.
        try { await remove(callId); }
        finally {
          try { await entry.prepared; } catch { /* Creation may have failed or performed its own late cleanup. */ }
          try { await remove(callId); } finally { if (entries.get(callId) === entry) entries.delete(callId); }
        }
      })();
      return entry.cleanup;
    },
  };
}
