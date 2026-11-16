import { randomUUID } from 'node:crypto';
import { MemoryKeyDirectory } from './support/memoryKeyDirectory.ts';
import { keyDirectoryContract, type KeyDirectoryHarness } from './support/keyDirectoryContract.ts';

/** In-memory reference harness. `reopen` round-trips every record through JSON, as storage would. */
function memoryHarness(directory: MemoryKeyDirectory = new MemoryKeyDirectory()): KeyDirectoryHarness {
  return {
    directory,
    async createConversation() {
      const userIds: [string, string] = [randomUUID(), randomUUID()];
      const conversationId = randomUUID();
      directory.addConversation(conversationId, userIds);
      return { conversationId, userIds };
    },
    async createOutsider() {
      return randomUUID();
    },
    async registerDevice(userId, body) {
      return directory.registerDevice(userId, body);
    },
    async revokeDevice(userId, deviceId) {
      return directory.revokeDevice(userId, deviceId);
    },
    async publishEpoch(userId, conversationId, body) {
      return directory.publishEpoch(userId, conversationId, body);
    },
    async reopen() {
      return memoryHarness(MemoryKeyDirectory.restore(directory.export()));
    },
  };
}

keyDirectoryContract('MemoryKeyDirectory (test-only reference)', async () => memoryHarness());
