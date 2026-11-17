/**
 * TEST-ONLY reference implementation of HPKE (RFC 9180) mode_base, single-shot, for
 * DHKEM(P-256, HKDF-SHA256) with HKDF-SHA256 and AES-128-GCM or AES-256-GCM, built on WebCrypto.
 * It is checked against RFC 9180 Appendix A.3.1 in hpke.test.ts before the flow tests use it.
 * The server never wraps or unwraps keys; the client must use a maintained HPKE library.
 */
import { createHmac, webcrypto } from 'node:crypto';

if (process.env.NODE_ENV === 'production') throw new Error('Test-only HPKE must never be loaded in production.');

type CryptoKey = webcrypto.CryptoKey;
const subtle = webcrypto.subtle;
const encoder = new TextEncoder();

export const AEADS = Object.freeze({
  aes128gcm: Object.freeze({ id: 0x0001, keyLength: 16 }),
  aes256gcm: Object.freeze({ id: 0x0002, keyLength: 32 }),
});
export type Aead = (typeof AEADS)[keyof typeof AEADS];

const KEM_ID = 0x0010;
const KDF_ID = 0x0001;
const SECRET_LENGTH = 32;
const NONCE_LENGTH = 12;
const HASH_LENGTH = 32;
const EMPTY = new Uint8Array(0);

function i2osp(value: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    out[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  return out;
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const text = (value: string) => encoder.encode(value);
const KEM_SUITE = concat(text('KEM'), i2osp(KEM_ID, 2));
const hpkeSuite = (aead: Aead) => concat(text('HPKE'), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(aead.id, 2));

function hmac(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac('sha256', key).update(data).digest());
}

/** RFC 5869 Extract; an empty salt means HashLen zero bytes. */
function extract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
  return hmac(salt.length > 0 ? salt : new Uint8Array(HASH_LENGTH), ikm);
}

function expand(prk: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  const blocks: Uint8Array[] = [];
  let previous: Uint8Array = EMPTY;
  for (let counter = 1, produced = 0; produced < length; counter += 1) {
    previous = hmac(prk, concat(previous, info, Uint8Array.of(counter)));
    blocks.push(previous);
    produced += previous.length;
  }
  return concat(...blocks).slice(0, length);
}

function labeledExtract(suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Uint8Array {
  return extract(salt, concat(text('HPKE-v1'), suite, text(label), ikm));
}

function labeledExpand(suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number): Uint8Array {
  return expand(prk, concat(i2osp(length, 2), text('HPKE-v1'), suite, text(label), info), length);
}

async function importPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

async function diffieHellman(privateKey: CryptoKey, publicKey: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: await importPublicKey(publicKey) }, privateKey, 256));
}

function extractAndExpand(dh: Uint8Array, kemContext: Uint8Array): Uint8Array {
  return labeledExpand(KEM_SUITE, labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', dh), 'shared_secret', kemContext, SECRET_LENGTH);
}

export interface EphemeralKey {
  readonly privateKey: CryptoKey;
  /** Uncompressed point. */
  readonly publicKey: Uint8Array;
}

export async function generateEphemeralKey(): Promise<EphemeralKey> {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as webcrypto.CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)) };
}

export interface KeySchedule {
  readonly context: Uint8Array;
  readonly secret: Uint8Array;
  readonly key: Uint8Array;
  readonly baseNonce: Uint8Array;
  readonly exporterSecret: Uint8Array;
}

export function keySchedule(sharedSecret: Uint8Array, info: Uint8Array, aead: Aead): KeySchedule {
  const suite = hpkeSuite(aead);
  const pskIdHash = labeledExtract(suite, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = labeledExtract(suite, EMPTY, 'info_hash', info);
  const context = concat(Uint8Array.of(0x00), pskIdHash, infoHash);
  const secret = labeledExtract(suite, sharedSecret, 'secret', EMPTY);
  return {
    context,
    secret,
    key: labeledExpand(suite, secret, 'key', context, aead.keyLength),
    baseNonce: labeledExpand(suite, secret, 'base_nonce', context, NONCE_LENGTH),
    exporterSecret: labeledExpand(suite, secret, 'exp', context, HASH_LENGTH),
  };
}

export interface SealInput {
  /** Recipient public key, uncompressed point. */
  readonly recipientPublicKey: Uint8Array;
  readonly info: Uint8Array;
  readonly aad: Uint8Array;
  readonly plaintext: Uint8Array;
  readonly aead?: Aead;
  /** Injected only for deterministic test vectors. */
  readonly ephemeral?: EphemeralKey;
}

export interface SealResult {
  readonly enc: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly sharedSecret: Uint8Array;
  readonly schedule: KeySchedule;
}

async function aesGcm(mode: 'encrypt' | 'decrypt', key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const imported = await subtle.importKey('raw', key, 'AES-GCM', false, [mode]);
  const params = { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 };
  return new Uint8Array(mode === 'encrypt' ? await subtle.encrypt(params, imported, data) : await subtle.decrypt(params, imported, data));
}

/** SealBase with sequence number 0 (one message per context). */
export async function sealBase(input: SealInput): Promise<SealResult> {
  const aead = input.aead ?? AEADS.aes256gcm;
  const ephemeral = input.ephemeral ?? await generateEphemeralKey();
  const dh = await diffieHellman(ephemeral.privateKey, input.recipientPublicKey);
  const enc = ephemeral.publicKey;
  const sharedSecret = extractAndExpand(dh, concat(enc, input.recipientPublicKey));
  const schedule = keySchedule(sharedSecret, input.info, aead);
  const ciphertext = await aesGcm('encrypt', schedule.key, schedule.baseNonce, input.aad, input.plaintext);
  return { enc, ciphertext, sharedSecret, schedule };
}

export interface OpenInput {
  readonly enc: Uint8Array;
  readonly recipientPrivateKey: CryptoKey;
  readonly recipientPublicKey: Uint8Array;
  readonly info: Uint8Array;
  readonly aad: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly aead?: Aead;
}

/** OpenBase with sequence number 0. Rejects (OperationError) when authentication fails. */
export async function openBase(input: OpenInput): Promise<Uint8Array> {
  const aead = input.aead ?? AEADS.aes256gcm;
  const dh = await diffieHellman(input.recipientPrivateKey, input.enc);
  const sharedSecret = extractAndExpand(dh, concat(input.enc, input.recipientPublicKey));
  const schedule = keySchedule(sharedSecret, input.info, aead);
  return aesGcm('decrypt', schedule.key, schedule.baseNonce, input.aad, input.ciphertext);
}

/** Imports a raw P-256 private scalar (with its public point) as a non-extractable ECDH key. */
export async function importEcdhPrivateKey(privateScalar: Uint8Array, publicPoint: Uint8Array): Promise<CryptoKey> {
  const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
  return subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: b64u(privateScalar), x: b64u(publicPoint.subarray(1, 33)), y: b64u(publicPoint.subarray(33, 65)),
  }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}
