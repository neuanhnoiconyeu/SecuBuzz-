import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import { planEpochPublication, type PublicationContext } from '../../src/e2ee/epochs.ts';
import { planDeviceRegistration, planDeviceRevocation, validateDeviceRegistration } from '../../src/e2ee/registration.ts';
import type { DeviceKeyRecord, StoredDeviceKey } from '../../src/e2ee/records.ts';
import { TestDevice, type PublicDeviceKey } from './support/deviceClient.ts';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const at = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';

async function validRecord(device: TestDevice, createdAt = at()): Promise<DeviceKeyRecord> {
  const result = validateDeviceRegistration(await device.registration(createdAt), { userId: device.userId });
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}
const stored = (record: DeviceKeyRecord, status: StoredDeviceKey['status'] = 'active'): StoredDeviceKey => ({ ...record, status });
const empty = { existingKey: null, deviceHistory: [], activeDevicesOfUser: [] };

describe('device registration validation', () => {
  test('binds the key to the authenticated user and derives the content-addressed key ID', async () => {
    const device = await TestDevice.create(ALICE);
    const record = await validRecord(device);
    assert.equal(record.userId, ALICE);
    assert.equal(record.deviceKeyId, device.deviceKeyId);
    assert.ok(Object.isFrozen(record));
  });

  test('refuses requests without an authenticated account or with a demo identity', async () => {
    const device = await TestDevice.create(ALICE);
    const body = await device.registration(at());
    for (const userId of [undefined, '', 'has space', 'local-user', 'demo-session-nova', 'demo:explorer']) {
      assert.deepEqual(validateDeviceRegistration(body, { userId: userId as string }), { ok: false, reason: 'invalid_registration' }, String(userId));
    }
    assert.deepEqual(validateDeviceRegistration(body, undefined as never), { ok: false, reason: 'invalid_registration' });
  });

  test('refuses cross-user substitution: a valid statement for Alice cannot register under Bob', async () => {
    const device = await TestDevice.create(ALICE);
    assert.deepEqual(validateDeviceRegistration(await device.registration(at()), { userId: BOB }), { ok: false, reason: 'signature_invalid' });
  });

  test('refuses identity fields, private keys, bad encodings, reused key pairs and forged signatures', async () => {
    const device = await TestDevice.create(ALICE);
    const body = await device.registration(at());
    const other = await TestDevice.create(ALICE);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...body, userId: ALICE }, 'invalid_registration'],
      [{ ...body, privateKey: 'AAAA' }, 'invalid_registration'],
      [{ ...body, d: 'AAAA' }, 'invalid_registration'],
      [{ ...body, deviceId: 'short' }, 'invalid_registration'],
      [{ ...body, keyVersion: 0 }, 'invalid_registration'],
      [{ ...body, keyVersion: 1.5 }, 'invalid_registration'],
      [{ ...body, keyVersion: '1' }, 'invalid_registration'],
      [{ ...body, createdAt: '2026-11-14T12:00:00Z' }, 'invalid_registration'],
      [{ ...body, agreementPublicKey: Buffer.alloc(65).toString('base64url') }, 'invalid_registration'],
      [{ ...body, agreementPublicKey: body.signingPublicKey }, 'invalid_registration'],
      [{ ...body, signature: `${body.signature}A` }, 'invalid_registration'],
      [{ ...body, agreementPublicKey: other.agreementPublicKey }, 'signature_invalid'],
      [{ ...body, keyVersion: 2 }, 'signature_invalid'],
      [{ ...body, signature: (await other.registration(at())).signature }, 'signature_invalid'],
    ];
    for (const [input, reason] of cases) assert.deepEqual(validateDeviceRegistration(input, { userId: ALICE }), { ok: false, reason }, JSON.stringify(Object.keys(input)));
    assert.deepEqual(validateDeviceRegistration(null, { userId: ALICE }), { ok: false, reason: 'invalid_registration' });
  });
});

describe('device registration planning', () => {
  test('creates fresh registrations and supersedes the previous version of the device', async () => {
    const v1 = await TestDevice.create(ALICE);
    const record1 = await validRecord(v1);
    assert.deepEqual(planDeviceRegistration(record1, empty, { nowMs: NOW }), { action: 'create', record: record1, supersede: [] });
    const v2 = await v1.rotate();
    const record2 = await validRecord(v2);
    const plan = planDeviceRegistration(record2, { existingKey: null, deviceHistory: [stored(record1)], activeDevicesOfUser: [stored(record1)] }, { nowMs: NOW });
    assert.deepEqual(plan, { action: 'create', record: record2, supersede: [record1.deviceKeyId] });
  });

  test('treats an identical or re-signed repeat as a duplicate, even after the freshness window', async () => {
    const device = await TestDevice.create(ALICE);
    const original = stored(await validRecord(device));
    const resigned = await validRecord(device, at(1_000));
    assert.deepEqual(planDeviceRegistration(resigned, { ...empty, existingKey: original }, { nowMs: NOW + 3_600_000 }), { action: 'duplicate', record: original });
  });

  test('refuses replays, stale versions, revoked keys and devices, foreign devices and the device limit', async () => {
    const device = await TestDevice.create(ALICE);
    const record = await validRecord(device);
    assert.deepEqual(planDeviceRegistration(record, { ...empty, existingKey: stored(record, 'revoked') }, { nowMs: NOW }), { action: 'refuse', reason: 'key_revoked' });
    assert.deepEqual(planDeviceRegistration(record, { ...empty, existingKey: stored(record, 'superseded') }, { nowMs: NOW }), { action: 'refuse', reason: 'key_revoked' });
    assert.deepEqual(planDeviceRegistration(record, { ...empty, existingKey: { ...stored(record), userId: BOB } }, { nowMs: NOW }), { action: 'refuse', reason: 'key_in_use' });
    assert.deepEqual(planDeviceRegistration(record, { ...empty, existingKey: { ...stored(record), keyVersion: 9 } }, { nowMs: NOW }), { action: 'refuse', reason: 'key_in_use' });
    assert.deepEqual(planDeviceRegistration(record, empty, { nowMs: NOW + 300_001 }), { action: 'refuse', reason: 'stale_registration' });
    assert.deepEqual(planDeviceRegistration(record, empty, { nowMs: NOW - 300_001 }), { action: 'refuse', reason: 'stale_registration' });
    const later = await TestDevice.create(ALICE, { deviceId: device.deviceId, keyVersion: 3 });
    const laterRecord = stored(await validRecord(later));
    assert.deepEqual(planDeviceRegistration(record, { ...empty, deviceHistory: [laterRecord] }, { nowMs: NOW }), { action: 'refuse', reason: 'stale_key_version' });
    assert.deepEqual(planDeviceRegistration(record, { ...empty, deviceHistory: [{ ...laterRecord, status: 'revoked' }] }, { nowMs: NOW }),
      { action: 'refuse', reason: 'device_revoked' });
    assert.deepEqual(planDeviceRegistration(record, { ...empty, deviceHistory: [{ ...laterRecord, userId: BOB }] }, { nowMs: NOW }),
      { action: 'refuse', reason: 'device_owned_by_another_user' });
    const others = await Promise.all(Array.from({ length: 10 }, async () => stored(await validRecord(await TestDevice.create(ALICE)))));
    assert.deepEqual(planDeviceRegistration(record, { ...empty, activeDevicesOfUser: others }, { nowMs: NOW }), { action: 'refuse', reason: 'device_limit' });
    assert.equal(planDeviceRegistration(record, { ...empty, activeDevicesOfUser: others.slice(1) }, { nowMs: NOW }).action, 'create');
  });

  test('rejects inconsistent lookups from the caller instead of guessing', async () => {
    const record = await validRecord(await TestDevice.create(ALICE));
    const unrelated = stored(await validRecord(await TestDevice.create(ALICE)));
    assert.throws(() => planDeviceRegistration(record, { ...empty, existingKey: unrelated }, { nowMs: NOW }), TypeError);
    assert.throws(() => planDeviceRegistration(record, { ...empty, deviceHistory: [unrelated] }, { nowMs: NOW }), TypeError);
    assert.throws(() => planDeviceRegistration(record, { ...empty, activeDevicesOfUser: [{ ...unrelated, userId: BOB }] }, { nowMs: NOW }), TypeError);
  });

  test('revocation is owner-only, permanent and idempotent', async () => {
    const device = await TestDevice.create(ALICE);
    const v1 = stored(await validRecord(device), 'superseded');
    const v2 = stored(await validRecord(await device.rotate()));
    assert.deepEqual(planDeviceRevocation(ALICE, device.deviceId, [v1, v2]), { action: 'revoke', deviceKeyIds: [v1.deviceKeyId, v2.deviceKeyId] });
    assert.deepEqual(planDeviceRevocation(BOB, device.deviceId, [v1, v2]), { action: 'refuse', reason: 'not_found' });
    assert.deepEqual(planDeviceRevocation(ALICE, device.deviceId, []), { action: 'refuse', reason: 'not_found' });
    assert.deepEqual(planDeviceRevocation(ALICE, 'not-a-device', [v1]), { action: 'refuse', reason: 'not_found' });
    assert.deepEqual(planDeviceRevocation(ALICE, device.deviceId, [{ ...v1, status: 'revoked' }, { ...v2, status: 'revoked' }]), { action: 'unchanged' });
  });
});

describe('epoch publication planning', () => {
  async function setup() {
    const a1 = await TestDevice.create(ALICE);
    const b1 = await TestDevice.create(BOB);
    const devices = [stored(await validRecord(a1)), stored(await validRecord(b1))];
    const context: PublicationContext = { actorUserId: ALICE, conversationId: CONVERSATION, participantIds: [ALICE, BOB], activeDevices: devices,
      currentEpoch: null, existingEpoch: null, nowMs: NOW };
    return { a1, b1, devices, context, records: devices as PublicDeviceKey[] };
  }

  test('creates epoch 1 signed by the actor device for exactly both participants', async () => {
    const { a1, context, records } = await setup();
    const { body } = await a1.createEpoch({ conversationId: CONVERSATION, epoch: 1, previousKeyId: null, devices: records, createdAt: at() });
    const plan = planEpochPublication(body, context);
    assert.equal(plan.action, 'create');
    if (plan.action !== 'create') return;
    assert.equal(plan.epoch.creatorUserId, ALICE);
    assert.equal(plan.epoch.wraps.length, 2);
    assert.match(plan.epoch.recipientSetDigest, /^[A-Za-z0-9_-]{43}$/);
  });

  test('refuses every rule violation with a specific reason', async () => {
    const { a1, b1, context, records, devices } = await setup();
    const make = (overrides: Partial<Parameters<TestDevice['createEpoch']>[0]> = {}, device = a1) =>
      device.createEpoch({ conversationId: CONVERSATION, epoch: 1, previousKeyId: null, devices: records, createdAt: at(), ...overrides });
    const { body } = await make();
    const cases: Array<[unknown, Partial<PublicationContext>, string]> = [
      [{ ...body, creatorUserId: BOB }, {}, 'invalid_publication'],
      [{ ...body, wraps: [] }, {}, 'invalid_publication'],
      [{ ...body, wraps: [...body.wraps].reverse() }, {}, 'invalid_publication'],
      [{ ...body, wraps: [body.wraps[0], body.wraps[0]] }, {}, 'invalid_publication'],
      [{ ...body, wraps: body.wraps.map((wrap) => ({ ...wrap, ciphertext: Buffer.alloc(32).toString('base64url') })) }, {}, 'invalid_publication'],
      [{ ...body, wraps: body.wraps.map((wrap) => ({ ...wrap, enc: Buffer.alloc(65).toString('base64url') })) }, {}, 'invalid_publication'],
      [{ ...body, wraps: body.wraps.map((wrap) => ({ ...wrap, extra: true })) }, {}, 'invalid_publication'],
      [body, { participantIds: [ALICE, BOB, 'carol'] }, 'unsupported_conversation'],
      [body, { participantIds: [ALICE] }, 'unsupported_conversation'],
      [body, { actorUserId: 'carol', participantIds: [ALICE, BOB] }, 'not_participant'],
      [body, { nowMs: NOW + 300_001 }, 'stale_publication'],
      [body, { currentEpoch: { keyId: randomBytes(16).toString('base64url'), epoch: 1 } }, 'epoch_out_of_order'],
      [body, { actorUserId: BOB }, 'creator_device_unknown'],
      [body, { activeDevices: [devices[0] as StoredDeviceKey] }, 'recipient_without_devices'],
      [{ ...body, signature: (await make({}, a1)).body.signature }, {}, 'signature_invalid'],
    ];
    for (const [input, overrides, reason] of cases) {
      assert.deepEqual(planEpochPublication(input, { ...context, ...overrides }), { action: 'refuse', reason }, reason);
    }
    const extraDevice = stored(await validRecord(await TestDevice.create(BOB)));
    assert.deepEqual(planEpochPublication(body, { ...context, activeDevices: [...devices, extraDevice] }), { action: 'refuse', reason: 'recipient_set_mismatch' },
      'a device registered after the client built the epoch');
    const skipped = await make({ epoch: 2 });
    assert.deepEqual(planEpochPublication(skipped.body, context), { action: 'refuse', reason: 'epoch_out_of_order' });
    const fromBob = await make({}, b1);
    assert.equal(planEpochPublication(fromBob.body, { ...context, actorUserId: BOB }).action, 'create', 'either participant may rotate');
  });

  test('requires epoch n+1 after epoch n and links previousKeyId', async () => {
    const { a1, context, records } = await setup();
    const first = await a1.createEpoch({ conversationId: CONVERSATION, epoch: 1, previousKeyId: null, devices: records, createdAt: at() });
    const current = { keyId: first.body.keyId, epoch: 1 };
    const second = await a1.createEpoch({ conversationId: CONVERSATION, epoch: 2, previousKeyId: first.body.keyId, devices: records, createdAt: at() });
    assert.equal(planEpochPublication(second.body, { ...context, currentEpoch: current }).action, 'create');
    const unlinked = await a1.createEpoch({ conversationId: CONVERSATION, epoch: 2, previousKeyId: randomBytes(16).toString('base64url'), devices: records, createdAt: at() });
    assert.deepEqual(planEpochPublication(unlinked.body, { ...context, currentEpoch: current }), { action: 'refuse', reason: 'epoch_out_of_order' });
    assert.deepEqual(planEpochPublication(first.body, { ...context, currentEpoch: current }), { action: 'refuse', reason: 'epoch_out_of_order' }, 'an old epoch cannot be replayed');
  });

  test('detects identical repeats and keyId reuse', async () => {
    const { a1, context, records } = await setup();
    const first = await a1.createEpoch({ conversationId: CONVERSATION, epoch: 1, previousKeyId: null, devices: records, createdAt: at() });
    const plan = planEpochPublication(first.body, context);
    assert.equal(plan.action, 'create');
    if (plan.action !== 'create') return;
    const later = { ...context, currentEpoch: { keyId: first.body.keyId, epoch: 1 }, existingEpoch: plan.epoch, nowMs: NOW + 3_600_000 };
    assert.deepEqual(planEpochPublication(first.body, later), { action: 'duplicate', epoch: plan.epoch });
    const reused = await a1.createEpoch({ conversationId: CONVERSATION, epoch: 2, previousKeyId: first.body.keyId, devices: records, createdAt: at(), keyId: first.body.keyId });
    assert.deepEqual(planEpochPublication(reused.body, later), { action: 'refuse', reason: 'key_id_conflict' });
  });
});
