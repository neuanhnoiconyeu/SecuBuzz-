import { SecureMessagingSession } from '@/security/e2ee/session';
import type { StoredMessage } from '@/security/e2ee/model';
import { envelope } from '@/realtime/testing/authenticatedFixtures';
import { AuthenticatedUnsend } from '../authenticatedUnsend';

const original: StoredMessage = { ...envelope, id: 'wire-id', storageId: 'different-server-storage-id', sequence: 4, revision: 0,
  state: 'active', storedAt: envelope.timestamp, updatedAt: envelope.timestamp, deletedAt: null };
const deleted: StoredMessage = { ...original, state: 'deleted', encryption: null, revision: 1, deletedAt: envelope.timestamp };
function fixture() {
  const session = new SecureMessagingSession({ actor: { id: original.senderId, username: 'alice' }, request: jest.fn(), dispose() {} });
  const remove = jest.spyOn(session.api, 'remove').mockResolvedValue(deleted);
  const history = jest.spyOn(session.api, 'history').mockResolvedValue({ items: [original], nextCursor: null });
  return { engine: new AuthenticatedUnsend(session), remove, history };
}
test('Unsend calls the existing API with the storage ID and preserves every stable wire identity field', async () => {
  const f = fixture(); expect(await f.engine.remove(original)).toEqual(deleted);
  expect(f.remove).toHaveBeenCalledWith('different-server-storage-id'); expect(f.remove).not.toHaveBeenCalledWith('wire-id');
  expect(f.history).not.toHaveBeenCalled(); expect(original.state).toBe('active');
});
test.each([{ ...original, senderId: 'bob' }, deleted, { ...original, encryption: null }])('ineligible messages cannot reach the REST mutation', async message => {
  const f = fixture(); await expect(f.engine.remove(message)).rejects.toThrow('cannot be unsent'); expect(f.remove).not.toHaveBeenCalled();
});
test('concurrent confirmations share one request and cannot report success before its result', async () => {
  const f = fixture(); let finish!: (message: StoredMessage) => void;
  f.remove.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = f.engine.remove(original), second = f.engine.remove(original), confirmed = jest.fn();
  void first.then(confirmed); expect(first).toBe(second); expect(f.remove).toHaveBeenCalledTimes(1); expect(confirmed).not.toHaveBeenCalled();
  finish(deleted); expect(await first).toEqual(deleted); expect(await second).toEqual(deleted);
});
test('failed requests preserve the original record and a retry remains available', async () => {
  const f = fixture(); f.remove.mockRejectedValueOnce(new Error('Unavailable'));
  await expect(f.engine.remove(original)).rejects.toThrow('Unavailable'); expect(original.state).toBe('active');
  expect(await f.engine.remove(original)).toEqual(deleted); expect(f.remove).toHaveBeenCalledTimes(2);
});
test('lost responses reconcile a committed tombstone through authorized history without a second DELETE', async () => {
  const f = fixture(); f.remove.mockRejectedValue(new Error('Lost response'));
  f.history.mockResolvedValueOnce({ items: [], nextCursor: 'older' }).mockResolvedValueOnce({ items: [deleted], nextCursor: null });
  expect(await f.engine.remove(original)).toEqual(deleted); expect(f.remove).toHaveBeenCalledTimes(1);
  expect(f.history).toHaveBeenNthCalledWith(2, original.conversationId, 'older');
});
test.each(['id', 'storageId', 'conversationId', 'senderId', 'senderName', 'timestamp', 'storedAt', 'sequence', 'revision', 'state', 'encryption', 'deletedAt'] as const)('a malformed confirmation cannot replace the original (%s)', async field => {
  const f = fixture(); const invalid: Record<string, unknown> = { ...deleted };
  invalid[field] = field === 'encryption' ? original.encryption : field === 'deletedAt' ? null : original[field] === deleted[field] ? 'wrong-identity' : original[field];
  f.remove.mockResolvedValue(invalid as unknown as StoredMessage);
  await expect(f.engine.remove(original)).rejects.toThrow('did not confirm'); expect(original.encryption).toBe(envelope.encryption);
});
