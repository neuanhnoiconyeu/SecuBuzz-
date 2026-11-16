import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AEADS, generateEphemeralKey, importEcdhPrivateKey, openBase, sealBase } from './support/hpke.ts';

const hex = (value: string) => new Uint8Array(Buffer.from(value.replace(/\s+/g, ''), 'hex'));
const toHex = (value: Uint8Array) => Buffer.from(value).toString('hex');

/** RFC 9180 Appendix A.3.1: DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, mode_base. */
const A31 = {
  info: hex('4f6465206f6e2061204772656369616e2055726e'),
  pkEm: hex(`04a92719c6195d5085104f469a8b9814d5838ff72b60501e2c4466e5e67b32
    5ac98536d7b61a1af4b78e5b7f951c0900be863c403ce65c9bfcb9382657222d18c4`),
  skEm: hex('4995788ef4b9d6132b249ce59a77281493eb39af373d236a1fe415cb0c2d7beb'),
  pkRm: hex(`04fe8c19ce0905191ebc298a9245792531f26f0cece2460639e8bc39cb7f70
    6a826a779b4cf969b8a0e539c7f62fb3d30ad6aa8f80e30f1d128aafd68a2ce72ea0`),
  skRm: hex('f3ce7fdae57e1a310d87f1ebbde6f328be0a99cdbcadf4d6589cf29de4b8ffd2'),
  enc: `04a92719c6195d5085104f469a8b9814d5838ff72b60501e2c4466e5e67b325
    ac98536d7b61a1af4b78e5b7f951c0900be863c403ce65c9bfcb9382657222d18c4`,
  sharedSecret: 'c0d26aeab536609a572b07695d933b589dcf363ff9d93c93adea537aeabb8cb8',
  keyScheduleContext: `00b88d4e6d91759e65e87c470e8b9141113e9ad5f0c8ce
    efc1e088c82e6980500798e486f9c9c09c9b5c753ac72d6005de254c607d1b534ed1
    1d493ae1c1d9ac85`,
  secret: '2eb7b6bf138f6b5aff857414a058a3f1750054a9ba1f72c2cf0684a6f20b10e1',
  key: '868c066ef58aae6dc589b6cfdd18f97e',
  baseNonce: '4e0bc5018beba4bf004cca59',
  exporterSecret: '14ad94af484a7ad3ef40e9f3be99ecc6fa9036df9d4920548424df127ee0d99f',
  pt: hex('4265617574792069732074727574682c20747275746820626561757479'),
  aad: hex('436f756e742d30'),
  ct: `5ad590bb8baa577f8619db35a36311226a896e7342a6d836d8b7bcd2f20b6c7f
    9076ac232e3ab2523f39513434`,
};
const strip = (value: string) => value.replace(/\s+/g, '');

describe('test-only HPKE reference', () => {
  test('matches RFC 9180 A.3.1 (DHKEM P-256, HKDF-SHA256, AES-128-GCM) at every step', async () => {
    const ephemeral = { privateKey: await importEcdhPrivateKey(A31.skEm, A31.pkEm), publicKey: A31.pkEm };
    const sealed = await sealBase({ recipientPublicKey: A31.pkRm, info: A31.info, aad: A31.aad, plaintext: A31.pt, aead: AEADS.aes128gcm, ephemeral });
    assert.equal(toHex(sealed.enc), strip(A31.enc));
    assert.equal(toHex(sealed.sharedSecret), A31.sharedSecret);
    assert.equal(toHex(sealed.schedule.context), strip(A31.keyScheduleContext));
    assert.equal(toHex(sealed.schedule.secret), A31.secret);
    assert.equal(toHex(sealed.schedule.key), A31.key);
    assert.equal(toHex(sealed.schedule.baseNonce), A31.baseNonce);
    assert.equal(toHex(sealed.schedule.exporterSecret), A31.exporterSecret);
    assert.equal(toHex(sealed.ciphertext), strip(A31.ct));
    const opened = await openBase({ enc: sealed.enc, recipientPrivateKey: await importEcdhPrivateKey(A31.skRm, A31.pkRm), recipientPublicKey: A31.pkRm,
      info: A31.info, aad: A31.aad, ciphertext: sealed.ciphertext, aead: AEADS.aes128gcm });
    assert.deepEqual(opened, A31.pt);
  });

  test('AES-256-GCM round trip fails for another recipient, other info, other aad or tampering', async () => {
    const recipient = await generateEphemeralKey();
    const other = await generateEphemeralKey();
    const info = new TextEncoder().encode('context');
    const plaintext = new Uint8Array(32).fill(7);
    const sealed = await sealBase({ recipientPublicKey: recipient.publicKey, info, aad: new Uint8Array(0), plaintext });
    assert.equal(sealed.enc.length, 65);
    assert.equal(sealed.ciphertext.length, 48);
    const open = (overrides: Partial<Parameters<typeof openBase>[0]>) => openBase({ enc: sealed.enc, recipientPrivateKey: recipient.privateKey,
      recipientPublicKey: recipient.publicKey, info, aad: new Uint8Array(0), ciphertext: sealed.ciphertext, ...overrides });
    assert.deepEqual(await open({}), plaintext);
    await assert.rejects(open({ recipientPrivateKey: other.privateKey, recipientPublicKey: other.publicKey }));
    await assert.rejects(open({ info: new TextEncoder().encode('other context') }));
    await assert.rejects(open({ aad: Uint8Array.of(1) }));
    const tampered = Uint8Array.from(sealed.ciphertext);
    tampered[0] = (tampered[0] as number) ^ 1;
    await assert.rejects(open({ ciphertext: tampered }));
  });
});
