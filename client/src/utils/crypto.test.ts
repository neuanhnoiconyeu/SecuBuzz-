/**
 * E2EE Crypto Utility Tests
 * 
 * Tests for:
 * - Key generation
 * - Message encryption
 * - Message decryption
 * - Error handling
 * - Round-trip encryption/decryption
 */

import {
  generateEncryptionKey,
  encryptMessage,
  decryptMessage,
  exportKey,
  importKey,
} from './crypto';

describe('Crypto Utilities', () => {
  describe('generateEncryptionKey', () => {
    it('should generate a valid AES-GCM encryption key', async () => {
      const key = await generateEncryptionKey();
      expect(key).toBeDefined();
      expect(key.type).toBe('secret');
      expect(key.algorithm.name).toBe('AES-GCM');
      expect(key.usages).toContain('encrypt');
      expect(key.usages).toContain('decrypt');
    });

    it('should generate different keys each time', async () => {
      const key1 = await generateEncryptionKey();
      const key2 = await generateEncryptionKey();

      // Keys should be different objects (though we can't directly compare CryptoKey)
      expect(key1).not.toBe(key2);
    });

    it('should throw error if Web Crypto API is unavailable', async () => {
      const originalCrypto = globalThis.crypto;
      (globalThis.crypto as any) = undefined;

      try {
        await expect(generateEncryptionKey()).rejects.toThrow(
          'Web Crypto API not available'
        );
      } finally {
        globalThis.crypto = originalCrypto;
      }
    });
  });

  describe('encryptMessage', () => {
    let key: CryptoKey;

    beforeEach(async () => {
      key = await generateEncryptionKey();
    });

    it('should encrypt a message and return ciphertext and IV', async () => {
      const message = 'Hello, Yahoo! Security Messenger';
      const result = await encryptMessage(message, key);

      expect(result).toHaveProperty('ciphertext');
      expect(result).toHaveProperty('iv');
      expect(typeof result.ciphertext).toBe('string');
      expect(typeof result.iv).toBe('string');
      expect(result.ciphertext.length).toBeGreaterThan(0);
      expect(result.iv.length).toBeGreaterThan(0);
    });

    it('should produce different ciphertexts for the same message (due to random IV)', async () => {
      const message = 'Test message';

      const result1 = await encryptMessage(message, key);
      const result2 = await encryptMessage(message, key);

      expect(result1.ciphertext).not.toBe(result2.ciphertext);
      expect(result1.iv).not.toBe(result2.iv);
    });

    it('should encrypt empty string', async () => {
      const result = await encryptMessage('', key);
      expect(result).toHaveProperty('ciphertext');
      expect(result).toHaveProperty('iv');
    });

    it('should encrypt long messages', async () => {
      const longMessage = 'A'.repeat(10000);
      const result = await encryptMessage(longMessage, key);
      expect(result.ciphertext.length).toBeGreaterThan(0);
    });

    it('should encrypt special characters and unicode', async () => {
      const message = '🔐 Hello 世界 مرحبا 🌍';
      const result = await encryptMessage(message, key);
      expect(result).toHaveProperty('ciphertext');
      expect(result).toHaveProperty('iv');
    });

    it('should throw error with invalid message', async () => {
      await expect(encryptMessage(null as any, key)).rejects.toThrow(
        'Invalid message'
      );
    });

    it('should throw error with invalid key', async () => {
      await expect(encryptMessage('test', null as any)).rejects.toThrow(
        'Invalid encryption key'
      );
    });
  });

  describe('decryptMessage', () => {
    let key: CryptoKey;

    beforeEach(async () => {
      key = await generateEncryptionKey();
    });

    it('should decrypt an encrypted message correctly', async () => {
      const originalMessage = 'Hello, Yahoo! Security Messenger';
      const { ciphertext, iv } = await encryptMessage(originalMessage, key);

      const decrypted = await decryptMessage(ciphertext, iv, key);
      expect(decrypted).toBe(originalMessage);
    });

    it('should decrypt messages with special characters', async () => {
      const originalMessage = '🔐 Test 中文 العربية';
      const { ciphertext, iv } = await encryptMessage(originalMessage, key);

      const decrypted = await decryptMessage(ciphertext, iv, key);
      expect(decrypted).toBe(originalMessage);
    });

    it('should throw error if ciphertext is tampered with', async () => {
      const { ciphertext, iv } = await encryptMessage('test', key);

      // Tamper with the ciphertext
      const tampered = Buffer.from(
        atob(ciphertext),
        'binary'
      );
      tampered[0] ^= 0xff; // Flip bits
      const tamperedBase64 = btoa(
        String.fromCharCode(...Array.from(tampered))
      );

      await expect(
        decryptMessage(tamperedBase64, iv, key)
      ).rejects.toThrow(
        /authentication|Decryption failed/i
      );
    });

    it('should throw error if IV is incorrect', async () => {
      const { ciphertext } = await encryptMessage('test', key);

      // Generate wrong IV
      const wrongIV = Buffer.from(new Uint8Array(12)).toString('base64');

      await expect(
        decryptMessage(ciphertext, wrongIV, key)
      ).rejects.toThrow(
        /authentication|Decryption failed/i
      );
    });

    it('should throw error with invalid ciphertext', async () => {
      const iv = Buffer.from(new Uint8Array(12)).toString('base64');

      await expect(
        decryptMessage('invalid', iv, key)
      ).rejects.toThrow('Decryption failed');
    });

    it('should throw error with invalid IV', async () => {
      const { ciphertext } = await encryptMessage('test', key);

      await expect(
        decryptMessage(ciphertext, 'invalid', key)
      ).rejects.toThrow('Decryption failed');
    });

    it('should throw error with invalid key', async () => {
      const { ciphertext, iv } = await encryptMessage('test', key);

      await expect(
        decryptMessage(ciphertext, iv, null as any)
      ).rejects.toThrow('Invalid decryption key');
    });
  });

  describe('Round-trip encryption/decryption', () => {
    let key: CryptoKey;

    beforeEach(async () => {
      key = await generateEncryptionKey();
    });

    it('should correctly round-trip multiple messages', async () => {
      const messages = [
        'Short',
        'This is a medium length message',
        'A'.repeat(1000),
        '🔐 Unicode: 日本語 العربية Ελληνικά',
      ];

      for (const message of messages) {
        const { ciphertext, iv } = await encryptMessage(message, key);
        const decrypted = await decryptMessage(ciphertext, iv, key);
        expect(decrypted).toBe(message);
      }
    });

    it('should maintain message integrity across multiple encryptions', async () => {
      const message = 'Integrity test message';

      for (let i = 0; i < 5; i++) {
        const { ciphertext, iv } = await encryptMessage(message, key);
        const decrypted = await decryptMessage(ciphertext, iv, key);
        expect(decrypted).toBe(message);
      }
    });
  });

  describe('Key export/import', () => {
    it('should export and import a key successfully', async () => {
      const originalKey = await generateEncryptionKey();

      // Export the key
      const exported = await exportKey(originalKey);
      expect(typeof exported).toBe('string');
      expect(exported.length).toBeGreaterThan(0);

      // Import the key
      const importedKey = await importKey(exported);

      // Test that imported key works
      const message = 'Test message';
      const { ciphertext, iv } = await encryptMessage(message, originalKey);
      const decrypted = await decryptMessage(ciphertext, iv, importedKey);
      expect(decrypted).toBe(message);
    });

    it('should throw error on invalid key export', async () => {
      await expect(exportKey(null as any)).rejects.toThrow(
        'Failed to export key'
      );
    });

    it('should throw error on invalid key import', async () => {
      await expect(importKey('invalid-base64!')).rejects.toThrow(
        'Failed to import key'
      );
    });
  });

  describe('Error handling', () => {
    it('should provide meaningful error messages', async () => {
      const key = await generateEncryptionKey();

      try {
        await decryptMessage('', '', key);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(
          /invalid|empty|decryption/i
        );
      }
    });
  });

  describe('Performance', () => {
    it('should encrypt message in reasonable time', async () => {
      const key = await generateEncryptionKey();
      const message = 'Performance test message';

      const start = performance.now();
      await encryptMessage(message, key);
      const duration = performance.now() - start;

      // Should complete within 100ms
      expect(duration).toBeLessThan(100);
    });

    it('should decrypt message in reasonable time', async () => {
      const key = await generateEncryptionKey();
      const message = 'Performance test message';
      const { ciphertext, iv } = await encryptMessage(message, key);

      const start = performance.now();
      await decryptMessage(ciphertext, iv, key);
      const duration = performance.now() - start;

      // Should complete within 100ms
      expect(duration).toBeLessThan(100);
    });
  });
});
