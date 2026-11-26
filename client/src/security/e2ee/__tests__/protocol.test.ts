/** @jest-environment node */
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Aes128Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import { base64url, decode, deviceKeyIdFor, encode, epochStatement, importPoint, messageAad, parseEnvelope, parseEpoch, registrationStatement, verifyDevice, verifySignature, wrapInfo } from '../protocol';
import { openKey, sealKey } from '../hpke';
import { generateDevice, registration, validateLocalDevice } from '../devices';
import { decryptV2 } from '../messages';
import { E2eeApi } from '../api';
import type { Registration, EpochBody } from '../model';
import { ApiError } from '@/api/sessionApi';

const vector = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), '../server/test/e2ee/vectors/protocol-v1.json'), 'utf8'));
const epoch = { ...vector.epoch.body, conversationId: vector.conversationId, creatorUserId: vector.epoch.creatorUserId, publishedAt: vector.epoch.body.createdAt };
const publicRecord = (d: typeof vector.devices.alice) => ({ deviceKeyId: d.deviceKeyId, userId: d.userId, deviceId: d.deviceId, keyVersion: d.keyVersion, createdAt: d.createdAt, agreementPublicKey: d.agreementPublicKey, signingPublicKey: d.signingPublicKey, signature: d.signature, status: 'active' as const, registeredAt: d.createdAt });
async function vectorPair(d: typeof vector.devices.alice): Promise<CryptoKeyPair> {
  const raw = decode(d.agreementPublicKey, 65);
  return { publicKey: await importPoint(d.agreementPublicKey, false), privateKey: await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', x: base64url(raw.slice(1, 33)), y: base64url(raw.slice(33)), d: d.privateKeys.agreementD,
  }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) };
}
beforeAll(() => { Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto }); });
test('device IDs, registration statements/signatures and epoch statements/signatures match the actual Kiro vector', async () => {
  for (const d of [vector.devices.alice, vector.devices.bob]) {
    expect(await deviceKeyIdFor(d.agreementPublicKey, d.signingPublicKey)).toBe(d.deviceKeyId);
    expect(registrationStatement(d)).toBe(d.registrationStatement); await verifyDevice(publicRecord(d));
  }
  expect(epochStatement(epoch)).toBe(vector.epoch.statement); parseEpoch(epoch, vector.conversationId);
  await verifySignature(vector.devices.alice.signingPublicKey, vector.epoch.statement, epoch.signature);
  for (const w of epoch.wraps) expect(new TextDecoder().decode(wrapInfo(epoch, w))).toBe(vector.epoch.wrapInfos[w.recipientDeviceKeyId]);
});
test('maintained HPKE opens both fixed protocol wraps with non-extractable private keys and decrypts exact v2 AAD', async () => {
  for (const d of [vector.devices.alice, vector.devices.bob]) {
    const wrap = epoch.wraps.find((w: { recipientDeviceKeyId: string }) => w.recipientDeviceKeyId === d.deviceKeyId);
    const pair = await vectorPair(d); expect(pair.privateKey.extractable).toBe(false);
    const key = await openKey(pair, wrap.enc, wrap.ciphertext, wrapInfo(epoch, wrap));
    expect(key.extractable).toBe(false); expect(new TextDecoder().decode(messageAad(vector.message.envelope))).toBe(vector.message.aad);
    expect(await decryptV2(key, vector.message.envelope)).toBe(vector.message.plaintext);
  }
});
test('HPKE matches RFC 9180 A.3.1 and rejects wrong context, wrong recipient and altered ciphertext', async () => {
  const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
  const recipient = hex('04fe8c19ce0905191ebc298a9245792531f26f0cece2460639e8bc39cb7f706a826a779b4cf969b8a0e539c7f62fb3d30ad6aa8f80e30f1d128aafd68a2ce72ea0');
  const ephemeral = hex('04a92719c6195d5085104f469a8b9814d5838ff72b60501e2c4466e5e67b325ac98536d7b61a1af4b78e5b7f951c0900be863c403ce65c9bfcb9382657222d18c4');
  const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
  const publicKey = await importPoint(base64url(ephemeral), false);
  const privateKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: base64url(ephemeral.slice(1, 33)), y: base64url(ephemeral.slice(33)), d: base64url(hex('4995788ef4b9d6132b249ce59a77281493eb39af373d236a1fe415cb0c2d7beb')) }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const result = await suite.seal({ recipientPublicKey: await importPoint(base64url(recipient), false), info: hex('4f6465206f6e2061204772656369616e2055726e'), ekm: { privateKey, publicKey } }, hex('4265617574792069732074727574682c20747275746820626561757479'), hex('436f756e742d30'));
  expect(Buffer.from(result.enc).toString('hex')).toBe(Buffer.from(ephemeral).toString('hex'));
  expect(Buffer.from(result.ct).toString('hex')).toBe('5ad590bb8baa577f8619db35a36311226a896e7342a6d836d8b7bcd2f20b6c7f9076ac232e3ab2523f39513434');
  const a = await generateDevice('alice'), b = await generateDevice('bob'), c = await generateDevice('charlie'), raw = crypto.getRandomValues(new Uint8Array(32));
  const wrap = await sealKey(b.agreementPublicKey, raw, encode('context'));
  await expect(openKey(c.agreement, wrap.enc, wrap.ciphertext, encode('context'))).rejects.toMatchObject({ code: 'invalid_proof' });
  await expect(openKey(b.agreement, wrap.enc, wrap.ciphertext, encode('other'))).rejects.toMatchObject({ code: 'invalid_proof' });
  const damaged = decode(wrap.ciphertext, 48); damaged[0] = damaged[0]! ^ 1;
  await expect(openKey(b.agreement, wrap.enc, base64url(damaged), encode('context'))).rejects.toMatchObject({ code: 'invalid_proof' });
  expect(a.signing.privateKey.extractable).toBe(false); raw.fill(0);
});
test('local device restoration proves both private/public key associations; malformed IDs and signatures fail', async () => {
  const a = await generateDevice('alice'), b = await generateDevice('alice'); await validateLocalDevice(a, 'alice');
  await expect(validateLocalDevice(a, 'bob')).rejects.toMatchObject({ code: 'storage_corrupt' });
  await expect(validateLocalDevice({ ...a, agreement: b.agreement }, 'alice')).rejects.toMatchObject({ code: 'storage_corrupt' });
  const body = await registration(a); expect(body).not.toHaveProperty('userId');
  await expect(verifyDevice({ ...publicRecord(vector.devices.alice), deviceId: base64url(new Uint8Array(16)) })).rejects.toMatchObject({ code: 'invalid_proof' });
  await expect(verifySignature(a.signingPublicKey, 'test', base64url(new Uint8Array(64)))).rejects.toMatchObject({ code: 'invalid_proof' });
});
test('v2 strict parsing and GCM authentication reject altered keyId, conversation, sender, timestamp and ciphertext', async () => {
  const d = vector.devices.bob, w = epoch.wraps.find((r: { recipientDeviceKeyId: string }) => r.recipientDeviceKeyId === d.deviceKeyId);
  const key = await openKey(await vectorPair(d), w.enc, w.ciphertext, wrapInfo(epoch, w)), e = vector.message.envelope;
  expect(parseEnvelope(e)).toEqual(e);
  for (const changed of [{ ...e, conversationId: 'other' }, { ...e, senderName: 'Impostor' }, { ...e, encryption: { ...e.encryption, keyId: base64url(new Uint8Array(16)) } }, { ...e, timestamp: '2026-01-01T00:00:00.000Z' }]) await expect(decryptV2(key, changed)).rejects.toMatchObject({ code: 'decryption_failed' });
  expect(() => parseEnvelope({ ...e, plaintext: 'private' })).toThrow(); expect(() => parseEnvelope({ ...e, timestamp: '2026-02-31T00:00:00Z' })).toThrow();
  const damaged = decode(e.encryption.ciphertext, undefined, false); damaged[0] = damaged[0]! ^ 1;
  await expect(decryptV2(key, { ...e, encryption: { ...e.encryption, ciphertext: Buffer.from(damaged).toString('base64') } })).rejects.toMatchObject({ code: 'decryption_failed' });
});
test('typed API boundaries reject unexpected private/raw-key fields before any network request', async () => {
  const request = jest.fn(), api = new E2eeApi({ actor: { id: vector.devices.alice.userId, username: 'alice' }, request, dispose() {} });
  await expect(api.register({ ...vector.registrations.alice, privateKey: 'must never leave the client' } as Registration)).rejects.toMatchObject({ code: 'invalid_proof' });
  await expect(api.publish(vector.conversationId, { ...vector.epoch.body, rawKey: new Uint8Array(32) } as EpochBody)).rejects.toMatchObject({ code: 'invalid_proof' });
  expect(request).not.toHaveBeenCalled();
});
test('conversation parsing preserves the exact legacy contract and requires the explicit V2 response shape', () => {
  const alice = vector.devices.alice.userId, bob = vector.devices.bob.userId;
  const api = new E2eeApi({ actor: { id: alice, username: 'alice' }, request: jest.fn(), dispose() {} });
  const participants = [
    { id: alice, username: 'alice', displayName: 'Alice', avatar: 'default' },
    { id: bob, username: 'bob', displayName: 'Bob', avatar: 'default' },
  ];
  const legacy = { id: vector.conversationId, type: 'direct', participants, createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', interactionAllowed: true };
  expect(api.conversation(legacy)).toEqual(legacy);
  expect(() => api.conversation({ ...legacy, themeId: 'ocean' })).toThrow();
  const version2 = { ...legacy, participants: participants.map(participant => ({ ...participant, avatarUrl: null })),
    themeId: 'ocean', nicknames: { [bob]: 'Bobby' } };
  expect(api.conversation(version2, 2)).toMatchObject({ themeId: 'ocean', nicknames: { [bob]: 'Bobby' } });
  expect(() => api.conversation(version2)).toThrow();
  expect(() => api.conversation(legacy, 2)).toThrow();
  expect(() => api.conversation({ ...version2, unexpected: true }, 2)).toThrow();
  expect(() => api.conversation({ ...version2, nicknames: { [bob]: '\ud800' } }, 2)).toThrow();
});
test('conversation list falls back only from rejected V2 query and accepts the current extended DTO without avatarUrl', async () => {
  const alice = vector.devices.alice.userId, bob = vector.devices.bob.userId;
  const dto = { id: vector.conversationId, type: 'direct', participants: [
    { id: alice, username: 'alice', displayName: 'Alice', avatar: 'default' },
    { id: bob, username: 'bob', displayName: 'Bob', avatar: 'default' },
  ], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  interactionAllowed: true, themeId: 'ocean', nicknames: { [bob]: 'Bobby' } };
  const request = jest.fn().mockRejectedValueOnce(new ApiError('validation'))
    .mockResolvedValueOnce({ items: [dto], nextCursor: null });
  const api = new E2eeApi({ actor: { id: alice, username: 'alice' }, request, dispose() {} });

  const page = await api.conversations();
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    '/api/conversations?contractVersion=2&limit=50',
    '/api/conversations?limit=50',
  ]);
  expect(page.items[0]).toMatchObject({
    themeId: 'ocean', nicknames: { [bob]: 'Bobby' },
    participants: [{ id: alice, avatarUrl: null }, { id: bob, avatarUrl: null }],
  });

  request.mockResolvedValueOnce({ conversation: dto });
  const opened = await api.createDirect(bob);
  expect(opened.id).toBe(vector.conversationId);
  expect(opened.participants.map(participant => participant.avatarUrl)).toEqual([null, null]);
  expect(request.mock.calls[2]![0]).toBe('/api/conversations/dm');
});
test('conversation listing retains strict V2 parsing and never falls back for authorization or malformed DTOs', async () => {
  const alice = vector.devices.alice.userId, bob = vector.devices.bob.userId;
  const dto = { id: vector.conversationId, type: 'direct', participants: [
    { id: alice, username: 'alice', displayName: 'Alice', avatar: 'default', avatarUrl: null },
    { id: bob, username: 'bob', displayName: 'Bob', avatar: 'default', avatarUrl: null },
  ], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  interactionAllowed: true, themeId: 'forest', nicknames: { [bob]: 'Bobby' } };
  const request = jest.fn().mockResolvedValue({ items: [dto], nextCursor: null });
  const api = new E2eeApi({ actor: { id: alice, username: 'alice' }, request, dispose() {} });

  const page = await api.conversations();
  expect(request).toHaveBeenCalledTimes(1);
  expect(page.items[0]).toMatchObject({ themeId: 'forest', nicknames: { [bob]: 'Bobby' } });

  const unauthorized = new E2eeApi({ actor: { id: alice, username: 'alice' },
    request: jest.fn().mockRejectedValue(new ApiError('unauthorized')), dispose() {} });
  await expect(unauthorized.conversations()).rejects.toMatchObject({ code: 'unauthorized' });

  const malformed = new E2eeApi({ actor: { id: alice, username: 'alice' },
    request: jest.fn().mockRejectedValueOnce(new ApiError('validation'))
      .mockResolvedValueOnce({ items: [{ ...dto, nicknames: { 'outsider-id': 'Intruder' } }], nextCursor: null }), dispose() {} });
  await expect(malformed.conversations()).rejects.toMatchObject({ code: 'invalid_proof' });
});
test('conversation detail retries without contractVersion only when the older backend rejects the query', async () => {
  const alice = vector.devices.alice.userId, bob = vector.devices.bob.userId, id = vector.conversationId;
  const oldDto = { id, type: 'direct', participants: [
    { id: alice, username: 'alice', displayName: 'Alice', avatar: 'default' },
    { id: bob, username: 'bob', displayName: 'Bob', avatar: 'default' },
  ], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  interactionAllowed: true, themeId: 'ocean', nicknames: { [bob]: 'Bobby' } };
  const envelope = vector.message.envelope;
  const request = jest.fn().mockRejectedValueOnce(new ApiError('validation'))
    .mockResolvedValueOnce({ conversation: oldDto })
    .mockResolvedValueOnce({ items: [{
      storageId: 'stored-message-id', id: envelope.id, conversationId: id, senderId: envelope.senderId,
      senderName: envelope.senderName, timestamp: envelope.timestamp, type: envelope.type, encryption: envelope.encryption,
      storedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      sequence: 1, revision: 0, state: 'active', deletedAt: null,
    }], nextCursor: null })
    .mockResolvedValueOnce({ conversation: { ...oldDto, participants: oldDto.participants.map(p => ({ ...p, avatarUrl: null })) } });
  const api = new E2eeApi({ actor: { id: alice, username: 'alice' }, request, dispose() {} });

  const oldConversation = await api.getConversation(id);
  expect(request.mock.calls.slice(0, 2).map(([url]) => url)).toEqual([
    `/api/conversations/${id}?contractVersion=2`,
    `/api/conversations/${id}`,
  ]);
  expect(oldConversation).toMatchObject({ themeId: 'ocean', nicknames: { [bob]: 'Bobby' },
    participants: [{ id: alice, avatarUrl: null }, { id: bob, avatarUrl: null }] });

  const history = await api.history(id);
  expect(request.mock.calls[2]![0]).toBe(`/api/conversations/${id}/messages?limit=50`);
  expect(history.items[0]!.id).toBe(envelope.id);

  const version2Conversation = await api.getConversation(id);
  expect(request.mock.calls[3]![0]).toBe(`/api/conversations/${id}?contractVersion=2`);
  expect(version2Conversation.nicknames).toEqual({ [bob]: 'Bobby' });
});
test('conversation detail does not retry authorization errors or accept malformed fallback data', async () => {
  const alice = vector.devices.alice.userId, bob = vector.devices.bob.userId, id = vector.conversationId;
  const request = jest.fn().mockRejectedValue(new ApiError('unauthorized'));
  const api = new E2eeApi({ actor: { id: alice, username: 'alice' }, request, dispose() {} });
  await expect(api.getConversation(id)).rejects.toMatchObject({ code: 'unauthorized' });
  expect(request).toHaveBeenCalledTimes(1);

  const invalidDto = { id, type: 'direct', participants: [
    { id: alice, username: 'alice', displayName: 'Alice', avatar: 'default' },
    { id: bob, username: 'bob', displayName: 'Bob', avatar: 'default' },
  ], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  interactionAllowed: true, themeId: 'ocean', nicknames: { 'outsider-id': 'Intruder' } };
  const malformedRequest = jest.fn().mockRejectedValueOnce(new ApiError('validation'))
    .mockResolvedValueOnce({ conversation: invalidDto });
  const malformedApi = new E2eeApi({ actor: { id: alice, username: 'alice' }, request: malformedRequest, dispose() {} });
  await expect(malformedApi.getConversation(id)).rejects.toMatchObject({ code: 'invalid_proof' });
  expect(malformedRequest).toHaveBeenCalledTimes(2);
});
test('conversation creation and preference writes use unversioned mutations and accept the legacy extended DTO', async () => {
  const alice = vector.devices.alice.userId, bob = vector.devices.bob.userId, id = vector.conversationId;
  const dto = { id, type: 'direct', participants: [
    { id: alice, username: 'alice', displayName: 'Alice', avatar: 'default' },
    { id: bob, username: 'bob', displayName: 'Bob', avatar: 'default' },
  ], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  interactionAllowed: true, themeId: 'ocean', nicknames: { [bob]: 'Bobby' } };
  const request = jest.fn()
    .mockResolvedValueOnce({ conversation: dto })
    .mockResolvedValueOnce({ conversation: dto });
  const api = new E2eeApi({ actor: { id: alice, username: 'alice' }, request, dispose() {} });

  const created = await api.createDirect(bob);
  const saved = await api.updatePreferences(id, { themeId: 'ocean', nicknames: { [bob]: 'Bobby' } });

  expect(created.nicknames).toEqual({ [bob]: 'Bobby' });
  expect(saved.nicknames).toEqual({ [bob]: 'Bobby' });
  expect(request.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([
    ['/api/conversations/dm', 'POST'],
    [`/api/conversations/${id}/preferences`, 'PATCH'],
  ]);
  expect(request.mock.calls[0]![1]?.body).toEqual({ recipientId: bob });
  expect(request.mock.calls[1]![1]?.body).toEqual({ themeId: 'ocean', nicknames: { [bob]: 'Bobby' } });
});
test('new backend V1 mutation responses are hydrated from strict V2 detail without retrying the mutation', async () => {
  const alice = vector.devices.alice.userId, bob = vector.devices.bob.userId, id = vector.conversationId;
  const v1 = { id, type: 'direct', participants: [
    { id: alice, username: 'alice', displayName: 'Alice', avatar: 'default' },
    { id: bob, username: 'bob', displayName: 'Bob', avatar: 'default' },
  ], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', interactionAllowed: true };
  const v2 = { ...v1, participants: v1.participants.map(participant => ({ ...participant, avatarUrl: null })),
    themeId: 'forest', nicknames: { [bob]: 'Bobby' } };
  const request = jest.fn()
    .mockResolvedValueOnce({ conversation: v1 })
    .mockResolvedValueOnce({ conversation: v2 })
    .mockResolvedValueOnce({ conversation: v1 })
    .mockResolvedValueOnce({ conversation: v2 });
  const api = new E2eeApi({ actor: { id: alice, username: 'alice' }, request, dispose() {} });

  const created = await api.createDirect(bob);
  const saved = await api.updatePreferences(id, { themeId: 'forest' });

  expect(created).toMatchObject({ id, themeId: 'forest', nicknames: { [bob]: 'Bobby' } });
  expect(saved).toMatchObject({ id, themeId: 'forest', nicknames: { [bob]: 'Bobby' } });
  expect(request.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([
    ['/api/conversations/dm', 'POST'],
    [`/api/conversations/${id}?contractVersion=2`, undefined],
    [`/api/conversations/${id}/preferences`, 'PATCH'],
    [`/api/conversations/${id}?contractVersion=2`, undefined],
  ]);
});
test('conversation mutations do not retry authorization failures or accept malformed response identities', async () => {
  const alice = vector.devices.alice.userId, bob = vector.devices.bob.userId, id = vector.conversationId;
  const denied = jest.fn().mockRejectedValue(new ApiError('forbidden'));
  const deniedApi = new E2eeApi({ actor: { id: alice, username: 'alice' }, request: denied, dispose() {} });
  await expect(deniedApi.updatePreferences(id, { themeId: 'ocean' })).rejects.toMatchObject({ code: 'forbidden' });
  expect(denied).toHaveBeenCalledTimes(1);

  const malformed = { id: 'another-conversation', type: 'direct', participants: [
    { id: alice, username: 'alice', displayName: 'Alice', avatar: 'default' },
    { id: bob, username: 'bob', displayName: 'Bob', avatar: 'default' },
  ], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  interactionAllowed: true, themeId: 'ocean', nicknames: {} };
  const malformedRequest = jest.fn().mockResolvedValue({ conversation: malformed });
  const malformedApi = new E2eeApi({ actor: { id: alice, username: 'alice' }, request: malformedRequest, dispose() {} });
  await expect(malformedApi.updatePreferences(id, { themeId: 'ocean' })).rejects.toMatchObject({ code: 'invalid_proof' });
  expect(malformedRequest).toHaveBeenCalledTimes(1);
});
