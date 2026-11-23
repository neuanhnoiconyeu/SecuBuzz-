import { hideLocalMessage, LOCAL_HIDDEN_MESSAGE_PREFIX, localHiddenMessageId, readLocalHiddenMessages, subscribeLocalHiddenMessages } from '../localHiddenMessages';

beforeEach(() => localStorage.clear());
afterEach(() => jest.restoreAllMocks());
const key = (account: string, conversation: string, id: string) => LOCAL_HIDDEN_MESSAGE_PREFIX + JSON.stringify([account, conversation, id]);

test('persistent markers contain identifiers only and isolate accounts, conversations and wire IDs', () => {
  hideLocalMessage('alice', 'chat', 'wire-id');
  expect(localStorage.getItem(key('alice', 'chat', 'wire-id'))).toBe('1');
  expect(readLocalHiddenMessages('alice').hidden.has(localHiddenMessageId('chat', 'wire-id'))).toBe(true);
  expect(readLocalHiddenMessages('bob').hidden.size).toBe(0);
  expect(readLocalHiddenMessages('alice').hidden.has(localHiddenMessageId('other-chat', 'wire-id'))).toBe(false);
  expect(readLocalHiddenMessages('alice').hidden.has(localHiddenMessageId('chat', 'storage-id'))).toBe(false);
  hideLocalMessage('bob', 'chat', 'other-wire-id');
  expect(readLocalHiddenMessages('alice').hidden.size).toBe(1);
  expect(readLocalHiddenMessages('bob').hidden).toEqual(new Set([localHiddenMessageId('chat', 'other-wire-id')]));
});

test('structured identities cannot collide through delimiters, quotes or scope boundaries', () => {
  hideLocalMessage('a:b', 'c', 'd'); hideLocalMessage('a', 'b:c', 'd'); hideLocalMessage('a', 'b', 'c:d');
  hideLocalMessage('a', 'b', 'quoted"id');
  expect(localStorage.length).toBe(4);
  expect(readLocalHiddenMessages('a:b').hidden).toEqual(new Set([localHiddenMessageId('c', 'd')]));
  expect(readLocalHiddenMessages('a').hidden.size).toBe(3);
});

test('separate tab writes and repeated hiding never overwrite other hidden identifiers', () => {
  hideLocalMessage('alice', 'chat', 'one');
  // A different document writes its own marker without sharing this module's memory.
  localStorage.setItem(key('alice', 'chat', 'two'), '1');
  hideLocalMessage('alice', 'chat', 'three'); hideLocalMessage('alice', 'chat', 'one');
  expect(readLocalHiddenMessages('alice').hidden.size).toBe(3); expect(localStorage.length).toBe(3);
  const snapshot = readLocalHiddenMessages('alice'); expect(readLocalHiddenMessages('alice')).toBe(snapshot);
});

test('failed persistence does not hide a message or report a successful change', () => {
  const change = jest.fn(), unsubscribe = subscribeLocalHiddenMessages(change);
  const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  expect(() => hideLocalMessage('alice', 'chat', 'failed')).toThrow('Full');
  setItem.mockRestore();
  expect(readLocalHiddenMessages('alice').hidden.size).toBe(0); expect(change).not.toHaveBeenCalled(); unsubscribe();
});

test('blocked storage preserves known hidden messages and cannot fall back to temporary deletion', () => {
  hideLocalMessage('alice', 'chat', 'known');
  jest.spyOn(Storage.prototype, 'key').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
  const snapshot = readLocalHiddenMessages('alice');
  expect(snapshot.unavailable).toBe(true); expect(snapshot.hidden.has(localHiddenMessageId('chat', 'known'))).toBe(true);
  expect(readLocalHiddenMessages('alice')).toBe(snapshot);
  expect(() => hideLocalMessage('alice', 'chat', 'new')).toThrow('Browser storage is unavailable');
});

test('malformed or unrelated preferences cannot hide messages or pollute account scopes', () => {
  localStorage.setItem(LOCAL_HIDDEN_MESSAGE_PREFIX + 'invalid-json', '1');
  localStorage.setItem(LOCAL_HIDDEN_MESSAGE_PREFIX + JSON.stringify(['alice', 'chat']), '1');
  localStorage.setItem(LOCAL_HIDDEN_MESSAGE_PREFIX + JSON.stringify(['alice', 'chat', {}]), '1');
  localStorage.setItem(key('alice', 'chat', 'bad-marker'), 'message text');
  localStorage.setItem('demo-hidden-message', '1');
  expect(readLocalHiddenMessages('alice').hidden.size).toBe(0);
  expect(() => hideLocalMessage('', 'chat', 'id')).toThrow('Invalid local message identity');
});

test('same-document changes, other tabs and explicit storage clearing notify active views', () => {
  const listener = jest.fn(), unsubscribe = subscribeLocalHiddenMessages(listener);
  hideLocalMessage('alice', 'chat', 'one'); expect(listener).toHaveBeenCalledTimes(1);
  localStorage.setItem(key('alice', 'chat', 'two'), '1');
  window.dispatchEvent(new StorageEvent('storage', { key: key('alice', 'chat', 'two') }));
  expect(listener).toHaveBeenCalledTimes(2); expect(readLocalHiddenMessages('alice').hidden.size).toBe(2);
  window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' })); expect(listener).toHaveBeenCalledTimes(2);
  localStorage.clear(); window.dispatchEvent(new StorageEvent('storage', { key: null }));
  expect(listener).toHaveBeenCalledTimes(3); expect(readLocalHiddenMessages('alice').hidden.size).toBe(0);
  unsubscribe(); window.dispatchEvent(new Event('focus')); expect(listener).toHaveBeenCalledTimes(3);
});
