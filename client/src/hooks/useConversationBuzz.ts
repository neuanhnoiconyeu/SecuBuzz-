import { useCallback, useEffect, useRef, useState } from 'react';
import { BUZZ_COOLDOWN_MS, BUZZ_EFFECT_MS, type BuzzEvent } from '../../../shared/buzz';
import { SocketFailure } from '@/realtime/authenticatedProtocol';

/** Ephemeral Buzz feedback; incoming callbacks never touch message/key storage. */
export function useConversationBuzz(incoming: BuzzEvent | undefined, active: boolean,
  send: ((cid: string) => Promise<BuzzEvent>) | undefined, receiveWhileInactive = false, onIncoming?: (event: BuzzEvent) => void) {
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [effectConversation, setEffectConversation] = useState<string | null>(null);
  const seen = useRef(new Set(incoming ? [incoming.id] : [])), locked = useRef(false), mounted = useRef(false);
  const effectTimer = useRef<ReturnType<typeof setTimeout>>(), cooldown = useRef<ReturnType<typeof setTimeout>>();
  const incomingCallback = useRef(onIncoming); incomingCallback.current = onIncoming;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(effectTimer.current); clearTimeout(cooldown.current); };
  }, []);
  const show = useCallback((cid: string, text: string) => {
    setNotice(text); setEffectConversation(cid); clearTimeout(effectTimer.current);
    effectTimer.current = setTimeout(() => setEffectConversation(null), BUZZ_EFFECT_MS);
  }, []);
  useEffect(() => {
    if (!incoming || seen.current.has(incoming.id)) return;
    seen.current.add(incoming.id);
    if (seen.current.size > 100) seen.current.delete(seen.current.values().next().value!);
    if (active || receiveWhileInactive) { incomingCallback.current?.(incoming); show(incoming.conversationId, `${incoming.displayName} sent you a BUZZ!`); }
  }, [incoming, active, receiveWhileInactive, show]);
  const dismiss = useCallback(() => setNotice(''), []);
  const sendBuzz = useCallback(async (cid: string) => {
    if (!send || locked.current || !active) return;
    locked.current = true; setBusy(true); setNotice('');
    // Keep the same window for failed/unconfirmed sends; the server also reserves it before I/O.
    cooldown.current = setTimeout(() => { locked.current = false; if (mounted.current) setBusy(false); }, BUZZ_COOLDOWN_MS);
    try { await send(cid); if (mounted.current) show(cid, 'BUZZ! sent.'); }
    catch (error) { if (mounted.current) setNotice(error instanceof SocketFailure && error.code === 'rate_limited'
      ? 'Please wait before sending another BUZZ.' : 'Could not send BUZZ. Your contact may be offline. Check the connection and try again shortly.'); }
  }, [send, active, show]);
  return { notice, busy, effectConversation, sendBuzz, dismiss };
}
