import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type SessionApi } from '@/api/sessionApi';
import { LIVEKIT_ROOM_ID } from '../../../shared/livekit';
import { DEFAULT_VOICE_ROOM_NAMES, VOICE_ROOMS, type VoiceRoom } from './voiceRooms';

export function parseRoomCatalog(value: unknown): VoiceRoom[] {
  const items = (value as {items?:unknown})?.items;
  if (!Array.isArray(items) || items.length > 200) throw new ApiError('invalid_response');
  const ids = new Set<string>();
  return items.map((r: unknown) => {
    const room = r as VoiceRoom;
    if (!room || typeof room.id !== 'string' || !LIVEKIT_ROOM_ID.test(room.id) || ids.has(room.id) ||
      typeof room.name !== 'string' || !room.name.trim() || room.name.length > 64 ||
      typeof room.description !== 'string' || room.description.length > 500 ||
      !(room.ownerId === null || typeof room.ownerId === 'string') ||
      !(room.ownerName === null || typeof room.ownerName === 'string')) throw new ApiError('invalid_response');
    ids.add(room.id);
    // Migration 0013 rows with ownerId=null are SQL-immutable; project current default names by stable ID.
    const defaultName = room.ownerId === null ? DEFAULT_VOICE_ROOM_NAMES[room.id] : undefined;
    return defaultName && defaultName !== room.name ? { ...room, name: defaultName } : room;
  });
}
export function roomFailure(error: unknown): string {
  return error instanceof ApiError && error.code === 'conflict' ? 'That room name is already in use, or the request changed. Refresh and try again.'
    : error instanceof ApiError && error.code === 'forbidden' ? 'Only the room owner can change or delete this room.'
      : error instanceof ApiError ? error.message : 'Voice rooms could not be updated. Please try again.';
}

/** The DATA catalog is authoritative. Polling never invents occupancy or clears rooms on a failed read. */
export function useRoomCatalog(api: SessionApi | null) {
  const [rooms, setRooms] = useState<readonly VoiceRoom[]>(VOICE_ROOMS);
  const [loaded, setLoaded] = useState(false), [error, setError] = useState('');
  const alive = useRef(false), currentApi = useRef(api); currentApi.current = api;
  const inFlight = useRef<{api:SessionApi;dirty:boolean;promise:Promise<void>} | null>(null);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!api) return;
    if (inFlight.current?.api === api) { inFlight.current.dirty = true; return inFlight.current.promise; }
    const job = {api,dirty:false,promise:Promise.resolve()};
    const work = async () => {
      do {
        job.dirty = false;
        try {
          const items = parseRoomCatalog(await api.request('/api/voice/rooms', {signal}));
          if (alive.current && currentApi.current === api && !signal?.aborted) { setRooms(items); setLoaded(true); setError(''); }
        } catch (e) { if (alive.current && currentApi.current === api && !signal?.aborted) setError(roomFailure(e)); }
      } while (job.dirty && alive.current && currentApi.current === api && !signal?.aborted);
    };
    job.promise = work().finally(() => { if (inFlight.current === job) inFlight.current = null; });
    inFlight.current = job; return job.promise;
  }, [api]);
  useEffect(() => {
    alive.current = true; const abort = new AbortController();
    setLoaded(false); void refresh(abort.signal);
    const timer = setInterval(() => { void refresh(abort.signal); }, 3000);
    return () => { alive.current = false; abort.abort(); clearInterval(timer); };
  }, [refresh]);
  return {rooms, loaded, error, refresh};
}
