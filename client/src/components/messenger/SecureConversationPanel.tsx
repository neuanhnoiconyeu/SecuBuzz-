'use client';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui';
import { securityMessage } from '@/security/e2ee/api';
import { E2eeError, type DirectConversation } from '@/security/e2ee/model';
import { SecureMessagingSession, type DecryptedRow } from '@/security/e2ee/session';
import { SecureRealtimeWorkspace, type SecureLiveState } from '@/realtime/SecureRealtimeWorkspace';
import { SocketFailure } from '@/realtime/authenticatedProtocol';
import styles from './SecureConversationPanel.module.css';

const emptyLive: SecureLiveState = { connection: 'offline', conversations: [], rows: {}, cursors: {}, unread: {}, typing: {}, presence: {}, receipts: {}, keyVersions: {}, errors: {}, synchronized: 0 };
const emptySnapshot = () => emptyLive;
const noSubscription = () => () => {};
export function SecureConversationPanel({ session, live, active = true, selectedId, onSelect, displayName }: {
  session: SecureMessagingSession; live?: SecureRealtimeWorkspace | undefined; active?: boolean; selectedId: string | null; onSelect(id: string): void; displayName: string;
}) {
  const liveState = useSyncExternalStore(live?.subscribe ?? noSubscription, live?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const [localConversations, setConversations] = useState<DirectConversation[]>([]), [listCursor, setListCursor] = useState<string | null>(null);
  const conversations = live ? liveState.conversations : localConversations;
  const authorized = !live || conversations.some(c => c.id === selectedId && c.interactionAllowed);
  const [status, setStatus] = useState('Initializing secure device…'), [error, setError] = useState('');
  const [deviceReady, setDeviceReady] = useState(false), [explicitEnrollment, setExplicitEnrollment] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [keyReview, setKeyReview] = useState<ReturnType<SecureMessagingSession['getKeyReview']>>(null);
  const [localRows, setRows] = useState<DecryptedRow[]>([]), [localCursor, setCursor] = useState<string | null>(null);
  const rows = useMemo(() => live && selectedId ? liveState.rows[selectedId] ?? [] : localRows, [live, selectedId, liveState.rows, localRows]);
  const cursor = live && selectedId ? liveState.cursors[selectedId] : localCursor;
  const [mode, setMode] = useState<'live' | 'rest'>(live ? 'live' : 'rest'), [sendState, setSendState] = useState('');
  const historyElement = useRef<HTMLDivElement>(null), followHistory = useRef(true);
  const [draft, setDraft] = useState(''), [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false), [safety, setSafety] = useState('');
  const alive = useRef(false), sequence = useRef(0), sending = useRef(false);
  useEffect(() => { const lifecycle = sequence; alive.current = true; return () => { alive.current = false; lifecycle.current++; }; }, [session]);
  const peer = useCallback((c: DirectConversation) => c.participants.find(p => p.id !== session.api.session.actor.id)?.displayName ?? 'Contact', [session]);
  const loadList = useCallback(async (next?: string) => {
    if (live) { try { await live.refresh(); } catch (e) { if (alive.current) setError(securityMessage(e)); } return; }
    try { const page = await session.api.conversations(next); if (!alive.current) return;
      setConversations(previous => next ? [...new Map([...previous, ...page.items].map(c => [c.id, c])).values()] : page.items); setListCursor(page.nextCursor);
    } catch (e) { if (alive.current) setError(securityMessage(e)); }
  }, [session, live]);
  const initialize = useCallback(async (enroll = false) => {
    setStatus('Registering device…'); setError('');
    try { await session.initialize(enroll); if (alive.current) { setDeviceReady(true); setExplicitEnrollment(false); setStatus('Secure device ready'); } }
    catch (e) { if (alive.current) { setRevoked(e instanceof E2eeError && e.code === 'device_revoked'); setStatus(e instanceof E2eeError && e.code === 'device_revoked' ? 'Device revoked' : 'Secure device unavailable'); setError(securityMessage(e)); setExplicitEnrollment(e instanceof E2eeError && e.code === 'enrollment_required'); } }
  }, [session]);
  useEffect(() => { void initialize(); void loadList(); }, [initialize, loadList]);
  const refresh = useCallback(async () => {
    if (!selectedId || (!deviceReady && !revoked)) return;
    const version = ++sequence.current; setBusy(true); setReady(false); setSafety(''); setError(''); setStatus('Preparing secure conversation…');
    try {
      if (live) await live.refresh();
      if (revoked) throw new E2eeError('device_revoked');
      const prepared = await session.prepare(selectedId);
      if (!alive.current || sequence.current !== version) return;
      setConversations(previous => [...new Map([prepared.conversation, ...previous].map(c => [c.id, c])).values()]);
      setSafety(prepared.safetyNumber); setKeyReview(null); setReady(true); setStatus('Secure message ready');
      live?.clearError(selectedId);
    } catch (e) {
      if (alive.current && sequence.current === version) { setError(securityMessage(e)); setKeyReview(session.getKeyReview(selectedId)); setStatus(e instanceof E2eeError && e.code === 'keys_changed' ? 'Recipient keys changed' : e instanceof E2eeError && e.code === 'recipient_missing' ? 'Waiting for recipient keys' : e instanceof E2eeError && e.code === 'device_revoked' ? 'Device revoked' : 'Key verification failed'); }
    }
    try {
      if (live) await live.sync(selectedId);
      const history = live ? null : await session.history(selectedId), outstanding = await session.pending(selectedId);
      if (alive.current && sequence.current === version) { if (history) { setRows(history.items); setCursor(history.nextCursor); } setPending(Boolean(outstanding)); }
    } catch (e) { if (alive.current && sequence.current === version) setError(securityMessage(e)); }
    finally { if (alive.current && sequence.current === version) setBusy(false); }
  }, [deviceReady, revoked, selectedId, session, live]);
  useEffect(() => { sequence.current++; setRows([]); setDraft(''); setPending(false); setReady(false); setSafety(''); setKeyReview(null); if (selectedId) void refresh(); }, [refresh, selectedId]);
  const keyRevision = selectedId ? liveState.keyVersions[selectedId] ?? 0 : 0;
  useEffect(() => { if (live && selectedId && deviceReady && (keyRevision || liveState.synchronized)) { setReady(false); void refresh(); } }, [keyRevision, liveState.synchronized, live, selectedId, deviceReady, refresh]);
  useEffect(() => {
    const update = () => { live?.select(selectedId, active && document.visibilityState === 'visible'); if (document.visibilityState === 'visible') live?.reconnect(); };
    update(); window.addEventListener('online', update); window.addEventListener('focus', update); document.addEventListener('visibilitychange', update);
    return () => { live?.select(null, false); window.removeEventListener('online', update); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, [live, selectedId, active]);
  useEffect(() => { if (historyElement.current && followHistory.current) historyElement.current.scrollTop = historyElement.current.scrollHeight; }, [rows]);
  const send = async () => {
    if (!selectedId || !draft.trim() || sending.current) return; sending.current = true; const version = sequence.current;
    setBusy(true); setError('');
    const progress = (state: string) => { if (alive.current && version === sequence.current) setSendState(state); };
    try { if (live) await live.send(selectedId, displayName, draft, mode, progress); else await session.send(selectedId, displayName, draft, undefined, progress); if (alive.current && version === sequence.current) { setDraft(''); setSendState('Persisted — delivery pending'); } }
    catch (e) { if (alive.current && version === sequence.current) { setError(e instanceof SocketFailure ? e.message : securityMessage(e)); setSendState(e instanceof SocketFailure ? e.retryable ? 'Failed — retryable' : e.permanent ? 'Permanently rejected — reconcile before continuing' : 'Failed — verify session, access or keys' : 'Failed — verify secure state'); setReady(false); setKeyReview(session.getKeyReview(selectedId)); } }
    finally {
      sending.current = false;
      if (alive.current && version === sequence.current) {
        setBusy(false);
        try { if (live) await live.sync(selectedId); const history = live ? null : await session.history(selectedId), outstanding = await session.pending(selectedId);
          if (alive.current && version === sequence.current) { if (history) { setRows(history.items); setCursor(history.nextCursor); } setPending(Boolean(outstanding)); } } catch { /* The explicit error and refresh remain available. */ }
      }
    }
  };
  const older = async () => { if (!selectedId || !cursor || busy) return; const version = sequence.current; setBusy(true);
    followHistory.current = false;
    try { if (live) await live.older(selectedId); else { const page = await session.history(selectedId, cursor); if (alive.current && version === sequence.current) { setRows(previous => [...new Map([...previous, ...page.items].map(row => [row.message.id, row])).values()]); setCursor(page.nextCursor); } } }
    catch (e) { if (alive.current && version === sequence.current) setError(securityMessage(e)); }
    finally { if (alive.current && version === sequence.current) setBusy(false); }
  };
  const retry = async () => { if (!selectedId || busy) return; const version = sequence.current; setBusy(true); setError('');
    try { const result = live ? await live.retry(selectedId, mode, setSendState) : await session.retryPending(selectedId); if (alive.current && version === sequence.current) { setPending(false); if (result) setDraft(''); await refresh(); } } catch (e) { if (alive.current && version === sequence.current) setError(e instanceof SocketFailure ? e.message : securityMessage(e)); } finally { if (alive.current && version === sequence.current) setBusy(false); }
  };
  const review = async () => { if (!selectedId) return; const version = sequence.current; setBusy(true); setError('');
    try { await session.acceptKeyChange(selectedId); if (alive.current && version === sequence.current) await refresh(); } catch (e) { if (alive.current && version === sequence.current) { setError(securityMessage(e)); setKeyReview(session.getKeyReview(selectedId)); } } finally { if (alive.current && version === sequence.current) setBusy(false); }
  };
  return <section className={styles.panel} aria-label="Secure conversations">
    <div className={styles.heading}><h1 id="real-chats-title" className="display-heading display-heading--section">Your conversations</h1><Button size="sm" variant="outline" onClick={() => void loadList()} disabled={busy}>Refresh conversations</Button></div>
    <p role="status" aria-live="polite">{status}</p>
    {live && <p role="status" aria-label="Live connection">{liveState.connection === 'connected' ? 'Live connected' : liveState.connection === 'auth_failed' ? 'Live session expired — sign in again' : `Live ${liveState.connection}`} {liveState.connection === 'offline' && <Button size="sm" variant="outline" onClick={() => live.reconnect()}>Reconnect live</Button>}</p>}
    {!deviceReady && <><p>{error}</p><Button onClick={() => void initialize(explicitEnrollment)}>{explicitEnrollment ? 'Enroll this browser — older history may be unavailable' : 'Retry secure device'}</Button></>}
    {(deviceReady || revoked) && <div className={styles.body}>
      <nav className={styles.list} aria-label="Direct conversations">{conversations.length === 0 && <p>No conversations yet. Message a friend to start.</p>}
        {conversations.map(c => <Button key={c.id} aria-label={peer(c)} aria-describedby={`conversation-unread-${c.id}`} variant={c.id === selectedId ? 'primary' : 'outline'} disabled={busy} onClick={() => { followHistory.current = true; onSelect(c.id); }}>
          {peer(c)}{(liveState.unread[c.id] ?? 0) > 0 ? ` (${liveState.unread[c.id]} unread)` : ''}
          {live && <small className={styles.preview}>{(liveState.rows[c.id] ?? []).slice(-1)[0]?.text?.slice(0, 50) ?? ''}</small>}
          <span id={`conversation-unread-${c.id}`} className="sr-only">{liveState.unread[c.id] ?? 0} unread messages</span>
        </Button>)}
        {listCursor && <Button variant="outline" onClick={() => void loadList(listCursor)}>More conversations</Button>}
      </nav>
      <div className={styles.conversation}>
        {!selectedId ? <p>Choose a conversation or message someone from Friends.</p> : <>
          <div className={styles.heading}><h2 className="display-heading display-heading--section">{conversations.find(c => c.id === selectedId) ? peer(conversations.find(c => c.id === selectedId)!) : 'Secure conversation'}</h2><Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>Refresh secure conversation</Button></div>
          {(error || liveState.errors[selectedId] || liveState.errors['']) && <p role="alert">{error || liveState.errors[selectedId] || liveState.errors['']}</p>}
          {liveState.errors[selectedId] && !error && <p role="alert">{liveState.errors[selectedId]}</p>}
          {keyReview && <div role="alert" className={styles.warning}><strong>Contact device keys changed</strong><p>Previously trusted: {keyReview.oldIds.join(', ')}</p><p>Current devices: {keyReview.newIds.join(', ')}</p><p>Check with your contact before trusting new keys. The server authenticates the directory; this is not independent identity verification.</p><Button disabled={busy} onClick={() => void review()}>Trust these device changes</Button></div>}
          {safety && <details><summary>Identity trust and safety number</summary><p>Server-authenticated keys, with trust on first use. Compare this number with your contact through another channel. It does not prove protection from a malicious server.</p><code className={styles.safety}>{safety}</code></details>}
          {live && <p className="friends-row-note">Contact presence: {liveState.presence[conversations.find(c => c.id === selectedId)?.participants.find(p => p.id !== session.api.session.actor.id)?.id ?? '']?.status ?? 'unavailable'}</p>}
          <div ref={historyElement} onScroll={e => { const element = e.currentTarget; followHistory.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }} role="log" aria-label="Encrypted conversation history" className={styles.history}>{[...rows].sort((a, b) => a.message.sequence - b.message.sequence).map(row => <article key={row.message.id}><strong>{row.message.senderName}</strong><p>{row.message.state === 'deleted' ? 'Message deleted' : row.error ?? row.text}</p>
            {row.message.senderId === session.api.session.actor.id && <small>{live?.receiptFor(selectedId, row.message.id)?.status === 'read' ? 'Read' : live?.receiptFor(selectedId, row.message.id)?.status === 'delivered' ? 'Delivered' : 'Persisted — delivery pending'}</small>}
          </article>)}{rows.length === 0 && <p>No messages in this page.</p>}</div>
          {liveState.typing[selectedId]?.isTyping && <p role="status">{liveState.typing[selectedId]?.displayName} is typing…</p>}
          {cursor && <Button size="sm" variant="outline" disabled={busy} onClick={() => void older()}>Load older messages</Button>}
          {pending && <div><p>A message is awaiting confirmation. It will retain its original encrypted bytes and ID.</p><Button disabled={busy} onClick={() => void retry()}>Reconcile or retry pending message</Button></div>}
          {live && <label>Message transport <select aria-label="Message transport" value={mode} disabled={busy} onChange={e => setMode(e.target.value === 'rest' ? 'rest' : 'live')}><option value="live">Live Socket.IO</option><option value="rest">REST persistence</option></select></label>}
          <form onSubmit={e => { e.preventDefault(); void send(); }} className={styles.composer}><label htmlFor="secure-message">Secure message</label><textarea id="secure-message" rows={3} value={draft} onChange={e => { setDraft(e.target.value); if (selectedId && e.target.value.trim()) live?.typing(selectedId); else live?.stopTyping(); }} onBlur={() => live?.stopTyping()} disabled={busy || !ready || pending || !authorized} maxLength={12000} /><Button type="submit" disabled={!ready || pending || busy || !authorized || !draft.trim() || (mode === 'live' && !live?.transport.connected)}>Send encrypted message</Button></form>
          {sendState && <p role="status" aria-label="Send state">{sendState}</p>}
          <p className="friends-row-note">{mode === 'live' ? 'Encrypted live delivery with committed REST history. Persistence, delivery and read receipts are separate.' : 'Encrypted REST persistence. Your contact may need to refresh history; immediate live delivery is not guaranteed.'}</p>
        </>}
      </div>
    </div>}
    <details><summary>This browser and key recovery</summary><p>Device keys stay in this browser’s IndexedDB after refresh and sign-out. They are not recoverable from your password. Clearing browser data or using a new browser may make older messages unavailable. IndexedDB does not protect keys against malicious same-origin JavaScript.</p>
      {deviceReady && <Button size="sm" variant="outline" onClick={() => { if (window.confirm('Permanently revoke this browser for future messages? Previously received keys and history are not erased.')) void session.revokeCurrentDevice().catch(e => { if (alive.current) { setRevoked(e instanceof E2eeError && e.code === 'device_revoked'); setDeviceReady(false); setReady(false); setStatus('Device revoked'); setError(securityMessage(e)); } }); }}>Revoke this browser</Button>}
    </details>
  </section>;
}
