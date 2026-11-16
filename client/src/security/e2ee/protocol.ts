import { E2eeError, type DeviceRecord, type EnvelopeV2, type KeyEpoch, type WrappedKey } from './model';
import { isTimestamp } from '@/realtime/realtimeValidation';
const utf8 = new TextEncoder();
export const encode = (value: string): Uint8Array<ArrayBuffer> => utf8.encode(value);
export function base64(bytes: Uint8Array): string { let binary = ''; for (const b of bytes) binary += String.fromCharCode(b); return btoa(binary); }
export const base64url = (bytes: Uint8Array): string => base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function decode(value: unknown, length?: number, url = true): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !value || value.length > 65536 || !(url ? /^[A-Za-z0-9_-]+$/ : /^[A-Za-z0-9+/]+={0,2}$/).test(value)) throw new E2eeError('invalid_proof');
  try { const raw = atob(url ? value.replace(/-/g, '+').replace(/_/g, '/') : value); const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
    if ((url ? base64url(bytes) : base64(bytes)) !== value || (length !== undefined && bytes.length !== length)) throw new Error(); return bytes;
  } catch { throw new E2eeError('invalid_proof'); }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new E2eeError('invalid_proof');
  const prototype = Object.getPrototypeOf(value);
  const plain = prototype === null || (Object.getPrototypeOf(prototype) === null &&
    typeof prototype.constructor === 'function' && Function.prototype.toString.call(prototype.constructor) === Function.prototype.toString.call(Object));
  if (!plain) throw new E2eeError('invalid_proof');
  return value as Record<string, unknown>;
}
export function exact(value: unknown, keys: string[]): Record<string, unknown> {
  const r = object(value); if (Reflect.ownKeys(r).length !== keys.length || keys.some(k => !Object.prototype.hasOwnProperty.call(r, k))) throw new E2eeError('invalid_proof'); return r;
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 256 || /[\s\u0000-\u001f\u007f-\u009f\p{Cs}]/u.test(value)) throw new E2eeError('invalid_proof'); return value;
}
export function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new E2eeError('invalid_proof'); return value;
}
export async function digest(text: string): Promise<string> { return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encode(text)))); }
export const deviceKeyIdFor = (agreement: string, signing: string) => digest(JSON.stringify(['secubuzz-device-key-id', 1, agreement, signing]));
export const registrationStatement = (d: Pick<DeviceRecord, 'userId' | 'deviceId' | 'keyVersion' | 'createdAt' | 'agreementPublicKey' | 'signingPublicKey'>): string =>
  JSON.stringify(['secubuzz-device-key', 1, d.userId, d.deviceId, d.keyVersion, d.createdAt, d.agreementPublicKey, d.signingPublicKey]);
export const epochStatement = (e: Omit<KeyEpoch, 'signature' | 'publishedAt'>): string => JSON.stringify(['secubuzz-conversation-key', 1, e.conversationId, e.keyId, e.epoch, e.previousKeyId,
  e.creatorUserId, e.creatorDeviceKeyId, e.createdAt, e.wraps.map(w => [w.recipientUserId, w.recipientDeviceKeyId, w.enc, w.ciphertext])]);
export const wrapInfo = (e: Pick<KeyEpoch, 'conversationId' | 'keyId' | 'epoch' | 'creatorUserId' | 'creatorDeviceKeyId'>, w: Pick<WrappedKey, 'recipientUserId' | 'recipientDeviceKeyId'>): Uint8Array<ArrayBuffer> =>
  encode(JSON.stringify(['secubuzz-conversation-key-wrap', 1, e.conversationId, e.keyId, e.epoch, e.creatorUserId, e.creatorDeviceKeyId, w.recipientUserId, w.recipientDeviceKeyId]));
export const messageAad = (e: EnvelopeV2): Uint8Array<ArrayBuffer> => encode(JSON.stringify(['yahoo-security-messenger', 2, e.conversationId, e.id, e.senderId, e.senderName, e.timestamp, 'text', e.encryption.keyId]));
export const recipientOrder = (a: { userId: string; deviceKeyId: string }, b: { userId: string; deviceKeyId: string }): number =>
  a.userId !== b.userId ? (a.userId < b.userId ? -1 : 1) : a.deviceKeyId < b.deviceKeyId ? -1 : a.deviceKeyId > b.deviceKeyId ? 1 : 0;
export async function importPoint(value: unknown, signing: boolean): Promise<CryptoKey> {
  const point = decode(value, 65), prime = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
  const number = (b: Uint8Array) => BigInt('0x' + [...b].map(n => n.toString(16).padStart(2, '0')).join(''));
  if (point[0] !== 4 || number(point.slice(1, 33)) >= prime || number(point.slice(33)) >= prime) throw new E2eeError('invalid_proof');
  try { return await crypto.subtle.importKey('raw', point, { name: signing ? 'ECDSA' : 'ECDH', namedCurve: 'P-256' }, true, signing ? ['verify'] : []); }
  catch { throw new E2eeError('invalid_proof'); }
}
export async function verifySignature(key: string, statement: string, signature: string): Promise<void> {
  try { if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await importPoint(key, true), decode(signature, 64), encode(statement))) throw new Error(); }
  catch { throw new E2eeError('invalid_proof'); }
}
export async function sign(key: CryptoKey, statement: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encode(statement))));
}
export async function verifyDevice(input: unknown): Promise<DeviceRecord> {
  const d = exact(input, ['deviceKeyId', 'userId', 'deviceId', 'keyVersion', 'createdAt', 'agreementPublicKey', 'signingPublicKey', 'signature', 'status', 'registeredAt']);
  identifier(d.userId); decode(d.deviceId, 16); decode(d.deviceKeyId, 32); timestamp(d.createdAt); timestamp(d.registeredAt);
  if (!Number.isInteger(d.keyVersion) || (d.keyVersion as number) < 1 || (d.keyVersion as number) > 1000000 || !['active', 'superseded', 'revoked'].includes(d.status as string) || d.agreementPublicKey === d.signingPublicKey) throw new E2eeError('invalid_proof');
  await importPoint(d.agreementPublicKey, false); await importPoint(d.signingPublicKey, true);
  if (await deviceKeyIdFor(d.agreementPublicKey as string, d.signingPublicKey as string) !== d.deviceKeyId) throw new E2eeError('invalid_proof');
  const result = d as unknown as DeviceRecord; await verifySignature(result.signingPublicKey, registrationStatement(result), result.signature); return Object.freeze({ ...result });
}
export function parseEpoch(input: unknown, cid: string): KeyEpoch {
  const e = exact(input, ['conversationId', 'keyId', 'epoch', 'previousKeyId', 'creatorUserId', 'creatorDeviceKeyId', 'createdAt', 'wraps', 'signature', 'publishedAt']);
  if (e.conversationId !== cid) throw new E2eeError('invalid_proof'); identifier(e.creatorUserId); decode(e.keyId, 16); decode(e.creatorDeviceKeyId, 32); decode(e.signature, 64); timestamp(e.createdAt); timestamp(e.publishedAt);
  if (!Number.isInteger(e.epoch) || (e.epoch as number) < 1 || (e.epoch as number) > 1000000000 || ((e.epoch === 1) !== (e.previousKeyId === null))) throw new E2eeError('invalid_proof');
  if (e.previousKeyId !== null) decode(e.previousKeyId, 16);
  if (!Array.isArray(e.wraps) || !e.wraps.length || e.wraps.length > 20) throw new E2eeError('invalid_proof');
  const wraps = e.wraps.map(w => { const r = exact(w, ['recipientUserId', 'recipientDeviceKeyId', 'enc', 'ciphertext']); identifier(r.recipientUserId); decode(r.recipientDeviceKeyId, 32); decode(r.ciphertext, 48); decode(r.enc, 65); return { ...r } as unknown as WrappedKey; });
  for (let i = 1; i < wraps.length; i++) { const a = wraps[i - 1]!, b = wraps[i]!;
    if (recipientOrder({ userId: a.recipientUserId, deviceKeyId: a.recipientDeviceKeyId }, { userId: b.recipientUserId, deviceKeyId: b.recipientDeviceKeyId }) >= 0) throw new E2eeError('invalid_proof'); }
  return { ...e, wraps } as unknown as KeyEpoch;
}
export function parseEnvelope(input: unknown): EnvelopeV2 {
  const e = exact(input, ['id', 'conversationId', 'senderId', 'senderName', 'timestamp', 'type', 'encryption']);
  identifier(e.id); identifier(e.conversationId); identifier(e.senderId);
  if (typeof e.senderName !== 'string' || !e.senderName.trim() || e.senderName.length > 160 || /[\u0000-\u001f\u007f-\u009f\p{Cs}]/u.test(e.senderName) || e.type !== 'text') throw new E2eeError('invalid_message');
  // DATA accepts explicit-zone ISO; do not rewrite historical authenticated bytes.
  if (!isTimestamp(e.timestamp)) throw new E2eeError('invalid_message');
  const x = exact(e.encryption, ['version', 'algorithm', 'encoding', 'keyId', 'iv', 'ciphertext']);
  if (x.version !== 2 || x.algorithm !== 'AES-256-GCM' || x.encoding !== 'base64') throw new E2eeError('invalid_message');
  decode(x.keyId, 16); decode(x.iv, 12, false); if (decode(x.ciphertext, undefined, false).length <= 16) throw new E2eeError('invalid_message');
  return { ...e, encryption: { ...x } } as unknown as EnvelopeV2;
}
