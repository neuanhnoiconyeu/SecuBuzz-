import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { AuthUser } from '@/auth/authModel';
import type {DirectCallSignalingClient} from './callSignaling';
import type { LiveKitConnectionService } from '@/voice/livekitConnection';
import { useLiveRoomMedia } from '@/voice/useLiveVoiceRoom';
import { CALL_CLIENT_EVENTS as C, type CallClientEventName, type CallSnapshot } from '../../../shared/directCalls';
import { LIVEKIT_CALL_ID } from '../../../shared/livekit';
import { callFailureMessage, parseCallCleared, parseCallSnapshot } from './callSignaling';
import { directCallReducer, idleDirectCall, isCallFinished, type DirectCallEvent, type DirectCallKind, type DirectCallPeer } from './directCallMachine';

const allowedCall = (id: string) => LIVEKIT_CALL_ID.test(id);
const terminal = (call: CallSnapshot) => call.status !== 'ringing' && call.status !== 'accepted';
const ok = (value: unknown): value is { status: 'ok'; call: unknown; calls?: unknown[] } => Boolean(value && typeof value === 'object' && 'status' in value && value.status === 'ok');

/** Invitation state comes only from signaling; capture/publication/playback belongs to the shared room controller. */
export function useLiveDirectCalls(client: DirectCallSignalingClient | null, service: LiveKitConnectionService | null, user: AuthUser) {
  const media = useLiveRoomMedia(service, user, allowedCall);
  const mediaRef = useRef(media); mediaRef.current = media;
  const [state, dispatch] = useReducer(directCallReducer, idleDirectCall);
  const ui = useRef(state); ui.current = state;
  const commit = useCallback((event: DirectCallEvent) => { ui.current = directCallReducer(ui.current, event); dispatch(event); }, []);
  const [wire, setWire] = useState<CallSnapshot | null>(null);
  const latest = useRef<CallSnapshot | null>(null);
  const [ownedId, setOwnedId] = useState<string | null>(null);
  const owned = useRef<string | null>(null);
  const attempted = useRef<string | null>(null);
  const progressed = useRef<string | null>(null);
  const pendingEnd = useRef<string | null>(null);
  const ending = useRef(new Set<string>());
  const watermarks = useRef(new Map<string, { revision: number; terminal: boolean }>());
  const generation = useRef(0);
  const invalidate = useCallback(() => { ++generation.current; }, []);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signalStatus, setSignalStatus] = useState(client?.getStatus() ?? 'disconnected');
  const own = (id: string | null) => { owned.current = id; setOwnedId(id); };
  const remember = (id: string, revision: number, finished: boolean) => {
    watermarks.current.delete(id); watermarks.current.set(id, { revision, terminal: finished });
    if (watermarks.current.size > 1000) watermarks.current.delete(watermarks.current.keys().next().value!);
  };
  const applyRef = useRef<(value: unknown) => void>(() => {});
  applyRef.current = (value) => {
    const call = parseCallSnapshot(value, user.id);
    if (!call) return;
    const known = watermarks.current.get(call.callId);
    if (known && (call.revision <= known.revision || known.terminal)) return;
    remember(call.callId, call.revision, terminal(call));
    const current = ui.current;
    if (current.phase !== 'idle' && current.call.id !== call.callId) {
      if (!isCallFinished(current)) return;
      commit({ type: 'RESET' });
    }
    if (ui.current.phase === 'idle' && terminal(call)) return; // Never pop up retained history as an incoming invitation.
    latest.current = call; setWire(call);
    const peer = call.caller.userId === user.id ? call.recipient : call.caller;
    commit({ type: 'SERVER', call: { id: call.callId, conversationId: call.conversationId, peer: { id: peer.userId, name: peer.displayName },
      kind: call.kind, direction: call.caller.userId === user.id ? 'outgoing' : 'incoming', source: 'transport', createdAt: Math.min(Date.now(), Date.parse(call.createdAt)) },
      phase: call.status === 'accepted' ? 'connecting' : call.status === 'ringing' ? 'ringing' : call.status === 'declined' ? 'declined' : call.status === 'missed' ? 'missed' : 'ended', at: Date.now() });
    if (terminal(call)) { pendingEnd.current = null; own(null); attempted.current = null; void mediaRef.current.leave(); }
  };
  const syncRef = useRef<() => Promise<void>>(async () => {});
  syncRef.current = async () => {
    const epoch = generation.current;
    const requestedId = latest.current?.callId;
    const requestedRevision = requestedId ? watermarks.current.get(requestedId)?.revision : undefined;
    const response = await client?.calls?.request(C.sync, {});
    if (epoch !== generation.current || !ok(response) || !Array.isArray(response.calls) || response.calls.length > 20) return;
    // Apply the current call's terminal outcome before considering a newer invitation.
    const currentId = requestedId;
    const matching = response.calls.find(value => value && typeof value === 'object' && 'callId' in value && value.callId === currentId);
    if (matching) applyRef.current(matching);
    for (const value of response.calls) applyRef.current(value);
    if (currentId && !matching && latest.current?.callId === currentId && watermarks.current.get(currentId)?.revision === requestedRevision) {
      commit({ type: 'TRANSPORT', callId: currentId, signal: 'ended', at: Date.now() });
      latest.current = null; setWire(null); own(null); void mediaRef.current.leave();
      pendingEnd.current = null;
    }
  };
  const endRef = useRef<(id: string) => Promise<void>>(async () => {});
  endRef.current = async (id) => {
    if (!client?.calls || ending.current.has(id)) return;
    const epoch = generation.current;
    ending.current.add(id); pendingEnd.current = id;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const call = latest.current;
        if (!call || call.callId !== id || terminal(call)) { pendingEnd.current = null; return; }
        const event = call.status === 'accepted' ? C.end : call.caller.userId === user.id ? C.cancel : C.decline;
        const response = await client.calls.request(event, { callId: id });
        if (epoch !== generation.current) return;
        if (ok(response)) { applyRef.current(response.call); pendingEnd.current = null; return; }
        await syncRef.current();
      }
      setError('Media stopped. The call end could not be confirmed; signaling will retry after reconnecting.');
    } catch { if (epoch === generation.current) setError('Media stopped. The call end could not be confirmed; signaling will retry after reconnecting.'); }
    finally { ending.current.delete(id); }
  };
  const stopRef = useRef<(id: string, message?: string) => void>(() => {});
  stopRef.current = (id, message) => {
    if (latest.current?.callId !== id) return;
    own(null); attempted.current = null;
    void mediaRef.current.leave();
    commit({ type: 'HANG_UP', callId: id, at: Date.now() });
    if (message) setError(message);
    void endRef.current(id);
  };

  useEffect(() => {
    const epoch = ++generation.current;
    commit({ type: 'RESET' }); latest.current = null; setWire(null); own(null); attempted.current = null;
    watermarks.current.clear(); pendingEnd.current = null; busyRef.current = false; setBusy(false); setError(null);
    if (!client?.calls || client.mode !== 'realtime' || client.actorId !== user.id || user.isDemo !== false) return;
    let active = true;
    setSignalStatus(client.getStatus());
    const onConnect = () => { void syncRef.current().then(() => { if (active && pendingEnd.current) void endRef.current(pendingEnd.current); }).catch(() => {
      if (active) setError('Call status could not be synchronized.');
    }); };
    const unsubscribe = client.calls.subscribe((kind, value) => {
      if (!active || epoch !== generation.current) return;
      if (kind === 'state') applyRef.current(value);
      else {
        const cleared = parseCallCleared(value), call = latest.current;
        if (!cleared || (watermarks.current.get(cleared.callId)?.revision ?? 0) >= cleared.revision) return;
        remember(cleared.callId, cleared.revision, true);
        if (call?.callId === cleared.callId) {
          commit({ type: 'TRANSPORT', callId: call.callId, signal: 'ended', at: Date.now() });
          latest.current = null; setWire(null); own(null); attempted.current = null; void mediaRef.current.leave();
        }
      }
    });
    const unstatus = client.subscribe((event) => {
      if (!active || event.type !== 'connection') return;
      setSignalStatus(event.status);
      if (event.status === 'connected') onConnect();
      else if (owned.current && latest.current) stopRef.current(latest.current.callId, 'Signaling was interrupted. Media has stopped.');
    });
    if (client.getStatus() === 'connected') onConnect();
    return () => {
      active = false; invalidate(); unsubscribe(); unstatus();
      const call = latest.current;
      if (call && owned.current && !terminal(call)) {
        const event = call.status === 'accepted' ? C.end : call.caller.userId === user.id ? C.cancel : C.decline;
        void client.calls!.request(event, { callId: call.callId }).catch(() => {});
      }
      void mediaRef.current.leave();
    };
  }, [client, user.id, user.isDemo, commit, invalidate]);

  useEffect(() => {
    if (wire?.status !== 'accepted' || ownedId !== wire.callId || !service || attempted.current === wire.callId) return;
    attempted.current = wire.callId;
    void mediaRef.current.join(wire.callId, { camera: wire.kind === 'video' });
  }, [wire, ownedId, service]);

  const remoteCount = media.participants.filter(person => !person.isLocal).length;
  useEffect(() => {
    if (!wire || wire.status !== 'accepted' || ownedId !== wire.callId || attempted.current !== wire.callId) return;
    if (['requesting-token', 'connecting', 'connected', 'reconnecting'].includes(media.status)) progressed.current = wire.callId;
    if (media.status === 'error' || media.status === 'disabled' || media.status === 'disconnected' && progressed.current === wire.callId) {
      if (service?.getSnapshot().error === 'media_in_use') { own(null); attempted.current = null; void mediaRef.current.leave(); setError('Call media is active on another device.'); return; }
      stopRef.current(wire.callId, 'The media connection failed. The call has stopped.'); return;
    }
    if (media.status === 'connected' && remoteCount === 1) {
      commit({ type: 'TRANSPORT', callId: wire.callId, signal: 'media-connected', at: Date.now() }); return;
    }
    if (media.status === 'reconnecting') commit({ type: 'TRANSPORT', callId: wire.callId, signal: 'media-reconnecting', at: Date.now() });
    else if (ui.current.phase === 'connected' && remoteCount === 0) { stopRef.current(wire.callId); return; }
    const timer = window.setTimeout(() => stopRef.current(wire.callId, 'The other participant could not be reached. The call has stopped.'), 25_000);
    return () => window.clearTimeout(timer);
  }, [wire, ownedId, media.status, remoteCount, commit, service]);

  const available = Boolean(client?.calls && client.mode === 'realtime' && signalStatus === 'connected' && user.isDemo === false && media.canJoin);
  const request = async (event: CallClientEventName, id: string) => {
    if (busyRef.current || !client?.calls || latest.current?.callId !== id) return;
    if (event === C.accept && !available) { setError('Live call media is unavailable. You can decline this call.'); return; }
    const epoch = generation.current; busyRef.current = true; setBusy(true); setError(null);
    if (event === C.accept) own(id);
    try {
      const response = await client.calls.request(event, { callId: id });
      if (epoch !== generation.current) return;
      if (!ok(response)) {
        // A newer accepted broadcast can arrive before an older request's error acknowledgement.
        if (event === C.accept && latest.current?.callId === id && latest.current.status === 'accepted') return;
        if (event === C.accept) own(null); setError(callFailureMessage(response)); await syncRef.current(); return;
      }
      applyRef.current(response.call);
    } catch { if (epoch === generation.current && !(latest.current?.callId === id && latest.current.status === 'accepted')) { own(null); setError(callFailureMessage()); } }
    finally { if (epoch === generation.current) { busyRef.current = false; setBusy(false); } }
  };
  const start = async (conversationId: string, peer: DirectCallPeer, kind: DirectCallKind) => {
    if (!available || busyRef.current || ui.current.phase !== 'idle' || !client?.calls) { setError('Authenticated calling and LiveKit must be configured before placing a call.'); return; }
    const epoch = generation.current; busyRef.current = true; setBusy(true); setError(null);
    try {
      const body = { requestId: crypto.randomUUID(), conversationId, recipientId: peer.id, kind };
      let response: unknown;
      try { response = await client.calls.request(C.initiate, body); }
      catch { if (epoch !== generation.current) return; response = await client.calls.request(C.initiate, body); }
      if (epoch !== generation.current) return;
      if (!ok(response)) { setError(callFailureMessage(response)); return; }
      const call = parseCallSnapshot(response.call, user.id);
      if (!call || call.conversationId !== conversationId || call.recipient.userId !== peer.id || call.caller.userId !== user.id) throw new Error();
      applyRef.current(call);
      if (!terminal(latest.current ?? call)) own(call.callId);
    } catch { if (epoch === generation.current) setError(callFailureMessage()); }
    finally { if (epoch === generation.current) { busyRef.current = false; setBusy(false); } }
  };
  return { state, media, error, busy, available, signalStatus, ownedId, canStart: available && !busy && state.phase === 'idle', start,
    accept: (id: string) => { void request(C.accept, id); }, decline: (id: string) => { void request(C.decline, id); },
    hangUp: (id: string) => stopRef.current(id), dismiss: (id: string) => {
      if (ui.current.phase === 'idle' || ui.current.call.id !== id || !isCallFinished(ui.current)) return;
      if (pendingEnd.current === id) { setError('The call end is still being synchronized.'); return; }
      commit({ type: 'DISMISS', callId: id }); latest.current = null; setWire(null); setError(null);
    } };
}
export type LiveDirectCallsController = ReturnType<typeof useLiveDirectCalls>;
