export interface VoiceRoom {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly ownerId?: string | null;
  readonly ownerName?: string | null;
}

/** Stable catalog until an authorized room API is available. Occupancy is separate. */
export const VOICE_ROOMS: readonly VoiceRoom[] = Object.freeze([
  Object.freeze({ id: 'lounge', name: 'Lounge', description: 'A little space to drop in and take a break.' }),
  Object.freeze({ id: 'study-room', name: 'Study Room', description: 'Settle in, focus, and work alongside each other.' }),
  Object.freeze({ id: 'dev-corner', name: 'Gaming Room', description: 'A home for gaming, hanging out, and talking through ideas.' }),
]);

/** Maps immutable default catalog room IDs to their current UI/API display names. */
export const DEFAULT_VOICE_ROOM_NAMES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(VOICE_ROOMS.map((room) => [room.id, room.name])),
);
