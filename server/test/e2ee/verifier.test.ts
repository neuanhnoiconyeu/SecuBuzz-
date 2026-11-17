import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { envelopeV2Fingerprint, parseMessageEnvelopeV2 } from '../../src/e2ee/envelope.ts';
import { verifyRecipientKeysSync } from '../../src/e2ee/evaluation.ts';
import { createRecipientKeyVerifier, RecipientKeyServiceUnavailableError, type RecipientKeyDirectory } from '../../src/e2ee/verifier.ts';
import { CapturingLogger } from '../support/fixtures.ts';
import { ALICE, BOB, CHARLIE, Scenario } from './support/scenario.ts';
import { TestDevice, type EnvelopeV2Like } from './support/deviceClient.ts';

const actor = (userId: string) => Object.freeze({ userId, sessionId: `session-${userId}`, displayName: 'Display name' });
const dataContext = (scenario: Scenario, envelope: EnvelopeV2Like, recipientIds: string[] = [BOB]) =>
  Object.freeze({ conversationId: scenario.conversationId, recipientIds: Object.freeze(recipientIds), fingerprint: envelopeV2Fingerprint(parseMessageEnvelopeV2(envelope)!) });

async function ready() {
  const scenario = new Scenario();
  await scenario.addDevice('a1', ALICE);
  await scenario.addDevice('b1', BOB);
  const epoch = await scenario.rotate('a1', ALICE);
  const envelope = await scenario.message('a1', epoch.key, epoch.keyId, 'Hello Bob');
  const logger = new CapturingLogger();
  const verifier = createRecipientKeyVerifier({ directory: scenario.directory, logger });
  return { scenario, epoch, envelope, logger, verifier };
}

describe('recipient-key verifier: positive path', () => {
  test('verifies a current-epoch v2 envelope for DATA (three arguments) and the realtime server (two)', async () => {
    const { scenario, envelope, verifier } = await ready();
    const viaData = await verifier.verifyEnvelope(actor(ALICE), envelope, dataContext(scenario, envelope));
    assert.deepEqual(viaData, { verified: true });
    assert.equal(Object.getPrototypeOf(viaData), Object.prototype);
    assert.deepEqual(Reflect.ownKeys(viaData), ['verified'], 'DATA accepts only an exact {verified:true}');
    assert.deepEqual(await verifier.verifyEnvelope(actor(ALICE), envelope), { verified: true });
    const fromBob = await scenario.message('b1', await scenario.open('b1', envelope.encryption.keyId), envelope.encryption.keyId, 'Hi Alice');
    assert.deepEqual(await verifier.verifyEnvelope(actor(BOB), fromBob, dataContext(scenario, fromBob, [ALICE])), { verified: true });
  });

  test('the synchronous in-transaction check agrees with the asynchronous verifier', async () => {
    const { scenario, envelope } = await ready();
    const state = scenario.directory.keyState(scenario.conversationId, envelope.encryption.keyId);
    const context = { actorUserId: ALICE, conversationId: scenario.conversationId, recipientIds: [BOB], fingerprint: dataContext(scenario, envelope).fingerprint };
    assert.equal(verifyRecipientKeysSync(envelope, context, state), true);
    assert.equal(verifyRecipientKeysSync(envelope, { ...context, recipientIds: [CHARLIE] }, state), false);
    assert.equal(verifyRecipientKeysSync(envelope, { ...context, fingerprint: 'F'.repeat(64) }, state), false);
    assert.equal(verifyRecipientKeysSync({ ...envelope, extra: 1 }, context, state), false);
    assert.equal(verifyRecipientKeysSync(envelope, context, { ...state, activeDevices: [] }), false);
    assert.equal(verifyRecipientKeysSync(envelope, context, null), false);
  });
});

describe('recipient-key verifier: refusals', () => {
  test('never verifies a version-1 envelope and does not even read the directory', async () => {
    const { scenario, envelope, verifier, logger } = await ready();
    const calls = scenario.directory.loadCalls;
    const v1 = { ...envelope, encryption: { version: 1, algorithm: 'AES-256-GCM', encoding: 'base64', iv: envelope.encryption.iv, ciphertext: envelope.encryption.ciphertext } };
    assert.deepEqual(await verifier.verifyEnvelope(actor(ALICE), v1, { conversationId: scenario.conversationId, recipientIds: [BOB], fingerprint: 'a'.repeat(64) }), { verified: false });
    assert.equal(scenario.directory.loadCalls, calls);
    assert.ok(logger.entries.some((entry) => entry.event === 'e2ee.verification.refused' && entry.fields.reason === 'envelope_unsupported'));
  });

  test('refuses identity mismatches: wrong actor, non-participant, wrong recipient, demo identity', async () => {
    const { scenario, envelope, verifier } = await ready();
    assert.deepEqual(await verifier.verifyEnvelope(actor(BOB), envelope, dataContext(scenario, envelope, [ALICE])), { verified: false });
    assert.deepEqual(await verifier.verifyEnvelope(actor(ALICE), envelope, dataContext(scenario, envelope, [CHARLIE])), { verified: false });
    assert.deepEqual(await verifier.verifyEnvelope(actor(ALICE), envelope, dataContext(scenario, envelope, [BOB, CHARLIE])), { verified: false });
    // Even holding the epoch key (for example leaked by Bob), a non-participant cannot get a send verified.
    const charlie = await TestDevice.create(CHARLIE);
    const forged = await charlie.encrypt(await scenario.open('b1', envelope.encryption.keyId), envelope.encryption.keyId,
      { conversationId: scenario.conversationId, id: 'forged', senderName: 'Charlie' }, 'I am not a participant');
    assert.deepEqual(await verifier.verifyEnvelope(actor(CHARLIE), forged), { verified: false });
    for (const bad of [null, {}, { userId: '' }, { userId: 'local-user' }, { userId: 'demo-session-nova' }, 'alice']) {
      assert.deepEqual(await verifier.verifyEnvelope(bad, envelope), { verified: false }, JSON.stringify(bad));
    }
  });

  test('refuses malformed context and fingerprint disagreement', async () => {
    const { scenario, envelope, verifier } = await ready();
    const context = dataContext(scenario, envelope);
    for (const bad of [null, [], { ...context, conversationId: 'other' }, { ...context, recipientIds: [] }, { ...context, recipientIds: ['has space'] },
      { ...context, fingerprint: 'A'.repeat(64) }, { ...context, extra: true }]) {
      assert.deepEqual(await verifier.verifyEnvelope(actor(ALICE), envelope, bad), { verified: false }, JSON.stringify(bad));
    }
    assert.deepEqual(await verifier.verifyEnvelope(actor(ALICE), envelope, { ...context, fingerprint: 'a'.repeat(64) }), { verified: false });
  });

  test('refuses unknown keys, keys of another conversation and superseded epochs', async () => {
    const { scenario, envelope, verifier, epoch } = await ready();
    const unknown = { ...envelope, encryption: { ...envelope.encryption, keyId: randomBytes(16).toString('base64url') } };
    assert.deepEqual(await verifier.verifyEnvelope(actor(ALICE), unknown), { verified: false });
    const otherConversation = randomUUID();
    scenario.directory.addConversation(otherConversation, [ALICE, BOB]);
    const moved = { ...envelope, conversationId: otherConversation };
    assert.deepEqual(await verifier.verifyEnvelope(actor(ALICE), moved), { verified: false }, 'keyId resolves only in its own conversation');
    const next = await scenario.rotate('a1', ALICE);
    assert.deepEqual(await verifier.verifyEnvelope(actor(ALICE), envelope), { verified: false }, 'epoch 1 is stale after epoch 2');
    const fresh = await scenario.message('a1', next.key, next.keyId, 'Current key');
    assert.deepEqual(await verifier.verifyEnvelope(actor(ALICE), fresh), { verified: true });
    assert.notEqual(epoch.keyId, next.keyId);
  });

  test('refuses after any device change until a participant rotates', async () => {
    const { scenario, envelope, verifier } = await ready();
    const check = (value: EnvelopeV2Like = envelope) => verifier.verifyEnvelope(actor(ALICE), value);
    await scenario.addDevice('b2', BOB);
    assert.deepEqual(await check(), { verified: false }, 'new recipient device not covered');
    let current = await scenario.rotate('b2', BOB);
    let message = await scenario.message('a1', await scenario.open('a1', current.keyId), current.keyId, 'after new device');
    assert.deepEqual(await check(message), { verified: true });
    assert.deepEqual(scenario.directory.revokeDevice(BOB, scenario.device('b2').deviceId), { status: 'revoked' });
    assert.deepEqual(await check(message), { verified: false }, 'revoked device still holds the epoch');
    current = await scenario.rotate('a1', ALICE);
    message = await scenario.message('a1', current.key, current.keyId, 'after revocation');
    assert.deepEqual(await check(message), { verified: true });
    await scenario.addDevice('b1v2', BOB, await scenario.device('b1').rotate());
    assert.deepEqual(await check(message), { verified: false }, 'rotated device key version');
    assert.deepEqual(scenario.directory.revokeDevice(BOB, scenario.device('b1').deviceId), { status: 'revoked' });
    assert.deepEqual(await check(message), { verified: false }, 'recipient without any active device');
  });

  test('refuses when membership changes or stored records are corrupted', async () => {
    const { scenario, envelope, verifier } = await ready();
    scenario.directory.setParticipants(scenario.conversationId, [ALICE, CHARLIE]);
    assert.deepEqual(await verifier.verifyEnvelope(actor(ALICE), envelope), { verified: false });
    scenario.directory.setParticipants(scenario.conversationId, [ALICE]);
    assert.deepEqual(await verifier.verifyEnvelope(actor(ALICE), envelope), { verified: false });
    scenario.directory.setParticipants(scenario.conversationId, [ALICE, BOB]);
    assert.deepEqual(await verifier.verifyEnvelope(actor(ALICE), envelope), { verified: true });
    const bob = scenario.directory.devices(BOB)[0]!;
    scenario.directory.forceDevice({ ...bob, keyVersion: bob.keyVersion + 1 });
    assert.deepEqual(await verifier.verifyEnvelope(actor(ALICE), envelope), { verified: false }, 'self-signature no longer matches the record');
    scenario.directory.forceDevice(bob);
    const tampered: RecipientKeyDirectory = {
      loadConversationKeyState(request) {
        const state = scenario.directory.keyState(request.conversationId, request.keyId) as Record<string, any>;
        const wraps = state.epoch.wraps.map((wrap: Record<string, string>, index: number) => index === 0 ? { ...wrap, ciphertext: randomBytes(48).toString('base64url') } : wrap);
        return { ...state, epoch: { ...state.epoch, wraps } };
      },
    };
    assert.deepEqual(await createRecipientKeyVerifier({ directory: tampered }).verifyEnvelope(actor(ALICE), envelope), { verified: false });
  });
});

describe('recipient-key verifier: fail-closed behavior', () => {
  test('throws "unavailable" when the directory throws, hangs or returns malformed data', async () => {
    const { scenario, envelope } = await ready();
    const logger = new CapturingLogger();
    const verifier = createRecipientKeyVerifier({ directory: scenario.directory, logger, timeoutMs: 50 });
    for (const mode of ['throw', 'hang', 'malformed'] as const) {
      scenario.directory.mode = mode;
      const started = Date.now();
      await assert.rejects(verifier.verifyEnvelope(actor(ALICE), envelope), RecipientKeyServiceUnavailableError, mode);
      assert.ok(Date.now() - started < 1_000, `${mode} respects the deadline`);
    }
    scenario.directory.mode = 'null';
    assert.deepEqual(await verifier.verifyEnvelope(actor(ALICE), envelope), { verified: false }, 'unknown conversation');
    assert.ok(!logger.text().includes('AQ.Ab'), 'directory error messages are never logged');
  });

  test('bounds concurrent verifications', async () => {
    const { scenario, envelope } = await ready();
    scenario.directory.mode = 'hang';
    const verifier = createRecipientKeyVerifier({ directory: scenario.directory, maxPending: 1, timeoutMs: 200 });
    const first = verifier.verifyEnvelope(actor(ALICE), envelope);
    await assert.rejects(verifier.verifyEnvelope(actor(ALICE), envelope), RecipientKeyServiceUnavailableError);
    await assert.rejects(first, RecipientKeyServiceUnavailableError);
  });

  test('has no default: construction needs a directory, and production refuses test-only directories', async () => {
    for (const options of [undefined, null, {}, { directory: null }, { directory: {} }, { directory: { loadConversationKeyState: 'yes' } }]) {
      assert.throws(() => createRecipientKeyVerifier(options as never), TypeError, JSON.stringify(options));
    }
    const { scenario } = await ready();
    assert.throws(() => createRecipientKeyVerifier({ directory: scenario.directory, timeoutMs: 0 }), TypeError);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(() => createRecipientKeyVerifier({ directory: scenario.directory }), /test-only key directory/);
      assert.doesNotThrow(() => createRecipientKeyVerifier({ directory: { loadConversationKeyState: () => null } }));
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  test('logs reason codes only: no IDs, keys, signatures or ciphertext', async () => {
    const { scenario, envelope, verifier, logger } = await ready();
    await verifier.verifyEnvelope(actor(BOB), envelope);
    await verifier.verifyEnvelope(actor(ALICE), { ...envelope, encryption: { ...envelope.encryption, keyId: randomBytes(16).toString('base64url') } });
    const text = logger.text();
    const secrets = [ALICE, BOB, scenario.conversationId, envelope.encryption.keyId, envelope.encryption.ciphertext, envelope.encryption.iv,
      ...scenario.directory.devices().flatMap((device) => [device.deviceKeyId, device.signingPublicKey, device.agreementPublicKey, device.signature])];
    for (const secret of secrets) assert.ok(!text.includes(secret), `logged ${secret.slice(0, 12)}`);
    assert.ok(logger.entries.every((entry) => Object.keys(entry.fields).every((key) => key === 'reason')));
  });
});
