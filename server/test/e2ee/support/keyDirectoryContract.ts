/**
 * Reusable key-directory contract tests. The Database Team runs them against its SQLite directory
 * by implementing `KeyDirectoryHarness` over its repositories or REST routes:
 *
 *   keyDirectoryContract('sqlite', async () => createSqliteHarness(...));
 *
 * Each harness operation must run the server's planner inside one immediate transaction.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseConversationKeyState } from '../../../src/e2ee/records.ts';
import type { RecipientKeyDirectory } from '../../../src/e2ee/verifier.ts';
import { TestDevice, type PublicDeviceKey } from './deviceClient.ts';
import type { DirectoryOutcome } from './memoryKeyDirectory.ts';

export interface KeyDirectoryHarness {
  readonly directory: RecipientKeyDirectory;
  /** Two fresh authenticated accounts and an authorized direct conversation between them. */
  createConversation(): Promise<{ conversationId: string; userIds: [string, string] }>;
  /** One more account that is not a participant. */
  createOutsider(): Promise<string>;
  registerDevice(userId: string, body: unknown): Promise<DirectoryOutcome>;
  revokeDevice(userId: string, deviceId: string): Promise<DirectoryOutcome>;
  publishEpoch(userId: string, conversationId: string, body: unknown): Promise<DirectoryOutcome>;
  /** Optional: reopen the same storage (process restart). */
  reopen?(): Promise<KeyDirectoryHarness>;
}

async function load(directory: RecipientKeyDirectory, conversationId: string, keyId = 'AAAAAAAAAAAAAAAAAAAAAA') {
  const raw = await directory.loadConversationKeyState({ conversationId, keyId });
  const state = parseConversationKeyState(raw, { conversationId, keyId });
  assert.ok(state, 'the directory must return a valid ConversationKeyState');
  return state;
}

const publicKey = (device: TestDevice, body: Awaited<ReturnType<TestDevice['registration']>>): PublicDeviceKey => ({
  deviceKeyId: device.deviceKeyId, userId: device.userId, ...body,
});

export function keyDirectoryContract(name: string, createHarness: () => Promise<KeyDirectoryHarness>): void {
  describe(`RecipientKeyDirectory contract: ${name}`, () => {
    async function setup() {
      const harness = await createHarness();
      const { conversationId, userIds: [alice, bob] } = await harness.createConversation();
      const a1 = await TestDevice.create(alice);
      const b1 = await TestDevice.create(bob);
      const a1Body = await a1.registration();
      const b1Body = await b1.registration();
      assert.deepEqual(await harness.registerDevice(alice, a1Body), { status: 'created' });
      assert.deepEqual(await harness.registerDevice(bob, b1Body), { status: 'created' });
      return { harness, conversationId, alice, bob, a1, b1, records: [publicKey(a1, a1Body), publicKey(b1, b1Body)] };
    }

    test('snapshots list both participants and their active devices only', async () => {
      const { harness, conversationId, alice, bob, a1, b1 } = await setup();
      const state = await load(harness.directory, conversationId);
      assert.deepEqual([...state.participantIds].sort(), [alice, bob].sort());
      assert.deepEqual(state.activeDevices.map((device) => device.deviceKeyId).sort(), [a1.deviceKeyId, b1.deviceKeyId].sort());
      assert.equal(state.currentEpoch, null);
      assert.equal(state.epoch, null);
      const rotated = await b1.rotate();
      assert.deepEqual(await harness.registerDevice(bob, await rotated.registration()), { status: 'created' });
      const afterRotation = await load(harness.directory, conversationId);
      assert.deepEqual(afterRotation.activeDevices.map((device) => device.deviceKeyId).sort(), [a1.deviceKeyId, rotated.deviceKeyId].sort());
      assert.deepEqual(await harness.revokeDevice(alice, a1.deviceId), { status: 'revoked' });
      assert.deepEqual((await load(harness.directory, conversationId)).activeDevices.map((device) => device.userId), [bob]);
    });

    test('registration is idempotent, monotonic, owner-bound and permanent after revocation', async () => {
      const { harness, alice, bob, a1 } = await setup();
      const body = await a1.registration();
      assert.deepEqual(await harness.registerDevice(alice, body), { status: 'duplicate' });
      assert.deepEqual(await harness.registerDevice(bob, await a1.signRegistrationAs(bob)), { status: 'refused', reason: 'key_in_use' });
      const stolenDevice = await TestDevice.create(bob, { deviceId: a1.deviceId, keyVersion: 5 });
      assert.deepEqual(await harness.registerDevice(bob, await stolenDevice.registration()), { status: 'refused', reason: 'device_owned_by_another_user' });
      const older = await TestDevice.create(alice, { deviceId: a1.deviceId, keyVersion: 1 });
      assert.deepEqual(await harness.registerDevice(alice, await older.registration()), { status: 'refused', reason: 'stale_key_version' });
      assert.deepEqual(await harness.revokeDevice(bob, a1.deviceId), { status: 'refused', reason: 'not_found' });
      assert.deepEqual(await harness.revokeDevice(alice, a1.deviceId), { status: 'revoked' });
      assert.deepEqual(await harness.revokeDevice(alice, a1.deviceId), { status: 'unchanged' });
      assert.deepEqual(await harness.registerDevice(alice, body), { status: 'refused', reason: 'key_revoked' });
      const newer = await a1.rotate();
      assert.deepEqual(await harness.registerDevice(alice, await newer.registration()), { status: 'refused', reason: 'device_revoked' });
    });

    test('at most ten active devices per user', async () => {
      const { harness, alice } = await setup();
      for (let index = 1; index < 10; index += 1) {
        assert.deepEqual(await harness.registerDevice(alice, await (await TestDevice.create(alice)).registration()), { status: 'created' });
      }
      assert.deepEqual(await harness.registerDevice(alice, await (await TestDevice.create(alice)).registration()), { status: 'refused', reason: 'device_limit' });
    });

    test('epochs are ordered, exact, signed, idempotent and scoped to their conversation', async () => {
      const { harness, conversationId, alice, bob, a1, b1, records } = await setup();
      const outsider = await harness.createOutsider();
      const first = await a1.createEpoch({ conversationId, epoch: 1, previousKeyId: null, devices: records });
      assert.deepEqual(await harness.publishEpoch(outsider, conversationId, first.body), { status: 'refused', reason: 'not_participant' });
      assert.deepEqual(await harness.publishEpoch(bob, conversationId, first.body), { status: 'refused', reason: 'creator_device_unknown' });
      const skipped = await a1.createEpoch({ conversationId, epoch: 2, previousKeyId: null, devices: records });
      assert.deepEqual(await harness.publishEpoch(alice, conversationId, skipped.body), { status: 'refused', reason: 'epoch_out_of_order' });
      const partial = await a1.createEpoch({ conversationId, epoch: 1, previousKeyId: null, devices: records.slice(0, 1) });
      assert.deepEqual(await harness.publishEpoch(alice, conversationId, partial.body), { status: 'refused', reason: 'recipient_set_mismatch' });
      assert.deepEqual(await harness.publishEpoch(alice, conversationId, first.body), { status: 'created' });
      assert.deepEqual(await harness.publishEpoch(alice, conversationId, first.body), { status: 'duplicate' });
      const reused = await a1.createEpoch({ conversationId, epoch: 2, previousKeyId: first.body.keyId, devices: records, keyId: first.body.keyId });
      assert.deepEqual(await harness.publishEpoch(alice, conversationId, reused.body), { status: 'refused', reason: 'key_id_conflict' });
      const state = await load(harness.directory, conversationId, first.body.keyId);
      assert.deepEqual(state.currentEpoch, { keyId: first.body.keyId, epoch: 1 });
      assert.equal(state.epoch?.creatorUserId, alice);
      assert.deepEqual(state.epoch?.wraps.map((wrap) => wrap.recipientDeviceKeyId).sort(), [a1.deviceKeyId, b1.deviceKeyId].sort());
      const second = await b1.createEpoch({ conversationId, epoch: 2, previousKeyId: first.body.keyId, devices: records });
      assert.deepEqual(await harness.publishEpoch(bob, conversationId, second.body), { status: 'created' });
      const latest = await load(harness.directory, conversationId, first.body.keyId);
      assert.deepEqual(latest.currentEpoch, { keyId: second.body.keyId, epoch: 2 });
      assert.equal(latest.epoch?.epoch, 1, 'older epochs stay readable for history');
      const other = await harness.createConversation();
      const elsewhere = await load(harness.directory, other.conversationId, first.body.keyId);
      assert.equal(elsewhere.epoch, null, 'a keyId never resolves in another conversation');
    });

    test('concurrent publications of the same epoch number commit exactly one', async () => {
      const { harness, conversationId, alice, bob, a1, b1, records } = await setup();
      const fromAlice = await a1.createEpoch({ conversationId, epoch: 1, previousKeyId: null, devices: records });
      const fromBob = await b1.createEpoch({ conversationId, epoch: 1, previousKeyId: null, devices: records });
      const outcomes = await Promise.all([harness.publishEpoch(alice, conversationId, fromAlice.body), harness.publishEpoch(bob, conversationId, fromBob.body)]);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'created').length, 1);
      assert.deepEqual(outcomes.find((outcome) => outcome.status === 'refused'), { status: 'refused', reason: 'epoch_out_of_order' });
    });

    test('concurrent identical registrations create one record', async () => {
      const harness = await createHarness();
      const { userIds: [alice] } = await harness.createConversation();
      const device = await TestDevice.create(alice);
      const body = await device.registration();
      const outcomes = await Promise.all([harness.registerDevice(alice, body), harness.registerDevice(alice, body), harness.registerDevice(alice, body)]);
      assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ['created', 'duplicate', 'duplicate']);
    });

    test('state survives a reopen of the same storage', async (t) => {
      const { harness, conversationId, alice, a1, b1, records } = await setup();
      if (!harness.reopen) {
        t.skip('this harness has no persistent storage');
        return;
      }
      const first = await a1.createEpoch({ conversationId, epoch: 1, previousKeyId: null, devices: records });
      assert.deepEqual(await harness.publishEpoch(alice, conversationId, first.body), { status: 'created' });
      const reopened = await harness.reopen();
      const state = await load(reopened.directory, conversationId, first.body.keyId);
      assert.deepEqual(state.currentEpoch, { keyId: first.body.keyId, epoch: 1 });
      assert.deepEqual(state.activeDevices.map((device) => device.deviceKeyId).sort(), [a1.deviceKeyId, b1.deviceKeyId].sort());
      assert.deepEqual(await reopened.publishEpoch(alice, conversationId, first.body), { status: 'duplicate' });
    });
  });
}
