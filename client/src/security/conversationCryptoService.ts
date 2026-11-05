import {
  CryptoOperationError,
  decryptMessage,
  encryptMessage,
  type CryptoMessageContext,
  type EncryptedMessagePayload,
} from '@/utils/crypto';
import {
  InMemoryDemoKeyManager,
  type ConversationKeyContext,
  type ConversationKeyManager,
  type ConversationSecurityStatus,
} from './keyManagement';

export interface ConversationCryptoService {
  prepareConversation(context: ConversationKeyContext): Promise<ConversationSecurityStatus>;
  encrypt(context: ConversationKeyContext, plaintext: string, message: CryptoMessageContext): Promise<EncryptedMessagePayload>;
  decrypt(context: ConversationKeyContext, payload: unknown, message: CryptoMessageContext): Promise<string>;
}

export class BrowserConversationCryptoService implements ConversationCryptoService {
  constructor(private readonly keyManager: ConversationKeyManager) {}

  prepareConversation(context: ConversationKeyContext) {
    return this.keyManager.getSecurityStatus(context);
  }

  async encrypt(context: ConversationKeyContext, plaintext: string, message: CryptoMessageContext) {
    const key = await this.keyManager.getConversationKey(context);
    return encryptMessage(plaintext, key, message);
  }

  async decrypt(context: ConversationKeyContext, payload: unknown, message: CryptoMessageContext) {
    const key = await this.keyManager.getExistingConversationKey(context);
    if (!key) throw new CryptoOperationError('missing_key');
    return decryptMessage(payload, key, message);
  }
}

export const demoConversationCryptoService = new BrowserConversationCryptoService(new InMemoryDemoKeyManager());
