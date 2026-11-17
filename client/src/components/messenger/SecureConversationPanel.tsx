'use client';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BrandLogo } from '@/components/branding';
import { Button } from '@/components/ui';
import { securityMessage } from '@/security/e2ee/api';
import { E2eeError, type DirectConversation } from '@/security/e2ee/model';
import { SecureMessagingSession, type DecryptedRow } from '@/security/e2ee/session';
import { SecureRealtimeWorkspace, type SecureLiveState } from '@/realtime/SecureRealtimeWorkspace';
import { SocketFailure } from '@/realtime/authenticatedProtocol';
import { ConversationSidebar } from './ConversationSidebar';
import { ConversationHeader } from './ConversationHeader';
import { MessageList } from './MessageList';
import { MessageComposer } from './MessageComposer';
import { conversationName, presentConnection, presentConversations, presentMessages, presentSendState } from './authenticatedChatPresentation';
import styles from './SecureConversationPanel.module.css';

const emptyLive: SecureLiveState = { connection: 'offline', conversations: [], rows: {}, cursors: {}, unread: {}, typing: {}, presence: {}, receipts: {}, keyVersions: {}, errors: {}, synchronized: 0 };
const emptySnapshot = () => emptyLive;
const noSubscription = () => () => {};
export function SecureConversationPanel({ session, live, active = true, selectedId, onSelect, displayName, onOpenVoiceRooms, onOpenFriends }: {
  session: SecureMessagingSession; live?: SecureRealtimeWorkspace | undefined; active?: boolean; selectedId: string | null;
  onSelect(id: string): void; displayName: string; onOpenVoiceRooms?: (() => void) | undefined; onOpenFriends?: (() => void) | undefined;
}) {
  const liveState = useSyncExternalStore(live?.subscribe ?? noSubscription, live?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const [localConversations, setConversations] = useState<DirectConversation[]>([]), [listCursor, setListCursor] = useState<string | null>(null);
  const conversations = live ? liveState.conversations : localConversations;
  const selected = conversations.find(c => c.id === selectedId);
  const authorized = Boolean(selected?.interactionAllowed);
  const actorId = session.api.session.actor.id;
  const [status, setStatus] = useState('Restoring secure device…'), [error, setError] = useState('');
  const [deviceReady, setDeviceReady] = useState(false), [explicitEnrollment, setExplicitEnrollment] = useState(false);
  const [initializing, setInitializing] = useState(false), [revoked, setRevoked] = useState(false);
  const [keyReview, setKeyReview] = useState<ReturnType<SecureMessagingSession['getKeyReview']>>(null);
  const [localRows, setRows] = useState<DecryptedRow[]>([]), [localCursor, setCursor] = useState<string | null>(null);
  const rows = useMemo(() => live && selectedId ? liveState.rows[selectedId] ?? [] : localRows.filter(row => row.message.conversationId === selectedId), [live, selectedId, liveState.rows, localRows]);
  const cursor = live && selectedId ? liveState.cursors[selectedId] : localCursor;
  const [mode, setMode] = useState<'live' | 'rest'>(live ? 'live' : 'rest'), [sendState, setSendState] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = selectedId ? drafts[selectedId] ?? '' : '';
  const [readyId, setReadyId] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const ready = Boolean(selectedId && readyId === selectedId && deviceReady && !revoked && authorized);
  const [pending, setPending] = useState(false), [safety, setSafety] = useState('');
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [mobileListOpen, setMobileListOpen] = useState(!selectedId), [narrow, setNarrow] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const alive = useRef(false), sequence = useRef(0), sending = useRef(false);
  const pendingDrafts = useRef<Record<string, string>>({});
  useEffect(() => { const lifecycle = sequence; alive.current = true; return () => { alive.current = false; lifecycle.current++; }; }, [session]);
  useEffect(() => {
    const resize = () => setNarrow(window.innerWidth <= 680);
    resize(); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => { if (selectedId) { setMobileListOpen(false); heading.current?.focus(); } }, [selectedId]);
  const visible = active && (!narrow || !mobileListOpen);
  const loadList = useCallback(async (next?: string) => {
    if (live) { try { await live.refresh(); } catch (e) { if (alive.current) setError(securityMessage(e)); } return; }
    try { const page = await session.api.conversations(next); if (!alive.current) return;
      setConversations(previous => next ? [...new Map([...previous, ...page.items].map(c => [c.id, c])).values()] : page.items); setListCursor(page.nextCursor);
    } catch (e) { if (alive.current) setError(securityMessage(e)); }
  }, [session, live]);
  const initialize = useCallback(async (enroll = false) => {
    setInitializing(true); setReadyId(null); setStatus(enroll ? 'Enrolling secure device…' : 'Restoring secure device…'); setError('');
    try { await session.initialize(enroll); if (alive.current) { setRevoked(false); setDeviceReady(true); setExplicitEnrollment(false); setStatus('Secure device ready'); } }
    catch (e) { if (alive.current) { setDeviceReady(false); setRevoked(e instanceof E2eeError && e.code === 'device_revoked'); setStatus(e instanceof E2eeError && e.code === 'device_revoked' ? 'Device revoked' : e instanceof E2eeError && e.code === 'enrollment_required' ? 'Device enrollment required' : 'Secure device unavailable'); setError(securityMessage(e)); setExplicitEnrollment(e instanceof E2eeError && e.code === 'enrollment_required'); } }
    finally { if (alive.current) setInitializing(false); }
  }, [session]);
  const enroll = () => {
    if (initializing || !explicitEnrollment) return;
    if (window.confirm('Enroll a new secure device in this browser profile? Existing device records and other browser profiles will not be changed. Older encrypted history may be unavailable, and contacts may need to review your new device.')) void initialize(true);
  };
  useEffect(() => { void initialize(); void loadList(); }, [initialize, loadList]);
  const refresh = useCallback(async () => {
    if (!selectedId || (!deviceReady && !revoked)) return;
    const version = ++sequence.current; setBusy(true); setReadyId(null); setSafety(''); setError(''); setStatus('Preparing secure conversation…');
    try {
      if (live) await live.refresh();
      if (revoked) throw new E2eeError('device_revoked');
      const prepared = await session.prepare(selectedId);
      if (!alive.current || sequence.current !== version) return;
      setConversations(previous => [...new Map([prepared.conversation, ...previous].map(c => [c.id, c])).values()]);
      setSafety(prepared.safetyNumber); setKeyReview(null); setReadyId(selectedId); setStatus('Secure message ready'); live?.clearError(selectedId);
    } catch (e) {
      if (alive.current && sequence.current === version && e instanceof E2eeError && e.code === 'device_revoked') { setRevoked(true); setDeviceReady(false); }
      if (alive.current && sequence.current === version) { setError(securityMessage(e)); setKeyReview(session.getKeyReview(selectedId)); setStatus(e instanceof E2eeError && e.code === 'keys_changed' ? 'Recipient keys changed' : e instanceof E2eeError && e.code === 'recipient_missing' ? 'Waiting for recipient keys' : e instanceof E2eeError && e.code === 'device_revoked' ? 'Device revoked' : 'Key verification failed'); }
    }
    try {
      if (live) await live.sync(selectedId);
      const history = live ? null : await session.history(selectedId), outstanding = await session.pending(selectedId);
      if (alive.current && sequence.current === version) { if (history) { setRows(history.items); setCursor(history.nextCursor); } setPending(Boolean(outstanding)); }
    } catch (e) { if (alive.current && sequence.current === version) setError(securityMessage(e)); }
    finally { if (alive.current && sequence.current === version) setBusy(false); }
  }, [deviceReady, revoked, selectedId, session, live]);
  useEffect(() => { sequence.current++; setRows([]); setPending(false); setReadyId(null); setSafety(''); setKeyReview(null); setError(''); setSendState(''); if (selectedId) void refresh(); }, [refresh, selectedId]);
  const keyRevision = selectedId ? liveState.keyVersions[selectedId] ?? 0 : 0;
  const observedKeys = useRef({ conversationId: selectedId, revision: keyRevision, synchronized: liveState.synchronized });
  useEffect(() => {
    const previous = observedKeys.current;
    observedKeys.current = { conversationId: selectedId, revision: keyRevision, synchronized: liveState.synchronized };
    // Selection/initialization already prepare above. Re-check this conversation
    // only when an actual key hint or completed reconnect advances its state.
    if (live && selectedId && deviceReady && previous.conversationId === selectedId &&
      (previous.revision !== keyRevision || previous.synchronized !== liveState.synchronized)) { setReadyId(null); void refresh(); }
  }, [keyRevision, liveState.synchronized, live, selectedId, deviceReady, refresh]);
  useEffect(() => {
    const selectVisible = () => live?.select(selectedId, visible && document.visibilityState === 'visible');
    selectVisible(); document.addEventListener('visibilitychange', selectVisible);
    return () => { live?.select(null, false); document.removeEventListener('visibilitychange', selectVisible); };
  }, [live, selectedId, visible]);
  useEffect(() => {
    const reconnect = () => { if (document.visibilityState === 'visible') live?.reconnect(); };
    window.addEventListener('online', reconnect); window.addEventListener('focus', reconnect); document.addEventListener('visibilitychange', reconnect);
    return () => { window.removeEventListener('online', reconnect); window.removeEventListener('focus', reconnect); document.removeEventListener('visibilitychange', reconnect); };
  }, [live]);
  const setDraft = (value: string) => { if (selectedId) setDrafts(previous => ({ ...previous, [selectedId]: value })); };
  const send = async (content: string): Promise<boolean> => {
    if (!selectedId || !content.trim() || sending.current || !ready || pending || (mode === 'live' && !live?.transport.connected)) return false;
    sending.current = true; const cid = selectedId, submittedDraft = draft, version = sequence.current;
    setSendingId(cid); setBusy(true); setError('');
    const progress = (value: string) => { if (alive.current && version === sequence.current) setSendState(value); };
    let accepted = false;
    try {
      if (live) await live.send(cid, displayName, content, mode, progress); else await session.send(cid, displayName, content, undefined, progress);
      accepted = true;
      if (alive.current) setDrafts(previous => previous[cid] === submittedDraft ? { ...previous, [cid]: '' } : previous);
      if (alive.current && version === sequence.current) setSendState('Persisted — delivery pending');
    } catch (e) {
      pendingDrafts.current[cid] = submittedDraft;
      if (alive.current && version === sequence.current) { setError(e instanceof SocketFailure ? e.message : securityMessage(e)); setSendState('Message not confirmed. Your draft is preserved.'); setReadyId(null); setKeyReview(session.getKeyReview(cid)); }
    } finally {
      sending.current = false; if (alive.current) setSendingId(null);
      if (alive.current && version === sequence.current) {
        try { if (live) await live.sync(cid); const history = live ? null : await session.history(cid), outstanding = await session.pending(cid);
          if (alive.current && version === sequence.current) { if (history) { setRows(history.items); setCursor(history.nextCursor); } setPending(Boolean(outstanding)); }
        } catch { /* Preserve the visible error and explicit reconciliation path. */ }
        if (alive.current && version === sequence.current) setBusy(false);
      }
    }
    return accepted;
  };
  const older = async () => {
    if (!selectedId || !cursor || busy) return; const version = sequence.current; setBusy(true);
    try { if (live) await live.older(selectedId); else { const page = await session.history(selectedId, cursor); if (alive.current && version === sequence.current) { setRows(previous => [...new Map([...previous, ...page.items].map(row => [row.message.id, row])).values()]); setCursor(page.nextCursor); } } }
    catch (e) { if (alive.current && version === sequence.current) setError(securityMessage(e)); }
    finally { if (alive.current && version === sequence.current) setBusy(false); }
  };
  const retry = async () => {
    if (!selectedId || busy || revoked) return; const version = sequence.current; setBusy(true); setError('');
    try { const result = live ? await live.retry(selectedId, mode, setSendState) : await session.retryPending(selectedId);
      if (alive.current && version === sequence.current) {
        if (result) { const submitted = pendingDrafts.current[selectedId]; setDrafts(previous => submitted !== undefined && previous[selectedId] === submitted ? { ...previous, [selectedId]: '' } : previous); delete pendingDrafts.current[selectedId]; }
        setPending(false); await refresh();
      }
    } catch (e) { if (alive.current && version === sequence.current) setError(e instanceof SocketFailure ? e.message : securityMessage(e)); }
    finally { if (alive.current && version === sequence.current) setBusy(false); }
  };
  const review = async () => {
    if (!selectedId) return; const version = sequence.current; setBusy(true); setError('');
    try { await session.acceptKeyChange(selectedId); if (alive.current && version === sequence.current) await refresh(); }
    catch (e) { if (alive.current && version === sequence.current) { setError(securityMessage(e)); setKeyReview(session.getKeyReview(selectedId)); } }
    finally { if (alive.current && version === sequence.current) setBusy(false); }
  };
  const sidebar = presentConversations(conversations, actorId, liveState, selectedId, localRows);
  const presented = presentMessages(rows, live ? (cid, id) => live.receiptFor(cid, id) : undefined);
  const name = selected ? conversationName(selected, actorId) : 'Secure conversation';
  const peer = selected?.participants.find(p => p.id !== actorId);
  const presence = peer ? liveState.presence[peer.id]?.status : undefined;
  const messageError = error || (selectedId ? liveState.errors[selectedId] : '') || liveState.errors[''];
  const connectionLabel = !live ? 'Live delivery unavailable' : liveState.connection === 'connected' ? 'Connected' : liveState.connection === 'auth_failed' ? 'Session expired — sign in again' : liveState.connection === 'offline' ? 'Offline' : 'Reconnecting…';
  const deviceNotice = <>
    <div className={deviceReady && !messageError ? 'sr-only' : styles.notice} role="status" aria-live="polite">{status}</div>
    {!deviceReady && <div className={styles.notice}>
      <Button disabled={initializing} onClick={() => explicitEnrollment ? enroll() : void initialize()}>{explicitEnrollment ? 'Enroll this browser — older history may be unavailable' : 'Retry secure device'}</Button>
      {explicitEnrollment && <p>Enrollment creates new non-extractable private keys in this browser profile. It does not recover keys from another device or make older messages decryptable.</p>}
      {revoked && <p>This profile keeps its revoked identity and historical keys. To enroll a different device, open this same application address in a fresh browser profile, sign in, and confirm “Enroll this browser”. Keep this profile and its browser storage for any history it can still decrypt.</p>}
    </div>}
    {messageError && <p role="alert" className={styles.warning}>{messageError}</p>}
  </>;
  return <section className={`${styles.workspace} ${mobileListOpen ? styles.listOpen : ''}`} aria-label="Secure conversations">
    <h1 id="real-chats-title" className="sr-only">Your conversations</h1>
    <ConversationSidebar conversations={sidebar} activeConversationId={selectedId} mobileListOpen={mobileListOpen} mode="remote"
      onSelect={id => { setMobileListOpen(false); onSelect(id); requestAnimationFrame(() => heading.current?.focus()); }}
      voiceRooms={<div className={styles.sidebarActions}>
        {narrow && mobileListOpen && deviceNotice}
        <p role="status" aria-label="Live connection">{connectionLabel}</p>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void loadList()}>Refresh conversations</Button>
        {listCursor && <Button size="sm" variant="ghost" onClick={() => void loadList(listCursor)}>More conversations</Button>}
        {onOpenFriends && <Button size="sm" variant="outline" onClick={onOpenFriends}>Manage Friends</Button>}
        {onOpenVoiceRooms && <Button size="sm" variant="outline" onClick={onOpenVoiceRooms}>Open Voice Rooms</Button>}
      </div>} />
    <div className={`messenger-main-column ${styles.column}`}>
      <section className="chat-window" aria-label={selectedId ? `${name} conversation` : 'Choose a conversation'}>
        {selectedId && <ConversationHeader name={name} type="direct" securityStatus={null} transportMode="realtime"
          connectionStatus={presentConnection(live?.getSnapshot().connection)} headingRef={heading} transitionKey={selectedId}
          onBackToConversations={() => setMobileListOpen(true)} showCalls={false}
          {...(presence && presence !== 'unknown' ? { presence } : {})}
          securePresentation={{ ready, label: ready ? 'End-to-end encrypted' : revoked ? 'Secure messaging locked' : keyReview ? 'Review contact keys' : 'Checking conversation keys', details: <>
            <p>Messages use E2EE v2. Device keys are authenticated by the service and remembered on this browser. Compare your safety number with your contact through another channel.</p>
            <p>This is trust on first use, not independent verification against a malicious server.</p>
            {safety && ready && <code className={styles.safety}>{safety}</code>}
          </> }} />}
        {(!narrow || !mobileListOpen) && deviceNotice}
        {keyReview && <div role="alert" className={styles.warning}><strong>Contact device keys changed</strong><p>Check with your contact before trusting new device keys.</p><details><summary>Compare device identities</summary><p>Previously trusted: {keyReview.oldIds.join(', ')}</p><p>Current devices: {keyReview.newIds.join(', ')}</p></details><Button disabled={busy} onClick={() => void review()}>Trust these device changes</Button></div>}
        {selectedId ? <>
          {cursor && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void older()}>Load older messages</Button>}
          <MessageList key={selectedId} messages={presented.messages} verifiedMessageIds={presented.verifiedIds} currentUserId={actorId}
            currentUserName={displayName} active={visible} transportMode="realtime" canEditMessage={false} onRetryMessage={() => void retry()} canRetryMessage={() => pending && !busy && !revoked} />
          {liveState.typing[selectedId]?.isTyping && <p role="status" className={styles.typing}>{liveState.typing[selectedId]?.displayName} is typing…</p>}
          {pending && <div className={styles.notice}><p>A message is awaiting confirmation. Retrying preserves its encrypted bytes and ID.</p><Button disabled={busy || revoked} onClick={() => void retry()}>Reconcile or retry pending message</Button></div>}
          <MessageComposer key={`composer:${selectedId}`} conversationName={name} messageCount={presented.messages.length}
            draftValue={draft} onDraftChange={setDraft} disabled={busy || !ready || pending || sendingId !== null || (mode === 'live' && !live?.transport.connected)}
            isSending={sendingId === selectedId} buzzBusy={false} textOnly demoNotice="Messages are encrypted on your device before sending."
            onTypingActivity={() => { if (selectedId) live?.typing(selectedId); }} onTypingStop={() => live?.stopTyping()}
            onSend={(text, extras) => extras?.voice || extras?.attachments?.length ? Promise.resolve(false) : send(text)} />
          {sendState && <p role="status" aria-label="Send state" className={sendState === 'Persisted — delivery pending' ? 'sr-only' : styles.sendState}>{presentSendState(sendState)}</p>}
        </> : <div className={styles.empty}><BrandLogo variant="full" size="lg" /><h2 className="display-heading display-heading--empty">Your people, your conversations</h2><p>Choose a chat or message someone from Friends.</p>{onOpenFriends && <Button onClick={onOpenFriends}>Find your friends</Button>}</div>}
        <details className={styles.advanced}><summary>Advanced settings</summary>
          <div className={styles.settings}>
            <Button size="sm" variant="outline" disabled={busy || !selectedId} onClick={() => void refresh()}>Refresh secure conversation</Button>
            {live && <><Button size="sm" variant="outline" onClick={() => live.reconnect()}>Reconnect live</Button><label>Message transport <select aria-label="Message transport" value={mode} disabled={busy} onChange={e => setMode(e.target.value === 'rest' ? 'rest' : 'live')}><option value="live">Live Socket.IO</option><option value="rest">REST persistence</option></select></label></>}
            <p>Group messaging, attachments, voice messages and direct calls remain separate until their authenticated encrypted contracts are verified.</p>
            <details><summary>This browser and key recovery</summary><p>Device keys stay in this browser’s IndexedDB after refresh and sign-out. They are not recoverable from your password. Clearing browser data may make older messages unavailable. IndexedDB does not protect keys against malicious same-origin JavaScript.</p>
              {deviceReady && <Button size="sm" variant="outline" onClick={() => { if (window.confirm('Permanently revoke this browser for future messages? Previously received keys and history are not erased.')) void session.revokeCurrentDevice().catch(e => { if (alive.current) { setRevoked(e instanceof E2eeError && e.code === 'device_revoked'); setDeviceReady(false); setReadyId(null); setStatus('Device revoked'); setError(securityMessage(e)); } }); }}>Revoke this browser</Button>}
            </details>
          </div>
        </details>
      </section>
    </div>
  </section>;
}
