export type DirectCallKind = 'voice' | 'video';
export interface DirectCallPeer { id: string; name: string; avatarUrl?: string }
export interface DirectCallSession {
  id: string;
  conversationId: string;
  peer: DirectCallPeer;
  kind: DirectCallKind;
  direction: 'incoming' | 'outgoing';
  /** Only a future signaling/media adapter may create transport sessions. */
  source: 'preview' | 'transport';
  createdAt: number;
}
export type DirectCallEndReason = 'hangup' | 'declined' | 'timeout' | 'unavailable' | 'remote';
export type DirectCallState = { phase: 'idle' } | { call: DirectCallSession } & (
  { phase: 'ringing' | 'connecting'; connectedAt: null; endedAt: null } |
  { phase: 'connected'; connectedAt: number; endedAt: null } |
  { phase: 'reconnecting'; connectedAt: number; endedAt: null } |
  { phase: 'declined' | 'missed' | 'ended'; connectedAt: number | null; endedAt: number; reason: DirectCallEndReason }
);
export type ActiveDirectCall = Exclude<DirectCallState, { phase: 'idle' }>;
export type DirectCallEvent =
  | { type: 'SERVER'; call: DirectCallSession; phase: 'ringing' | 'connecting' | 'declined' | 'missed' | 'ended'; at: number }
  | { type: 'START'; call: DirectCallSession }
  | { type: 'RESET' }
  | { type: 'DISMISS'; callId: string }
  | { type: 'ACCEPT' | 'DECLINE' | 'HANG_UP'; callId: string; at: number }
  | { type: 'EXPIRE'; callId: string; phase: 'ringing' | 'connecting'; at: number }
  | { type: 'TRANSPORT'; callId: string; signal: 'accepted' | 'media-connected' | 'media-reconnecting' | 'declined' | 'ended'; at: number };

export const idleDirectCall: DirectCallState = { phase: 'idle' };
export const isCallFinished = (state: DirectCallState) => state.phase === 'declined' || state.phase === 'missed' || state.phase === 'ended';

/** UI domain only. Never infer call acceptance or connection from chat presence or elapsed time. */
export function directCallReducer(state: DirectCallState, event: DirectCallEvent): DirectCallState {
  if (event.type === 'RESET') return idleDirectCall;
  if (event.type === 'SERVER') {
    if (event.call.source !== 'transport' || state.phase !== 'idle' && state.call.id !== event.call.id) return state;
    if (state.phase !== 'idle' && isCallFinished(state)) return state;
    const connectedAt = state.phase === 'idle' ? null : state.connectedAt;
    if (event.phase === 'connecting' && connectedAt !== null) return state;
    if (event.phase === 'declined' || event.phase === 'missed' || event.phase === 'ended') return { call: event.call, phase: event.phase, connectedAt,
      endedAt: Math.max(event.at, connectedAt ?? event.call.createdAt), reason: 'remote' };
    return { call: event.call, phase: event.phase, connectedAt: null, endedAt: null };
  }
  if (event.type === 'START') {
    return state.phase === 'idle' ? { phase: 'ringing', call: event.call, connectedAt: null, endedAt: null } : state;
  }
  if (state.phase === 'idle' || event.callId !== state.call.id) return state;
  if (event.type === 'DISMISS') return isCallFinished(state) ? idleDirectCall : state;
  if (isCallFinished(state) || !Number.isFinite(event.at) || event.at < (state.connectedAt ?? state.call.createdAt)) return state;
  const finish = (phase: 'declined' | 'missed' | 'ended', reason: DirectCallEndReason): DirectCallState =>
    ({ ...state, phase, endedAt: event.at, reason });
  if (event.type === 'HANG_UP') return finish('ended', 'hangup');
  if (event.type === 'DECLINE') return state.phase === 'ringing' && state.call.direction === 'incoming' ? finish('declined', 'declined') : state;
  if (event.type === 'ACCEPT') return state.phase === 'ringing' && state.call.direction === 'incoming' ? { ...state, phase: 'connecting', connectedAt: null, endedAt: null } : state;
  if (event.type === 'EXPIRE') {
    if (state.phase !== event.phase) return state;
    return state.phase === 'ringing' ? finish('missed', 'timeout') : finish('ended', 'unavailable');
  }
  // The preview controller cannot turn signaling/UI acceptance into a media connection.
  if (event.type !== 'TRANSPORT' || state.call.source !== 'transport') return state;
  switch (event.signal) {
    case 'accepted': return state.phase === 'ringing' && state.call.direction === 'outgoing'
      ? { ...state, phase: 'connecting', connectedAt: null, endedAt: null } : state;
    case 'media-connected': return state.phase === 'connecting' || state.phase === 'reconnecting' ? { ...state, phase: 'connected', connectedAt: state.connectedAt ?? event.at, endedAt: null } : state;
    case 'media-reconnecting': return state.phase === 'connected' ? { ...state, phase: 'reconnecting' } : state;
    case 'declined': return state.phase === 'ringing' && state.call.direction === 'outgoing' ? finish('declined', 'declined') : state;
    case 'ended': return finish('ended', 'remote');
  }
}

export function formatCallDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
