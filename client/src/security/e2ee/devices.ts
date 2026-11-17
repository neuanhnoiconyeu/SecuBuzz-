import { E2eeError, type DeviceIdentity, type DeviceRecord, type Registration } from './model';
import { base64url, decode, deviceKeyIdFor, encode, registrationStatement, sign, verifySignature } from './protocol';

export async function generateDevice(userId: string): Promise<DeviceIdentity> {
  const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const agreement = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const agreementPublicKey = base64url(new Uint8Array(await crypto.subtle.exportKey('raw', agreement.publicKey)));
  const signingPublicKey = base64url(new Uint8Array(await crypto.subtle.exportKey('raw', signing.publicKey)));
  return { schema: 1, userId, deviceId: base64url(crypto.getRandomValues(new Uint8Array(16))), keyVersion: 1,
    deviceKeyId: await deviceKeyIdFor(agreementPublicKey, signingPublicKey), signing, agreement, agreementPublicKey, signingPublicKey };
}
export async function validateLocalDevice(d: DeviceIdentity, userId: string): Promise<void> {
  try {
    decode(d?.deviceId, 16); decode(d?.deviceKeyId, 32);
    if (!d || d.schema !== 1 || d.userId !== userId || d.keyVersion !== 1 || !d.deviceId || d.signing.privateKey.extractable || d.agreement.privateKey.extractable ||
      d.signing.privateKey.algorithm.name !== 'ECDSA' || d.agreement.privateKey.algorithm.name !== 'ECDH' ||
      !d.signing.privateKey.usages.includes('sign') || !d.agreement.privateKey.usages.includes('deriveBits') ||
      await deviceKeyIdFor(d.agreementPublicKey, d.signingPublicKey) !== d.deviceKeyId ||
      base64url(new Uint8Array(await crypto.subtle.exportKey('raw', d.agreement.publicKey))) !== d.agreementPublicKey ||
      base64url(new Uint8Array(await crypto.subtle.exportKey('raw', d.signing.publicKey))) !== d.signingPublicKey) throw new Error();
    const challenge = base64url(crypto.getRandomValues(new Uint8Array(32)));
    await verifySignature(d.signingPublicKey, challenge, await sign(d.signing.privateKey, challenge));
    const peer = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    let a: Uint8Array | undefined, b: Uint8Array | undefined;
    try {
      a = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer.publicKey }, d.agreement.privateKey, 256));
      b = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: d.agreement.publicKey }, peer.privateKey, 256));
      if (!a.every((v, i) => v === b![i])) throw new Error();
    } finally { a?.fill(0); b?.fill(0); }
  } catch { throw new E2eeError('storage_corrupt'); }
}
export async function registration(d: DeviceIdentity): Promise<Registration> {
  const fields = { userId: d.userId, deviceId: d.deviceId, keyVersion: d.keyVersion, createdAt: new Date().toISOString(), agreementPublicKey: d.agreementPublicKey, signingPublicKey: d.signingPublicKey };
  const { userId: _userId, ...body } = fields;
  return { ...body, signature: await sign(d.signing.privateKey, registrationStatement(fields)) };
}
export function matchesDevice(d: DeviceIdentity, r: DeviceRecord): boolean {
  return r.userId === d.userId && r.deviceKeyId === d.deviceKeyId && r.deviceId === d.deviceId && r.keyVersion === d.keyVersion &&
    r.agreementPublicKey === d.agreementPublicKey && r.signingPublicKey === d.signingPublicKey;
}
export async function safetyNumber(devices: DeviceRecord[], participantIds: string[]): Promise<string> {
  const statement = JSON.stringify(['secubuzz-safety-number', 1, [...participantIds].sort().map(id => [id, devices.filter(d => d.userId === id).map(d => d.deviceKeyId).sort()])]);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encode(statement)));
  return [...hash].map(b => b.toString(16).padStart(2, '0')).join('').match(/.{4}/g)!.join(' ');
}
