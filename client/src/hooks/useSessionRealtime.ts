import { useEffect, useRef, useState } from 'react';
import type { PresenceStatus } from '@/messaging/messageModel';
import type { RealtimeClient, RealtimeConnectionStatus, RealtimeEvent } from '@/realtime/realtimeModel';
import { parseRealtimeEvent } from '@/realtime/realtimeValidation';

export const PRESENCE_TTL_MS = 45_000;
type PresenceSample = { status: PresenceStatus; timestamp: number; expiresAt: number };
type ConversationUpdate = Extract<RealtimeEvent, { type: 'conversation' }>;

/** Ephemeral connection/presence state only; messages remain in useConversationMessages. */
export function useSessionRealtime(
  client: RealtimeClient,
  watchedUserIds: readonly string[],
  onConversationUpdated?: (update: ConversationUpdate) => void,
) {
  const [status, setStatus] = useState<RealtimeConnectionStatus>(() => client.getStatus());
  const [presence, setPresence] = useState<ReadonlyMap<string, PresenceSample>>(new Map());
  const samples = useRef(new Map<string, PresenceSample>());
  const lastPresenceTimestamp = useRef(new Map<string, number>());
  const watchedKey = JSON.stringify([...new Set(watchedUserIds)].sort());
  const watched = useRef(new Set(watchedUserIds));
  watched.current = new Set(watchedUserIds);
  const updateCallback = useRef(onConversationUpdated);
  updateCallback.current = onConversationUpdated;

  useEffect(() => {
    const ids = JSON.parse(watchedKey) as string[];
    for (const id of samples.current.keys()) if (!watched.current.has(id)) samples.current.delete(id);
    for (const id of lastPresenceTimestamp.current.keys()) if (!watched.current.has(id)) lastPresenceTimestamp.current.delete(id);
    setPresence(new Map(samples.current));
    client.watchPresence(ids);
  }, [client, watchedKey]);

  useEffect(() => {
    let active = true;
    samples.current.clear();
    lastPresenceTimestamp.current.clear();
    setPresence(new Map());
    setStatus(client.getStatus());
    const unsubscribe = client.subscribe((raw) => {
      if (!active) return;
      const event = parseRealtimeEvent(raw.type, raw, client.mode);
      if (!event) return;
      if (event.type === 'connection') {
        setStatus(event.status);
        if (event.status !== 'connected') { samples.current.clear(); lastPresenceTimestamp.current.clear(); setPresence(new Map()); }
      } else if (event.type === 'presence') {
        if (!watched.current.has(event.userId) || event.userId === client.actorId || client.getStatus() !== 'connected') return;
        const timestamp = Date.parse(event.timestamp);
        if (timestamp > Date.now() + 60_000 || timestamp < Date.now() - PRESENCE_TTL_MS ||
          timestamp <= (lastPresenceTimestamp.current.get(event.userId) ?? -Infinity)) return;
        lastPresenceTimestamp.current.set(event.userId, timestamp);
        if (event.status === 'unknown') samples.current.delete(event.userId);
        else samples.current.set(event.userId, { status: event.status, timestamp,
          expiresAt: Math.min(Date.now(), timestamp) + PRESENCE_TTL_MS });
        setPresence(new Map(samples.current));
      } else if (event.type === 'conversation') updateCallback.current?.(event);
    });
    void client.connect().catch(() => { if (active) setStatus(client.getStatus()); });
    const timer = window.setInterval(() => {
      let changed = false;
      for (const [id, sample] of samples.current) {
        if (sample.expiresAt <= Date.now()) { samples.current.delete(id); changed = true; }
      }
      if (changed) setPresence(new Map(samples.current));
    }, 1_000);
    return () => { active = false; window.clearInterval(timer); unsubscribe(); };
  }, [client]);

  return { status, presence };
}
