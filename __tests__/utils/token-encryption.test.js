/**
 * Token Encryption Utilities Test Suite
 *
 * Tests for AES-256-GCM token encryption/decryption
 * These are CRITICAL security functions - high coverage required
 */

const {
    encryptToken,
    decryptToken,
    isEncryptedToken,
    validateEncryptionKey,
    testEncryption
} = require('../../utils/token-encryption');

describe('Token Encryption Utilities', () => {

    // ==================== encryptToken ====================
    describe('encryptToken', () => {

        test('returns encrypted string in correct format', () => {
            const encrypted = encryptToken('my-secret-token');
            expect(typeof encrypted).toBe('string');

            // Format should be iv:authTag:ciphertext
            const parts = encrypted.split(':');
            expect(parts).toHaveLength(3);
        });

        test('IV has correct length (32 hex chars = 16 bytes)', () => {
            const encrypted = encryptToken('test-token');
            const [iv] = encrypted.split(':');
            expect(iv.length).toBe(32);
            expect(/^[a-fA-F0-9]+$/.test(iv)).toBe(true);
        });

        test('auth tag has correct length (32 hex chars = 16 bytes)', () => {
            const encrypted = encryptToken('test-token');
            const [, authTag] = encrypted.split(':');
            expect(authTag.length).toBe(32);
            expect(/^[a-fA-F0-9]+$/.test(authTag)).toBe(true);
        });

        test('ciphertext is non-empty hex string', () => {
            const encrypted = encryptToken('test-token');
            const [, , ciphertext] = encrypted.split(':');
            expect(ciphertext.length).toBeGreaterThan(0);
            expect(/^[a-fA-F0-9]+$/.test(ciphertext)).toBe(true);
        });

        test('produces different ciphertext for same input (random IV)', () => {
            const encrypted1 = encryptToken('same-token');
            const encrypted2 = encryptToken('same-token');
            expect(encrypted1).not.toBe(encrypted2);
        });

        test('handles empty string token', () => {
            expect(() => encryptToken('')).toThrow('Token must be a non-empty string');
        });

        test('handles null token', () => {
            expect(() => encryptToken(null)).toThrow('Token must be a non-empty string');
        });

        test('handles undefined token', () => {
            expect(() => encryptToken(undefined)).toThrow('Token must be a non-empty string');
        });

        test('handles non-string input', () => {
            expect(() => encryptToken(12345)).toThrow('Token must be a non-empty string');
        });

        test('handles unicode characters', () => {
            const encrypted = encryptToken('token-with-unicode-');
            expect(encrypted.split(':').length).toBe(3);
        });

        test('handles very long tokens', () => {
            const longToken = 'x'.repeat(10000);
            const encrypted = encryptToken(longToken);
            expect(encrypted.split(':').length).toBe(3);
        });

        test('handles tokens with special characters', () => {
            const specialToken = 'token!@#$%^&*()_+-=[]{}|;:",.<>?/`~';
            const encrypted = encryptToken(specialToken);
            expect(encrypted.split(':').length).toBe(3);
        });

        test('handles newlines in token', () => {
            const tokenWithNewlines = 'line1\nline2\nline3';
            const encrypted = encryptToken(tokenWithNewlines);
            expect(encrypted.split(':').length).toBe(3);
        });
    });

    // ==================== decryptToken ====================
    describe('decryptToken', () => {

        test('correctly decrypts encrypted token', () => {
            const original = 'my-secret-token-12345';
            const encrypted = encryptToken(original);
            const decrypted = decryptToken(encrypted);
            expect(decrypted).toBe(original);
        });

        test('correctly decrypts unicode token', () => {
            const original = 'token-';
            const encrypted = encryptToken(original);
            const decrypted = decryptToken(encrypted);
            expect(decrypted).toBe(original);
        });

        test('correctly decrypts very long token', () => {
            const original = 'x'.repeat(10000);
            const encrypted = encryptToken(original);
            const decrypted = decryptToken(encrypted);
            expect(decrypted).toBe(original);
        });

        test('correctly decrypts token with special characters', () => {
            const original = 'token!@#$%^&*()_+-=[]{}|;:",.<>?/`~';
            const encrypted = encryptToken(original);
            const decrypted = decryptToken(encrypted);
            expect(decrypted).toBe(original);
        });

        test('correctly decrypts token with newlines', () => {
            const original = 'line1\nline2\nline3';
            const encrypted = encryptToken(original);
            const decrypted = decryptToken(encrypted);
            expect(decrypted).toBe(original);
        });

        test('throws on empty string', () => {
            expect(() => decryptToken('')).toThrow('Encrypted token must be a non-empty string');
        });

        test('throws on null', () => {
            expect(() => decryptToken(null)).toThrow('Encrypted token must be a non-empty string');
        });

        test('throws on undefined', () => {
            expect(() => decryptToken(undefined)).toThrow('Encrypted token must be a non-empty string');
        });

        test('throws on invalid format (no colons)', () => {
            expect(() => decryptToken('invalid-token-no-colons')).toThrow('Invalid encrypted token format');
        });

        test('throws on invalid format (too few parts)', () => {
            expect(() => decryptToken('part1:part2')).toThrow('Invalid encrypted token format');
        });

        test('throws on invalid format (too many parts)', () => {
            expect(() => decryptToken('part1:part2:part3:part4')).toThrow('Invalid encrypted token format');
        });

        test('throws on invalid IV length', () => {
            // IV should be 32 hex chars (16 bytes)
            const shortIv = 'a'.repeat(30); // too short
            const authTag = 'b'.repeat(32);
            const ciphertext = 'c'.repeat(20);
            expect(() => decryptToken(`${shortIv}:${authTag}:${ciphertext}`)).toThrow('Invalid IV');
        });

        test('throws on invalid auth tag length', () => {
            const iv = 'a'.repeat(32);
            const shortAuthTag = 'b'.repeat(30); // too short
            const ciphertext = 'c'.repeat(20);
            expect(() => decryptToken(`${iv}:${shortAuthTag}:${ciphertext}`)).toThrow('Invalid auth tag');
        });

        test('throws on missing ciphertext', () => {
            const iv = 'a'.repeat(32);
            const authTag = 'b'.repeat(32);
            expect(() => decryptToken(`${iv}:${authTag}:`)).toThrow('Missing ciphertext');
        });

        test('throws on tampered ciphertext', () => {
            const encrypted = encryptToken('test-token');
            const parts = encrypted.split(':');
            // Tamper with ciphertext
            parts[2] = 'tampered' + parts[2].slice(8);
            const tampered = parts.join(':');
            expect(() => decryptToken(tampered)).toThrow('Failed to decrypt');
        });

        test('throws on tampered auth tag', () => {
            const encrypted = encryptToken('test-token');
            const parts = encrypted.split(':');
            // Tamper with auth tag
            parts[1] = 'a'.repeat(32);
            const tampered = parts.join(':');
            expect(() => decryptToken(tampered)).toThrow('Failed to decrypt');
        });

        test('throws on tampered IV', () => {
            const encrypted = encryptToken('test-token');
            const parts = encrypted.split(':');
            // Tamper with IV
            parts[0] = 'b'.repeat(32);
            const tampered = parts.join(':');
            expect(() => decryptToken(tampered)).toThrow('Failed to decrypt');
        });
    });

    // ==================== isEncryptedToken ====================
    describe('isEncryptedToken', () => {

        test('returns true for valid encrypted token', () => {
            const encrypted = encryptToken('test-token');
            expect(isEncryptedToken(encrypted)).toBe(true);
        });

        test('returns false for null', () => {
            expect(isEncryptedToken(null)).toBe(false);
        });

        test('returns false for undefined', () => {
            expect(isEncryptedToken(undefined)).toBe(false);
        });

        test('returns false for empty string', () => {
            expect(isEncryptedToken('')).toBe(false);
        });

        test('returns false for plain text token', () => {
            expect(isEncryptedToken('EAABwzLixnjYBO...')).toBe(false);
        });

        test('returns false for string with wrong number of parts', () => {
            expect(isEncryptedToken('part1:part2')).toBe(false);
            expect(isEncryptedToken('part1:part2:part3:part4')).toBe(false);
        });

        test('returns false for invalid IV length', () => {
            const shortIv = 'a'.repeat(30);
            const authTag = 'b'.repeat(32);
            const ciphertext = 'c'.repeat(20);
            expect(isEncryptedToken(`${shortIv}:${authTag}:${ciphertext}`)).toBe(false);
        });

        test('returns false for invalid auth tag length', () => {
            const iv = 'a'.repeat(32);
            const shortAuthTag = 'b'.repeat(30);
            const ciphertext = 'c'.repeat(20);
            expect(isEncryptedToken(`${iv}:${shortAuthTag}:${ciphertext}`)).toBe(false);
        });

        test('returns false for non-hex characters in IV', () => {
            const badIv = 'g'.repeat(32); // 'g' is not hex
            const authTag = 'a'.repeat(32);
            const ciphertext = 'b'.repeat(20);
            expect(isEncryptedToken(`${badIv}:${authTag}:${ciphertext}`)).toBe(false);
        });

        test('returns false for non-hex characters in auth tag', () => {
            const iv = 'a'.repeat(32);
            const badAuthTag = 'z'.repeat(32); // 'z' is not hex
            const ciphertext = 'b'.repeat(20);
            expect(isEncryptedToken(`${iv}:${badAuthTag}:${ciphertext}`)).toBe(false);
        });

        test('returns false for non-hex characters in ciphertext', () => {
            const iv = 'a'.repeat(32);
            const authTag = 'b'.repeat(32);
            const badCiphertext = 'xyz123'; // 'x', 'y', 'z' are not hex
            expect(isEncryptedToken(`${iv}:${authTag}:${badCiphertext}`)).toBe(false);
        });

        test('returns true for valid format regardless of content', () => {
            // Even if it can't be decrypted, the format check should pass
            const validFormat = 'a'.repeat(32) + ':' + 'b'.repeat(32) + ':' + 'c'.repeat(20);
            expect(isEncryptedToken(validFormat)).toBe(true);
        });
    });

    // ==================== validateEncryptionKey ====================
    describe('validateEncryptionKey', () => {

        test('returns true when valid key is configured', () => {
            // The setup.js sets a valid key
            expect(validateEncryptionKey()).toBe(true);
        });

        test('returns false when key is missing', () => {
            const originalKey = process.env.TOKEN_ENCRYPTION_KEY;
            delete process.env.TOKEN_ENCRYPTION_KEY;

            expect(validateEncryptionKey()).toBe(false);

            process.env.TOKEN_ENCRYPTION_KEY = originalKey;
        });

        test('returns false when key is too short', () => {
            const originalKey = process.env.TOKEN_ENCRYPTION_KEY;
            process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(32); // 32 chars, need 64

            expect(validateEncryptionKey()).toBe(false);

            process.env.TOKEN_ENCRYPTION_KEY = originalKey;
        });

        test('returns false when key is too long', () => {
            const originalKey = process.env.TOKEN_ENCRYPTION_KEY;
            process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(128); // too long

            expect(validateEncryptionKey()).toBe(false);

            process.env.TOKEN_ENCRYPTION_KEY = originalKey;
        });

        test('returns false when key contains non-hex characters', () => {
            const originalKey = process.env.TOKEN_ENCRYPTION_KEY;
            process.env.TOKEN_ENCRYPTION_KEY = 'g'.repeat(64); // 'g' is not hex

            expect(validateEncryptionKey()).toBe(false);

            process.env.TOKEN_ENCRYPTION_KEY = originalKey;
        });
    });

    // ==================== testEncryption ====================
    describe('testEncryption', () => {

        test('returns true when encryption is working', () => {
            expect(testEncryption()).toBe(true);
        });

        test('returns false when encryption key is invalid', () => {
            const originalKey = process.env.TOKEN_ENCRYPTION_KEY;
            process.env.TOKEN_ENCRYPTION_KEY = 'invalid';

            expect(testEncryption()).toBe(false);

            process.env.TOKEN_ENCRYPTION_KEY = originalKey;
        });
    });

    // ==================== Roundtrip Tests ====================
    describe('Encryption Roundtrip', () => {

        test('multiple roundtrips work correctly', () => {
            const tokens = [
                'simple-token',
                'token-with-special-!@#$%',
                'token with spaces',
                'token\nwith\nnewlines',
                'x'.repeat(1000),
                'unicode-'
            ];

            for (const token of tokens) {
                const encrypted = encryptToken(token);
                const decrypted = decryptToken(encrypted);
                expect(decrypted).toBe(token);
            }
        });

        test('encrypted tokens are detected correctly', () => {
            const original = 'test-token';
            const encrypted = encryptToken(original);

            expect(isEncryptedToken(original)).toBe(false);
            expect(isEncryptedToken(encrypted)).toBe(true);
        });
    });
});
