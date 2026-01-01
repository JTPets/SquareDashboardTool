/**
 * Token Encryption Utility
 * Provides AES-256-GCM encryption for Square OAuth tokens at rest
 *
 * Usage:
 *   const { encryptToken, decryptToken } = require('./token-encryption');
 *   const encrypted = encryptToken(accessToken);
 *   const decrypted = decryptToken(encrypted);
 *
 * Environment:
 *   TOKEN_ENCRYPTION_KEY - 32-byte hex string (64 characters)
 *   Generate with: openssl rand -hex 32
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;        // 128 bits
const AUTH_TAG_LENGTH = 16;  // 128 bits

/**
 * Get the encryption key from environment
 * @returns {Buffer} 32-byte encryption key
 * @throws {Error} If key is missing or invalid
 */
function getEncryptionKey() {
    const key = process.env.TOKEN_ENCRYPTION_KEY;

    if (!key) {
        throw new Error(
            'TOKEN_ENCRYPTION_KEY environment variable is required. ' +
            'Generate one with: openssl rand -hex 32'
        );
    }

    if (key.length !== 64) {
        throw new Error(
            'TOKEN_ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters). ' +
            `Current length: ${key.length / 2} bytes`
        );
    }

    // Validate hex format
    if (!/^[a-fA-F0-9]{64}$/.test(key)) {
        throw new Error('TOKEN_ENCRYPTION_KEY must be a valid hex string');
    }

    return Buffer.from(key, 'hex');
}

/**
 * Encrypt a plaintext token using AES-256-GCM
 * @param {string} plaintext - The token to encrypt
 * @returns {string} Encrypted token in format: iv:authTag:ciphertext (all hex)
 */
function encryptToken(plaintext) {
    if (!plaintext || typeof plaintext !== 'string') {
        throw new Error('Token must be a non-empty string');
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:ciphertext (all hex encoded)
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt an encrypted token using AES-256-GCM
 * @param {string} encryptedToken - The encrypted token from encryptToken()
 * @returns {string} The original plaintext token
 * @throws {Error} If decryption fails (invalid token, wrong key, or tampering)
 */
function decryptToken(encryptedToken) {
    if (!encryptedToken || typeof encryptedToken !== 'string') {
        throw new Error('Encrypted token must be a non-empty string');
    }

    const parts = encryptedToken.split(':');
    if (parts.length !== 3) {
        throw new Error('Invalid encrypted token format. Expected iv:authTag:ciphertext');
    }

    const [ivHex, authTagHex, ciphertext] = parts;

    // Validate parts
    if (!ivHex || ivHex.length !== IV_LENGTH * 2) {
        throw new Error('Invalid IV in encrypted token');
    }
    if (!authTagHex || authTagHex.length !== AUTH_TAG_LENGTH * 2) {
        throw new Error('Invalid auth tag in encrypted token');
    }
    if (!ciphertext) {
        throw new Error('Missing ciphertext in encrypted token');
    }

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
    decipher.setAuthTag(authTag);

    try {
        let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        // GCM auth failure or other decryption error
        throw new Error('Failed to decrypt token. Token may be corrupted or key is incorrect.');
    }
}

/**
 * Check if a string appears to be an encrypted token
 * @param {string} value - The value to check
 * @returns {boolean} True if the format matches encrypted token pattern
 */
function isEncryptedToken(value) {
    if (!value || typeof value !== 'string') {
        return false;
    }

    const parts = value.split(':');
    if (parts.length !== 3) {
        return false;
    }

    const [iv, authTag, ciphertext] = parts;

    // Check hex format and lengths
    const hexPattern = /^[a-fA-F0-9]+$/;
    return (
        iv && iv.length === IV_LENGTH * 2 && hexPattern.test(iv) &&
        authTag && authTag.length === AUTH_TAG_LENGTH * 2 && hexPattern.test(authTag) &&
        ciphertext && ciphertext.length > 0 && hexPattern.test(ciphertext)
    );
}

/**
 * Validate that the encryption key is properly configured
 * @returns {boolean} True if key is valid
 */
function validateEncryptionKey() {
    try {
        getEncryptionKey();
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * Test encryption/decryption roundtrip
 * Use this to verify the encryption is working correctly
 * @returns {boolean} True if encryption/decryption works
 */
function testEncryption() {
    const testValue = 'test_token_' + Date.now();
    try {
        const encrypted = encryptToken(testValue);
        const decrypted = decryptToken(encrypted);
        return decrypted === testValue;
    } catch (error) {
        console.error('Encryption test failed:', error.message);
        return false;
    }
}

module.exports = {
    encryptToken,
    decryptToken,
    isEncryptedToken,
    validateEncryptionKey,
    testEncryption
};
