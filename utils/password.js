/**
 * Password Utilities
 * Handles password hashing, verification, and validation
 */

const bcrypt = require('bcrypt');
const logger = require('./logger');

// Number of salt rounds for bcrypt (higher = more secure but slower)
const SALT_ROUNDS = 12;

// Password requirements
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_REQUIRE_UPPERCASE = true;
const PASSWORD_REQUIRE_NUMBER = true;

/**
 * Validate password meets requirements
 * @param {string} password - Plain text password
 * @returns {Object} { valid: boolean, errors: string[] }
 */
function validatePassword(password) {
    const errors = [];

    if (!password || typeof password !== 'string') {
        return { valid: false, errors: ['Password is required'] };
    }

    if (password.length < PASSWORD_MIN_LENGTH) {
        errors.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
    }

    if (PASSWORD_REQUIRE_UPPERCASE && !/[A-Z]/.test(password)) {
        errors.push('Password must contain at least one uppercase letter');
    }

    if (PASSWORD_REQUIRE_NUMBER && !/[0-9]/.test(password)) {
        errors.push('Password must contain at least one number');
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Hash a password using bcrypt
 * @param {string} password - Plain text password
 * @returns {Promise<string>} Hashed password
 */
async function hashPassword(password) {
    try {
        const hash = await bcrypt.hash(password, SALT_ROUNDS);
        return hash;
    } catch (error) {
        logger.error('Password hashing failed', { error: error.message, stack: error.stack });
        throw new Error('Failed to hash password');
    }
}

/**
 * Verify a password against a hash
 * @param {string} password - Plain text password
 * @param {string} hash - Bcrypt hash to compare against
 * @returns {Promise<boolean>} True if password matches
 */
async function verifyPassword(password, hash) {
    try {
        const match = await bcrypt.compare(password, hash);
        return match;
    } catch (error) {
        logger.error('Password verification failed', { error: error.message, stack: error.stack });
        return false;
    }
}

/**
 * Generate a random password (for initial admin or password resets)
 * SECURITY FIX: Uses crypto.randomInt for cryptographically secure random numbers
 * @param {number} length - Password length (default 16)
 * @returns {string} Random password meeting requirements
 */
function generateRandomPassword(length = 16) {
    const crypto = require('crypto');
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const numbers = '0123456789';
    const special = '!@#$%^&*';
    const all = uppercase + lowercase + numbers + special;

    // SECURITY FIX: Use crypto.randomInt instead of Math.random for secure random selection
    const secureRandom = (max) => crypto.randomInt(0, max);

    let password = '';

    // Ensure at least one of each required type
    password += uppercase[secureRandom(uppercase.length)];
    password += lowercase[secureRandom(lowercase.length)];
    password += numbers[secureRandom(numbers.length)];
    password += special[secureRandom(special.length)];

    // Fill rest with random characters
    for (let i = password.length; i < length; i++) {
        password += all[secureRandom(all.length)];
    }

    // SECURITY FIX: Use Fisher-Yates shuffle with crypto.randomInt for secure shuffling
    const chars = password.split('');
    for (let i = chars.length - 1; i > 0; i--) {
        const j = secureRandom(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
}

module.exports = {
    validatePassword,
    hashPassword,
    verifyPassword,
    generateRandomPassword,
    PASSWORD_MIN_LENGTH,
    PASSWORD_REQUIRE_UPPERCASE,
    PASSWORD_REQUIRE_NUMBER
};
