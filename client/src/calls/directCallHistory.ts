import type { CallSnapshot } from '../../../shared/directCalls';
import { formatCallDuration, type DirectCallKind, type DirectCallState } from './directCallMachine';

/** Observations owned by this workspace session; never a message or durable call record. */
export interface DirectCallSummary {
  id: string;
  conversationId: string;
  kind: DirectCallKind;
  endedAt: number;
  durationMs: number | null;
  outcome: 'completed' | 'missed' | 'rejected' | 'canceled' | 'ended';
  confirmed: boolean;
}

export function summarizeDirectCall(state: DirectCallState, snapshot: CallSnapshot | null): DirectCallSummary | null {
  if (state.phase !== 'ended' && state.phase !== 'missed' && state.phase !== 'declined') return null;
  if (state.call.source !== 'transport') return null;
  const wire = snapshot?.callId === state.call.id && snapshot.conversationId === state.call.conversationId ? snapshot : null;
  if (wire?.reason === 'access_revoked') return null;
  const outcome = wire?.status === 'declined' || state.phase === 'declined' ? 'rejected'
    : wire?.status === 'cancelled' ? 'canceled'
      : wire?.status === 'missed' || state.phase === 'missed' ? 'missed'
        : state.connectedAt !== null ? 'completed'
          : wire?.status === 'ringing' && state.call.direction === 'outgoing' && state.reason === 'hangup' ? 'canceled' : 'ended';
  return { id: state.call.id, conversationId: state.call.conversationId, kind: state.call.kind, endedAt: state.endedAt,
    // acceptedAt includes media setup time. Only the existing media-confirmed UI clock is usable.
    durationMs: state.connectedAt === null ? null : Math.max(0, state.endedAt - state.connectedAt), outcome,
    confirmed: Boolean(wire && wire.status !== 'ringing' && wire.status !== 'accepted') };
}

export function rememberDirectCall(history: readonly DirectCallSummary[], summary: DirectCallSummary): readonly DirectCallSummary[] {
  const previous = history.find(call => call.id === summary.id);
  if (previous && JSON.stringify(previous) === JSON.stringify(summary)) return history;
  return [summary, ...history.filter(call => call.id !== summary.id)].slice(0, 50);
}

export function directCallSummaryLabel(call: DirectCallSummary): string {
  const kind = call.kind === 'video' ? 'Video call' : 'Voice call';
  const detail = call.outcome === 'completed' && call.durationMs !== null ? formatCallDuration(call.durationMs)
    : call.outcome === 'missed' ? 'Missed' : call.outcome === 'rejected' ? 'Rejected' : call.outcome === 'canceled' ? 'Canceled'
      : 'Ended · duration unavailable on this device';
  return `${kind} · ${detail}`;
}
