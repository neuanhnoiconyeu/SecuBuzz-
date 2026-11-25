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
  Object.freeze({ id: 'dev-corner', name: 'Dev Corner', description: 'A home for building things and talking through ideas.' }),
]);
