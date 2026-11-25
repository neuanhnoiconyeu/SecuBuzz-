import type { CallSnapshot } from '../../../../shared/directCalls';
import type { ActiveDirectCall } from '../directCallMachine';
import { directCallSummaryLabel, rememberDirectCall, summarizeDirectCall } from '../directCallHistory';

const finished: ActiveDirectCall = { phase: 'ended', reason: 'remote', connectedAt: 21_000, endedAt: 353_000,
  call: { id: 'call-1', conversationId: 'dm-1', kind: 'voice', peer: { id: 'bob', name: 'Bob' }, direction: 'outgoing', source: 'transport', createdAt: 1_000 } };
const wire: CallSnapshot = { callId: 'call-1', conversationId: 'dm-1', kind: 'voice', caller: { userId: 'alice', displayName: 'Alice' },
  recipient: { userId: 'bob', displayName: 'Bob' }, status: 'ended', revision: 3, createdAt: new Date(1000).toISOString(),
  updatedAt: new Date(353000).toISOString(), ringExpiresAt: new Date(31000).toISOString(), acceptedAt: new Date(11000).toISOString(),
  endedAt: new Date(353000).toISOString(), reason: 'ended' };

test.each(['voice', 'video'] as const)('%s summary uses media connection time, never ringing/acceptance time', kind => {
  const summary = summarizeDirectCall({ ...finished, call: { ...finished.call, kind } }, { ...wire, kind })!;
  expect(summary.durationMs).toBe(332000); expect(summary.confirmed).toBe(true);
  expect(directCallSummaryLabel(summary)).toBe(`${kind === 'voice' ? 'Voice' : 'Video'} call · 05:32`);
});
test.each([['declined', 'rejected', 'Rejected'], ['cancelled', 'canceled', 'Canceled'], ['missed', 'missed', 'Missed']] as const)(
  '%s has its own outcome without inventing a duration', (status, outcome, label) => {
    const summary = summarizeDirectCall({ ...finished, connectedAt: null }, { ...wire, status })!;
    expect(summary).toMatchObject({ outcome, durationMs: null, confirmed: true });
    expect(directCallSummaryLabel(summary)).toBe('Voice call · ' + label);
  });
test('accepted calls never observed connected on this device do not manufacture a duration', () => {
  const summary = summarizeDirectCall({ ...finished, connectedAt: null }, wire)!;
  expect(summary.durationMs).toBeNull(); expect(directCallSummaryLabel(summary)).toContain('duration unavailable on this device');
});
test('local cancellation is separate from missed calls and remains unconfirmed until signaling succeeds', () => {
  const summary = summarizeDirectCall({ ...finished, connectedAt: null, reason: 'hangup' }, { ...wire, status: 'ringing', acceptedAt: null, endedAt: null, reason: null })!;
  expect(summary).toMatchObject({ outcome: 'canceled', confirmed: false, durationMs: null });
});
test('server confirmation updates one frozen summary without counting acknowledgement delay', () => {
  const local = summarizeDirectCall(finished, { ...wire, status: 'accepted', endedAt: null, reason: null })!;
  const confirmed = summarizeDirectCall(finished, { ...wire, endedAt: new Date(383000).toISOString() })!;
  const history = rememberDirectCall(rememberDirectCall([], local), confirmed);
  expect(history).toHaveLength(1); expect(history[0]).toMatchObject({ durationMs: 332000, confirmed: true });
  expect(rememberDirectCall(history, confirmed)).toBe(history);
});
test('idle, ringing, connecting, connected and preview states cannot create completed history', () => {
  expect(summarizeDirectCall({ phase: 'idle' }, wire)).toBeNull();
  for (const phase of ['ringing', 'connecting'] as const) expect(summarizeDirectCall({ call: finished.call, phase, connectedAt: null, endedAt: null }, wire)).toBeNull();
  expect(summarizeDirectCall({ call: finished.call, phase: 'connected', connectedAt: 21000, endedAt: null }, wire)).toBeNull();
  expect(summarizeDirectCall({ ...finished, call: { ...finished.call, source: 'preview' } }, wire)).toBeNull();
});
test('revoked access drops the summary, and another call cannot authorize confirmation', () => {
  expect(summarizeDirectCall(finished, { ...wire, reason: 'access_revoked' })).toBeNull();
  expect(summarizeDirectCall(finished, { ...wire, callId: 'other' })?.confirmed).toBe(false);
});
test('session history is bounded and repeated terminal notifications do not duplicate rows', () => {
  let history = [summarizeDirectCall(finished, wire)!];
  for (let i = 0; i < 55; i++) history = [...rememberDirectCall(history, { ...history[0]!, id: 'call-' + i })];
  expect(history).toHaveLength(50); expect(new Set(history.map(call => call.id)).size).toBe(50);
  expect(history[0]?.id).toBe('call-54');
});
