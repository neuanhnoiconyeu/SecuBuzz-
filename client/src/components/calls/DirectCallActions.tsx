import { Phone, Video } from 'lucide-react';
import type { DirectCallKind, DirectCallPeer } from '@/calls/directCallMachine';
import { useDirectCalls } from './DirectCallsRuntime';

/** Shared invitation buttons. Preview callbacks and authenticated targets remain explicit alternatives. */
export function DirectCallActions({ name, target, onPreviewCall, disabled = false }: {
  name: string;
  target?: { conversationId: string; peer: DirectCallPeer };
  onPreviewCall?(kind: DirectCallKind): void;
  disabled?: boolean;
}) {
  const calls = useDirectCalls();
  const start = onPreviewCall ?? (calls && target ? (kind: DirectCallKind) => void calls.start(target.conversationId, target.peer, kind) : undefined);
  const unavailable = disabled || !start || Boolean(!onPreviewCall && calls && !calls.canStart);
  return <div className="direct-call-header-actions" role="group" aria-label="Direct call actions">
    <button type="button" aria-label={`Voice call ${name}`} title={onPreviewCall ? 'Voice call · UI preview' : 'Voice call'} disabled={unavailable}
      onClick={() => start?.('voice')}><Phone size={19} aria-hidden="true" /></button>
    <button type="button" aria-label={`Video call ${name}`} title={onPreviewCall ? 'Video call · UI preview' : 'Video call'} disabled={unavailable}
      onClick={() => start?.('video')}><Video size={20} aria-hidden="true" /></button>
  </div>;
}
