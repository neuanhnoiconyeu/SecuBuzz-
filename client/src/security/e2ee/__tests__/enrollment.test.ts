/** @jest-environment node */
import { randomUUID, webcrypto } from 'node:crypto';
import { indexedDB } from 'fake-indexeddb';
import { ApiError, type ApiRequest } from '@/api/sessionApi';
import { generateDevice, registration } from '../devices';
import { type DeviceIdentity, type DeviceRecord } from '../model';
import { deviceKeyIdFor } from '../protocol';
import { SecureMessagingSession } from '../session';
import { BrowserKeyStore } from '../storage';

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: indexedDB });
});

async function record(device: DeviceIdentity, status: DeviceRecord['status']): Promise<DeviceRecord> {
  return { ...await registration(device), userId: device.userId, deviceKeyId: device.deviceKeyId, status, registeredAt: new Date().toISOString() };
}
function fixture(records: DeviceRecord[] = []) {
  const store = new BrowserKeyStore('alice', 'enrollment-' + randomUUID());
  const request = jest.fn(async (_path: string, options?: ApiRequest) => {
    if (options?.method !== 'POST') return { items: [...records] };
    const body = options.body;
    if (!body || typeof body !== 'object' || !('agreementPublicKey' in body) || !('signingPublicKey' in body) ||
      typeof body.agreementPublicKey !== 'string' || typeof body.signingPublicKey !== 'string') throw new Error('Invalid test registration');
    const device = { ...body, userId: 'alice', deviceKeyId: await deviceKeyIdFor(body.agreementPublicKey, body.signingPublicKey),
      status: 'active', registeredAt: new Date().toISOString() };
    return { device };
  });
  const session = new SecureMessagingSession({ actor: { id: 'alice', username: 'alice' }, request, dispose() {} }, store);
  return { store, request, session };
}

test('startup with no identity never generates or registers a first device without explicit enrollment', async () => {
  const f = fixture(), enroll = jest.spyOn(f.store, 'enroll');
  try {
    await expect(f.session.initialize()).rejects.toMatchObject({ code: 'enrollment_required' });
    expect(enroll).not.toHaveBeenCalled(); expect(await f.store.get('device')).toBeUndefined();
    expect(await f.store.get('enrolled')).toBeUndefined(); expect(f.request).toHaveBeenCalledTimes(1);
    const device = await f.session.initialize(true);
    expect(device.agreement.privateKey.extractable).toBe(false); expect(device.signing.privateKey.extractable).toBe(false);
    expect(enroll).toHaveBeenCalledTimes(1);
  } finally { f.session.dispose(); }
});

test.each(['revoked', 'superseded'] as const)('explicit enrollment cannot replace this profile’s %s identity', async status => {
  const old = await generateDevice('alice'), f = fixture([await record(old, status)]);
  await f.store.enroll(old); const enroll = jest.spyOn(f.store, 'enroll');
  try {
    await expect(f.session.initialize(true)).rejects.toMatchObject({ code: 'device_revoked' });
    expect((await f.store.get<DeviceIdentity>('device'))?.deviceId).toBe(old.deviceId);
    expect(enroll).not.toHaveBeenCalled(); expect(f.request).toHaveBeenCalledTimes(1);
  } finally { f.session.dispose(); }
});

test('a fresh profile may explicitly enroll when all existing account devices are revoked', async () => {
  const old = await generateDevice('alice'), revoked = await record(old, 'revoked'), f = fixture([revoked]);
  try {
    await expect(f.session.initialize()).rejects.toMatchObject({ code: 'enrollment_required' });
    const device = await f.session.initialize(true);
    expect(device.deviceId).not.toBe(old.deviceId); expect(device.deviceKeyId).not.toBe(old.deviceKeyId);
    expect(revoked.status).toBe('revoked'); expect(f.request.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1);
  } finally { f.session.dispose(); }
});

test('generic KEY_CONFLICT remains a registration conflict and never replaces local keys', async () => {
  const device = await generateDevice('alice'), f = fixture(); await f.store.enroll(device);
  const workingRequest = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (url, options) => {
    if (options?.method === 'POST') throw new ApiError('key_conflict');
    return workingRequest(url, options);
  });
  try {
    await expect(f.session.initialize()).rejects.toMatchObject({ code: 'key_conflict' });
    expect((await f.store.get<DeviceIdentity>('device'))?.deviceKeyId).toBe(device.deviceKeyId);
    f.request.mockImplementation(workingRequest);
    expect((await f.session.initialize()).deviceId).toBe(device.deviceId);
  } finally { f.session.dispose(); }
});

test('an active signed registration with mismatched identity is invalid proof, not evidence of revocation', async () => {
  const device = await generateDevice('alice'), otherId = (await generateDevice('alice')).deviceId;
  const f = fixture([await record({ ...device, deviceId: otherId }, 'active')]); await f.store.enroll(device);
  try { await expect(f.session.initialize()).rejects.toMatchObject({ code: 'invalid_proof' }); }
  finally { f.session.dispose(); }
});
