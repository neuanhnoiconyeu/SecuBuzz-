import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui';
import type { Conversation } from '@/conversations/conversationModel';
import type { MockRealtimeClient } from '@/realtime/MockRealtimeClient';
import type { RealtimeConnectionStatus, RealtimePresenceStatus } from '@/realtime/realtimeModel';

export function RealtimeDemoControls({ client, conversations, activeConversationId, status }: {
  client: MockRealtimeClient; conversations: readonly Conversation[]; activeConversationId: string | null; status: RealtimeConnectionStatus;
}) {
  const [target, setTarget] = useState(activeConversationId ?? conversations[0]?.id ?? '');
  const [notice, setNotice] = useState('');
  const [presenceIndex, setPresenceIndex] = useState(0);
  const selectId = useId();
  useEffect(() => { if (activeConversationId) setTarget(activeConversationId); }, [activeConversationId]);
  if (process.env.NODE_ENV === 'production') return null;
  const run = (operation: () => void | Promise<void>, message: string) => {
    try { void Promise.resolve(operation()).then(() => setNotice(message), () => setNotice('The demo action is unavailable. Reconnect and try again.')); }
    catch { setNotice('The demo action is unavailable. Reconnect and try again.'); }
  };
  const connected = status === 'connected';
  const presenceStates: RealtimePresenceStatus[] = ['away', 'offline', 'online', 'unknown'];
  return <details className="realtime-demo-controls">
    <summary>Realtime demo controls</summary>
    <div className="realtime-demo-panel">
      <p>Fictional activity in this page only. No remote users, server delivery, or real presence.</p>
      <label htmlFor={selectId}>Demo conversation</label>
      <select id={selectId} className="ui-input" value={target} onChange={(event) => setTarget(event.target.value)}>
        {conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.displayName}</option>)}
      </select>
      <div className="realtime-demo-actions">
        <Button size="sm" variant="outline" disabled={!connected || !target} onClick={() => run(() => client.simulateIncoming(target), 'Incoming message simulated.')}>Simulate incoming</Button>
        <Button size="sm" variant="outline" disabled={!connected || !target} onClick={() => run(() => client.simulateTyping(target), 'Typing simulated.')}>Simulate typing</Button>
        <Button size="sm" variant="outline" disabled={!connected} onClick={() => {
          const next = presenceStates[presenceIndex % presenceStates.length]!;
          run(() => client.simulatePresence('demo-ava', next), `Ava presence simulated: ${next}.`);
          setPresenceIndex((index) => index + 1);
        }}>Simulate presence</Button>
        <Button size="sm" variant="outline" disabled={!connected} onClick={() => run(() => client.failNextSend(), 'The next send will fail locally before acknowledgement.')}>Fail next send</Button>
        <Button size="sm" variant="outline" disabled={!connected} onClick={() => run(() => client.simulateNetworkFailure(), 'Demo connection interrupted.')}>Go offline</Button>
        <Button size="sm" disabled={connected || status === 'connecting' || status === 'reconnecting'} onClick={() => run(() => client.simulateReconnect(), 'Demo connection restored.')}>Reconnect</Button>
      </div>
      <p role="status" aria-live="polite" className="realtime-demo-notice">{notice}</p>
    </div>
  </details>;
}
