import { UnsendDialog, type UnsendScope } from './UnsendDialog';
import { QUICK_EMOJIS, emojiName, isEmojiOnlyMessage } from './emojiData';
import { EmojiPicker } from './EmojiPicker';
import { rememberEmoji } from './recentEmojis';
import { useAnchoredMessagePopover } from '@/hooks/useAnchoredMessagePopover';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  AlertTriangle, ArrowDown, Check, Edit2, Forward, LockKeyhole, MoreHorizontal,
  Pin, Plus, Reply, SmilePlus, Sparkles, Trash2, X,
} from 'lucide-react';
import { BrandLogo } from '@/components/branding';
import { Badge, Button, Surface } from '@/components/ui';
import type { ChatMessage, TransportMode } from '@/messaging/messageModel';
import type { DirectCallSummary } from '@/calls/directCallHistory';
import { CallEventBubble } from '@/components/calls/CallEventBubble';
import { DEMO_MESSAGING_CAPABILITIES, type MessagingCapabilities } from '@/messaging/messagingCapabilities';
import { AI_MAX_INPUT, type AIMessageAction } from '@/ai/aiModel';
import { useMessageEntryMotion } from './useMessageEntryMotion';
import { MessageAttachmentView } from './MessageAttachmentView';
import {VoiceMessageView} from './VoiceMessageView';
import './message-reactions.css';

export interface MessageListProps {
  messages: ChatMessage[];
  /** Session-only call observations already scoped to the authorized conversation. */
  callEvents?: readonly DirectCallSummary[] | undefined;
  currentUserId: string;
  /** Current display label only; stored authenticated sender metadata stays unchanged. */
  currentUserName?: string;
  /** Suppresses entry motion while this conversation's UI is hidden. */
  active?: boolean;
  transportMode?: TransportMode;
  capabilities?: MessagingCapabilities;
  onRetryMessage(messageId: string): void;
  canRetryMessage?(messageId: string): boolean;
  onReplyMessage?: (message: ChatMessage) => void;
  onEditMessage?: (messageId: string, newContent: string) => Promise<boolean> | boolean | void;
  canEditMessage?: boolean;
  isEditEligible?(message:ChatMessage):boolean;
  editFailureMessage?:string;
  onDeleteMessage?: (messageId: string) => Promise<boolean | void> | boolean | void;
  /** Compatibility prop; all local deletion now uses the shared confirmation. */
  confirmDeleteForMe?: boolean;
  onUnsendMessage?: (messageId: string) => Promise<boolean> | boolean;
  onTogglePin?: (messageId: string) => Promise<boolean | void> | boolean | void;
  pinBusy?: boolean;
  onToggleReaction?: (messageId: string, emoji: string) => Promise<boolean | void> | boolean | void;
  reactionBusy?: boolean;
  onAIMessage?: (task: AIMessageAction, messageId: string) => void;
  onForwardMessage?: (message: ChatMessage) => void;
  canForwardMessage?: (message:ChatMessage)=>boolean;
  verifiedMessageIds?: ReadonlySet<string>;
  emptyState?: { title: string; description: string } | undefined;
}

const noCallEvents: readonly DirectCallSummary[] = [];
type TimelineEntry = { key: string; message: ChatMessage; call?: never }
  | { key: string; call: DirectCallSummary; message?: never };

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'Time unavailable';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isGroupedWithPrevious(message: ChatMessage, previous?: ChatMessage): boolean {
  if (!previous || message.type !== 'text' || previous.type !== 'text') return false;
  if (message.senderId !== previous.senderId || message.conversationId !== previous.conversationId) return false;
  const timeGap = new Date(message.timestamp).getTime() - new Date(previous.timestamp).getTime();
  return timeGap >= 0 && timeGap <= 5 * 60 * 1000;
}

function deliveryLabel(status: ChatMessage['deliveryStatus'], transportMode: TransportMode): string {
  switch (status) {
    case 'sending': return 'Sending';
    case 'sent': return transportMode === 'local-demo' ? 'Accepted by local demo' : 'Sent';
    case 'delivered': return transportMode === 'local-demo' ? 'Delivered · simulated' : 'Delivered';
    case 'read': return transportMode === 'local-demo' ? 'Read · simulated' : 'Read';
    case 'failed': return 'Not sent';
  }
}

function isAcceptedMessage(message: ChatMessage): boolean {
  return !message.isDeleted && ['text', 'voice'].includes(message.type) && message.deliveryStatus !== 'sending' && message.deliveryStatus !== 'failed';
}

export function MessageList({
  messages,
  callEvents = noCallEvents,
  currentUserId,
  currentUserName = 'You',
  active = true,
  canEditMessage = true,
  isEditEligible,
  editFailureMessage='Could not edit this message. Your original message is unchanged.',
  onRetryMessage,
  canRetryMessage,
  onReplyMessage: suppliedReply,
  onEditMessage: suppliedEdit,
  onDeleteMessage: suppliedDelete,
  onUnsendMessage: suppliedUnsend,
  onTogglePin: suppliedPin,
  pinBusy = false,
  onToggleReaction: suppliedReaction,
  reactionBusy = false,
  onAIMessage,
  onForwardMessage: suppliedForward,
  canForwardMessage,
  transportMode = 'local-demo',
  capabilities = DEMO_MESSAGING_CAPABILITIES,
  verifiedMessageIds,
  emptyState,
}: MessageListProps) {
  const timeline = useMemo(() => {
    const calls = [...new Map(callEvents.map(call => [call.id, call])).values()]
      .sort((a, b) => a.endedAt - b.endedAt || a.id.localeCompare(b.id));
    const entries: TimelineEntry[] = [];
    let nextCall = 0;
    // Preserve authenticated message order; interleave local observations by their end time.
    for (const message of messages) {
      while (nextCall < calls.length && calls[nextCall]!.endedAt <= Date.parse(message.timestamp)) {
        const call = calls[nextCall++]!;
        entries.push({ key: `call:${call.id}`, call });
      }
      entries.push({ key: `message:${message.id}`, message });
    }
    for (const call of calls.slice(nextCall)) entries.push({ key: `call:${call.id}`, call });
    return entries;
  }, [messages, callEvents]);
  // A callback cannot enable an operation unsupported by this transport.
  const onReplyMessage = capabilities.reply ? suppliedReply : undefined;
  const onEditMessage = capabilities.edit ? suppliedEdit : undefined;
  const onDeleteMessage = capabilities.deleteForMe ? suppliedDelete : undefined;
  const onUnsendMessage = capabilities.unsendForEveryone ? suppliedUnsend : undefined;
  const onTogglePin = capabilities.pin ? suppliedPin : undefined;
  const onToggleReaction = capabilities.reactions ? suppliedReaction : undefined;
  const onForwardMessage = capabilities.forward ? suppliedForward : undefined;
  const historyRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);
  const previousPage = useRef({ first: timeline[0]?.key, last: timeline.at(-1)?.key, height: 0, keys: new Set(timeline.map(entry => entry.key)) });
  const initialScrollHandled = useRef(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const { enteringIds, finishEntry } = useMessageEntryMotion(messages, active);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editError, setEditError] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const editLock = useRef(false);
  const saveEdit = async (messageId: string) => {
    if (!editDraft.trim() || editLock.current || !canEditMessage || !onEditMessage) return;
    if(isEditEligible&&!messages.some(m=>m.id===messageId&&isEditEligible(m))){setEditError('This message is no longer eligible for editing.');return;}
    editLock.current = true;
    setSavingEdit(true);
    setEditError('');
    try {
      if (await onEditMessage(messageId, editDraft) === false) {
        setEditError(editFailureMessage);
        return;
      }
      setEditingId(null);
    } catch {
      setEditError(editFailureMessage);
    } finally {
      editLock.current = false;
      setSavingEdit(false);
    }
  };
  const [unsendingMessage, setUnsendingMessage] = useState<ChatMessage | null>(null);
  const [removing, setRemoving] = useState(false);
  const removalLock = useRef(false);
  const [actionFeedback, setActionFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const remove = async (messageId: string, scope: UnsendScope): Promise<boolean> => {
    const message = messages.find(candidate => candidate.id === messageId);
    const handler = scope === 'everyone' ? onUnsendMessage : onDeleteMessage;
    if (!removalLock.current && transportMode === 'realtime' && scope === 'everyone' && message?.isDeleted && message.senderId === currentUserId && handler) {
      setActionFeedback({ error: false, text: 'Message unsent for everyone.' }); return true;
    }
    if (removalLock.current || !message || !handler || (scope === 'everyone' && (message.senderId !== currentUserId || !isAcceptedMessage(message)))) return false;
    removalLock.current = true; setRemoving(true); setActionFeedback(null);
    try {
      if (await handler(messageId) === false) return false;
      setActionFeedback({ error: false, text: scope === 'me' ? 'Message deleted for you on this device.'
        : transportMode === 'local-demo' ? 'Message unsent in this local demo only.' : 'Message unsent for everyone.' });
      return true;
    } catch {
      return false;
    } finally {
      removalLock.current = false; setRemoving(false);
    }
  };
  const [pinsOpen, setPinsOpen] = useState(false);
  const [pinning, setPinning] = useState(false);
  const pinLock = useRef(false);
  const reactionLock=useRef(false);
  const [reacting,setReacting]=useState(false);
  const submitReaction=async(messageId:string,emoji:string,returnFocus?:HTMLElement)=>{
    if(!onToggleReaction||reactionBusy||reactionLock.current)return;
    const focusRow=returnFocus?.closest('article');let pending=false;
    reactionLock.current=true;setReacting(true);setActionFeedback(null);
    try{
      let result=onToggleReaction(messageId,emoji);if(result&&typeof result==='object'&&typeof result.then==='function'){pending=true;result=await result;}
      if(result===false)throw new Error('Reaction was not confirmed');
      if(transportMode==='realtime')setActionFeedback({error:false,text:'Reactions updated.'});
    }catch{setActionFeedback({error:true,text:'Could not update reactions. Your previous reaction is unchanged. Try again.'});}
    finally{
      reactionLock.current=false;setReacting(false);
      if(pending&&returnFocus)requestAnimationFrame(()=>{
        if(document.activeElement!==document.body&&document.activeElement!==returnFocus)return;
        const target=returnFocus.isConnected?returnFocus:focusRow?.querySelector<HTMLButtonElement>('button[aria-label="React to message"]');
        if(target?.isConnected&&!target.matches(':disabled'))target.focus({preventScroll:true});
      });
    }
  };
  const changePin = async (messageId: string) => {
    if (!onTogglePin || pinBusy || pinLock.current) return;
    pinLock.current = true; setPinning(true); setActionFeedback(null);
    try {
      let result = onTogglePin(messageId);
      if (result && typeof result === 'object' && typeof result.then === 'function') result = await result;
      if (result === false) throw new Error('Pin was not confirmed');
      if (transportMode === 'realtime') setActionFeedback({ error: false, text: 'Pinned messages updated.' });
    } catch { setActionFeedback({ error: true, text: 'Could not update pinned messages. Refresh and try again.' }); }
    finally { pinLock.current = false; setPinning(false); }
  };
  const pinsButton = useRef<HTMLButtonElement>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [replyNotice, setReplyNotice] = useState('');
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (highlightTimer.current !== null) clearTimeout(highlightTimer.current);
  }, []);
  const navigateToMessage = (messageId: string, conversationId: string, kind = 'original') => {
    const original = messages.find(candidate => candidate.id === messageId && candidate.conversationId === conversationId);
    const row = Array.from(historyRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])
      .find(element => element.dataset.messageId === original?.id);
    if (!original || original.isDeleted || original.type === 'security_alert' || !row) {
      setHighlightedId(null);
      setReplyNotice(original?.isDeleted ? `The ${kind} message was deleted.` : `The ${kind} message is unavailable in the loaded history.`);
      return;
    }
    setReplyNotice('');
    row.scrollIntoView?.({ block: 'center', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    row.focus({ preventScroll: true });
    setHighlightedId(original.id);
    if (highlightTimer.current !== null) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightedId(null), 2000);
  };

  // Reaction picker (quick bar -> expanded grid) and "more" menu: only one open at a time.
  const [pickerOpenId, setPickerOpenId] = useState<string | null>(null);
  const [pickerExpanded, setPickerExpanded] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restorePopoverFocus = useRef(false);
  const popoverId = useId();

  const pinnedMessages = messages.filter((m) => m.isPinned && !m.isDeleted);
  useEffect(() => {
    if (!active || pinnedMessages.length === 0) {
      setPinsOpen(false);
      if (active && pinsOpen) historyRef.current?.focus({ preventScroll: true });
    }
  }, [active, pinnedMessages.length, pinsOpen]);

  const closePopovers = useCallback((restoreFocus = false) => {
    restorePopoverFocus.current = restoreFocus;
    setPickerOpenId(null);
    setPickerExpanded(false);
    setMenuOpenId(null);
  }, []);

  const openPopover = pickerOpenId ? `reaction:${pickerOpenId}:${pickerExpanded}` : menuOpenId ? `menu:${menuOpenId}` : null;
  useAnchoredMessagePopover(popoverRef, popoverTriggerRef, openPopover, closePopovers, pickerExpanded, historyRef);

  useEffect(() => {
    if (!pickerOpenId && !menuOpenId) {
      if (restorePopoverFocus.current) {
        restorePopoverFocus.current = false;
        (popoverTriggerRef.current?.isConnected ? popoverTriggerRef.current : historyRef.current)?.focus({ preventScroll: true });
      }
      return;
    }
    if (!active) { closePopovers(); return; }
    const panel = popoverRef.current;
    panel?.querySelector<HTMLElement>('input[type="search"], button:not(:disabled)')?.focus({ preventScroll: true });
  }, [active, pickerOpenId, menuOpenId, pickerExpanded, closePopovers]);

  useEffect(() => {
    const id = pickerOpenId ?? menuOpenId;
    if (id && !messages.some((message) => message.id === id && !message.isDeleted)) closePopovers(true);
  }, [messages, pickerOpenId, menuOpenId, closePopovers]);

  const handlePopoverKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.closest('.emoji-picker')) return;
    const panel = event.currentTarget;
    if (event.key === 'Tab') {
      event.preventDefault();
      const trigger = popoverTriggerRef.current;
      const controls = Array.from(document.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex]'))
        .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[hidden], [inert]') &&
          !panel.contains(element) && element.getClientRects().length > 0);
      const next = controls[controls.indexOf(trigger!) + (event.shiftKey ? -1 : 1)];
      closePopovers();
      (next ?? trigger ?? historyRef.current)?.focus({ preventScroll: true });
      return;
    }
    const items = Array.from(panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = pickerExpanded && (event.key === 'ArrowDown' || event.key === 'ArrowUp') ? 6 : 1;
    let next: number | undefined;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + step) % items.length;
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - step + items.length) % items.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = items.length - 1;
    if (next !== undefined && items.length) { event.preventDefault(); items[next]?.focus({ preventScroll: true }); }
  };

  useEffect(() => {
    const history = historyRef.current;
    if (!initialScrollHandled.current) {
      initialScrollHandled.current = true;
      previousPage.current = { first: timeline[0]?.key, last: timeline.at(-1)?.key, height: history?.scrollHeight ?? 0, keys: new Set(timeline.map(entry => entry.key)) };
      if (timeline.length > 0 && history) {
        history.scrollTop = history.scrollHeight;
        isNearBottom.current = true;
      }
      return;
    }

    const addedCount = timeline.filter(entry => !previousPage.current.keys.has(entry.key)).length;
    const prepended = addedCount > 0 && previousPage.current.first && timeline[0]?.key !== previousPage.current.first && timeline.at(-1)?.key === previousPage.current.last;
    if (prepended && history) {
      history.scrollTop += Math.max(0, history.scrollHeight - previousPage.current.height);
    } else if (addedCount > 0) {
      if (isNearBottom.current) {
        if (history) history.scrollTop = history.scrollHeight;
        setNewMessageCount(0);
      } else {
        setNewMessageCount((count) => count + addedCount);
      }
    }
    previousPage.current = { first: timeline[0]?.key, last: timeline.at(-1)?.key, height: history?.scrollHeight ?? 0, keys: new Set(timeline.map(entry => entry.key)) };
  }, [timeline]);

  const updateViewportPosition = () => {
    closePopovers();
    const history = historyRef.current;
    if (!history) return;
    isNearBottom.current = history.scrollHeight - history.scrollTop - history.clientHeight <= 72;
    if (isNearBottom.current) setNewMessageCount(0);
  };

  const jumpToLatest = () => {
    const history = historyRef.current;
    if (history) history.scrollTop = history.scrollHeight;
    isNearBottom.current = true;
    setNewMessageCount(0);
  };

  const react = (messageId: string, emoji: string, remember = true) => {
    if (remember) rememberEmoji(emoji);
    void submitReaction(messageId, emoji, popoverTriggerRef.current ?? undefined);
    closePopovers(true);
  };

  return (
    <div className="chat-history-wrap">
      {pinnedMessages.length > 0 && (
        <div className="pinned-messages-bar" style={{ padding: '6px 12px', background: 'rgba(139, 92, 246, 0.12)', borderBottom: '1px solid rgba(139, 92, 246, 0.25)', fontSize: '0.82rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <div className="pinned-message-summary">
            <Pin size={14} aria-hidden="true" />
            <strong>Pinned ({pinnedMessages.length}):</strong>
            <button type="button" className="pinned-message-preview" aria-label="Go to latest pinned message"
              onClick={() => { const message = pinnedMessages[pinnedMessages.length - 1]!; navigateToMessage(message.id, message.conversationId, 'pinned'); }}>
              {pinnedMessages[pinnedMessages.length - 1]?.content}
            </button>
          </div>
          <Button ref={pinsButton} size="sm" variant="ghost" aria-expanded={pinsOpen} aria-controls={`${popoverId}-pins`} onClick={() => setPinsOpen(open => !open)}>
            View pinned messages
          </Button>
          {onTogglePin && (
            <Button size="sm" variant="outline" disabled={pinBusy || pinning} onClick={() => {
              void changePin(pinnedMessages[pinnedMessages.length - 1]!.id);
              if (pinnedMessages.length === 1) historyRef.current?.focus({ preventScroll: true });
            }}>
              Unpin
            </Button>
          )}
        </div>
      )}
      {pinsOpen && pinnedMessages.length > 0 && <section id={`${popoverId}-pins`} className="pinned-messages-panel" aria-label="Pinned messages"
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setPinsOpen(false); pinsButton.current?.focus(); } }}>
        {transportMode === 'local-demo' && <p className="pinned-messages-notice">Pins apply only to this local demo.</p>}
        <ul className="pinned-messages-list">
          {pinnedMessages.map(message => <li key={message.id}>
            <button type="button" className="pinned-message-link" onClick={() => { setPinsOpen(false); navigateToMessage(message.id, message.conversationId, 'pinned'); }}>
              <strong>{message.senderId === currentUserId ? currentUserName : message.senderName}</strong>
              <span>{message.content}</span>
            </button>
            {onTogglePin && <Button size="sm" variant="outline" disabled={pinBusy || pinning} aria-label={`Unpin message: ${message.content.slice(0, 60)}`} onClick={() => void changePin(message.id)}>Unpin</Button>}
          </li>)}
        </ul>
      </section>}
      <Surface
        ref={historyRef}
        variant="default"
        className="chat-history"
        role="log"
        aria-label="Chat messages"
        aria-live="polite"
        onScroll={updateViewportPosition}
        tabIndex={0}
      >
        {timeline.length === 0 ? (
          <div className="chat-empty-state">
            <div className="chat-empty-atmosphere" aria-hidden="true" />
            <div className="chat-empty-brand-stage">
              <BrandLogo variant="full" size="lg" className="chat-empty-logo" />
            </div>
            <h2 className="display-heading display-heading--empty">{emptyState?.title ?? 'No messages yet'}</h2>
            <p>{emptyState?.description ?? (transportMode === 'local-demo'
              ? 'A little hello starts a conversation. Try it in this local demo.'
              : 'Write a message to start this conversation.')}</p>
          </div>
        ) : (
          <div className="message-list">
            {timeline.map((entry, index) => {
              if (entry.call) return <CallEventBubble key={entry.key} call={entry.call} />;
              const message = entry.message;
              const previous = timeline[index - 1]?.message;
              const grouped = isGroupedWithPrevious(message, previous);
              const isOutgoing = message.senderId === currentUserId;

              if (message.type === 'system') {
                return (
                  <article className="message-system" key={entry.key} role="note" data-message-id={message.id}>
                    <span>{message.content}</span>
                    <time dateTime={message.timestamp} title={new Date(message.timestamp).toLocaleString()}>
                      {formatTime(message.timestamp)}
                    </time>
                  </article>
                );
              }

              if (message.type === 'security_alert') {
                return (
                  <article className="message-security-alert" key={entry.key} role="alert" data-message-id={message.id}>
                    <AlertTriangle size={18} aria-hidden="true" />
                    <div className="message-security-copy">
                      <strong>{message.senderName}</strong>
                      <p>{message.content}</p>
                      <time dateTime={message.timestamp} title={new Date(message.timestamp).toLocaleString()}>
                        {formatTime(message.timestamp)}
                      </time>
                    </div>
                  </article>
                );
              }

              const hasReactions = !message.isDeleted && !!message.reactions && message.reactions.length > 0;
              const isPickerOpen = pickerOpenId === message.id;
              const isMenuOpen = menuOpenId === message.id;
              const myReactions = new Set(
                (message.reactions ?? []).filter((r) => r.userIds.includes(currentUserId)).map((r) => r.emoji),
              );
              const canShareWithAI = Boolean(onAIMessage && message.type === 'text' && !message.isDeleted && message.content.trim() && message.content.length <= AI_MAX_INPUT);
              const hasAttachments = !message.isDeleted && Boolean(message.attachments && message.attachments.length > 0);
              const hasVoice = !message.isDeleted && Boolean(message.voice);
              const hasText = Boolean(message.content.trim());
              const showTextBubble = message.isDeleted || hasText || (!hasAttachments && !hasVoice);
              const isBareEmoji = message.type === 'text' && !message.isDeleted && !hasAttachments && !hasVoice && isEmojiOnlyMessage(message.content);
              const accepted = isAcceptedMessage(message);
              const canEdit = Boolean(isOutgoing && onEditMessage && canEditMessage && (!isEditEligible||isEditEligible(message)) && message.type === 'text' && accepted);
              const canUnsend = Boolean(isOutgoing && onUnsendMessage && accepted);
              const canDelete = Boolean(onDeleteMessage && !message.isDeleted);
              const canForward = Boolean(onForwardMessage && accepted && (canForwardMessage?.(message)??true));
              const canPin = Boolean(onTogglePin && (accepted || message.isPinned));
              const canReact = Boolean(onToggleReaction && accepted);
              const canShowMenu = !!(canShareWithAI || canForward || canPin || canEdit || canDelete || canUnsend);
              const originalReply = message.replyTo && messages.find(candidate => candidate.id === message.replyTo?.messageId && candidate.conversationId === message.conversationId);

              return (
                <article
                  className={`message-row ${isOutgoing ? 'message-row-outgoing' : ''} ${grouped ? 'message-row-grouped' : ''}`}
                  key={entry.key}
                  data-message-id={message.id}
                  data-message-highlighted={highlightedId === message.id && !message.isDeleted ? 'true' : undefined}
                  tabIndex={-1}
                  data-message-enter={active && enteringIds.has(message.id) ? 'true' : undefined}
                  onAnimationEnd={(event) => {
                    if (event.target === event.currentTarget) finishEntry(message.id);
                  }}
                >
                  <div className="message-meta">
                    {!grouped && <strong>{isOutgoing ? currentUserName === 'You' ? 'You' : `${currentUserName} (You)` : message.senderName}</strong>}
                    <time dateTime={message.timestamp} title={new Date(message.timestamp).toLocaleString()}>
                      {formatTime(message.timestamp)}
                    </time>
                    {message.isEdited && !message.isDeleted && <span style={{ fontSize: '0.72rem', opacity: 0.7 }}>(edited)</span>}
                    {message.isPinned && !message.isDeleted && <Pin size={12} aria-label="Pinned message" />}
                  </div>

                  {message.replyTo && !message.isDeleted && (
                    <button type="button" className="message-reply-quote" onClick={() => navigateToMessage(message.replyTo!.messageId, message.conversationId)}
                      aria-label={`Go to original message from ${message.replyTo.senderName}`}>
                      <strong>Replying to {message.replyTo.senderName}: </strong>
                      <span>{originalReply?.isDeleted ? 'Original message deleted.' : !originalReply ? 'Original message unavailable.' : message.replyTo.contentSnippet}</span>
                    </button>
                  )}

                  <div className="message-content-row">
                    {editingId === message.id && canEdit ? (
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', width: '100%' }}>
                        <textarea
                          aria-label="Edit message"
                          rows={3}
                          value={editDraft}
                          disabled={savingEdit}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
                              e.preventDefault(); void saveEdit(message.id);
                            } else if (e.key === 'Escape' && !editLock.current) { setEditingId(null); setEditError(''); }
                          }}
                          style={{ flex: 1, minWidth: 0, maxHeight: '14rem', resize: 'vertical', padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(139,92,246,0.5)', background: 'rgba(0,0,0,0.25)', color: 'inherit', font: 'inherit' }}
                          autoFocus
                        />
                        <Button size="sm" variant="primary" aria-label="Save edit" loading={savingEdit} disabled={!editDraft.trim()} onClick={() => void saveEdit(message.id)}>
                          <Check size={14} />
                        </Button>
                        <Button size="sm" variant="outline" aria-label="Cancel edit" disabled={savingEdit} onClick={() => { setEditingId(null); setEditError(''); }}>
                          <X size={14} />
                        </Button>
                        {editError && <span role="alert" style={{ color: 'var(--color-error)', fontSize: '0.75rem' }}>{editError}</span>}
                      </div>
                    ) : (
                      <div className={`msg-bubble-wrap ${hasReactions ? 'msg-bubble-wrap--has-reactions' : ''}`}>
                        {showTextBubble ? (
                          <div className={`message-bubble${isBareEmoji ? ' message-bubble--bare' : ''}`} style={message.isDeleted ? { fontStyle: 'italic', opacity: 0.6 } : undefined}>
                            {(message.forwardedFrom || message.isForwarded) && (
                              <span className="message-forwarded-label">
                                <Forward size={12} aria-hidden="true" /> Forwarded{message.forwardedFrom ? ` from ${message.forwardedFrom}` : ''}
                              </span>
                            )}
                            <span className={isBareEmoji ? 'message-text message-text--emoji' : 'message-text'}>
                              {message.content}
                            </span>
                          </div>
                        ) : (message.forwardedFrom || message.isForwarded) ? (
                          <span className="message-forwarded-label message-forwarded-label--standalone">
                            <Forward size={12} aria-hidden="true" /> Forwarded{message.forwardedFrom ? ` from ${message.forwardedFrom}` : ''}
                          </span>
                        ) : null}

                        {hasAttachments && (
                          <div className="message-attachments">
                            {message.attachments!.map((attachment) => <MessageAttachmentView key={attachment.id} attachment={attachment} ownerId={currentUserId} conversationId={message.conversationId} />)}
                          </div>
                        )}

                        {hasVoice && message.voice && (
                          <VoiceMessageView voice={message.voice} senderName={isOutgoing?currentUserName:message.senderName} ownerId={currentUserId} conversationId={message.conversationId}/>
                        )}

                        {hasReactions && (
                          <div className="rx-summary">
                            {message.reactions!.map((reaction) => {
                              const reactedByMe = reaction.userIds.includes(currentUserId);
                              return (
                                <button
                                  key={reaction.emoji}
                                  type="button"
                                  className="rx-pill"
                                  aria-pressed={reactedByMe}
                                  aria-label={`${reaction.emoji} ${reaction.userIds.length}`}
                                  aria-describedby={`${popoverId}-${message.id}-${encodeURIComponent(reaction.emoji)}-description`}
                                  disabled={!canReact || reactionBusy || reacting}
                                  onClick={(event) => { rememberEmoji(reaction.emoji); void submitReaction(message.id, reaction.emoji, event.currentTarget); }}
                                >
                                  <span>{reaction.emoji}</span>
                                  <span className="sr-only" id={`${popoverId}-${message.id}-${encodeURIComponent(reaction.emoji)}-description`}>
                                    {emojiName(reaction.emoji)}. {reactedByMe ? 'Your reaction; activate to remove it.' : 'Activate to use this reaction.'}
                                  </span>
                                  {reaction.userIds.length > 1 && (
                                    <span className="rx-pill-count">{reaction.userIds.length}</span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        )}

                        {!message.isDeleted && (
                          <div className="msg-toolbar" data-popover data-open={isPickerOpen || isMenuOpen}>
                            {canReact && (
                              <div style={{ position: 'relative' }}>
                                <button
                                  type="button"
                                  className="msg-icon-btn"
                                  title="React"
                                  aria-label="React to message"
                                  disabled={reactionBusy || reacting}
                                  aria-haspopup={isPickerOpen && pickerExpanded ? 'dialog' : 'menu'}
                                  aria-expanded={isPickerOpen}
                                  aria-controls={isPickerOpen ? `${popoverId}-${message.id}-reactions` : undefined}
                                  onClick={(event) => {
                                    popoverTriggerRef.current = event.currentTarget;
                                    setMenuOpenId(null);
                                    setPickerExpanded(false);
                                    setPickerOpenId(isPickerOpen ? null : message.id);
                                  }}
                                >
                                  <SmilePlus size={16} aria-hidden="true" />
                                </button>

                                {isPickerOpen && (
                                  <div id={`${popoverId}-${message.id}-reactions`} ref={popoverRef} onKeyDown={handlePopoverKeyDown} className={`rx-popover ${pickerExpanded ? 'emoji-picker-panel' : 'rx-bar'}`} role={pickerExpanded ? 'dialog' : 'menu'} aria-label="Choose a reaction">
                                    {pickerExpanded ? (
                                      <EmojiPicker reaction selected={myReactions} onSelect={emoji => react(message.id, emoji, false)} onClose={() => closePopovers(true)} />
                                    ) : (
                                      <>
                                        {QUICK_EMOJIS.map((emoji) => (
                                          <button
                                            key={emoji}
                                            type="button"
                                            className="rx-emoji-btn"
                                            role="menuitemcheckbox"
                                            disabled={reactionBusy || reacting}
                                            aria-checked={myReactions.has(emoji)}
                                            aria-label={`React ${emoji}`}
                                            onClick={() => react(message.id, emoji)}
                                            title={`React with ${emojiName(emoji)} ${emoji}`}
                                          >
                                            {emoji}
                                          </button>
                                        ))}
                                        <button
                                          type="button"
                                          className="rx-more-btn"
                                          role="menuitem"
                                          title="More reactions"
                                          aria-label="More reactions"
                                          onClick={() => setPickerExpanded(true)}
                                        >
                                          <Plus size={16} aria-hidden="true" />
                                        </button>
                                      </>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}

                            {onReplyMessage && accepted && (
                              <button type="button" className="msg-icon-btn" title="Reply" aria-label="Reply" onClick={() => onReplyMessage(message)}>
                                <Reply size={16} aria-hidden="true" />
                              </button>
                            )}

                            {canShowMenu && (
                              <div style={{ position: 'relative' }}>
                                <button
                                  type="button"
                                  className="msg-icon-btn"
                                  title="More"
                                  aria-label="More actions"
                                  aria-haspopup="menu"
                                  aria-expanded={isMenuOpen}
                                  aria-controls={isMenuOpen ? `${popoverId}-${message.id}-actions` : undefined}
                                  onClick={(event) => {
                                    popoverTriggerRef.current = event.currentTarget;
                                    setPickerOpenId(null);
                                    setPickerExpanded(false);
                                    setMenuOpenId(isMenuOpen ? null : message.id);
                                  }}
                                >
                                  <MoreHorizontal size={16} aria-hidden="true" />
                                </button>

                                {isMenuOpen && (
                                  <div id={`${popoverId}-${message.id}-actions`} ref={popoverRef} onKeyDown={handlePopoverKeyDown} className="rx-popover msg-menu" role="menu" aria-label="Message actions">
                                    {canShareWithAI && (['chat', 'summarize', 'translate', 'explain'] as const).map(task => (
                                      <button key={task} type="button" role="menuitem" className="msg-menu-item" onClick={() => { onAIMessage?.(task, message.id); closePopovers(); }}>
                                        <Sparkles size={14} aria-hidden="true" />{task === 'chat' ? 'Ask @Secu' : `${task === 'summarize' ? 'Summarize' : task === 'translate' ? 'Translate' : 'Explain'} selected message`}
                                      </button>
                                    ))}
                                    {canForward && (
                                      <button type="button" role="menuitem" className="msg-menu-item" onClick={() => { onForwardMessage?.(message); closePopovers(true); }}>
                                        <Forward size={14} aria-hidden="true" /> Forward
                                      </button>
                                    )}
                                    {canPin && (
                                      <button type="button" role="menuitem" className="msg-menu-item" disabled={pinBusy || pinning} onClick={() => { void changePin(message.id); closePopovers(true); }}>
                                        <Pin size={14} aria-hidden="true" /> {message.isPinned ? 'Unpin' : 'Pin'}
                                      </button>
                                    )}
                                    {canEdit && (
                                      <button
                                        type="button"
                                        role="menuitem"
                                        className="msg-menu-item"
                                        disabled={savingEdit}
                                        onClick={() => { setEditingId(message.id); setEditDraft(message.content); setEditError(''); closePopovers(); }}
                                      >
                                        <Edit2 size={14} aria-hidden="true" /> Edit
                                      </button>
                                    )}
                                    {(canDelete || canUnsend) && (
                                      <button type="button" role="menuitem" className="msg-menu-item" disabled={removing} onClick={() => {
                                        closePopovers();
                                        // Keep a mounted return target for the modal's focus restoration.
                                        popoverTriggerRef.current?.focus({ preventScroll: true });
                                        setUnsendingMessage(message);
                                      }}>
                                        <Trash2 size={14} aria-hidden="true" /> Delete
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {isOutgoing && message.deliveryStatus === 'failed' && (
                      <Button size="sm" variant="outline" disabled={!capabilities.retryMessages || (canRetryMessage ? !canRetryMessage(message.id) : false)} onClick={() => { if (capabilities.retryMessages) onRetryMessage(message.id); }}>
                        {!capabilities.retryMessages || (canRetryMessage && !canRetryMessage(message.id)) ? 'Retry unavailable' : 'Retry'}
                      </Button>
                    )}
                  </div>

                  {(message.encryption || verifiedMessageIds?.has(message.id) || message.demoOnly || isOutgoing) && (
                    <div className="message-status-line">
                      {message.encryption && (
                        <Badge status="success" aria-label="Encrypted in this browser demo">
                          <LockKeyhole size={12} aria-hidden="true" />
                          Encrypted locally
                        </Badge>
                      )}
                      {verifiedMessageIds?.has(message.id) && <Badge status="success" aria-label="End-to-end encrypted message"><LockKeyhole size={12} aria-hidden="true" />Encrypted</Badge>}
                      {message.demoOnly && <Badge status="info">Demo reply</Badge>}
                      {isOutgoing && <span className={`message-delivery message-delivery--${message.deliveryStatus}`}>
                        {deliveryLabel(message.deliveryStatus, transportMode)}
                      </span>}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </Surface>
      {actionFeedback && <p className={actionFeedback.error ? 'composer-error' : 'message-action-feedback'} role={actionFeedback.error ? 'alert' : 'status'}>{actionFeedback.text}</p>}
      {replyNotice && <p className="composer-error" role="status">{replyNotice}</p>}
      {newMessageCount > 0 && (
        <div className="chat-scroll-notice">
          <Button size="sm" variant="secondary" onClick={jumpToLatest} trailingIcon={<ArrowDown size={14} aria-hidden="true" />}>
            {newMessageCount} new {newMessageCount === 1 ? 'message' : 'messages'} — latest
          </Button>
        </div>
      )}
        <UnsendDialog
          message={unsendingMessage}
          canUnsendEveryone={Boolean(onUnsendMessage && unsendingMessage && unsendingMessage.senderId === currentUserId && isAcceptedMessage(unsendingMessage))}
          canDeleteForMe={Boolean(onDeleteMessage)}
          localOnly={transportMode === 'local-demo'}
          onClose={() => setUnsendingMessage(null)}
          onConfirm={scope => unsendingMessage ? remove(unsendingMessage.id, scope) : Promise.resolve(false)}
      />
    </div>
  );
}
