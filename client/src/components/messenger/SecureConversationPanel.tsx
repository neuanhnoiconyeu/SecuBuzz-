'use client';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BrandLogo } from '@/components/branding';
import { Button } from '@/components/ui';
import { securityMessage } from '@/security/e2ee/api';
import { E2eeError, type DirectConversation } from '@/security/e2ee/model';
import { SecureMessagingSession, type DecryptedRow } from '@/security/e2ee/session';
import { SecureRealtimeWorkspace, mergeSecureRows, type SecureLiveState } from '@/realtime/SecureRealtimeWorkspace';
import { SocketFailure } from '@/realtime/authenticatedProtocol';
import { ConversationSidebar } from './ConversationSidebar';
import { ConversationHeader } from './ConversationHeader';
import { MessageList } from './MessageList';
import { MessageComposer } from './MessageComposer';
import { REAL_ACCOUNT_MESSAGING_CAPABILITIES as capabilities } from '@/messaging/messagingCapabilities';
import { useLocalHiddenMessages } from '@/hooks/useLocalHiddenMessages';
import { encodeAuthenticatedContent, type EncryptedReplyReference } from '@/messaging/authenticatedContent';
import { AuthenticatedForwarding } from '@/messaging/authenticatedForwarding';
import { AuthenticatedUnsend } from '@/messaging/authenticatedUnsend';
import { AuthenticatedPins, type AuthenticatedPinState } from '@/messaging/authenticatedPins';
import { AuthenticatedReactions, type ReactionState } from '@/messaging/authenticatedReactions';
import type { ChatMessage,MessageAttachment,VoiceMessageMetadata } from '@/messaging/messageModel';
import {AuthenticatedAttachments} from '@/messaging/authenticatedAttachments';
import {EncryptedAttachmentContext} from '@/messaging/EncryptedAttachmentContext';
import {useChatFileDrop} from '@/hooks/useChatFileDrop';
import { ReplyPreview } from './ReplyPreview';
import {MAX_MESSAGE_EDITS} from '../../../../shared/messageRevisions';
import { ForwardDialog } from './ForwardDialog';
import { conversationName, presentConnection, presentConversations, presentMessages, presentSendState } from './authenticatedChatPresentation';
import styles from './SecureConversationPanel.module.css';

const emptyLive: SecureLiveState = { connection: 'offline', conversations: [], rows: {}, cursors: {}, unread: {}, typing: {}, presence: {}, receipts: {}, keyVersions: {}, errors: {}, synchronized: 0 };
const emptySnapshot = () => emptyLive;
const noSubscription = () => () => {};
const emptyPins: AuthenticatedPinState = { collections: {}, rows: {}, saving: {}, errors: {} };
const emptyPinSnapshot = () => emptyPins;
const emptyReactions: ReactionState = { records: {}, saving: {}, errors: {} };
const emptyReactionSnapshot = () => emptyReactions;
export function SecureConversationPanel({ session, live, active = true, selectedId, onSelect, displayName, onOpenVoiceRooms, onOpenFriends }: {
  session: SecureMessagingSession; live?: SecureRealtimeWorkspace | undefined; active?: boolean; selectedId: string | null;
  onSelect(id: string): void; displayName: string; onOpenVoiceRooms?: (() => void) | undefined; onOpenFriends?: (() => void) | undefined;
}) {
  const liveState = useSyncExternalStore(live?.subscribe ?? noSubscription, live?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const [localConversations, setConversations] = useState<DirectConversation[]>([]), [listCursor, setListCursor] = useState<string | null>(null);
  const conversations = live ? liveState.conversations : localConversations;
  const selected = conversations.find(c => c.id === selectedId);
  const authorized = Boolean(selected?.interactionAllowed);
  const [localPins, setLocalPins] = useState<{ session: SecureMessagingSession; store: AuthenticatedPins } | null>(null);
  useEffect(() => {
    if (live) return;
    const store = new AuthenticatedPins(session); setLocalPins({ session, store });
    return () => store.dispose();
  }, [session, live]);
  const pins = live?.pins ?? (localPins?.session === session ? localPins.store : undefined);
  const pinState = useSyncExternalStore(pins?.subscribe ?? noSubscription, pins?.getSnapshot ?? emptyPinSnapshot, emptyPinSnapshot);
  const [localReactions,setLocalReactions]=useState<{session:SecureMessagingSession;store:AuthenticatedReactions}|null>(null);
  useEffect(()=>{if(live)return;const store=new AuthenticatedReactions(session.api.session);setLocalReactions({session,store});return()=>store.dispose();},[session,live]);
  const reactions=live?.reactions??(localReactions?.session===session?localReactions.store:undefined);
  const reactionState=useSyncExternalStore(reactions?.subscribe??noSubscription,reactions?.getSnapshot??emptyReactionSnapshot,emptyReactionSnapshot);
  const actorId = session.api.session.actor.id;
  const attachmentSession=useMemo(()=>new AuthenticatedAttachments(session.api.session,selectedId??''),[session,selectedId]);
  const [attachmentLimit,setAttachmentLimit]=useState<number|null>(null),[attachmentError,setAttachmentError]=useState('');
  const [composerRevision,setComposerRevision]=useState(0);
  useEffect(()=>{
    let active=true;setAttachmentLimit(null);setAttachmentError('');
    if(session.api.session.binary)void session.api.session.request('/api/attachments/limits').then(value=>{
      const limit=(value as {v:number;maxCiphertextBytes:number});
      if(limit?.v!==1||!Number.isSafeInteger(limit.maxCiphertextBytes)||limit.maxCiphertextBytes<17)throw new Error('Encrypted attachment storage is unavailable.');
      if(active)setAttachmentLimit(limit.maxCiphertextBytes);
    }).catch(()=>{if(active)setAttachmentError('Encrypted file storage is unavailable. Text messaging is still available.');});
    return()=>{active=false;};
  },[session]);
  const chatCapabilities=useMemo(()=>({...capabilities,attachments:capabilities.attachments&&attachmentLimit!==null,voiceMessages:capabilities.voiceMessages&&attachmentLimit!==null}),[attachmentLimit]);
  const localHidden = useLocalHiddenMessages(actorId);
  const [localDeleteError, setLocalDeleteError] = useState('');
  const [unsendError, setUnsendError] = useState('');
  const unsender = useMemo(() => new AuthenticatedUnsend(session), [session]);
  const [status, setStatus] = useState('Restoring secure device…'), [error, setError] = useState('');
  const [deviceReady, setDeviceReady] = useState(false), [explicitEnrollment, setExplicitEnrollment] = useState(false);
  const [initializing, setInitializing] = useState(false), [revoked, setRevoked] = useState(false);
  const [keyReview, setKeyReview] = useState<ReturnType<SecureMessagingSession['getKeyReview']>>(null);
  const [localRows, setRows] = useState<DecryptedRow[]>([]), [localCursor, setCursor] = useState<string | null>(null);
  const rows = useMemo(() => mergeSecureRows(live && selectedId ? liveState.rows[selectedId] ?? [] : localRows.filter(row => row.message.conversationId === selectedId),
    selectedId ? pinState.rows[selectedId] ?? [] : []), [live, selectedId, liveState.rows, localRows, pinState.rows]);
  useEffect(() => {
    pins?.authorize(conversations);
    if (pins && selectedId && authorized && deviceReady) void pins.refresh(selectedId).catch(() => {});
  }, [pins, conversations, selectedId, authorized, deviceReady]);
  useEffect(()=>{
    reactions?.authorize(conversations);
    if(reactions&&selectedId&&authorized&&deviceReady){reactions.watch(selectedId,rows.map(row=>row.message));void reactions.refresh(selectedId).catch(()=>{});}
  },[reactions,conversations,selectedId,authorized,deviceReady,rows]);
  const cursor = live && selectedId ? liveState.cursors[selectedId] : localCursor;
  const [mode, setMode] = useState<'live' | 'rest'>(live ? 'live' : 'rest'), [sendState, setSendState] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [replies, setReplies] = useState<Record<string, EncryptedReplyReference>>({});
  const pendingReplies = useRef<Record<string, EncryptedReplyReference | undefined>>({});
  const [forwardSource, setForwardSource] = useState<{ id: string; conversationId: string } | null>(null);
  const [forwardBusy, setForwardBusy] = useState(false);
  const forwarding = useMemo(() => new AuthenticatedForwarding(session, live), [session, live]);
  const draft = selectedId ? drafts[selectedId] ?? '' : '';
  const [readyId, setReadyId] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const ready = Boolean(selectedId && readyId === selectedId && deviceReady && !revoked && authorized);
  const [pending, setPending] = useState(false), [safety, setSafety] = useState('');
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [mobileListOpen, setMobileListOpen] = useState(!selectedId), [narrow, setNarrow] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const alive = useRef(false), sequence = useRef(0), sending = useRef(false);
  const drop=useChatFileDrop(selectedId??'',chatCapabilities.attachments&&ready&&!busy&&!pending&&!forwardBusy&&sendingId===null&&active);
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
      await pins?.refresh(selectedId, true).catch(() => {});
      const history = live ? null : await session.history(selectedId), outstanding = await session.pending(selectedId);
      if (alive.current && sequence.current === version) { if (history) { setRows(previous => mergeSecureRows(previous.filter(row => row.message.conversationId === selectedId && row.message.state === 'deleted'), history.items)); setCursor(history.nextCursor); } setPending(Boolean(outstanding)); }
    } catch (e) { if (alive.current && sequence.current === version) setError(securityMessage(e)); }
    finally { if (alive.current && sequence.current === version) setBusy(false); }
  }, [deviceReady, revoked, selectedId, session, live, pins]);
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
  const clearReply = (cid: string, reference: EncryptedReplyReference | undefined) => {
    if (reference) setReplies(previous => { if (previous[cid] !== reference) return previous; const next = { ...previous }; delete next[cid]; return next; });
  };
  const send = async (content: string,files:MessageAttachment[]=[],voice?:VoiceMessageMetadata): Promise<boolean> => {
    if (!selectedId || (!content.trim()&&!files.length&&!voice) || files.length&&!chatCapabilities.attachments || voice&&(!chatCapabilities.voiceMessages||!voice.attachment?.encrypted) || sending.current || !ready || pending || (mode === 'live' && !live?.transport.connected)) return false;
    sending.current = true; const cid = selectedId, submittedDraft = draft, version = sequence.current, reply = replies[selectedId];
    setSendingId(cid); setBusy(true); setError('');
    const progress = (value: string) => { if (alive.current && version === sequence.current) setSendState(value); };
    let accepted = false;
    try {
      const allFiles=voice?.attachment?[...files,voice.attachment]:files;
      const batch=allFiles.length?await attachmentSession.seal(allFiles):null;
      const encoded = encodeAuthenticatedContent({ text: content, ...(reply ? { reply } : {}),...(batch?{attachments:batch.manifests}:{}),
        ...(voice?.attachment?{voice:{v:1 as const,attachmentId:voice.attachment.id,durationSeconds:voice.durationSeconds}}:{}) });
      if(batch){
        if(live)await live.send(cid,displayName,encoded,mode,progress,batch.messageId);else await session.send(cid,displayName,encoded,undefined,progress,batch.messageId);
        attachmentSession.accepted(batch.messageId);
      }else if (live) await live.send(cid, displayName, encoded, mode, progress); else await session.send(cid, displayName, encoded, undefined, progress);
      accepted = true;
      if (alive.current) clearReply(cid, reply);
      if (alive.current) setDrafts(previous => previous[cid] === submittedDraft ? { ...previous, [cid]: '' } : previous);
      if (alive.current && version === sequence.current) setSendState('Persisted — delivery pending');
    } catch (e) {
      pendingDrafts.current[cid] = submittedDraft;
      pendingReplies.current[cid] = reply;
      if (alive.current && version === sequence.current) { setError(e instanceof SocketFailure ? e.message : securityMessage(e)); setSendState('Message not confirmed. Your draft is preserved.'); setReadyId(null); setKeyReview(session.getKeyReview(cid)); }
    } finally {
      sending.current = false; if (alive.current) setSendingId(null);
      if (alive.current && version === sequence.current) {
        try { if (live) await live.sync(cid); const history = live ? null : await session.history(cid), outstanding = await session.pending(cid);
          if (alive.current && version === sequence.current) { if (history) { setRows(mergeSecureRows(rows, history.items)); if (!rows.length) setCursor(history.nextCursor); } setPending(Boolean(outstanding)); }
        } catch { /* Preserve the visible error and explicit reconciliation path. */ }
        if (alive.current && version === sequence.current) setBusy(false);
      }
    }
    return accepted;
  };
  const older = async () => {
    if (!selectedId || !cursor || busy) return; const version = sequence.current; setBusy(true);
    try { if (live) await live.older(selectedId); else { const page = await session.history(selectedId, cursor); if (alive.current && version === sequence.current) { setRows(previous => mergeSecureRows(previous, page.items)); setCursor(page.nextCursor); } } }
    catch (e) { if (alive.current && version === sequence.current) setError(securityMessage(e)); }
    finally { if (alive.current && version === sequence.current) setBusy(false); }
  };
  const retry = async () => {
    if (!selectedId || busy || revoked) return; const version = sequence.current; setBusy(true); setError('');
    try { const result = live ? await live.retry(selectedId, mode, setSendState) : await session.retryPending(selectedId);
      if (alive.current && version === sequence.current) {
        if (result) { attachmentSession.accepted(result.id);setComposerRevision(n=>n+1);const submitted = pendingDrafts.current[selectedId]; setDrafts(previous => submitted !== undefined && previous[selectedId] === submitted ? { ...previous, [selectedId]: '' } : previous); delete pendingDrafts.current[selectedId]; clearReply(selectedId, pendingReplies.current[selectedId]); delete pendingReplies.current[selectedId]; }
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
  const deleteForMe = (messageId: string): boolean => {
    // Only hide a currently displayed, authenticated row using its stable wire ID.
    const row = rows.find(candidate => candidate.message.id === messageId && candidate.message.conversationId === selectedId);
    if (!row || !selectedId) return false;
    try { localHidden.hide(selectedId, row.message.id); setLocalDeleteError(''); return true; }
    catch { setLocalDeleteError('Delete for Me could not be saved on this device. Check browser storage and try again. Your message is unchanged.'); return false; }
  };
  const unsendForEveryone = async (messageId: string): Promise<boolean> => {
    const row = rows.find(candidate => candidate.message.id === messageId && candidate.message.conversationId === selectedId);
    if (!row || row.message.senderId !== actorId || row.message.state !== 'active' || row.error || row.text === null) return false;
    const version = sequence.current;
    setUnsendError('');
    try {
      const message = await unsender.remove(row.message);
      if (alive.current && version === sequence.current) {
        if (live) live.acceptUnsend(message);
        else setRows(previous => mergeSecureRows(previous, [{ message, text: null, error: null }]));
        void pins?.refresh(message.conversationId).catch(() => {});
        void reactions?.refresh(message.conversationId).catch(()=>{});
        setUnsendError('');
      }
      return true;
    } catch (e) {
      if (alive.current && version === sequence.current) setUnsendError(`Could not confirm Unsend. ${securityMessage(e)}`);
      return false;
    }
  };
  const editMessage=async(messageId:string,text:string):Promise<boolean>=>{
    const row=rows.find(r=>r.message.id===messageId&&r.message.conversationId===selectedId);
    if(!row||row.error||!ready||revoked)throw new Error('Edit unavailable');
    const version=sequence.current;setError('');
    try{
      const result=await session.editMessage(row.message,text);
      if(alive.current&&version===sequence.current){if(live)live.acceptEdit(result);else setRows(previous=>mergeSecureRows(previous,[result]));}
      return true;
    }catch(e){if(alive.current&&version===sequence.current)setError(securityMessage(e));throw e;}
  };
  const sidebar = presentConversations(conversations, actorId, liveState, selectedId, localRows, localHidden.isHidden);
  const presented = presentMessages(rows, live ? (cid, id) => live.receiptFor(cid, id) : undefined, localHidden.isHidden);
  const pinnedIds = new Set((selectedId ? pinState.collections[selectedId]?.items : undefined)?.map(pin => pin.message.id) ?? []);
  for (const message of presented.messages) if (!message.isDeleted && pinnedIds.has(message.id)) message.isPinned = true;
  for(const m of presented.messages){
    const record=reactionState.records[m.conversationId]?.[m.id];
    if(!m.isDeleted&&presented.verifiedIds.has(m.id)&&record?.state==='active'){
      const groups=new Map<string,string[]>();for(const a of record.actors)if(a.emoji)groups.set(a.emoji,[...groups.get(a.emoji)??[],a.userId]);
      m.reactions=[...groups].map(([emoji,userIds])=>({emoji,userIds}));
    }
  }
  const toggleReaction=async(messageId:string,emoji:string)=>{
    const row=rows.find(r=>r.message.id===messageId&&r.message.conversationId===selectedId);
    if(!reactions||!row||!presented.verifiedIds.has(messageId)||row.message.state!=='active')return false;
    const own=reactionState.records[row.message.conversationId]?.[messageId]?.actors.find(a=>a.userId===actorId);
    await reactions.set(row.message,own?.emoji===emoji?null:emoji);return true;
  };
  const togglePin = async (messageId: string) => {
    const row = rows.find(r => r.message.id === messageId && r.message.conversationId === selectedId);
    if (!pins || !row || (!pinnedIds.has(messageId) && !presented.verifiedIds.has(messageId))) return false;
    await pins.set(row.message, !pinnedIds.has(messageId)); return true;
  };
  const reply = selectedId ? replies[selectedId] : undefined;
  const replyOriginal = reply && presented.messages.find(m => m.id === reply.messageId && m.senderId === reply.senderId && !m.isDeleted && presented.verifiedIds.has(m.id));
  const forwardMessage = forwardSource && presented.messages.find(m => m.id === forwardSource.id && m.conversationId === forwardSource.conversationId && !m.isDeleted && presented.verifiedIds.has(m.id));
  const forwardTargets = conversations.filter(c => c.type === 'direct' && c.interactionAllowed && c.participants.length === 2 && c.participants.some(p => p.id === actorId)).map(c => ({ id: c.id, displayName: conversationName(c, actorId) }));
  const chooseReply = (message: ChatMessage) => {
    if (selectedId && presented.verifiedIds.has(message.id) && !message.isDeleted) {
      setReplies(previous => ({ ...previous, [selectedId]: { messageId: message.id, senderId: message.senderId } }));
      document.querySelector<HTMLTextAreaElement>('#message-input')?.focus();
    }
  };
  const confirmForward = async (targets: string[], note: string, operationId: string) => {
    const valid = new Set(forwardTargets.map(target => target.id));
    if (!forwardMessage || sending.current) return { failed: targets };
    const cid = selectedId, version = sequence.current;
    sending.current = true; setForwardBusy(true);
    try {
      const result = await forwarding.forward(forwardMessage, targets.filter(id => valid.has(id)), note, operationId, displayName, mode);
      return { ...result, failed: [...new Set([...targets.filter(id => !valid.has(id)), ...result.failed])] };
    }
    finally {
      sending.current = false;
      if (alive.current) {
        setForwardBusy(false);
        if (cid && version === sequence.current) {
          if (live) await live.sync(cid).catch(() => {});
          else { const history = await session.history(cid).catch(() => null); if (history && alive.current && version === sequence.current) { try { setRows(mergeSecureRows(rows, history.items)); } catch (e) { setError(securityMessage(e)); } } }
          const outstanding = await session.pending(cid).catch(() => null);
          if (alive.current && version === sequence.current) setPending(Boolean(outstanding));
        }
      }
    }
  };
  const missingHistoricalKeys = rows.some(row => !localHidden.isHidden(row.message.conversationId, row.message.id) && row.text === null && row.errorCode === 'missing_key');
  const name = selected ? conversationName(selected, actorId) : 'Secure conversation';
  const peer = selected?.participants.find(p => p.id !== actorId);
  const presence = peer ? liveState.presence[peer.id]?.status : undefined;
  const messageError = error || (selectedId ? liveState.errors[selectedId] : '') || liveState.errors[''];
  const connectionLabel = !live ? 'Live delivery unavailable' : liveState.connection === 'connected' ? 'Connected' : liveState.connection === 'auth_failed' ? 'Session expired — sign in again' : liveState.connection === 'offline' ? 'Offline' : 'Reconnecting…';
  const deviceNotice = <>
    <div className={deviceReady && !messageError ? 'sr-only' : styles.notice} role="status" aria-live="polite">{status}</div>
    {!deviceReady && <div className={styles.notice}>
      <Button disabled={initializing} onClick={() => explicitEnrollment ? enroll() : void initialize()}>{explicitEnrollment ? 'Enroll this browser — older history may be unavailable' : 'Retry secure device'}</Button>
      {explicitEnrollment && <p>Enrollment creates new non-extractable private keys in this browser profile. It does not recover keys from another device or make older messages decryptable. Private browsing has separate temporary storage; closing all private windows can lose access to those keys.</p>}
      {revoked && <p>This profile keeps its revoked identity and historical keys. To enroll a different device, open this same application address in a fresh browser profile, sign in, and confirm “Enroll this browser”. Keep this profile and its browser storage for any history it can still decrypt.</p>}
    </div>}
    {messageError && <p role="alert" className={styles.warning}>{messageError}</p>}
  </>;
  return <EncryptedAttachmentContext.Provider value={attachmentSession.read}><section className={`${styles.workspace} ${mobileListOpen ? styles.listOpen : ''}`} aria-label="Secure conversations">
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
      <section className="chat-window chat-attachment-drop-target" {...drop.bind} aria-label={selectedId ? `${name} conversation` : 'Choose a conversation'}>
        {drop.dragging&&<div className="chat-attachment-drop-overlay" aria-hidden="true">Drop files to attach</div>}
        {selectedId && <ConversationHeader name={name} type="direct" securityStatus={null} transportMode="realtime"
          connectionStatus={presentConnection(live?.getSnapshot().connection)} headingRef={heading} transitionKey={selectedId}
          onBackToConversations={() => setMobileListOpen(true)} showCalls={capabilities.directCalls}
          callDisabled={!authorized||!live?.transport.connected}
          {...(selectedId&&peer?{callTarget:{conversationId:selectedId,peer:{id:peer.id,name:peer.displayName}}}:{})}
          {...(presence && presence !== 'unknown' ? { presence } : {})}
          securePresentation={{ ready, label: ready ? 'End-to-end encrypted' : revoked ? 'Secure messaging locked' : keyReview ? 'Review contact keys' : 'Checking conversation keys', details: <>
            <p>Messages use E2EE v2. Device keys are authenticated by the service and remembered on this browser. Compare your safety number with your contact through another channel.</p>
            <p>Conversation readiness applies to new messages. Earlier messages still require the device keys they were encrypted for.</p>
            <p>This is trust on first use, not independent verification against a malicious server.</p>
            {safety && ready && <code className={styles.safety}>{safety}</code>}
          </> }} />}
        {(!narrow || !mobileListOpen) && deviceNotice}
        {keyReview && <div role="alert" className={styles.warning}><strong>Contact device keys changed</strong><p>Check with your contact before trusting new device keys.</p><details><summary>Compare device identities</summary><p>Previously trusted: {keyReview.oldIds.join(', ')}</p><p>Current devices: {keyReview.newIds.join(', ')}</p></details><Button disabled={busy} onClick={() => void review()}>Trust these device changes</Button></div>}
        {selectedId ? <>
          {localHidden.unavailable && <p role="status" className={styles.notice}>Local Delete for Me preferences could not be loaded. Allow browser storage to keep messages hidden on this device.</p>}
          {localDeleteError && <p role="alert" className={styles.warning}>{localDeleteError}</p>}
          {unsendError && <p role="alert" className={styles.warning}>{unsendError}</p>}
          {selectedId && pinState.errors[selectedId] && <p role="alert" className={styles.warning}>{pinState.errors[selectedId]}</p>}
          {selectedId&&reactionState.errors[selectedId]&&<p role="alert" className={styles.warning}>{reactionState.errors[selectedId]}</p>}
          {missingHistoricalKeys && <div role="status" aria-label="Historical message keys" className={styles.notice}>
            <p>Some earlier messages cannot be decrypted in this browser. Use the original browser profile if it still has their keys. Enrolling another device does not recover earlier messages. New messages can still work once your current device and contact keys are verified.</p>
          </div>}
          {cursor && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void older()}>Load older messages</Button>}
          <MessageList key={selectedId} messages={presented.messages} verifiedMessageIds={presented.verifiedIds} currentUserId={actorId}
            currentUserName={displayName} active={visible} transportMode="realtime" capabilities={chatCapabilities}
            canForwardMessage={message=>!message.attachments?.length&&!message.voice}
            canEditMessage={ready&&!busy&&!revoked}
            isEditEligible={message=>!message.attachments?.length&&!message.voice&&Boolean(rows.find(r=>r.message.id===message.id&&!r.error&&(r.message.edit?.proofs.length??0)<MAX_MESSAGE_EDITS))}
            onEditMessage={editMessage}
            editFailureMessage="Your edit could not be confirmed. Your draft is preserved; retry or refresh to check the latest message."
            onReplyMessage={chooseReply} onForwardMessage={message => setForwardSource({ id: message.id, conversationId: message.conversationId })}
            onUnsendMessage={unsendForEveryone}
            onTogglePin={togglePin} pinBusy={Boolean(selectedId && pinState.saving[selectedId])}
            onToggleReaction={toggleReaction} reactionBusy={Boolean(selectedId&&reactionState.saving[selectedId])}
            confirmDeleteForMe {...(!localHidden.unavailable ? { onDeleteMessage: deleteForMe } : {})}
            onRetryMessage={() => void retry()} canRetryMessage={() => pending && !busy && !revoked} />
          {liveState.typing[selectedId]?.isTyping && <p role="status" className={styles.typing}>{liveState.typing[selectedId]?.displayName} is typing…</p>}
          {pending && <div className={styles.notice}><p>A message is awaiting confirmation. Retrying preserves its encrypted bytes and ID.</p><Button disabled={busy || revoked} onClick={() => void retry()}>Reconcile or retry pending message</Button></div>}
          {reply && <ReplyPreview message={replyOriginal || { senderName: 'a message', content: 'Original message unavailable.' }} onCancel={() => { if (selectedId) setReplies(previous => { const next = { ...previous }; delete next[selectedId]; return next; }); }} />}
          {attachmentError&&<p role="status" className={styles.notice}>{attachmentError}</p>}
          <MessageComposer key={`composer:${selectedId}:${composerRevision}`} conversationName={name} messageCount={presented.messages.length}
            draftValue={draft} onDraftChange={setDraft} disabled={busy || forwardBusy || !ready || pending || sendingId !== null || (mode === 'live' && !live?.transport.connected)}
            isSending={sendingId === selectedId} buzzBusy={false} capabilities={chatCapabilities} active={visible}
            textOnly={!chatCapabilities.attachments && !chatCapabilities.voiceMessages} demoNotice={`Messages and files are encrypted on your device before sending.${attachmentLimit?` Server file limit: ${Math.floor(attachmentLimit/1024/1024)} MB including encryption overhead.`:''}`}
            uploadAttachment={attachmentSession.upload} discardAttachment={attachmentSession.discard} attachmentActionLabel="Encrypting and uploading"
            prepareVoice={attachmentSession.uploadVoice}
            {...(drop.files?{droppedFiles:drop.files}:{})}
            onTypingActivity={() => { if (selectedId) live?.typing(selectedId); }} onTypingStop={() => live?.stopTyping()}
            onSend={(text, extras) => send(text,extras?.attachments,extras?.voice)} />
          {sendState && <p role="status" aria-label="Send state" className={sendState === 'Persisted — delivery pending' ? 'sr-only' : styles.sendState}>{presentSendState(sendState)}</p>}
        </> : <div className={styles.empty}><BrandLogo variant="full" size="lg" /><h2 className="display-heading display-heading--empty">Your people, your conversations</h2><p>Choose a chat or message someone from Friends.</p>{onOpenFriends && <Button onClick={onOpenFriends}>Find your friends</Button>}</div>}
        <details className={styles.advanced}><summary>Advanced settings</summary>
          <div className={styles.settings}>
            <Button size="sm" variant="outline" disabled={busy || !selectedId} onClick={() => void refresh()}>Refresh secure conversation</Button>
            {live && <><Button size="sm" variant="outline" onClick={() => live.reconnect()}>Reconnect live</Button><label>Message transport <select aria-label="Message transport" value={mode} disabled={busy} onChange={e => setMode(e.target.value === 'rest' ? 'rest' : 'live')}><option value="live">Live Socket.IO</option><option value="rest">REST persistence</option></select></label></>}
            <p>Group messaging and direct calls remain separate until their authenticated encrypted contracts are verified. Media forwarding remains unavailable.</p>
            <details><summary>This browser and key recovery</summary><p>Device keys stay in this browser’s IndexedDB after refresh and sign-out. They are not recoverable from your password. Another browser, a different application address, or a private window has separate key storage. Closing all private windows or clearing browser data may make older messages unavailable. IndexedDB does not protect keys against malicious same-origin JavaScript.</p>
              {deviceReady && <Button size="sm" variant="outline" onClick={() => { if (window.confirm('Permanently revoke this browser for future messages? Previously received keys and history are not erased.')) void session.revokeCurrentDevice().catch(e => { if (alive.current) { setRevoked(e instanceof E2eeError && e.code === 'device_revoked'); setDeviceReady(false); setReadyId(null); setStatus('Device revoked'); setError(securityMessage(e)); } }); }}>Revoke this browser</Button>}
            </details>
          </div>
        </details>
      </section>
      <ForwardDialog message={visible ? forwardMessage || null : null} conversations={forwardTargets} onClose={() => setForwardSource(null)} onConfirm={confirmForward} />
    </div>
  </section></EncryptedAttachmentContext.Provider>;
}
