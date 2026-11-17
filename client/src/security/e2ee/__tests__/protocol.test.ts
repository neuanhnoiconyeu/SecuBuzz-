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
