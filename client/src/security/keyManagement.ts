import { generateEncryptionKey, isWebCryptoAvailable } from '@/utils/crypto';

export interface ConversationKeyContext {
  conversationId: string;
  localUserId: string;
  recipientId?: string;
}

/** Opaque placeholder for a future reviewed recipient-key protocol. */
export interface RecipientPublicKeyMetadata {
  recipientId: string;
  keyId: string;
  algorithm: string;
  version: number;
}

export interface ConversationSecurityStatus {
  browserCryptoAvailable: boolean;
  localEncryptionAvailable: boolean;
  recipientKeyAvailable: boolean;
  authenticatedKeyExchangeEstablished: boolean;
}

export class KeyManagementError extends Error {
  constructor(public readonly code: 'key_exchange_not_configured') {
    super('Authenticated recipient key exchange is not configured.');
    this.name = 'KeyManagementError';
  }
}

export interface ConversationKeyManager {
  getConversationKey(context: ConversationKeyContext): Promise<CryptoKey>;
  getExistingConversationKey(context: ConversationKeyContext): Promise<CryptoKey | null>;
  getRecipientPublicKeyMetadata(context: ConversationKeyContext): Promise<RecipientPublicKeyMetadata | null>;
  establishAuthenticatedKeyExchange(context: ConversationKeyContext): Promise<void>;
  rotateConversationKey(context: ConversationKeyContext): Promise<CryptoKey>;
  getSecurityStatus(context: ConversationKeyContext): Promise<ConversationSecurityStatus>;
}

/** Demo manager: ephemeral keys exist only in this page's memory. */
export class InMemoryDemoKeyManager implements ConversationKeyManager {
  private readonly keys = new Map<string, Promise<CryptoKey>>();

  private keyId(context: ConversationKeyContext): string {
    return JSON.stringify([context.localUserId, context.conversationId]);
  }

  private createConversationKey(id: string): Promise<CryptoKey> {
    const pending = generateEncryptionKey().catch((error: unknown) => {
      if (this.keys.get(id) === pending) this.keys.delete(id);
      throw error;
    });
    this.keys.set(id, pending);
    return pending;
  }

  getConversationKey(context: ConversationKeyContext): Promise<CryptoKey> {
    const id = this.keyId(context);
    return this.keys.get(id) ?? this.createConversationKey(id);
  }

  async getExistingConversationKey(context: ConversationKeyContext): Promise<CryptoKey | null> {
    const keyPromise = this.keys.get(this.keyId(context));
    return keyPromise ? keyPromise : null;
  }

  async getRecipientPublicKeyMetadata(_context: ConversationKeyContext): Promise<RecipientPublicKeyMetadata | null> {
    return null;
  }

  async establishAuthenticatedKeyExchange(_context: ConversationKeyContext): Promise<void> {
    throw new KeyManagementError('key_exchange_not_configured');
  }

  rotateConversationKey(context: ConversationKeyContext): Promise<CryptoKey> {
    return this.createConversationKey(this.keyId(context));
  }

  async getSecurityStatus(context: ConversationKeyContext): Promise<ConversationSecurityStatus> {
    const browserCryptoAvailable = isWebCryptoAvailable();
    let localEncryptionAvailable = false;
    if (browserCryptoAvailable) {
      try {
        await this.getConversationKey(context);
        localEncryptionAvailable = true;
      } catch {
        localEncryptionAvailable = false;
      }
    }
    return {
      browserCryptoAvailable,
      localEncryptionAvailable,
      recipientKeyAvailable: false,
      authenticatedKeyExchangeEstablished: false,
    };
  }
}
