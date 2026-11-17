/**
 * TEST-ONLY simulated browser device. It follows the protocol text (docs/e2ee-recipient-key-integration.md)
 * with WebCrypto and the test HPKE reference, and deliberately does NOT import the server's
 * canonicalization, so tests catch disagreements between an independent client and the server.
 * Private keys are generated non-extractable, as the real client must do.
 */
import { randomBytes, webcrypto } from 'node:crypto';
import { openBase, sealBase } from './hpke.ts';

if (process.env.NODE_ENV === 'production') throw new Error('Test devices must never be loaded in production.');

type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;
const subtle = webcrypto.subtle;
const encoder = new TextEncoder();
const utf8 = (value: string) => encoder.encode(value);
export const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
export const fromB64u = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'));
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

async function sha256Base64Url(text: string): Promise<string> {
  return b64u(new Uint8Array(await subtle.digest('SHA-256', utf8(text))));
}

export interface PublicDeviceKey {
  readonly deviceKeyId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly keyVersion: number;
  readonly createdAt: string;
  readonly agreementPublicKey: string;
  readonly signingPublicKey: string;
  readonly signature: string;
}

export interface WrapBody {
  readonly recipientUserId: string;
  readonly recipientDeviceKeyId: string;
  readonly enc: string;
  readonly ciphertext: string;
}

export interface EpochBody {
  readonly keyId: string;
  readonly epoch: number;
  readonly previousKeyId: string | null;
  readonly creatorDeviceKeyId: string;
  readonly createdAt: string;
  readonly wraps: readonly WrapBody[];
  readonly signature: string;
}

export interface EpochRecordLike extends EpochBody {
  readonly conversationId: string;
  readonly creatorUserId: string;
}

export interface EnvelopeV2Like {
  readonly id: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly timestamp: string;
  readonly type: 'text';
  readonly encryption: { readonly version: 2; readonly algorithm: 'AES-256-GCM'; readonly encoding: 'base64'; readonly keyId: string; readonly iv: string; readonly ciphertext: string };
}

export function deviceKeyIdOf(agreementPublicKey: string, signingPublicKey: string): Promise<string> {
  return sha256Base64Url(JSON.stringify(['secubuzz-device-key-id', 1, agreementPublicKey, signingPublicKey]));
}

const registrationText = (record: Omit<PublicDeviceKey, 'deviceKeyId' | 'signature'>) =>
  JSON.stringify(['secubuzz-device-key', 1, record.userId, record.deviceId, record.keyVersion, record.createdAt, record.agreementPublicKey, record.signingPublicKey]);

const epochText = (conversationId: string, creatorUserId: string, body: Omit<EpochBody, 'signature'>) =>
  JSON.stringify(['secubuzz-conversation-key', 1, conversationId, body.keyId, body.epoch, body.previousKeyId, creatorUserId, body.creatorDeviceKeyId,
    body.createdAt, body.wraps.map((wrap) => [wrap.recipientUserId, wrap.recipientDeviceKeyId, wrap.enc, wrap.ciphertext])]);

const wrapText = (conversationId: string, keyId: string, epoch: number, creatorUserId: string, creatorDeviceKeyId: string, recipient: PublicDeviceKey) =>
  JSON.stringify(['secubuzz-conversation-key-wrap', 1, conversationId, keyId, epoch, creatorUserId, creatorDeviceKeyId, recipient.userId, recipient.deviceKeyId]);

export const messageAadText = (envelope: Pick<EnvelopeV2Like, 'conversationId' | 'id' | 'senderId' | 'senderName' | 'timestamp'> & { keyId: string }) =>
  JSON.stringify(['yahoo-security-messenger', 2, envelope.conversationId, envelope.id, envelope.senderId, envelope.senderName, envelope.timestamp, 'text', envelope.keyId]);

const ordered = (devices: readonly PublicDeviceKey[]) => [...devices].sort((left, right) =>
  left.userId !== right.userId ? (left.userId < right.userId ? -1 : 1) : left.deviceKeyId < right.deviceKeyId ? -1 : left.deviceKeyId > right.deviceKeyId ? 1 : 0);

async function importVerifyKey(encoded: string): Promise<CryptoKey> {
  return subtle.importKey('raw', fromB64u(encoded), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

async function verifySignature(encodedKey: string, text: string, signature: string): Promise<boolean> {
  try {
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await importVerifyKey(encodedKey), fromB64u(signature), utf8(text));
  } catch {
    return false;
  }
}

/** Client-side checks a recipient performs before trusting a device record. */
export async function verifyDeviceRecord(device: PublicDeviceKey): Promise<boolean> {
  return device.deviceKeyId === await deviceKeyIdOf(device.agreementPublicKey, device.signingPublicKey) &&
    verifySignature(device.signingPublicKey, registrationText(device), device.signature);
}

export class TestDevice {
  readonly userId: string;
  readonly deviceId: string;
  readonly keyVersion: number;
  readonly agreementPublicKey: string;
  readonly signingPublicKey: string;
  readonly deviceKeyId: string;
  readonly #signing: CryptoKeyPair;
  readonly #agreement: CryptoKeyPair;

  private constructor(userId: string, deviceId: string, keyVersion: number, signing: CryptoKeyPair, agreement: CryptoKeyPair,
    signingPublicKey: string, agreementPublicKey: string, deviceKeyId: string) {
    this.userId = userId;
    this.deviceId = deviceId;
    this.keyVersion = keyVersion;
    this.#signing = signing;
    this.#agreement = agreement;
    this.signingPublicKey = signingPublicKey;
    this.agreementPublicKey = agreementPublicKey;
    this.deviceKeyId = deviceKeyId;
  }

  static async create(userId: string, options: { deviceId?: string; keyVersion?: number } = {}): Promise<TestDevice> {
    const signing = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
    const agreement = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as CryptoKeyPair;
    if (signing.privateKey.extractable || agreement.privateKey.extractable) throw new Error('Private keys must be non-extractable.');
    const signingPublicKey = b64u(new Uint8Array(await subtle.exportKey('raw', signing.publicKey)));
    const agreementPublicKey = b64u(new Uint8Array(await subtle.exportKey('raw', agreement.publicKey)));
    return new TestDevice(userId, options.deviceId ?? b64u(randomBytes(16)), options.keyVersion ?? 1, signing, agreement,
      signingPublicKey, agreementPublicKey, await deviceKeyIdOf(agreementPublicKey, signingPublicKey));
  }

  /** New key pairs for the same device, one version higher. */
  rotate(): Promise<TestDevice> {
    return TestDevice.create(this.userId, { deviceId: this.deviceId, keyVersion: this.keyVersion + 1 });
  }

  /** Same device key, presented as another user's (cross-user substitution attempt). */
  async signRegistrationAs(userId: string, createdAt: string = new Date().toISOString()) {
    const fields = { userId, deviceId: this.deviceId, keyVersion: this.keyVersion, createdAt, agreementPublicKey: this.agreementPublicKey, signingPublicKey: this.signingPublicKey };
    return { deviceId: fields.deviceId, keyVersion: fields.keyVersion, createdAt, agreementPublicKey: fields.agreementPublicKey,
      signingPublicKey: fields.signingPublicKey, signature: await this.sign(registrationText(fields)) };
  }

  /** `POST /api/keys/devices` body. */
  registration(createdAt: string = new Date().toISOString()) {
    return this.signRegistrationAs(this.userId, createdAt);
  }

  async sign(text: string): Promise<string> {
    return b64u(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.#signing.privateKey, utf8(text))));
  }

  /**
   * Creates an epoch for `devices` (all active devices of both participants, as the directory
   * reported them). Verifies every device record first, as a real client must.
   */
  async createEpoch(input: { conversationId: string; epoch: number; previousKeyId: string | null; devices: readonly PublicDeviceKey[];
    createdAt?: string; keyId?: string; /** Test hook: a copy of the raw key, for "never stored" assertions. */ revealRawKey?: (raw: Uint8Array) => void }): Promise<{ body: EpochBody; key: CryptoKey }> {
    for (const device of input.devices) if (!await verifyDeviceRecord(device)) throw new Error('Refusing an unverified device record.');
    const keyId = input.keyId ?? b64u(randomBytes(16));
    const createdAt = input.createdAt ?? new Date().toISOString();
    const raw = new Uint8Array(randomBytes(32));
    input.revealRawKey?.(Uint8Array.from(raw));
    try {
      const wraps: WrapBody[] = [];
      for (const recipient of ordered(input.devices)) {
        const sealed = await sealBase({ recipientPublicKey: fromB64u(recipient.agreementPublicKey), aad: new Uint8Array(0), plaintext: raw,
          info: utf8(wrapText(input.conversationId, keyId, input.epoch, this.userId, this.deviceKeyId, recipient)) });
        wraps.push({ recipientUserId: recipient.userId, recipientDeviceKeyId: recipient.deviceKeyId, enc: b64u(sealed.enc), ciphertext: b64u(sealed.ciphertext) });
      }
      const unsigned = { keyId, epoch: input.epoch, previousKeyId: input.previousKeyId, creatorDeviceKeyId: this.deviceKeyId, createdAt, wraps };
      const signature = await this.sign(epochText(input.conversationId, this.userId, unsigned));
      const key = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
      return { body: { ...unsigned, signature }, key };
    } finally {
      raw.fill(0);
    }
  }

  /**
   * Opens this device's wrap after verifying the creator's device record and the epoch signature.
   * `devices` is the directory's device list; the creator must be in it.
   */
  async openEpoch(epoch: EpochRecordLike, devices: readonly PublicDeviceKey[]): Promise<CryptoKey> {
    const creator = devices.find((device) => device.deviceKeyId === epoch.creatorDeviceKeyId && device.userId === epoch.creatorUserId);
    if (!creator || !await verifyDeviceRecord(creator)) throw new Error('Unknown or unverified creator device.');
    if (!await verifySignature(creator.signingPublicKey, epochText(epoch.conversationId, epoch.creatorUserId, epoch), epoch.signature)) {
      throw new Error('Epoch signature is invalid.');
    }
    const own = epoch.wraps.find((wrap) => wrap.recipientDeviceKeyId === this.deviceKeyId && wrap.recipientUserId === this.userId);
    if (!own) throw new Error('No wrap for this device.');
    const self: PublicDeviceKey = { deviceKeyId: this.deviceKeyId, userId: this.userId, deviceId: this.deviceId, keyVersion: this.keyVersion,
      createdAt: '', agreementPublicKey: this.agreementPublicKey, signingPublicKey: this.signingPublicKey, signature: '' };
    const raw = await openBase({ enc: fromB64u(own.enc), recipientPrivateKey: this.#agreement.privateKey, recipientPublicKey: fromB64u(this.agreementPublicKey),
      info: utf8(wrapText(epoch.conversationId, epoch.keyId, epoch.epoch, epoch.creatorUserId, epoch.creatorDeviceKeyId, self)),
      aad: new Uint8Array(0), ciphertext: fromB64u(own.ciphertext) });
    try {
      return await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    } finally {
      raw.fill(0);
    }
  }

  /** Tries to open a wrap addressed to another device (unauthorized access attempt). */
  async openWrapOf(epoch: EpochRecordLike, wrap: WrapBody, claimed: PublicDeviceKey): Promise<Uint8Array> {
    return openBase({ enc: fromB64u(wrap.enc), recipientPrivateKey: this.#agreement.privateKey, recipientPublicKey: fromB64u(this.agreementPublicKey),
      info: utf8(wrapText(epoch.conversationId, epoch.keyId, epoch.epoch, epoch.creatorUserId, epoch.creatorDeviceKeyId, claimed)),
      aad: new Uint8Array(0), ciphertext: fromB64u(wrap.ciphertext) });
  }

  async encrypt(key: CryptoKey, keyId: string, message: { conversationId: string; id: string; senderName: string; timestamp?: string }, plaintext: string,
    iv: Uint8Array = new Uint8Array(randomBytes(12))): Promise<EnvelopeV2Like> {
    const timestamp = message.timestamp ?? new Date().toISOString();
    const aad = utf8(messageAadText({ conversationId: message.conversationId, id: message.id, senderId: this.userId, senderName: message.senderName, timestamp, keyId }));
    const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, utf8(plaintext)));
    return { id: message.id, conversationId: message.conversationId, senderId: this.userId, senderName: message.senderName, timestamp, type: 'text',
      encryption: { version: 2, algorithm: 'AES-256-GCM', encoding: 'base64', keyId, iv: b64(iv), ciphertext: b64(ciphertext) } };
  }

  static async decrypt(key: CryptoKey, envelope: EnvelopeV2Like): Promise<string> {
    const aad = utf8(messageAadText({ ...envelope, keyId: envelope.encryption.keyId }));
    const plaintext = await subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(envelope.encryption.iv, 'base64'), additionalData: aad, tagLength: 128 },
      key, Buffer.from(envelope.encryption.ciphertext, 'base64'));
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  }
}

/** Trust on first use: what a client remembers about each peer's device keys. */
export class TrustStore {
  readonly #pins = new Map<string, Set<string>>();

  /** `first_use` pins silently; `changed` must be shown to the user before any new epoch is sent. */
  observe(userId: string, deviceKeyIds: readonly string[]): { status: 'first_use' | 'unchanged' | 'changed'; added: string[]; removed: string[] } {
    const current = new Set(deviceKeyIds);
    const pinned = this.#pins.get(userId);
    if (!pinned) {
      this.#pins.set(userId, current);
      return { status: 'first_use', added: [...current], removed: [] };
    }
    const added = [...current].filter((id) => !pinned.has(id));
    const removed = [...pinned].filter((id) => !current.has(id));
    return { status: added.length || removed.length ? 'changed' : 'unchanged', added, removed };
  }

  accept(userId: string, deviceKeyIds: readonly string[]): void {
    this.#pins.set(userId, new Set(deviceKeyIds));
  }
}
