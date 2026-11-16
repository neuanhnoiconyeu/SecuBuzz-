import { directCallReducer as reduce, formatCallDuration, idleDirectCall, type DirectCallSession, type DirectCallState } from '../directCallMachine';

const call: DirectCallSession = { id: 'call-1', conversationId: 'dm-1', peer: { id: 'peer', name: 'Ava Morgan' }, kind: 'voice',
  direction: 'outgoing', source: 'transport', createdAt: 1000 };
const begin = (changes: Partial<DirectCallSession> = {}) => reduce(idleDirectCall, { type: 'START', call: { ...call, ...changes } });
const signal = (state: DirectCallState, value: 'accepted' | 'media-connected' | 'declined' | 'ended', at = 2000) =>
  reduce(state, { type: 'TRANSPORT', callId: call.id, signal: value, at });

test('outgoing ringing requires acceptance then a media confirmation before it can connect', () => {
  const ringing = begin();
  expect(ringing.phase).toBe('ringing');
  expect(signal(ringing, 'media-connected')).toBe(ringing);
  expect(reduce(ringing, { type: 'ACCEPT', callId: call.id, at: 2000 })).toBe(ringing);
  const connecting = signal(ringing, 'accepted');
  expect(connecting.phase).toBe('connecting'); expect(connecting).toMatchObject({ connectedAt: null });
  const connected = signal(connecting, 'media-connected', 4000);
  expect(connected).toMatchObject({ phase: 'connected', connectedAt: 4000 });
  expect(signal(connected, 'media-connected', 6000)).toBe(connected);
  expect(signal(connected, 'ended', 9000)).toMatchObject({ phase: 'ended', connectedAt: 4000, endedAt: 9000 });
});

test('incoming acceptance only starts connecting; declining is valid only while ringing', () => {
  const ringing = begin({ direction: 'incoming' });
  expect(signal(ringing, 'accepted')).toBe(ringing);
  expect(reduce(ringing, { type: 'DECLINE', callId: call.id, at: 2000 })).toMatchObject({ phase: 'declined', reason: 'declined', connectedAt: null });
  const connecting = reduce(ringing, { type: 'ACCEPT', callId: call.id, at: 2000 });
  expect(connecting.phase).toBe('connecting');
  expect(reduce(connecting, { type: 'DECLINE', callId: call.id, at: 2001 })).toBe(connecting);
  expect(signal(connecting, 'media-connected', 3000).phase).toBe('connected');
});

test('preview sessions cannot be accepted or connected by transport events', () => {
  const outgoing = begin({ source: 'preview' });
  expect(signal(outgoing, 'accepted')).toBe(outgoing); expect(signal(outgoing, 'media-connected')).toBe(outgoing);
  const incoming = begin({ source: 'preview', direction: 'incoming' });
  const connecting = reduce(incoming, { type: 'ACCEPT', callId: call.id, at: 2000 });
  expect(connecting.phase).toBe('connecting'); expect(signal(connecting, 'media-connected')).toBe(connecting);
});

test('timeouts distinguish missed ringing from unavailable connections and ignore an earlier phase timer', () => {
  const ringing = begin();
  expect(reduce(ringing, { type: 'EXPIRE', callId: call.id, phase: 'ringing', at: 31000 })).toMatchObject({ phase: 'missed', connectedAt: null });
  const connecting = signal(ringing, 'accepted');
  expect(reduce(connecting, { type: 'EXPIRE', callId: call.id, phase: 'ringing', at: 31000 })).toBe(connecting);
  expect(reduce(connecting, { type: 'EXPIRE', callId: call.id, phase: 'connecting', at: 31000 })).toMatchObject({ phase: 'ended', reason: 'unavailable' });
});

test('remote decline, hangup and terminal states reject stale events and duplicate calls', () => {
  const ringing = begin(); const declined = signal(ringing, 'declined');
  expect(declined.phase).toBe('declined'); expect(signal(declined, 'accepted')).toBe(declined);
  expect(reduce(ringing, { type: 'START', call: { ...call, id: 'other' } })).toBe(ringing);
  expect(reduce(ringing, { type: 'DISMISS', callId: call.id })).toBe(ringing);
  expect(reduce(ringing, { type: 'HANG_UP', callId: 'old-call', at: 2000 })).toBe(ringing);
  const ended = reduce(ringing, { type: 'HANG_UP', callId: call.id, at: 2000 });
  expect(ended).toMatchObject({ phase: 'ended', reason: 'hangup' });
  expect(signal(ended, 'media-connected')).toBe(ended);
  expect(reduce(ended, { type: 'DISMISS', callId: call.id })).toBe(idleDirectCall);
  expect(reduce(declined, { type: 'RESET' })).toBe(idleDirectCall);
});

test('invalid timestamps and delayed pre-connection events cannot change a connected call', () => {
  const connected = signal(signal(begin(), 'accepted'), 'media-connected', 5000);
  expect(signal(connected, 'ended', 4000)).toBe(connected);
  expect(signal(connected, 'ended', Number.NaN)).toBe(connected);
});

test.each([[0, '00:00'], [65000, '01:05'], [3661000, '1:01:01'], [-1000, '00:00']])('formats elapsed time %i as %s', (ms, label) => {
  expect(formatCallDuration(ms as number)).toBe(label);
});
