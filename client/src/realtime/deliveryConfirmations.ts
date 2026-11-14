import type { EncryptedIncomingMessage } from '@/messaging/messageModel';
import { RealtimeOperationError, type RealtimeErrorCode } from './realtimeModel';

const MAX_PENDING = 100;
const MAX_RETAINED_BYTES = 16 * 1024 * 1024;
const CONFIRMATION_DEADLINE = 5_000; // Conservative: below the server's default 10s callback timeout.
// Account for the snapshot's strings and the canonical fingerprint, plus entry overhead.
const retainedBytes = (fingerprint: string) => fingerprint.length * 4 + 512;

/** Trusted recipient-key attestation boundary. No production implementation exists yet.
 * A shape check, readiness flag or successful local demo decryption cannot implement this policy.
 */
export type DeliveryConfirmationVerifier = (message: Readonly<EncryptedIncomingMessage>, actorId: string) => boolean | Promise<boolean>;

interface PendingConfirmation {
  message: EncryptedIncomingMessage;
  fingerprint: string;
  timer: ReturnType<typeof setTimeout>;
  acknowledge: ((payload: unknown) => void) | null;
  promise?: Promise<void>;
  cancel?: (error: RealtimeOperationError) => void;
}

/** Session-owned, transient callback handles; never an offline queue or a message store. */
export class DeliveryConfirmations {
  private readonly entries = new Map<string, PendingConfirmation>();
  private bytes = 0;

  constructor(private readonly actorId: string, private readonly verifier: DeliveryConfirmationVerifier | undefined,
    private readonly eligible: (message: EncryptedIncomingMessage) => boolean) {}

  get enabled() { return typeof this.verifier === 'function'; }

  capture(message: EncryptedIncomingMessage, acknowledge: unknown) {
    if (!this.enabled || typeof acknowledge !== 'function' || !this.eligible(message)) return;
    const key = JSON.stringify([message.conversationId, message.id]);
    const fingerprint = JSON.stringify(message);
    if (this.entries.has(key) || this.entries.size >= MAX_PENDING || this.bytes + retainedBytes(fingerprint) > MAX_RETAINED_BYTES) return;
    const snapshot = Object.freeze({ ...message, encryption: Object.freeze({ ...message.encryption }) });
    const timer = setTimeout(() => this.remove(key, 'ack_timeout'), CONFIRMATION_DEADLINE);
    this.entries.set(key, { message: snapshot, fingerprint, timer, acknowledge: acknowledge as (payload: unknown) => void });
    this.bytes += retainedBytes(fingerprint);
  }

  confirm(message: EncryptedIncomingMessage): Promise<void> {
    if (!this.enabled) return Promise.reject(new RealtimeOperationError('recipient_keys_unavailable'));
    const key = JSON.stringify([message.conversationId, message.id]);
    const entry = this.entries.get(key);
    if (!entry || entry.fingerprint !== JSON.stringify(message)) return Promise.reject(new RealtimeOperationError('invalid_payload'));
    if (!this.eligible(entry.message)) return Promise.reject(new RealtimeOperationError('unauthorized_conversation'));
    if (entry.promise) return entry.promise;
    let resolve!: () => void;
    let reject!: (error: RealtimeOperationError) => void;
    entry.promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    entry.cancel = reject;
    // Deferring also contains synchronous verifier throws and protects against reentrant consumers.
    void Promise.resolve().then(() => this.entries.get(key) === entry ? this.verifier!(entry.message, this.actorId) : false).then((verified) => {
      if (this.entries.get(key) !== entry) return;
      if (verified !== true || !this.eligible(entry.message)) {
        this.remove(key, 'recipient_keys_unavailable');
        return;
      }
      const acknowledge = entry.acknowledge;
      entry.acknowledge = null;
      try {
        acknowledge?.({ conversationId: message.conversationId, messageId: message.id, status: 'delivered' });
        delete entry.cancel;
        resolve(); // Submission only: the server does not acknowledge this callback back to us.
      } catch { this.remove(key, 'send_failed'); }
    }, () => this.removeIfCurrent(key, entry, 'recipient_keys_unavailable'));
    return entry.promise;
  }

  private removeIfCurrent(key: string, entry: PendingConfirmation, code: RealtimeErrorCode) {
    if (this.entries.get(key) === entry) this.remove(key, code);
  }

  private remove(key: string, code: RealtimeErrorCode) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= retainedBytes(entry.fingerprint);
    clearTimeout(entry.timer);
    entry.acknowledge = null;
    entry.cancel?.(new RealtimeOperationError(code));
  }

  prune() {
    for (const [key, entry] of this.entries) if (!this.eligible(entry.message)) this.remove(key, 'unauthorized_conversation');
  }

  clear(code: RealtimeErrorCode) {
    for (const key of this.entries.keys()) this.remove(key, code);
  }
}
