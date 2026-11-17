import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, test } from 'node:test';
import { canonicalJson, decodeBase64Url, isCanonicalTimestamp } from '../../src/e2ee/codec.ts';
import { deviceKeyIdFor, importP256PublicKey } from '../../src/e2ee/keys.ts';
import { verifyStatementSignature } from '../../src/e2ee/signatures.ts';
import { compareRecipients, epochStatement, recipientSetDigest, registrationStatement, wrapInfo } from '../../src/e2ee/statements.ts';

function p256() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.of(4), Buffer.from(jwk.x as string, 'base64url'), Buffer.from(jwk.y as string, 'base64url')]);
  return { privateKey, encoded: raw.toString('base64url'), raw };
}

describe('canonical encodings', () => {
  test('base64url must be canonical, unpadded and of the exact length', () => {
    const bytes = randomBytes(16);
    const encoded = bytes.toString('base64url');
    assert.deepEqual(decodeBase64Url(encoded, 16), bytes);
    assert.equal(encoded.length, 22);
    for (const value of [`${encoded}=`, `${encoded}==`, encoded.slice(1), `${encoded}A`, encoded.replace(/./, '+'), encoded.replace(/./, '/'),
      ` ${encoded.slice(1)}`, 42, null]) {
      assert.equal(decodeBase64Url(value, 16), null, String(value));
    }
    const last = encoded.at(-1) as string;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const flipped = alphabet[(alphabet.indexOf(last) ^ 1)] as string;
    assert.equal(decodeBase64Url(`${encoded.slice(0, -1)}${flipped}`, 16), null, 'non-zero trailing bits are not canonical');
  });

  test('timestamps must be canonical UTC ISO strings with milliseconds', () => {
    assert.equal(isCanonicalTimestamp('2026-11-14T12:00:00.000Z'), true);
    for (const value of ['2026-11-14T12:00:00Z', '2026-11-14T12:00:00.000+00:00', '2026-02-30T00:00:00.000Z', '2026-11-14 12:00:00.000Z', '', 0]) {
      assert.equal(isCanonicalTimestamp(value), false, String(value));
    }
  });

  test('canonical JSON accepts only strings, safe integers, null and arrays', () => {
    assert.equal(canonicalJson(['a', 1, null, ['b', 2]]), '["a",1,null,["b",2]]');
    assert.throws(() => canonicalJson([1.5]), TypeError);
    assert.throws(() => canonicalJson([Number.MAX_SAFE_INTEGER + 1]), TypeError);
    assert.throws(() => canonicalJson([{ a: 1 } as never]), TypeError);
    assert.throws(() => canonicalJson([true as never]), TypeError);
  });
});

describe('P-256 public keys', () => {
  test('accepts uncompressed on-curve points and derives a stable key ID', () => {
    const agreement = p256();
    const signing = p256();
    assert.ok(importP256PublicKey(agreement.encoded));
    const id = deviceKeyIdFor(agreement.encoded, signing.encoded);
    assert.equal(id, deviceKeyIdFor(agreement.encoded, signing.encoded));
    assert.equal(id.length, 43);
    assert.notEqual(id, deviceKeyIdFor(signing.encoded, agreement.encoded), 'key order matters');
  });

  test('rejects off-curve, unreduced, compressed, truncated and non-canonical points', () => {
    const { raw } = p256();
    const offCurve = Buffer.from(raw);
    offCurve[64] = (offCurve[64] as number) ^ 1;
    const compressed = Buffer.concat([Buffer.of(2 + ((raw[64] as number) & 1)), raw.subarray(1, 33)]);
    const unreduced = Buffer.concat([Buffer.of(4), Buffer.alloc(32, 0xff), raw.subarray(33)]);
    const prefixed = Buffer.from(raw);
    prefixed[0] = 0x06;
    for (const candidate of [offCurve.toString('base64url'), compressed.toString('base64url'), unreduced.toString('base64url'),
      prefixed.toString('base64url'), raw.subarray(0, 64).toString('base64url'), raw.toString('base64'), `${raw.toString('base64url')}=`, Buffer.alloc(65).toString('base64url')]) {
      assert.equal(importP256PublicKey(candidate), null, candidate);
    }
  });
});

describe('statement signatures', () => {
  test('verify only the exact statement with the matching key in IEEE P1363 form', () => {
    const signer = p256();
    const other = p256();
    const statement = registrationStatement({ userId: 'user-1', deviceId: randomBytes(16).toString('base64url'), keyVersion: 1,
      createdAt: '2026-11-14T12:00:00.000Z', agreementPublicKey: other.encoded, signingPublicKey: signer.encoded });
    const signature = sign('sha256', Buffer.from(statement), { key: signer.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    assert.equal(verifyStatementSignature(signer.encoded, statement, signature), true);
    assert.equal(verifyStatementSignature(signer.encoded, statement, signature), true, 'cached result is stable');
    assert.equal(verifyStatementSignature(other.encoded, statement, signature), false);
    assert.equal(verifyStatementSignature(signer.encoded, `${statement} `, signature), false);
    const der = sign('sha256', Buffer.from(statement), signer.privateKey).toString('base64url');
    assert.equal(verifyStatementSignature(signer.encoded, statement, der), false, 'DER signatures are not accepted');
    assert.equal(verifyStatementSignature(signer.encoded, statement, Buffer.alloc(64).toString('base64url')), false);
    assert.equal(verifyStatementSignature(signer.encoded, statement, `${signature.slice(0, -2)}AA`), false);
    assert.equal(verifyStatementSignature('not-a-key', statement, signature), false);
  });
});

describe('canonical statements', () => {
  test('have fixed field order and domain labels', () => {
    assert.equal(registrationStatement({ userId: 'u', deviceId: 'd', keyVersion: 2, createdAt: 't', agreementPublicKey: 'A', signingPublicKey: 'S' }),
      '["secubuzz-device-key",1,"u","d",2,"t","A","S"]');
    assert.equal(epochStatement({ conversationId: 'c', keyId: 'k', epoch: 1, previousKeyId: null, creatorUserId: 'u', creatorDeviceKeyId: 'D',
      createdAt: 't', wraps: [{ recipientUserId: 'r', recipientDeviceKeyId: 'R', enc: 'E', ciphertext: 'C' }] }),
    '["secubuzz-conversation-key",1,"c","k",1,null,"u","D","t",[["r","R","E","C"]]]');
    assert.equal(wrapInfo({ conversationId: 'c', keyId: 'k', epoch: 3, creatorUserId: 'u', creatorDeviceKeyId: 'D', recipientUserId: 'r', recipientDeviceKeyId: 'R' }),
      '["secubuzz-conversation-key-wrap",1,"c","k",3,"u","D","r","R"]');
  });

  test('recipient order is by user then device key, and the set digest ignores input order', () => {
    const devices = [{ userId: 'b', deviceKeyId: 'x' }, { userId: 'a', deviceKeyId: 'z' }, { userId: 'a', deviceKeyId: 'y' }];
    assert.deepEqual([...devices].sort(compareRecipients), [{ userId: 'a', deviceKeyId: 'y' }, { userId: 'a', deviceKeyId: 'z' }, { userId: 'b', deviceKeyId: 'x' }]);
    assert.equal(recipientSetDigest('c', devices), recipientSetDigest('c', [...devices].reverse()));
    assert.notEqual(recipientSetDigest('c', devices), recipientSetDigest('other', devices));
  });
});
