import { ApiError, type SessionApi } from '@/api/sessionApi';
import { E2eeError, type DeviceRecord, type DirectConversation, type EnvelopeV2, type EpochBody, type KeyEpoch, type KeyState, type Registration, type StoredMessage } from './model';
import { decode, exact, identifier, object, parseEnvelope, parseEpoch, registrationStatement, timestamp, verifyDevice, verifySignature } from './protocol';
import {parseEditProof,MAX_MESSAGE_EDITS} from '../../../../shared/messageRevisions';
import { isConversationThemeId, type ConversationThemeId } from '../../../../shared/conversationThemes';
import { validAvatarUrl } from '@/api/socialValidation';
const part = (value: string) => encodeURIComponent(identifier(value));
const pageCursor = (v: unknown): string | null => { if (v === null) return null; if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(v)) throw new E2eeError('invalid_proof'); return v; };
const CONVERSATION_V1_KEYS = ['id', 'type', 'participants', 'createdAt', 'updatedAt', 'interactionAllowed'];
const CONVERSATION_V2_KEYS = ['id', 'type', 'participants', 'createdAt', 'updatedAt', 'interactionAllowed', 'themeId', 'nicknames'];
const PARTICIPANT_V1_KEYS = ['id', 'username', 'displayName', 'avatar'];
const PARTICIPANT_V2_KEYS = ['id', 'username', 'displayName', 'avatar', 'avatarUrl'];
const CONVERSATION_V2_QUERY = '?contractVersion=2';
const hasExactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
const wellFormed = (value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};
export class E2eeApi {
  constructor(readonly session: SessionApi) {}
  private async device(input: unknown): Promise<DeviceRecord> { const d = await verifyDevice(input); if (d.userId !== this.session.actor.id) throw new E2eeError('invalid_proof'); return d; }
  async ownDevices(): Promise<DeviceRecord[]> { const r = exact(await this.session.request('/api/keys/devices'), ['items']);
    if (!Array.isArray(r.items) || r.items.length > 50) throw new E2eeError('invalid_proof'); return Promise.all(r.items.map(d => this.device(d))); }
  async register(body: Registration): Promise<DeviceRecord> {
    const input = exact(body, ['deviceId', 'keyVersion', 'createdAt', 'agreementPublicKey', 'signingPublicKey', 'signature']);
    decode(input.deviceId, 16); decode(input.agreementPublicKey, 65); decode(input.signingPublicKey, 65); decode(input.signature, 64); timestamp(input.createdAt);
    if (!Number.isInteger(input.keyVersion) || (input.keyVersion as number) < 1 || (input.keyVersion as number) > 1000000) throw new E2eeError('invalid_proof');
    const safe = { ...input } as unknown as Registration;
    await verifySignature(safe.signingPublicKey, registrationStatement({ ...safe, userId: this.session.actor.id }), safe.signature);
    const r = exact(await this.session.request('/api/keys/devices', { method: 'POST', body: safe, status: [200, 201] }), ['device']); return this.device(r.device);
  }
  async revoke(deviceId: string): Promise<void> { decode(deviceId, 16); const r = exact(await this.session.request(`/api/keys/devices/${part(deviceId)}/revoke`, { method: 'POST' }), ['outcome']); if (!['revoked', 'unchanged'].includes(r.outcome as string)) throw new E2eeError('invalid_proof'); }
  private conversationResponse(input: unknown): { version: 1 | 2; conversation: DirectConversation } {
    const raw = object(input);
    const version: 1 | 2 = hasExactKeys(raw, CONVERSATION_V1_KEYS) && Array.isArray(raw.participants) &&
      raw.participants.every(participant => hasExactKeys(object(participant), PARTICIPANT_V1_KEYS)) ? 1 : 2;
    return { version, conversation: this.conversation(input, version) };
  }
  conversation(input: unknown, contractVersion: 1 | 2 = 1): DirectConversation {
    const c = exact(input, contractVersion === 1 ? CONVERSATION_V1_KEYS : CONVERSATION_V2_KEYS);
    identifier(c.id); timestamp(c.createdAt); timestamp(c.updatedAt);
    if (c.type !== 'direct' || !Array.isArray(c.participants) || c.participants.length !== 2 || typeof c.interactionAllowed !== 'boolean') throw new E2eeError('invalid_proof');
    const participants = c.participants.map(p => {
      const pRaw = object(p);
      const participantInput = contractVersion === 2 && !Object.prototype.hasOwnProperty.call(pRaw, 'avatarUrl')
        ? { ...pRaw, avatarUrl: null } : pRaw;
      const r = exact(participantInput, contractVersion === 1 ? PARTICIPANT_V1_KEYS : PARTICIPANT_V2_KEYS); identifier(r.id);
      if (typeof r.username !== 'string' || typeof r.displayName !== 'string' || !r.displayName.trim() || typeof r.avatar !== 'string') throw new E2eeError('invalid_proof');
      if (contractVersion === 1) return r as unknown as DirectConversation['participants'][number];
      const avatarUrl = validAvatarUrl(r.avatarUrl);
      if (r.avatarUrl !== null && avatarUrl === undefined) throw new E2eeError('invalid_proof');
      return { ...r, avatarUrl: r.avatarUrl === null ? null : avatarUrl } as unknown as DirectConversation['participants'][number];
    });
    if (participants[0]!.id === participants[1]!.id || !participants.some(p => p.id === this.session.actor.id)) throw new E2eeError('invalid_proof');
    if (contractVersion === 1) return { ...c, participants } as unknown as DirectConversation;
    if (!isConversationThemeId(c.themeId)) throw new E2eeError('invalid_proof');
    const nObj = object(c.nicknames), nicknames: Record<string, string> = {};
    const ids = participants.map(p => p.id);
    for (const [uid, val] of Object.entries(nObj)) {
      if (!ids.includes(uid) || typeof val !== 'string' || !val.trim() || !wellFormed(val) ||
          /[\u0000-\u001f\u007f-\u009f]/u.test(val) || [...val].length > 40) throw new E2eeError('invalid_proof');
      nicknames[uid] = val;
    }
    return { ...c, participants, themeId: c.themeId as ConversationThemeId, nicknames } as unknown as DirectConversation;
  }
  async updatePreferences(cid: string, patch: { themeId?: ConversationThemeId; nicknames?: Record<string, string | null> }): Promise<DirectConversation> {
    const r = exact(await this.session.request(`/api/conversations/${part(cid)}/preferences`, { method: 'PATCH', body: patch }), ['conversation']);
    const result = this.conversationResponse(r.conversation);
    if (result.conversation.id !== cid) throw new E2eeError('invalid_proof');
    return result.version === 2 ? result.conversation : this.getConversation(cid);
  }
  async conversations(cursor?: string): Promise<{ items: DirectConversation[]; nextCursor: string | null }> {
    const suffix = '&limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    let response: unknown;
    try {
      response = await this.session.request('/api/conversations?contractVersion=2' + suffix);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'validation') throw error;
      response = await this.session.request('/api/conversations?limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    }
    const r = exact(response, ['items', 'nextCursor']);
    if (!Array.isArray(r.items) || r.items.length > 50) throw new E2eeError('invalid_proof'); return { items: r.items.map(c => this.conversation(c,2)), nextCursor: pageCursor(r.nextCursor) };
  }
  async getConversation(cid: string): Promise<DirectConversation> {
    const path = '/api/conversations/' + part(cid);
    let response: unknown;
    try {
      response = await this.session.request(path + CONVERSATION_V2_QUERY);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'validation') throw error;
      response = await this.session.request(path);
    }
    const r = exact(response, ['conversation']), conversation = this.conversation(r.conversation,2);
    if (conversation.id !== cid) throw new E2eeError('invalid_proof');
    return conversation;
  }
  async createDirect(recipientId: string): Promise<DirectConversation> {
    const r = exact(await this.session.request('/api/conversations/dm', { method: 'POST', body: { recipientId: identifier(recipientId) }, status: [200, 201] }), ['conversation']);
    const result = this.conversationResponse(r.conversation);
    if (!result.conversation.participants.some(p => p.id === recipientId)) throw new E2eeError('invalid_proof');
    if (result.version === 2) return result.conversation;
    const conversation = await this.getConversation(result.conversation.id);
    if (!conversation.participants.some(p => p.id === recipientId)) throw new E2eeError('invalid_proof');
    return conversation;
  }
  async state(cid: string, participants: string[]): Promise<KeyState> {
    const r = exact(await this.session.request(`/api/conversations/${part(cid)}/keys`), ['conversationId', 'participantIds', 'devices', 'currentEpoch', 'epochs', 'cursor']);
    if (r.conversationId !== cid || !Array.isArray(r.participantIds) || JSON.stringify([...r.participantIds].sort()) !== JSON.stringify([...participants].sort()) ||
      !Array.isArray(r.devices) || r.devices.length > 20 || !Array.isArray(r.epochs) || r.epochs.length > 20) throw new E2eeError('invalid_proof');
    const devices = await Promise.all(r.devices.map(verifyDevice));
    if (devices.some(d => d.status !== 'active' || !participants.includes(d.userId)) || new Set(devices.map(d => d.deviceKeyId)).size !== devices.length) throw new E2eeError('invalid_proof');
    let currentEpoch: KeyState['currentEpoch'] = null;
    if (r.currentEpoch !== null) { const c = exact(r.currentEpoch, ['keyId', 'epoch']); decode(c.keyId, 16); if (!Number.isInteger(c.epoch) || (c.epoch as number) < 1 || (c.epoch as number) > 1000000000) throw new E2eeError('invalid_proof'); currentEpoch = c as unknown as KeyState['currentEpoch']; }
    const epochs = r.epochs.map(e => parseEpoch(e, cid));
    if (epochs.some((e, i) => !participants.includes(e.creatorUserId) || (i > 0 && e.epoch >= epochs[i - 1]!.epoch)) ||
      (currentEpoch ? epochs[0]?.keyId !== currentEpoch.keyId || epochs[0].epoch !== currentEpoch.epoch : epochs.length !== 0)) throw new E2eeError('invalid_proof');
    return { conversationId: cid, participantIds: participants, devices, currentEpoch, epochs, cursor: pageCursor(r.cursor) };
  }
  async epoch(cid: string, keyId: string): Promise<KeyEpoch> { decode(keyId, 16); const r = exact(await this.session.request(`/api/conversations/${part(cid)}/keys/epochs/${part(keyId)}`), ['epoch']); const e = parseEpoch(r.epoch, cid); if (e.keyId !== keyId) throw new E2eeError('invalid_proof'); return e; }
  async publish(cid: string, body: EpochBody): Promise<KeyEpoch> {
    const validated = parseEpoch({ ...body, conversationId: cid, creatorUserId: this.session.actor.id, publishedAt: body.createdAt }, cid);
    const { conversationId: _cid, creatorUserId: _creator, publishedAt: _time, ...safe } = validated;
    const r = exact(await this.session.request(`/api/conversations/${part(cid)}/keys/epochs`, { method: 'POST', body: safe, status: [200, 201] }), ['epoch']); const e = parseEpoch(r.epoch, cid); if (e.keyId !== body.keyId) throw new E2eeError('invalid_proof'); return e;
  }
  stored(input: unknown, cid: string): StoredMessage {
    const r = exact(input, ['storageId', 'id', 'conversationId', 'senderId', 'senderName', 'timestamp', 'type', 'encryption', 'storedAt', 'updatedAt', 'sequence', 'revision', 'state', 'deletedAt',...(Object.prototype.hasOwnProperty.call(object(input),'edit')?['edit']:[])]);
    if(r.edit!==undefined){
      if(r.state!=='active')throw new E2eeError('invalid_message');
      const edit=exact(r.edit,['v','proofs','envelope']);
      if(edit.v!==1||!Array.isArray(edit.proofs)||!edit.proofs.length||edit.proofs.length>MAX_MESSAGE_EDITS)throw new E2eeError('invalid_message');
      edit.proofs.forEach((item,i)=>{const x=exact(item,['proof','signer']),p=parseEditProof(x.proof);
        if(!p||p.revision!==i+1||p.storageId!==r.storageId||p.messageId!==r.id||p.conversationId!==cid||p.senderId!==r.senderId)throw new E2eeError('invalid_message');object(x.signer);
      });parseEnvelope(edit.envelope);
    }
    if (r.conversationId !== cid || !Number.isSafeInteger(r.sequence) || (r.sequence as number) < 1 || ![0, 1].includes(r.revision as number) || !['active', 'deleted'].includes(r.state as string)) throw new E2eeError('invalid_message');
    identifier(r.storageId); timestamp(r.storedAt); timestamp(r.updatedAt);
    if (r.state === 'deleted') { if (r.encryption !== null || r.revision !== 1) throw new E2eeError('invalid_message'); timestamp(r.deletedAt); identifier(r.id); identifier(r.senderId); }
    else { if (r.deletedAt !== null || r.revision !== 0) throw new E2eeError('invalid_message');
      const wire = Object.fromEntries(['id', 'conversationId', 'senderId', 'senderName', 'timestamp', 'type', 'encryption'].map(k => [k, r[k]]));
      if (object(r.encryption).version === 1) { const x = exact(r.encryption, ['version', 'algorithm', 'encoding', 'iv', 'ciphertext']);
        if (x.algorithm !== 'AES-256-GCM' || x.encoding !== 'base64') throw new E2eeError('invalid_message'); decode(x.iv, 12, false); decode(x.ciphertext, undefined, false);
      } else parseEnvelope(wire);
    }
    return r as unknown as StoredMessage;
  }
  async submit(envelope: EnvelopeV2): Promise<StoredMessage> {
    const r = exact(await this.session.request(`/api/conversations/${part(envelope.conversationId)}/messages`, { method: 'POST', body: parseEnvelope(envelope), status: [200, 201] }), ['outcome', 'message']);
    if (!['created', 'duplicate'].includes(r.outcome as string)) throw new E2eeError('invalid_message'); const message = this.stored(r.message, envelope.conversationId);
    if (message.id !== envelope.id || message.senderId !== this.session.actor.id) throw new E2eeError('invalid_message'); return message;
  }
  async history(cid: string, cursor?: string): Promise<{ items: StoredMessage[]; nextCursor: string | null }> {
    const r = exact(await this.session.request(`/api/conversations/${part(cid)}/messages?limit=50` + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')), ['items', 'nextCursor']);
    if (!Array.isArray(r.items) || r.items.length > 50) throw new E2eeError('invalid_message'); const items = r.items.map(m => this.stored(m, cid));
    if (items.some((m, i) => i > 0 && m.sequence >= items[i - 1]!.sequence)) throw new E2eeError('invalid_message'); return { items, nextCursor: pageCursor(r.nextCursor) };
  }
  async read(storageId: string): Promise<void> { await this.session.request(`/api/messages/${part(storageId)}/read`, { method: 'POST' }); }
  async remove(storageId: string): Promise<StoredMessage> { const r = object(await this.session.request(`/api/messages/${part(storageId)}`, { method: 'DELETE' })); const m = object(r.message); return this.stored(m, identifier(m.conversationId)); }
}
export function securityMessage(error: unknown): string { return error instanceof E2eeError || error instanceof ApiError ? error.message : 'Secure messaging is unavailable. Refresh and try again.'; }
