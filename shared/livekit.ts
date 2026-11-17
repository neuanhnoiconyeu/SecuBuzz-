/** Public wire contract only. LiveKit signing credentials must never enter this module. */
export const LIVEKIT_TOKEN_PATH = '/api/voice/token';
export const LIVEKIT_CALL_TOKEN_PATH = '/api/calls/token';
export const LIVEKIT_CALL_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const LIVEKIT_ROOM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface LiveKitConnectionDetails {
  roomId: string;
  roomName: string;
  participantIdentity: string;
  serverUrl: string;
  token: string;
  expiresAt: string;
  peerIdentity?: string;
}

/** Plain WebSockets are allowed only for loopback development. */
export function parseLiveKitUrl(value: unknown, allowLoopback: boolean): string | null {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\\\u0000-\u0020\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== 'wss:' && !(allowLoopback && local && url.protocol === 'ws:'))) return null;
    return url.href;
  } catch { return null; }
}
