/**
 * TEST-ONLY scenario builder: two independent accounts with their own device keys, an authorized
 * direct conversation, a published epoch and helpers to encrypt envelopes. Everything goes through
 * the in-memory directory and therefore through the server's planners.
 */
import assert from 'node:assert/strict';
import { randomUUID, type webcrypto } from 'node:crypto';
import type { StoredDeviceKey } from '../../../src/e2ee/records.ts';
import { MemoryKeyDirectory } from './memoryKeyDirectory.ts';
import { TestDevice, type EnvelopeV2Like, type EpochRecordLike, type PublicDeviceKey } from './deviceClient.ts';

if (process.env.NODE_ENV === 'production') throw new Error('Test scenarios must never be loaded in production.');

export const ALICE = 'aaaaaaaa-1111-4111-8111-111111111111';
export const BOB = 'bbbbbbbb-2222-4222-8222-222222222222';
export const CHARLIE = 'cccccccc-3333-4333-8333-333333333333';

export class Scenario {
  readonly directory: MemoryKeyDirectory;
  readonly conversationId: string;
  readonly devices = new Map<string, TestDevice>();
  readonly keys = new Map<string, Map<string, webcrypto.CryptoKey>>();
  #sequence = 0;

  constructor(directory: MemoryKeyDirectory = new MemoryKeyDirectory(), conversationId: string = randomUUID()) {
    this.directory = directory;
    this.conversationId = conversationId;
    directory.addConversation(conversationId, [ALICE, BOB]);
  }

  /** Creates and registers a device; `name` is a test label such as `a1`. */
  async addDevice(name: string, userId: string, device?: TestDevice): Promise<TestDevice> {
    const created = device ?? await TestDevice.create(userId);
    assert.deepEqual(this.directory.registerDevice(userId, await created.registration()), { status: 'created' }, `register ${name}`);
    this.devices.set(name, created);
    return created;
  }

  device(name: string): TestDevice {
    const device = this.devices.get(name);
    if (!device) throw new Error(`No device ${name}`);
    return device;
  }

  /** The device list a client would download for this conversation. */
  activeDevices(): PublicDeviceKey[] {
    return this.directory.activeDevicesOf(this.conversationId).map(publicRecord);
  }

  /** Publishes the next epoch from `creator` for the current active devices. */
  async rotate(creator: string, userId: string): Promise<{ keyId: string; key: webcrypto.CryptoKey }> {
    const device = this.device(creator);
    const current = this.directory.currentEpoch(this.conversationId);
    const { body, key } = await device.createEpoch({ conversationId: this.conversationId, epoch: (current?.epoch ?? 0) + 1,
      previousKeyId: current?.keyId ?? null, devices: this.activeDevices() });
    assert.deepEqual(this.directory.publishEpoch(userId, this.conversationId, body), { status: 'created' }, `publish from ${creator}`);
    return { keyId: body.keyId, key };
  }

  epoch(keyId: string): EpochRecordLike {
    const epoch = this.directory.epochRecord(this.conversationId, keyId);
    assert.ok(epoch, 'epoch exists');
    return epoch;
  }

  /** What a recipient device does: verify and open its wrap from the directory's records. */
  open(name: string, keyId: string): Promise<webcrypto.CryptoKey> {
    return this.device(name).openEpoch(this.epoch(keyId), this.directory.devices());
  }

  async message(sender: string, key: webcrypto.CryptoKey, keyId: string, plaintext: string, senderName = 'Sender'): Promise<EnvelopeV2Like> {
    this.#sequence += 1;
    return this.device(sender).encrypt(key, keyId, { conversationId: this.conversationId, id: `client-message-${this.#sequence}`, senderName }, plaintext);
  }
}

/** Public projection of a stored device key (what a client downloads). */
export function publicRecord(device: StoredDeviceKey): PublicDeviceKey {
  return { deviceKeyId: device.deviceKeyId, userId: device.userId, deviceId: device.deviceId, keyVersion: device.keyVersion, createdAt: device.createdAt,
    agreementPublicKey: device.agreementPublicKey, signingPublicKey: device.signingPublicKey, signature: device.signature };
}
