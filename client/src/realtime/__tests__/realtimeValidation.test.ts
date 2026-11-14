import type { OutboundMessage } from '@/messaging/messageModel';
import { DEMO_REALTIME_MESSAGE_TEXT } from '../realtimeModel';
import { isIdentifier, isTimestamp, parseOutboundMessage, parseReadAcknowledgement, parseRealtimeEvent, parseSendAcknowledgement } from '../realtimeValidation';

const timestamp = '2026-11-09T12:00:00.000Z';
const encryption = { version: 1 as const, algorithm: 'AES-256-GCM' as const, encoding: 'base64' as const,
  iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAA=' };
const incoming = { id: 'message-1', conversationId: 'conversation-1', senderId: 'peer-1', senderName: 'Peer',
  timestamp, type: 'text' as const, deliveryStatus: 'delivered' as const, encryption };
const outbound: OutboundMessage = { id: incoming.id, conversationId: incoming.conversationId, senderId: 'actor-1',
  senderName: 'Actor', timestamp, type: 'text', encryption: { ...encryption, scope: 'browser-demo' } };

describe('realtime event validation', () => {
  test('preserves only consistent normalized error codes and never remote error details', () => {
    const unavailable = { type: 'error' as const, code: 'unavailable' as const, serverCode: 'REALTIME_UNAVAILABLE' as const };
    expect(parseRealtimeEvent('error', unavailable, 'realtime')).toEqual(unavailable);
    expect(parseRealtimeEvent('error', { ...unavailable, code: 'authentication_rejected' }, 'realtime')).toBeNull();
    expect(parseRealtimeEvent('error', { ...unavailable, serverCode: 'UNKNOWN' }, 'realtime')).toBeNull();
    expect(parseRealtimeEvent('error', { ...unavailable, details: 'secret' }, 'realtime')).toBeNull();
  });
  test('projects exact encrypted incoming envelopes without decrypting or mutating source metadata', () => {
    const result = parseRealtimeEvent('message', { message: incoming }, 'realtime');
    expect(result).toEqual({ type: 'message', message: incoming });
    expect(parseRealtimeEvent('message', incoming, 'realtime')).toEqual(result);
    expect(result).not.toBe(incoming);
    if (result?.type === 'message' && 'encryption' in result.message) {
      result.message.encryption.iv = 'changed';
      expect(encryption.iv).toBe('AAAAAAAAAAAAAAAA');
    }
  });

  test.each([
    { ...incoming, content: 'unverified plaintext' }, { ...incoming, demoOnly: true },
    { ...incoming, token: 'private' }, { ...incoming, replyTo: { contentSnippet: 'unverified' } },
    { ...incoming, encryption: { ...encryption, scope: 'browser-demo' } },
    { ...incoming, encryption: { ...encryption, key: 'not-allowed' } },
    { ...incoming, encryption: { ...encryption, version: 2 } },
    { ...incoming, encryption: { ...encryption, algorithm: 'AES-CBC' } },
    { ...incoming, encryption: { ...encryption, encoding: 'hex' } },
    { ...incoming, encryption: { ...encryption, iv: 'AAAA' } },
    { ...incoming, encryption: { ...encryption, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==' } },
    { ...incoming, encryption: { ...encryption, ciphertext: 'invalid-base64' } },
    { ...incoming, senderName: 'x'.repeat(161) }, { ...incoming, deliveryStatus: 'sending' },
    { ...incoming, timestamp: 'invalid-date' }, { ...incoming, timestamp: '2026-02-30T12:00:00.000Z' },
    { ...incoming, conversationId: 'invalid conversation' }, { ...incoming, type: 'voice' },
  ])('rejects unsafe or malformed remote messages %#', (payload) => {
    expect(parseRealtimeEvent('message', payload, 'realtime')).toBeNull();
  });

  test('plaintext fixtures require explicit local mode, demoOnly and one of the fixed demo texts', () => {
    const demo = { ...incoming, encryption: undefined, demoOnly: true, content: DEMO_REALTIME_MESSAGE_TEXT.bot };
    Reflect.deleteProperty(demo, 'encryption');
    expect(parseRealtimeEvent('message', demo, 'realtime')).toBeNull();
    expect(parseRealtimeEvent('message', demo, 'local-demo')).toEqual({ type: 'message', message: demo });
    expect(parseRealtimeEvent('message', { ...demo, demoOnly: false }, 'local-demo')).toBeNull();
    expect(parseRealtimeEvent('message', { ...demo, content: 'arbitrary local plaintext' }, 'local-demo')).toBeNull();
    expect(parseRealtimeEvent('message', { ...demo, attachments: [] }, 'local-demo')).toBeNull();
  });

  test('receipt, typing, presence and conversation metadata use bounded allowlisted projections', () => {
    const receipt = { conversationId: 'conversation-1', messageId: 'message-1', status: 'read' as const, userId: 'peer-1', timestamp };
    const typing = { conversationId: 'conversation-1', userId: 'peer-1', displayName: 'Peer', isTyping: true, timestamp };
    const presence = { userId: 'peer-1', status: 'unknown' as const, timestamp };
    const conversation = { conversationId: 'conversation-1', displayName: 'Updated name', updatedAt: timestamp };
    expect(parseRealtimeEvent('receipt', receipt, 'realtime')).toEqual({ type: 'receipt', ...receipt });
    expect(parseRealtimeEvent('typing', typing, 'realtime')).toEqual({ type: 'typing', ...typing });
    expect(parseRealtimeEvent('presence', presence, 'realtime')).toEqual({ type: 'presence', ...presence });
    expect(parseRealtimeEvent('conversation', conversation, 'realtime')).toEqual({ type: 'conversation', ...conversation });
    expect(parseRealtimeEvent('receipt', { ...receipt, status: 'failed' }, 'realtime')).toBeNull();
    expect(parseRealtimeEvent('typing', { ...typing, isTyping: 'true' }, 'realtime')).toBeNull();
    expect(parseRealtimeEvent('typing', { ...typing, password: 'private' }, 'realtime')).toBeNull();
    expect(parseRealtimeEvent('presence', { ...presence, status: 'invisible' }, 'realtime')).toBeNull();
    expect(parseRealtimeEvent('conversation', { ...conversation, members: ['unverified'] }, 'realtime')).toBeNull();
    expect(parseRealtimeEvent('conversation', { ...conversation, displayName: 'x'.repeat(161) }, 'realtime')).toBeNull();
  });

  test('validates connection/error discriminators without accepting remote diagnostic details', () => {
    expect(parseRealtimeEvent('connection', { status: 'reconnecting' }, 'realtime')).toEqual({ type: 'connection', status: 'reconnecting' });
    expect(parseRealtimeEvent('connection', { status: 'ready' }, 'realtime')).toBeNull();
    expect(parseRealtimeEvent('error', { code: 'authentication_rejected' }, 'realtime')).toEqual({ type: 'error', code: 'authentication_rejected' });
    expect(parseRealtimeEvent('error', { code: 'authentication_rejected', message: 'private diagnostics' }, 'realtime')).toBeNull();
    expect(parseRealtimeEvent('error', { code: 'unknown-server-code' }, 'realtime')).toBeNull();
    expect(parseRealtimeEvent('presence', { type: 'typing', userId: 'peer-1', status: 'online', timestamp }, 'realtime')).toBeNull();
  });

  test.each([null, undefined, [], 'text', 42, new Date()])('rejects non-payload inputs %#', (input) => {
    for (const kind of ['message', 'receipt', 'typing', 'presence', 'conversation', 'connection', 'error'] as const) {
      expect(parseRealtimeEvent(kind, input, 'realtime')).toBeNull();
    }
  });

  test('enforces canonical base64 and a bounded envelope without nested regex expansion', () => {
    expect(parseRealtimeEvent('message', { ...incoming, encryption: { ...encryption, ciphertext: 'AB==' } }, 'realtime')).toBeNull();
    expect(parseRealtimeEvent('message', { ...incoming, encryption: { ...encryption, ciphertext: 'A'.repeat(1_400_004) } }, 'realtime')).toBeNull();
    const large = btoa('x'.repeat(200_000));
    expect(parseRealtimeEvent('message', { ...incoming, encryption: { ...encryption, ciphertext: large } }, 'realtime')).not.toBeNull();
  });

  test('only accepts a strictly projected browser-demo outbound envelope and never plaintext', () => {
    expect(parseOutboundMessage(outbound)).toEqual(outbound);
    expect(parseOutboundMessage({ ...outbound, content: 'private' })).toBeNull();
    expect(parseOutboundMessage({ ...outbound, encryption: { ...outbound.encryption, key: 'private' } })).toBeNull();
    expect(parseOutboundMessage({ ...outbound, encryption })).toBeNull();
  });

  test('acknowledgements distinguish send/read and reject mismatched IDs, diagnostics or invalid timestamps', () => {
    const send = { conversationId: 'conversation-1', messageId: 'message-1', status: 'sent', timestamp };
    expect(parseSendAcknowledgement(send)).toEqual(send);
    expect(parseSendAcknowledgement({ ...send, status: 'delivered' })).toBeNull();
    expect(parseSendAcknowledgement({ ...send, token: 'private' })).toBeNull();
    expect(parseSendAcknowledgement({ ...send, timestamp: 'bad-date' })).toBeNull();
    const read = { ...send, status: 'read', userId: 'actor-1' };
    expect(parseReadAcknowledgement(read, 'conversation-1', 'message-1')).toBe(true);
    expect(parseReadAcknowledgement(read, 'another', 'message-1')).toBe(false);
    expect(parseReadAcknowledgement(read, 'conversation-1', 'another')).toBe(false);
    expect(parseReadAcknowledgement({ ...read, token: 'private' }, 'conversation-1', 'message-1')).toBe(false);
    expect(parseReadAcknowledgement(send, 'conversation-1', 'message-1')).toBe(false);
  });

  test('identifier and timestamp boundaries preserve supported wire values without accepting control characters', () => {
    expect(isIdentifier('conversation-1')).toBe(true);
    expect(isIdentifier('x'.repeat(257))).toBe(false);
    expect(isIdentifier('private\nvalue')).toBe(false);
    expect(isTimestamp(timestamp)).toBe(true);
    expect(isTimestamp('2024-02-29T12:00:00Z')).toBe(true);
    expect(isTimestamp('2026-02-29T12:00:00Z')).toBe(false);
    expect(isTimestamp('2026-11-09T24:00:00Z')).toBe(false);
  });
});
