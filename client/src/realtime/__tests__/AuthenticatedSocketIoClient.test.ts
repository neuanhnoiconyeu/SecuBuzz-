import { AuthenticatedSocketIoClient } from '../AuthenticatedSocketIoClient';
import { ACK_CODES, keysChanged, messageDeleted } from '../authenticatedProtocol';
import type { SessionApi } from '@/api/sessionApi';
import { ack, conversation, envelope, FakeSocket, flush, handlers, proof } from '../testing/authenticatedFixtures';
import { CallTestBroker, alice } from '@/test-support/directCallFixture';
import type {CallClientEventName} from '../../../../shared/directCalls';

test('calling shares the encrypted message socket and verifies participant snapshots',async()=>{
  const h=setup(),listener=jest.fn(),status=jest.fn();h.client.calls.subscribe(listener);h.client.subscribe(status);
  h.client.start();await flush();const socket=h.sockets[0]!;
  Object.assign(socket,{id:'owned-socket'});
  expect(h.client.actorId).toBe('alice');expect(h.client.calls.getConnectionId()).toBe('owned-socket');
  const pending=h.client.calls.request('call:sync',{});
  const emitted=socket.emit.mock.calls[0]!;expect(emitted.slice(0,2)).toEqual(['call:sync',{}]);emitted[2]!({status:'ok',calls:[]});
  await expect(pending).resolves.toEqual({status:'ok',calls:[]});expect(h.factory).toHaveBeenCalledTimes(1);
  const broker=new CallTestBroker();await broker.request(alice.id,'call:initiate',{kind:'voice'});
  socket.fire('call:state',{...broker.call,caller:{userId:'outside',displayName:'Outsider'},recipient:{userId:'other',displayName:'Other'}});
  socket.fire('call:state',{...broker.call,revision:0});expect(listener).not.toHaveBeenCalled();
  socket.fire('call:state',broker.call);expect(listener).toHaveBeenCalledWith('state',broker.call);
  expect(status).toHaveBeenCalledWith({type:'connection',status:'connected'});
  await expect(h.client.calls.request('message:send' as CallClientEventName,{})).rejects.toMatchObject({code:'unavailable'});
  h.client.dispose();socket.fire('call:state',broker.call);expect(listener).toHaveBeenCalledTimes(1);expect(h.client.calls.getConnectionId()).toBeNull();
});

test('call operations cancel on reconnect and late acknowledgements cannot cross socket generations',async()=>{
  const h=setup();h.client.start();await flush();Object.assign(h.sockets[0]!,{id:'old'});
  const pending=h.client.calls.request('call:sync',{}),cancelled=expect(pending).rejects.toMatchObject({code:'unavailable'});
  const oldAck=h.sockets[0]!.emit.mock.calls[0]![2]!;h.sockets[0]!.drop();await cancelled;
  expect(h.client.calls.getConnectionId()).toBeNull();jest.advanceTimersByTime(1000);await flush();
  Object.assign(h.sockets[1]!,{id:'new'});oldAck({status:'ok',calls:[]});expect(h.client.calls.getConnectionId()).toBe('new');h.client.dispose();
});

test('pin hints require an exact payload and authorized scope and stop after disposal', async () => {
  const h = setup(), pins = jest.fn(); h.events.pins = pins;
  h.client.start(); await flush();
  h.sockets[0]!.fire('conversation:pins-changed', { conversationId: conversation.id, pinnedBy: 'spoofed' });
  h.sockets[0]!.fire('conversation:pins-changed', { conversationId: 'other' });
  expect(pins).not.toHaveBeenCalled();
  h.sockets[0]!.fire('conversation:pins-changed', { conversationId: conversation.id });
  expect(pins).toHaveBeenCalledTimes(1); h.client.dispose();
  h.sockets[0]!.fire('conversation:pins-changed', { conversationId: conversation.id }); expect(pins).toHaveBeenCalledTimes(1);
});

test('reaction hints are scoped and cannot carry client permissions or reaction state',async()=>{
  const h=setup(),reactions=jest.fn();h.events.reactions=reactions;h.client.start();await flush();
  h.sockets[0]!.fire('message:reactions-changed',{conversationId:conversation.id,messageId:envelope.id,emoji:'👍'});
  h.sockets[0]!.fire('message:reactions-changed',{conversationId:'other',messageId:envelope.id});expect(reactions).not.toHaveBeenCalled();
  h.sockets[0]!.fire('message:reactions-changed',{conversationId:conversation.id,messageId:envelope.id});expect(reactions).toHaveBeenCalledTimes(1);h.client.dispose();
});

function setup(auto = true) {
  const api: SessionApi = { actor: { id: 'alice', username: 'alice' }, request: jest.fn(), realtimeAuth: jest.fn().mockResolvedValue(proof), invalidateSession: jest.fn(), dispose: jest.fn() };
  const events = handlers(), sockets: FakeSocket[] = [];
  const factory = jest.fn((_url, options) => { const socket = new FakeSocket(options, auto); sockets.push(socket); return socket; });
  const client = new AuthenticatedSocketIoClient(api, events, 'http://localhost:4177', factory);
  client.setScopes([conversation]); return { client, api, events, sockets, factory };
}
test('Buzz uses the existing session socket, exact conversation-only request and actor-bound acknowledgement', async () => {
  const h = setup(); h.client.start(); await flush();
  const received = jest.fn(); h.events.buzz = received;
  const value = { id: 'buzz-1', conversationId: conversation.id, userId: 'alice', displayName: 'Alice', timestamp: new Date().toISOString() };
  const pending = h.client.buzz(conversation.id), emitted = h.sockets[0]!.emit.mock.calls.at(-1)!;
  expect(emitted.slice(0, 2)).toEqual(['buzz:send', { conversationId: conversation.id }]); emitted[2]!(value);
  await expect(pending).resolves.toEqual(value); expect(h.factory).toHaveBeenCalledTimes(1);
  await expect(h.client.buzz('outside')).rejects.toMatchObject({ code: 'unauthorized_conversation' });
  const peer = { ...value, userId: 'bob', displayName: 'Bob' };
  for (const invalid of [{ ...peer, content: 'forged' }, { ...peer, conversationId: 'outside' }, { ...peer, userId: 'outsider' }, value,
    { ...peer, timestamp: new Date(Date.now() - 60000).toISOString() }]) h.sockets[0]!.fire('buzz:received', invalid);
  expect(received).not.toHaveBeenCalled();
  h.sockets[0]!.fire('buzz:received', peer); h.sockets[0]!.fire('buzz:received', peer);
  expect(received).toHaveBeenCalledTimes(1); h.client.dispose();
  h.sockets[0]!.fire('buzz:received', { ...peer, id: 'buzz-2' }); expect(received).toHaveBeenCalledTimes(1);
  await expect(h.client.buzz(conversation.id)).rejects.toBeInstanceOf(Error);
});

test('Buzz failures, forged acknowledgements and disconnect never report success or buffer a retry', async () => {
  const h = setup(); h.client.start(); await flush(); const socket = h.sockets[0]!;
  const failed = h.client.buzz(conversation.id), rejected = expect(failed).rejects.toMatchObject({ code: 'unavailable' });
  socket.emit.mock.calls.at(-1)![2]!({ id: 'buzz-1', conversationId: conversation.id, userId: 'bob', displayName: 'Bob', timestamp: new Date().toISOString() }); await rejected;
  const pending = h.client.buzz(conversation.id), canceled = expect(pending).rejects.toMatchObject({ code: 'unavailable' });
  socket.drop(); await canceled; expect(socket.emit).toHaveBeenCalledTimes(2); h.client.dispose();
});
test('edit hints are identifier-only, scope checked and ignored after disposal',async()=>{
 const h=setup(),edited=jest.fn();Object.assign(h.events,{edited});h.client.start();await flush();const socket=h.sockets[0]!;
 socket.fire('message:edited',{conversationId:conversation.id,messageId:envelope.id,content:'forged'});
 socket.fire('message:edited',{conversationId:'outside',messageId:envelope.id});expect(edited).not.toHaveBeenCalled();
 socket.fire('message:edited',{conversationId:conversation.id,messageId:envelope.id});expect(edited).toHaveBeenCalledWith({conversationId:conversation.id,messageId:envelope.id});
 h.client.dispose();socket.fire('message:edited',{conversationId:conversation.id,messageId:envelope.id});expect(edited).toHaveBeenCalledTimes(1);
});
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('cookie handshake uses fresh scoped CSRF, exact auth, no identity/query and no offline message buffer', async () => {
  const h = setup(); h.client.start(); await flush();
  expect(h.factory).toHaveBeenCalledWith('http://localhost:4177', expect.objectContaining({ auth: proof, withCredentials: true, reconnection: false, retries: 0, autoConnect: false }));
  expect(Object.keys(h.sockets[0]!.options.auth)).toEqual(['csrfToken']);
  expect(h.sockets[0]!.options).not.toHaveProperty('query'); expect(h.client.connected).toBe(true); h.client.dispose();
});

test('server deletion hints are strict, scope checked, and discarded after disposal', async () => {
  const h = setup(), deleted = jest.fn(); h.events.deleted = deleted;
  h.client.start(); await flush();
  const hint = { conversationId: conversation.id, messageId: envelope.id };
  expect(messageDeleted(hint)).toEqual(hint);
  for (const value of [{ ...hint, content: 'untrusted' }, { ...hint, conversationId: 'outside-scope' }, { ...hint, messageId: '' }]) h.sockets[0]!.fire('message:deleted', value);
  expect(deleted).not.toHaveBeenCalled();
  h.sockets[0]!.fire('message:deleted', hint); expect(deleted).toHaveBeenCalledWith(hint);
  h.client.dispose(); h.sockets[0]!.fire('message:deleted', hint); expect(deleted).toHaveBeenCalledTimes(1);
});
test('missing CSRF fails closed without creating a socket', async () => {
  const h = setup(); (h.api.realtimeAuth as jest.Mock).mockResolvedValue({}); h.client.start(); await flush();
  expect(h.factory).not.toHaveBeenCalled(); expect(h.api.invalidateSession).toHaveBeenCalledTimes(1); h.client.dispose();
});
test.each(['AUTH_REQUIRED', 'SESSION_EXPIRED'])('%s invalidates session and does not reconnect', async code => {
  const h = setup(false); h.client.start(); await flush(); h.sockets[0]!.fire('connect_error', { data: { code } });
  jest.advanceTimersByTime(120000); await flush(); expect(h.factory).toHaveBeenCalledTimes(1); expect(h.api.invalidateSession).toHaveBeenCalledTimes(1); h.client.dispose();
});
test('UNAUTHORIZED refreshes CSRF once, then invalidates; arbitrary server messages stay private', async () => {
  const h = setup(false); h.client.start(); await flush(); h.sockets[0]!.fire('connect_error', { message: 'private diagnostics', data: { code: 'UNAUTHORIZED' } });
  jest.advanceTimersByTime(1000); await flush(); expect(h.api.realtimeAuth).toHaveBeenCalledTimes(2);
  h.sockets[1]!.fire('connect_error', { data: { code: 'UNAUTHORIZED' } }); expect(h.api.invalidateSession).toHaveBeenCalledTimes(1); h.client.dispose();
});
test('logout/disposal discards late CSRF and old-account events', async () => {
  const h = setup(); let resolve!: (value: unknown) => void; (h.api.realtimeAuth as jest.Mock).mockImplementation(() => new Promise(done => { resolve = done; }));
  h.client.start(); h.client.dispose(); resolve(proof); await flush(); expect(h.factory).not.toHaveBeenCalled();
});
test('account replacement has separate managers, scopes and event listeners', async () => {
  const old = setup(); old.client.start(); await flush(); old.client.dispose();
  const next = setup(); next.client.start(); await flush(); old.sockets[0]!.fire('message:new', { ...envelope, deliveryStatus: 'sent' });
  expect(next.events.message).not.toHaveBeenCalled(); expect(old.events.message).not.toHaveBeenCalled(); next.client.dispose();
});
test('reconnect refreshes proof and does not reuse an old manager', async () => {
  const h = setup(); h.client.start(); await flush(); (h.api.realtimeAuth as jest.Mock).mockResolvedValue({ csrfToken: 'B'.repeat(43) });
  h.sockets[0]!.drop(); jest.advanceTimersByTime(1000); await flush();
  expect(h.sockets[1]!.options.auth).toEqual({ csrfToken: 'B'.repeat(43) }); expect(h.sockets[0]!.disconnect).toHaveBeenCalled(); h.client.dispose();
});
test('infrastructure reconnect attempts are bounded', async () => {
  const h = setup(false); h.client.start(); await flush();
  for (let i = 0; i < 6; i++) { h.sockets[i]!.fire('connect_error', { data: { code: 'REALTIME_UNAVAILABLE' } }); jest.advanceTimersByTime(16000); await flush(); }
  expect(h.factory).toHaveBeenCalledTimes(6); expect(h.client.state).toBe('offline'); h.client.dispose();
});
test('v2 send awaits exact persistence ack and transmits only encrypted bytes', async () => {
  const h = setup(); h.client.start(); await flush(); const pending = h.client.send(envelope);
  const call = h.sockets[0]!.emit.mock.calls[0]!; expect(call[0]).toBe('message:send'); expect(call[1]).toEqual(envelope); expect(call[1]).not.toHaveProperty('text');
  call[2]!(ack); await expect(pending).resolves.toEqual(ack); h.client.dispose();
});
test('idempotent retry and duplicate ack retain the same ID, IV and ciphertext', async () => {
  const h = setup(); h.client.start(); await flush();
  for (let i = 0; i < 2; i++) { const operation = h.client.send(envelope); h.sockets[0]!.emit.mock.calls[i]![2]!(ack); h.sockets[0]!.emit.mock.calls[i]![2]!(ack); await operation; }
  expect(h.sockets[0]!.emit.mock.calls.map(c => c[1])).toEqual([envelope, envelope]); h.client.dispose();
});
test.each(ACK_CODES)('classifies server refusal %s without changing ciphertext', async code => {
  const h = setup(); h.client.start(); await flush(); const operation = h.client.send(envelope); h.sockets[0]!.emit.mock.calls[0]![2]!({ status: 'error', code });
  await expect(operation).rejects.toMatchObject({ code, retryable: ['unavailable', 'rate_limited'].includes(code) }); h.client.dispose();
});
test('ack deadline exceeds eight seconds, unknown outcome retains no automatic resend', async () => {
  const h = setup(); h.client.start(); await flush(); const result = h.client.send(envelope).catch(e => e); let completed = false; void result.then(() => { completed = true; });
  jest.advanceTimersByTime(8000); await flush(); expect(completed).toBe(false); jest.advanceTimersByTime(2000);
  expect(await result).toMatchObject({ code: 'unavailable' }); expect(h.sockets[0]!.emit).toHaveBeenCalledTimes(1); h.client.dispose();
});
test('disconnect during persistence wait rejects unknown outcome and ignores a late ack', async () => {
  const h = setup(); h.client.start(); await flush(); const result = h.client.send(envelope).catch(e => e); const callback = h.sockets[0]!.emit.mock.calls[0]![2]!;
  h.sockets[0]!.drop(); callback(ack); expect(await result).toMatchObject({ code: 'unavailable' }); h.client.dispose();
});
test.each([{ ...ack, messageId: 'wrong' }, { ...ack, extra: true }, { status: 'sent' }, { status: 'error', code: 'secret' }])('rejects malformed or unrelated ack %#', async response => {
  const h = setup(); h.client.start(); await flush(); const result = h.client.send(envelope); h.sockets[0]!.emit.mock.calls[0]![2]!(response);
  await expect(result).rejects.toMatchObject({ code: 'unavailable' }); h.client.dispose();
});
test('valid receive acknowledges delivery only after local acceptance; own-device messages never claim recipient delivery', async () => {
  const h = setup(); h.client.start(); await flush(); const callback = jest.fn(); const peer = { ...envelope, senderId: 'bob', senderName: 'Bob', deliveryStatus: 'sent' };
  h.sockets[0]!.fire('message:new', peer, callback); expect(callback).not.toHaveBeenCalled(); await flush(); expect(callback).toHaveBeenCalledWith({ conversationId: conversation.id, messageId: envelope.id, status: 'delivered' });
  callback.mockClear(); h.sockets[0]!.fire('message:new', { ...envelope, deliveryStatus: 'sent' }, callback); await flush(); expect(h.events.message).toHaveBeenCalledTimes(2); expect(callback).not.toHaveBeenCalled(); h.client.dispose();
});
test('failed decrypt, invalid envelope, wrong scope and revoked scope produce no delivery', async () => {
  const h = setup(); h.client.start(); await flush(); (h.events.message as jest.Mock).mockResolvedValue(false); const callback = jest.fn();
  h.sockets[0]!.fire('message:new', { ...envelope, senderId: 'bob', deliveryStatus: 'sent' }, callback);
  h.sockets[0]!.fire('message:new', { ...envelope, text: 'plaintext', deliveryStatus: 'sent' }, callback);
  h.sockets[0]!.fire('message:new', { ...envelope, conversationId: 'foreign', deliveryStatus: 'sent' }, callback); await flush();
  h.client.setScopes([]); h.sockets[0]!.fire('message:new', { ...envelope, deliveryStatus: 'sent' }, callback); await flush(); expect(h.events.message).toHaveBeenCalledTimes(1); expect(callback).not.toHaveBeenCalled(); h.client.dispose();
});
test('key hints accept only exact documented fields and remain hints', async () => {
  const h = setup(); h.client.start(); await flush(); const event = { conversationId: conversation.id, currentEpoch: { keyId: envelope.encryption.keyId, epoch: 2 } };
  h.sockets[0]!.fire('conversation:keys-changed', event); h.sockets[0]!.fire('conversation:keys-changed', { ...event, key: 'secret' });
  h.sockets[0]!.fire('conversation:keys-changed', { ...event, conversationId: 'foreign' }); expect(h.events.keys).toHaveBeenCalledTimes(1); expect(keysChanged({ ...event, currentEpoch: null })).toEqual({ ...event, currentEpoch: null }); h.client.dispose();
});
test('typing is scoped, throttled and content-free; no preference override is sent', async () => {
  const h = setup(); h.client.start(); await flush(); const socket = h.sockets[0]!;
  h.client.typing(conversation.id); h.client.typing(conversation.id); h.client.typing('foreign'); jest.advanceTimersByTime(1500); h.client.typing(conversation.id); h.client.stopTyping(conversation.id);
  expect(socket.volatile.emit.mock.calls.filter(c => c[0] === 'typing:start')).toEqual([['typing:start', { conversationId: conversation.id }], ['typing:start', { conversationId: conversation.id }]]);
  expect(socket.volatile.emit).toHaveBeenCalledWith('typing:stop', { conversationId: conversation.id });
  expect(socket.volatile.emit.mock.calls.every(c => !JSON.stringify(c).includes('invisible'))).toBe(true); h.client.dispose();
});
test('presence and receipt events require known participants; unknown visibility is forwarded for removal', async () => {
  const h = setup(); h.client.start(); await flush(); const s = h.sockets[0]!;
  s.fire('presence:update', { userId: 'bob', status: 'unknown', timestamp: envelope.timestamp }); s.fire('presence:update', { userId: 'foreign', status: 'online', timestamp: envelope.timestamp });
  s.fire('message:read', { ...ack, status: 'read', userId: 'bob' }); s.fire('message:read', { ...ack, status: 'read', userId: 'foreign' });
  expect(h.events.presence).toHaveBeenCalledTimes(1); expect(h.events.receipt).toHaveBeenCalledTimes(1); h.client.dispose();
});
