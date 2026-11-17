/**
 * TEST-ONLY in-memory key directory. It shows the semantics DATA must implement over SQLite: each
 * operation reads state, calls the server's synchronous planner and writes, with no await in
 * between, which is what one `BEGIN IMMEDIATE` transaction gives DATA. It is not persistent,
 * refuses to load in production and marks itself `testOnly`, which production verifiers refuse.
 */
import { planDeviceRegistration, planDeviceRevocation, validateDeviceRegistration } from '../../../src/e2ee/registration.ts';
import { planEpochPublication, type PublishedEpoch } from '../../../src/e2ee/epochs.ts';
import type { ConversationKeyEpoch, EpochSummary, StoredDeviceKey } from '../../../src/e2ee/records.ts';
import type { RecipientKeyDirectory } from '../../../src/e2ee/verifier.ts';

if (process.env.NODE_ENV === 'production') throw new Error('The in-memory key directory must never be loaded in production.');

export type DirectoryFault = 'normal' | 'throw' | 'hang' | 'malformed' | 'null';

export type DirectoryOutcome =
  | { readonly status: 'created' | 'duplicate' | 'revoked' | 'unchanged' }
  | { readonly status: 'refused'; readonly reason: string };

interface Snapshot {
  conversations: Array<[string, string[]]>;
  devices: StoredDeviceKey[];
  epochs: PublishedEpoch[];
}

export class MemoryKeyDirectory implements RecipientKeyDirectory {
  readonly testOnly = true;
  mode: DirectoryFault = 'normal';
  loadCalls = 0;
  now: () => number = Date.now;
  readonly #conversations = new Map<string, string[]>();
  readonly #devices = new Map<string, StoredDeviceKey>();
  readonly #epochs = new Map<string, Map<string, PublishedEpoch>>();

  addConversation(conversationId: string, participantIds: readonly string[]): void {
    this.#conversations.set(conversationId, [...participantIds]);
  }

  /** Simulates a DB-4A membership change. */
  setParticipants(conversationId: string, participantIds: readonly string[]): void {
    this.addConversation(conversationId, participantIds);
  }

  registerDevice(userId: string, body: unknown): DirectoryOutcome {
    const validated = validateDeviceRegistration(body, { userId });
    if (!validated.ok) return { status: 'refused', reason: validated.reason };
    const record = validated.value;
    const all = [...this.#devices.values()];
    const plan = planDeviceRegistration(record, {
      existingKey: this.#devices.get(record.deviceKeyId) ?? null,
      deviceHistory: all.filter((device) => device.deviceId === record.deviceId),
      activeDevicesOfUser: all.filter((device) => device.userId === userId && device.status === 'active'),
    }, { nowMs: this.now() });
    if (plan.action === 'refuse') return { status: 'refused', reason: plan.reason };
    if (plan.action === 'duplicate') return { status: 'duplicate' };
    for (const id of plan.supersede) this.#setStatus(id, 'superseded');
    this.#devices.set(record.deviceKeyId, Object.freeze({ ...record, status: 'active' }));
    return { status: 'created' };
  }

  revokeDevice(userId: string, deviceId: string): DirectoryOutcome {
    const plan = planDeviceRevocation(userId, deviceId, [...this.#devices.values()].filter((device) => device.deviceId === deviceId));
    if (plan.action === 'refuse') return { status: 'refused', reason: plan.reason };
    if (plan.action === 'unchanged') return { status: 'unchanged' };
    for (const id of plan.deviceKeyIds) this.#setStatus(id, 'revoked');
    return { status: 'revoked' };
  }

  publishEpoch(userId: string, conversationId: string, body: unknown): DirectoryOutcome {
    const participantIds = this.#conversations.get(conversationId);
    if (!participantIds) return { status: 'refused', reason: 'not_found' };
    const epochs = this.#epochs.get(conversationId) ?? new Map<string, PublishedEpoch>();
    const keyId = typeof body === 'object' && body !== null ? (body as { keyId?: unknown }).keyId : undefined;
    const plan = planEpochPublication(body, {
      actorUserId: userId,
      conversationId,
      participantIds,
      activeDevices: this.#activeDevices(participantIds),
      currentEpoch: this.#current(conversationId),
      existingEpoch: typeof keyId === 'string' ? epochs.get(keyId) ?? null : null,
      nowMs: this.now(),
    });
    if (plan.action === 'refuse') return { status: 'refused', reason: plan.reason };
    if (plan.action === 'duplicate') return { status: 'duplicate' };
    epochs.set(plan.epoch.keyId, plan.epoch);
    this.#epochs.set(conversationId, epochs);
    return { status: 'created' };
  }

  /** Synchronous snapshot, as DATA would read it on its own connection inside a transaction. */
  keyState(conversationId: string, keyId: string): Record<string, unknown> | null {
    const participantIds = this.#conversations.get(conversationId);
    if (!participantIds) return null;
    const epoch = this.#epochs.get(conversationId)?.get(keyId) ?? null;
    return {
      conversationId,
      participantIds: [...participantIds],
      activeDevices: this.#activeDevices(participantIds).map((device) => ({ ...device, registeredAt: '2026-11-14T00:00:00.000Z' })),
      currentEpoch: this.#current(conversationId),
      epoch: epoch ? this.#publicEpoch(epoch) : null,
    };
  }

  async loadConversationKeyState(request: { readonly conversationId: string; readonly keyId: string }): Promise<unknown> {
    this.loadCalls += 1;
    if (this.mode === 'throw') throw new Error('directory failure with secret detail: AQ.Ab-not-a-key');
    if (this.mode === 'hang') return new Promise<never>(() => undefined);
    if (this.mode === 'null') return null;
    const state = this.keyState(request.conversationId, request.keyId);
    if (this.mode === 'malformed' && state) return { ...state, activeDevices: 'everyone' };
    return state;
  }

  epochRecord(conversationId: string, keyId: string): ConversationKeyEpoch | null {
    const epoch = this.#epochs.get(conversationId)?.get(keyId);
    return epoch ? this.#publicEpoch(epoch) : null;
  }

  devices(userId?: string): StoredDeviceKey[] {
    return [...this.#devices.values()].filter((device) => userId === undefined || device.userId === userId);
  }

  activeDevicesOf(conversationId: string): StoredDeviceKey[] {
    return this.#activeDevices(this.#conversations.get(conversationId) ?? []);
  }

  currentEpoch(conversationId: string): EpochSummary | null {
    return this.#current(conversationId);
  }

  /** Test-only mutation that bypasses the planners, to simulate a malicious or corrupted store. */
  forceDevice(record: StoredDeviceKey): void {
    this.#devices.set(record.deviceKeyId, Object.freeze({ ...record }));
  }

  /** Everything stored, for "never stored" assertions and restart simulation. */
  export(): string {
    const snapshot: Snapshot = {
      conversations: [...this.#conversations.entries()],
      devices: [...this.#devices.values()],
      epochs: [...this.#epochs.values()].flatMap((epochs) => [...epochs.values()]),
    };
    return JSON.stringify(snapshot);
  }

  static restore(serialized: string): MemoryKeyDirectory {
    const snapshot = JSON.parse(serialized) as Snapshot;
    const directory = new MemoryKeyDirectory();
    for (const [id, participants] of snapshot.conversations) directory.addConversation(id, participants);
    for (const device of snapshot.devices) directory.#devices.set(device.deviceKeyId, Object.freeze(device));
    for (const epoch of snapshot.epochs) {
      const epochs = directory.#epochs.get(epoch.conversationId) ?? new Map<string, PublishedEpoch>();
      epochs.set(epoch.keyId, epoch);
      directory.#epochs.set(epoch.conversationId, epochs);
    }
    return directory;
  }

  #setStatus(deviceKeyId: string, status: StoredDeviceKey['status']): void {
    const record = this.#devices.get(deviceKeyId);
    if (record) this.#devices.set(deviceKeyId, Object.freeze({ ...record, status }));
  }

  #activeDevices(participantIds: readonly string[]): StoredDeviceKey[] {
    return [...this.#devices.values()].filter((device) => device.status === 'active' && participantIds.includes(device.userId));
  }

  #current(conversationId: string): EpochSummary | null {
    let current: EpochSummary | null = null;
    for (const epoch of this.#epochs.get(conversationId)?.values() ?? []) {
      if (!current || epoch.epoch > current.epoch) current = { keyId: epoch.keyId, epoch: epoch.epoch };
    }
    return current;
  }

  #publicEpoch(epoch: PublishedEpoch): ConversationKeyEpoch {
    const { recipientSetDigest: _digest, ...record } = epoch;
    return record;
  }
}
