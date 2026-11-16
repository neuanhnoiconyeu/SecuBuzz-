import { useCallback, useEffect, useId, useReducer, useRef } from 'react';
import { directCallReducer, idleDirectCall, type DirectCallKind, type DirectCallPeer } from './directCallMachine';

export const CALL_PREVIEW_RING_MS = 30_000;
export const CALL_PREVIEW_CONNECT_MS = 15_000;

/** No signaling, media capture, network calls or automatic remote activity. */
export function useDirectCallPreview(session: object) {
  const [state, dispatch] = useReducer(directCallReducer, idleDirectCall);
  const instance = useId();
  const sequence = useRef(0);
  useEffect(() => { dispatch({ type: 'RESET' }); }, [session]);
  useEffect(() => {
    if (state.phase !== 'ringing' && state.phase !== 'connecting') return;
    const { phase, call } = state;
    const timer = window.setTimeout(() => dispatch({ type: 'EXPIRE', callId: call.id, phase, at: Date.now() }),
      phase === 'ringing' ? CALL_PREVIEW_RING_MS : CALL_PREVIEW_CONNECT_MS);
    return () => window.clearTimeout(timer);
  }, [state]);
  const start = useCallback((conversationId: string, peer: DirectCallPeer, kind: DirectCallKind, direction: 'incoming' | 'outgoing' = 'outgoing') => {
    dispatch({ type: 'START', call: { id: `${instance}-${++sequence.current}`, conversationId, peer: { ...peer }, kind, direction, source: 'preview', createdAt: Date.now() } });
  }, [instance]);
  const act = (type: 'ACCEPT' | 'DECLINE' | 'HANG_UP' | 'DISMISS', callId: string) => dispatch({ type, callId, at: Date.now() });
  return { state, start, accept: (id: string) => act('ACCEPT', id), decline: (id: string) => act('DECLINE', id),
    hangUp: (id: string) => act('HANG_UP', id), dismiss: (id: string) => act('DISMISS', id) };
}
