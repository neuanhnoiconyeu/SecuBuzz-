import { ApiError, type SessionApi } from '@/api/sessionApi';
import { E2eeApi } from './api';
import { BrowserKeyStore } from './storage';
import { generateDevice, matchesDevice, registration, safetyNumber, validateLocalDevice } from './devices';
import { decryptV2, encryptV2 } from './messages';
import { openKey, sealKey } from './hpke';
import { base64url, digest, epochStatement, importPoint, parseEnvelope, parseEpoch, recipientOrder, sign, verifyDevice, verifySignature, wrapInfo } from './protocol';
import { E2eeError, type DeviceIdentity, type DeviceRecord, type DirectConversation, type EnvelopeV2, type KeyEpoch, type KeyState, type SecurityErrorCode, type StoredMessage } from './model';
import {MAX_MESSAGE_EDITS,editCore,editStatement,revisionEnvelopeStatement,type EditProof} from '../../../../shared/messageRevisions';
import {editDigest,editedContent,messageEditHead,messageEditVersion,protectedEditContent,verifyEditedContent} from './edits';

interface CachedEpoch { epoch: KeyEpoch; creator: DeviceRecord; key: CryptoKey }
interface TrustedPeer { ids: string[] }
export interface PreparedConversation { conversation: DirectConversation; keyId: string; key: CryptoKey; safetyNumber: string }
export interface DecryptedRow { message: StoredMessage; text: string | null; error: string | null; errorCode?: SecurityErrorCode }
export interface PersistenceAck { conversationId: string; messageId: string; status: 'sent'; timestamp: string }
export type EncryptedSubmit = (envelope: EnvelopeV2) => Promise<PersistenceAck>;
export type SendProgress = (state: 'Encrypting' | 'Sending' | 'Awaiting persistence acknowledgment' | 'Persisted — delivery pending') => void;
export class SecureMessagingSession {
  readonly api: E2eeApi;
  readonly store: BrowserKeyStore;
  private active = true;
  private initialization: Promise<DeviceIdentity> | undefined;
  private identity: DeviceIdentity | undefined;
  private review: { conversationId: string; digest: string; oldIds: string[]; newIds: string[] } | undefined;
  constructor(session: SessionApi, store = new BrowserKeyStore(session.actor.id)) {
    if (store.accountId !== session.actor.id) throw new E2eeError('storage_corrupt');
    this.api = new E2eeApi(session); this.store = store;
  }
  private assert(): void { if (!this.active) throw new E2eeError('disposed'); }
  initialize(explicitEnrollment = false): Promise<DeviceIdentity> {
    this.assert();
    if (!this.initialization) { const pending = this.initializeDevice(explicitEnrollment).catch((e: unknown) => { this.initialization = undefined; throw e; }); this.initialization = pending; }
    return this.initialization;
  }
  private async initializeDevice(explicit: boolean): Promise<DeviceIdentity> {
    let device = await this.store.get<DeviceIdentity>('device'); const own = await this.api.ownDevices(); this.assert();
    if (!device) {
      if (await this.store.get('enrolled')) throw new E2eeError('storage_corrupt');
      // Creating an identity is a user-confirmed operation, including the first device.
      // A revoked identity in this profile is never replaced by this path.
      if (!explicit) throw new E2eeError('enrollment_required');
      const candidate = await generateDevice(this.api.session.actor.id); this.assert(); device = await this.store.enroll(candidate);
    }
    await validateLocalDevice(device, this.api.session.actor.id); this.assert(); this.identity = device;
    const prior = own.find(d => d.deviceKeyId === device.deviceKeyId);
    if (prior && !matchesDevice(device, prior)) throw new E2eeError('invalid_proof');
    if (prior && prior.status !== 'active') throw new E2eeError('device_revoked');
    // KEY_CONFLICT also covers ownership/version/registration conflicts. It is not
    // evidence of revocation; only verified directory state establishes that.
    const registered = await this.api.register(await registration(device));
    this.assert(); if (!matchesDevice(device, registered) || registered.status !== 'active') throw new E2eeError('invalid_proof');
    await this.store.put('verified-device', registered.deviceKeyId, registered); this.assert(); return device;
  }
  getKeyReview(cid?: string): { oldIds: string[]; newIds: string[] } | null { return this.review && (!cid || this.review.conversationId === cid) ? { oldIds: [...this.review.oldIds], newIds: [...this.review.newIds] } : null; }
  private async trust(state: KeyState, accept?: string): Promise<void> {
    const peer = state.participantIds.find(id => id !== this.api.session.actor.id)!;
    const ids = state.devices.filter(d => d.userId === peer).map(d => d.deviceKeyId).sort();
    if (!ids.length) throw new E2eeError('recipient_missing');
    const fingerprint = await digest(JSON.stringify([state.conversationId, peer, ids]));
    const known = await this.store.putIfAbsent<TrustedPeer>('trust', peer, { ids }); this.assert();
    if (!known || !Array.isArray(known.ids) || known.ids.some(id => typeof id !== 'string')) throw new E2eeError('storage_corrupt');
    if (JSON.stringify(known.ids) !== JSON.stringify(ids)) {
      if (accept !== fingerprint) { this.review = { conversationId: state.conversationId, digest: fingerprint, oldIds: known.ids, newIds: ids }; throw new E2eeError('keys_changed'); }
      await this.store.put('trust', peer, { ids });
    }
    for (const device of state.devices) await this.store.put('verified-device', device.deviceKeyId, device);
    this.assert(); this.review = undefined;
  }
  async acceptKeyChange(conversationId: string): Promise<void> {
    this.assert(); const expected = this.review; if (!expected || expected.conversationId !== conversationId) throw new E2eeError('keys_changed');
    const c = await this.api.getConversation(conversationId), state = await this.api.state(conversationId, c.participants.map(p => p.id));
    await this.trust(state, expected.digest); this.assert();
  }
  private covers(epoch: KeyEpoch, devices: DeviceRecord[]): boolean {
    const expected = [...devices].sort(recipientOrder);
    return expected.length === epoch.wraps.length && expected.every((d, i) => d.userId === epoch.wraps[i]!.recipientUserId && d.deviceKeyId === epoch.wraps[i]!.recipientDeviceKeyId);
  }
  private async verifyEpoch(epoch: KeyEpoch, creator: DeviceRecord, participants: string[]): Promise<void> {
    if (creator.deviceKeyId !== epoch.creatorDeviceKeyId || creator.userId !== epoch.creatorUserId || !participants.includes(creator.userId) || epoch.wraps.some(w => !participants.includes(w.recipientUserId))) throw new E2eeError('invalid_proof');
    await verifySignature(creator.signingPublicKey, epochStatement(epoch), epoch.signature);
    await Promise.all(epoch.wraps.map(w => importPoint(w.enc, false)));
  }
  private async openEpoch(epoch: KeyEpoch, creator: DeviceRecord, participants: string[], device: DeviceIdentity): Promise<CryptoKey> {
    await this.verifyEpoch(epoch, creator, participants); const own = epoch.wraps.find(w => w.recipientUserId === device.userId && w.recipientDeviceKeyId === device.deviceKeyId);
    if (!own) throw new E2eeError('missing_key');
    const key = await openKey(device.agreement, own.enc, own.ciphertext, wrapInfo(epoch, own)); this.assert();
    await this.store.put<CachedEpoch>('epoch', JSON.stringify([epoch.conversationId, epoch.keyId]), { epoch, creator, key }); this.assert(); return key;
  }
  private async validatedState(cid: string): Promise<{ device: DeviceIdentity; conversation: DirectConversation; state: KeyState }> {
    const device = await this.initialize(), conversation = await this.api.getConversation(cid);
    if (!conversation.interactionAllowed) throw new ApiError('forbidden');
    const state = await this.api.state(cid, conversation.participants.map(p => p.id)); this.assert();
    if (!state.devices.some(d => d.deviceKeyId === device.deviceKeyId && matchesDevice(device, d))) throw new E2eeError('device_revoked');
    if (state.participantIds.some(id => !state.devices.some(d => d.userId === id))) throw new E2eeError('recipient_missing');
    await this.trust(state); return { device, conversation, state };
  }
  async prepare(cid: string): Promise<PreparedConversation> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { device, conversation, state } = await this.validatedState(cid);
      let epoch = state.epochs[0];
      if (!epoch || !this.covers(epoch, state.devices) || !state.devices.some(d => d.deviceKeyId === epoch!.creatorDeviceKeyId)) {
        const raw = crypto.getRandomValues(new Uint8Array(32));
        const fields = { conversationId: cid, keyId: base64url(crypto.getRandomValues(new Uint8Array(16))), epoch: (state.currentEpoch?.epoch ?? 0) + 1,
          previousKeyId: state.currentEpoch?.keyId ?? null, creatorUserId: device.userId, creatorDeviceKeyId: device.deviceKeyId, createdAt: new Date().toISOString() };
        try {
          const wraps = [];
          for (const recipient of [...state.devices].sort(recipientOrder)) {
            const target = { recipientUserId: recipient.userId, recipientDeviceKeyId: recipient.deviceKeyId };
            wraps.push({ ...target, ...await sealKey(recipient.agreementPublicKey, raw, wrapInfo(fields, target)) }); this.assert();
          }
          const signature = await sign(device.signing.privateKey, epochStatement({ ...fields, wraps })); this.assert();
          const { conversationId: _cid, creatorUserId: _actor, ...body } = fields;
          epoch = await this.api.publish(cid, { ...body, wraps, signature });
        } catch (e) { if (e instanceof ApiError && e.code === 'recipient_keys_changed' && attempt === 0) continue; throw e; }
        finally { raw.fill(0); }
      }
      const creator = state.devices.find(d => d.deviceKeyId === epoch.creatorDeviceKeyId);
      if (!creator || !this.covers(epoch, state.devices) || epoch.epoch < (state.currentEpoch?.epoch ?? 0)) throw new E2eeError('invalid_proof');
      const key = await this.openEpoch(epoch, creator, state.participantIds, device); this.assert();
      return { conversation, keyId: epoch.keyId, key, safetyNumber: await safetyNumber(state.devices, state.participantIds) };
    }
    throw new E2eeError('stale_epoch');
  }
  async pending(cid: string): Promise<EnvelopeV2 | null> {
    const pending = await this.store.get<unknown>('pending', cid); this.assert();
    if (pending === undefined) return null;
    try { const e = parseEnvelope(pending); if (e.conversationId !== cid || e.senderId !== this.api.session.actor.id) throw new Error(); return e; }
    catch { throw new E2eeError('storage_corrupt'); }
  }
  private async confirmed(envelope: EnvelopeV2, submit?: EncryptedSubmit, progress?: SendProgress): Promise<StoredMessage> {
    let message: StoredMessage | undefined;
    if (submit) {
      progress?.('Sending');
      const operation = submit(envelope);
      progress?.('Awaiting persistence acknowledgment');
      const ack = await operation; this.assert();
      if (ack.conversationId !== envelope.conversationId || ack.messageId !== envelope.id || ack.status !== 'sent') throw new E2eeError('invalid_message');
      progress?.('Persisted — delivery pending');
      // Socket acknowledgments contain no storage ID or sequence. Never fabricate either,
      // and never POST a second copy to obtain them. Read the already committed row.
      message = await this.findPersisted(envelope);
      if (!message || message.storedAt !== ack.timestamp) throw new ApiError('unavailable');
    } else { progress?.('Sending'); message = await this.api.submit(envelope); }
    this.assert();
    if (message.timestamp !== envelope.timestamp || message.senderName !== envelope.senderName ||
      (message.encryption !== null && JSON.stringify([message.encryption.version, message.encryption.keyId, message.encryption.iv, message.encryption.ciphertext]) !==
        JSON.stringify([2, envelope.encryption.keyId, envelope.encryption.iv, envelope.encryption.ciphertext]))) throw new E2eeError('invalid_message');
    await this.store.clearPending(envelope.conversationId, envelope.id); this.assert(); return message;
  }
  async send(cid: string, displayName: string, text: string, submit?: EncryptedSubmit, progress?: SendProgress, messageId?:string): Promise<StoredMessage> {
    this.assert(); if (await this.pending(cid)) throw new E2eeError('pending_message');
    progress?.('Encrypting');
    const prepared = await this.prepare(cid); this.assert();
    if(messageId!==undefined&&!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(messageId))throw new E2eeError('invalid_message');
    const envelope = await encryptV2(prepared.key, this.store, { id: messageId??crypto.randomUUID(), conversationId: cid, senderId: this.api.session.actor.id, senderName: displayName, timestamp: new Date().toISOString(), type: 'text' }, prepared.keyId, text); this.assert();
    const stored = await this.store.putIfAbsent('pending', cid, envelope); this.assert(); if (stored.id !== envelope.id) throw new E2eeError('pending_message');
    return this.confirmed(envelope, submit, progress);
  }
  private async findPersisted(envelope: EnvelopeV2): Promise<StoredMessage | undefined> {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const history = await this.api.history(envelope.conversationId, cursor); this.assert(); const found = history.items.find(m => m.id === envelope.id);
      if (found) { if (found.timestamp !== envelope.timestamp || found.senderName !== envelope.senderName || (found.encryption !== null &&
        JSON.stringify([found.encryption.version, found.encryption.keyId, found.encryption.iv, found.encryption.ciphertext]) !== JSON.stringify([2, envelope.encryption.keyId, envelope.encryption.iv, envelope.encryption.ciphertext])) || found.senderId !== envelope.senderId) throw new E2eeError('invalid_message');
        return found; }
      if (!history.nextCursor) break; cursor = history.nextCursor;
      if (page === 19) throw new ApiError('resource_limit');
    }
    return undefined;
  }
  async retryPending(cid: string, submit?: EncryptedSubmit, progress?: SendProgress): Promise<StoredMessage | null> {
    const envelope = await this.pending(cid); if (!envelope) return null;
    // Reconcile an uncertain outcome before any transport retry, without changing bytes.
    const found = await this.findPersisted(envelope);
    if (found) { await this.store.clearPending(cid, envelope.id); this.assert(); return found; }
    const { state } = await this.validatedState(cid), epoch = state.epochs[0];
    if (!epoch || state.currentEpoch?.keyId !== envelope.encryption.keyId || !this.covers(epoch, state.devices)) throw new E2eeError('pending_stale');
    const creator = state.devices.find(d => d.deviceKeyId === epoch.creatorDeviceKeyId); if (!creator) throw new E2eeError('pending_stale');
    await this.verifyEpoch(epoch, creator, state.participantIds); this.assert(); return this.confirmed(envelope, submit, progress);
  }
  /** Hints never provide trusted key material. No current-directory cache is retained. */
  async revalidate(cid: string): Promise<void> {
    const { state } = await this.validatedState(cid), epoch = state.epochs[0];
    if (epoch && this.covers(epoch, state.devices)) {
      const creator = state.devices.find(d => d.deviceKeyId === epoch.creatorDeviceKeyId);
      if (!creator) throw new E2eeError('invalid_proof');
      await this.verifyEpoch(epoch, creator, state.participantIds);
    }
    this.assert();
  }
  async decryptIncoming(input: EnvelopeV2): Promise<string> {
    this.assert(); const envelope = parseEnvelope(input), c = await this.api.getConversation(envelope.conversationId); this.assert();
    if (!c.interactionAllowed || !c.participants.some(p => p.id === envelope.senderId)) throw new ApiError('forbidden');
    const text = await decryptV2(await this.historyKey(c, envelope.encryption.keyId), envelope); this.assert(); return text;
  }
  private async historyKey(c: DirectConversation, keyId: string): Promise<CryptoKey> {
    const cache = await this.store.get<CachedEpoch>('epoch', JSON.stringify([c.id, keyId])); this.assert();
    if (cache) {
      const epoch = parseEpoch(cache.epoch, c.id); if (epoch.keyId !== keyId || !cache.key || cache.key.extractable || cache.key.type !== 'secret' || cache.key.algorithm.name !== 'AES-GCM') throw new E2eeError('storage_corrupt');
      await this.verifyEpoch(epoch, await verifyDevice(cache.creator), c.participants.map(p => p.id)); this.assert(); return cache.key;
    }
    const epoch = await this.api.epoch(c.id, keyId);
    // Known historical signer/own wrap remain usable even while new peer keys await review.
    let creator = await this.store.get<DeviceRecord>('verified-device', epoch.creatorDeviceKeyId);
    if (!creator) { const state = await this.api.state(c.id, c.participants.map(p => p.id)); await this.trust(state); creator = state.devices.find(d => d.deviceKeyId === epoch.creatorDeviceKeyId); }
    if (!creator) throw new E2eeError('missing_key');
    const local = this.identity ?? await this.store.get<DeviceIdentity>('device'); if (!local) throw new E2eeError('missing_key'); await validateLocalDevice(local, this.api.session.actor.id);
    return this.openEpoch(epoch, await verifyDevice(creator), c.participants.map(p => p.id), local);
  }
  async history(cid: string, cursor?: string): Promise<{ items: DecryptedRow[]; nextCursor: string | null }> {
    this.assert();
    const conversation = await this.api.getConversation(cid), result = await this.api.history(cid, cursor); this.assert();
    const keys = new Map<string, Promise<CryptoKey>>();
    const items = await Promise.all(result.items.map(async message => {
      if (!conversation.participants.some(p => p.id === message.senderId)) throw new E2eeError('invalid_message');
      if (message.state === 'deleted') {await this.store.observeRevision(message.storageId,[],true);return { message, text: null, error: null };}
      try {
        if (message.encryption?.version !== 2) throw new E2eeError('missing_key');
        const keyId = message.encryption.keyId;
        if (!keys.has(keyId)) keys.set(keyId, this.historyKey(conversation, keyId));
        const wire = { id: message.id, conversationId: cid, senderId: message.senderId, senderName: message.senderName, timestamp: message.timestamp, type: message.type, encryption: message.encryption };
        const original = await decryptV2(await keys.get(keyId)!, wire);
        const text=await verifyEditedContent(message,original,conversation,this.store,k=>this.historyKey(conversation,k));this.assert();return { message, text, error: null };
      } catch (e) { return { message, text: null, error: e instanceof E2eeError ? e.message : 'Unable to decrypt this message.', ...(e instanceof E2eeError ? { errorCode: e.code } : {}) }; }
    }));
    this.assert(); return { items, nextCursor: result.nextCursor };
  }
  async decryptStoredMessage(input:StoredMessage):Promise<DecryptedRow>{
    this.assert();const m=this.api.stored(input,input.conversationId),c=await this.api.getConversation(m.conversationId);this.assert();
    if(!c.interactionAllowed||!c.participants.some(p=>p.id===m.senderId))throw new ApiError('forbidden');
    if(m.state!=='active'||m.encryption?.version!==2)throw new E2eeError('invalid_message');
    const wire={id:m.id,conversationId:m.conversationId,senderId:m.senderId,senderName:m.senderName,timestamp:m.timestamp,type:m.type,encryption:m.encryption};
    const original=await decryptV2(await this.historyKey(c,m.encryption.keyId),wire);
    const text=await verifyEditedContent(m,original,c,this.store,k=>this.historyKey(c,k));this.assert();return {message:m,text,error:null};
  }
  async revokeCurrentDevice(): Promise<void> {
    const local = await this.initialize(); await this.api.revoke(local.deviceId); this.assert(); this.initialization = undefined;
    throw new E2eeError('device_revoked');
  }
  private async editRow(message:StoredMessage):Promise<DecryptedRow>{
    let cursor:string|undefined;
    for(let page=0;page<100;page++){
      const history=await this.history(message.conversationId,cursor),found=history.items.find(r=>r.message.storageId===message.storageId);
      if(found)return found;if(!history.nextCursor)break;cursor=history.nextCursor;
    }throw new ApiError('not_found');
  }
  async editMessage(original:StoredMessage,text:string):Promise<DecryptedRow>{
    this.assert();if(original.senderId!==this.api.session.actor.id||original.state!=='active'||messageEditVersion(original)>=MAX_MESSAGE_EDITS)throw new ApiError('forbidden');
    const current=await this.editRow(original);this.assert();
    if(current.message.senderId!==this.api.session.actor.id)throw new ApiError('forbidden');
    if(current.message.state!=='active'||current.error||current.text===null)throw new E2eeError('invalid_message');
    const content=editedContent(current.text,text),contentHash=await editDigest(content);
    type Pending={contentHash:string;request:{proof:EditProof;envelope:EnvelopeV2}};
    let pending=await this.store.get<Pending>('pending-edit',original.storageId);
    if(pending&&current.message.edit?.proofs.some(p=>p.proof.operationId===pending!.request.proof.operationId)){
      await this.store.clearPendingEdit(original.storageId,pending.request.proof.operationId);
      if(pending.contentHash===contentHash)return current;pending=undefined;
    }
    if(pending&&pending.contentHash!==contentHash)throw new ApiError('conflict');
    if(!pending){
      if(await messageEditHead(current.message)!==await messageEditHead(original))throw new ApiError('stale_state');
      const prepared=await this.prepare(original.conversationId),device=await this.initialize();
      const core={v:1 as const,storageId:original.storageId,messageId:original.id,conversationId:original.conversationId,senderId:original.senderId,
        revision:messageEditVersion(current.message)+1,operationId:crypto.randomUUID(),previousHash:await messageEditHead(current.message),keyId:prepared.keyId,signerDeviceKeyId:device.deviceKeyId,editedAt:new Date().toISOString()};
      const envelope=await encryptV2(prepared.key,this.store,{id:core.operationId,conversationId:core.conversationId,senderId:core.senderId,senderName:original.senderName,timestamp:core.editedAt,type:'text'},prepared.keyId,protectedEditContent(core,content));
      const fields={...editCore(core),envelopeHash:await editDigest(revisionEnvelopeStatement(envelope))},signature=await sign(device.signing.privateKey,editStatement(fields));
      pending=await this.store.putIfAbsent<Pending>('pending-edit',original.storageId,{contentHash,request:{proof:{...fields,signature},envelope}});
      if(pending.contentHash!==contentHash)throw new ApiError('conflict');
    }
    this.assert();
    let response:unknown;
    try{response=await this.api.session.request(`/api/messages/${encodeURIComponent(original.storageId)}`,{method:'PATCH',body:pending.request});}
    catch(e){
      if(e instanceof ApiError&&['forbidden','not_found','validation','stale_state','conflict','key_proof_invalid','recipient_keys_changed','recipient_keys_unverified'].includes(e.code))await this.store.clearPendingEdit(original.storageId,pending.request.proof.operationId);
      throw e;
    }this.assert();
    const result=objectEditReceipt(response),p=pending.request.proof;
    if(result.storageId!==original.storageId||result.messageId!==original.id||result.conversationId!==original.conversationId||result.senderId!==original.senderId||result.revision!==p.revision||result.operationId!==p.operationId||result.proofHash!==await editDigest(JSON.stringify([editStatement(p),p.signature])))throw new E2eeError('invalid_message');
    const confirmed=await this.editRow(original);this.assert();
    if(confirmed.message.state!=='active'||confirmed.error||!confirmed.message.edit?.proofs.some(r=>r.proof.signature===p.signature&&r.proof.operationId===p.operationId))throw new E2eeError('invalid_message');
    await this.store.clearPendingEdit(original.storageId,p.operationId);return confirmed;
  }
  dispose(): void { this.active = false; this.initialization = undefined; this.identity = undefined; this.review = undefined; this.store.close(); }
}
function objectEditReceipt(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||!('outcome'in value)||!['created','duplicate'].includes(value.outcome as string)||!('edit'in value)||!value.edit||typeof value.edit!=='object')throw new E2eeError('invalid_message');
  return value.edit as Record<string,unknown>;
}
