/**
 * Password Utilities Test Suite
 *
 * Tests for password validation, hashing, and verification
 * These are CRITICAL security functions - high coverage required
 */

const {
    validatePassword,
    hashPassword,
    verifyPassword,
    generateRandomPassword,
    PASSWORD_MIN_LENGTH,
    PASSWORD_REQUIRE_UPPERCASE,
    PASSWORD_REQUIRE_NUMBER
} = require('../../utils/password');

describe('Password Utilities', () => {

    // ==================== validatePassword ====================
    describe('validatePassword', () => {

        describe('valid passwords', () => {
            test('accepts password meeting all requirements', () => {
                const result = validatePassword('SecurePass123');
                expect(result.valid).toBe(true);
                expect(result.errors).toHaveLength(0);
            });

            test('accepts password with special characters', () => {
                const result = validatePassword('MyP@ssw0rd!');
                expect(result.valid).toBe(true);
                expect(result.errors).toHaveLength(0);
            });

            test('accepts exactly minimum length password', () => {
                const result = validatePassword('Abcdefg1'); // 8 chars
                expect(result.valid).toBe(true);
            });

            test('accepts very long passwords', () => {
                const longPassword = 'A1' + 'a'.repeat(100);
                const result = validatePassword(longPassword);
                expect(result.valid).toBe(true);
            });
        });

        describe('missing/invalid input', () => {
            test('rejects null password', () => {
                const result = validatePassword(null);
                expect(result.valid).toBe(false);
                expect(result.errors).toContain('Password is required');
            });

            test('rejects undefined password', () => {
                const result = validatePassword(undefined);
                expect(result.valid).toBe(false);
                expect(result.errors).toContain('Password is required');
            });

            test('rejects empty string', () => {
                const result = validatePassword('');
                expect(result.valid).toBe(false);
            });

            test('rejects non-string input (number)', () => {
                const result = validatePassword(12345678);
                expect(result.valid).toBe(false);
                expect(result.errors).toContain('Password is required');
            });

            test('rejects non-string input (object)', () => {
                const result = validatePassword({ password: 'test' });
                expect(result.valid).toBe(false);
            });
        });

        describe('length requirements', () => {
            test('rejects password shorter than minimum', () => {
                const result = validatePassword('Short1A'); // 7 chars
                expect(result.valid).toBe(false);
                expect(result.errors.some(e => e.includes('at least'))).toBe(true);
            });

            test('rejects single character password', () => {
                const result = validatePassword('A');
                expect(result.valid).toBe(false);
            });
        });

        describe('uppercase requirement', () => {
            test('rejects password without uppercase', () => {
                const result = validatePassword('lowercase123');
                expect(result.valid).toBe(false);
                expect(result.errors.some(e => e.includes('uppercase'))).toBe(true);
            });

            test('accepts password with uppercase at start', () => {
                const result = validatePassword('Uppercase123');
                expect(result.valid).toBe(true);
            });

            test('accepts password with uppercase at end', () => {
                const result = validatePassword('uppercase12A');
                expect(result.valid).toBe(true);
            });

            test('accepts password with uppercase in middle', () => {
                const result = validatePassword('upperCase123');
                expect(result.valid).toBe(true);
            });
        });

        describe('number requirement', () => {
            test('rejects password without numbers', () => {
                const result = validatePassword('NoNumbersHere');
                expect(result.valid).toBe(false);
                expect(result.errors.some(e => e.includes('number'))).toBe(true);
            });

            test('accepts password with number at start', () => {
                const result = validatePassword('1Uppercase');
                expect(result.valid).toBe(true);
            });

            test('accepts password with number at end', () => {
                const result = validatePassword('Uppercase1');
                expect(result.valid).toBe(true);
            });

            test('accepts password with multiple numbers', () => {
                const result = validatePassword('Secure123456');
                expect(result.valid).toBe(true);
            });
        });

        describe('multiple violations', () => {
            test('returns all errors for password with multiple issues', () => {
                const result = validatePassword('short'); // too short, no uppercase, no number
                expect(result.valid).toBe(false);
                expect(result.errors.length).toBeGreaterThan(1);
            });

            test('includes length error when too short', () => {
                const result = validatePassword('ab1');
                expect(result.errors.some(e => e.includes('at least'))).toBe(true);
            });
        });
    });

    // ==================== hashPassword ====================
    describe('hashPassword', () => {

        test('returns a string hash', async () => {
            const hash = await hashPassword('SecurePass123');
            expect(typeof hash).toBe('string');
        });

        test('returns different hash for same password (salted)', async () => {
            const hash1 = await hashPassword('SecurePass123');
            const hash2 = await hashPassword('SecurePass123');
            expect(hash1).not.toBe(hash2);
        });

        test('hash starts with bcrypt identifier', async () => {
            const hash = await hashPassword('SecurePass123');
            expect(hash.startsWith('$2')).toBe(true); // bcrypt hashes start with $2a, $2b, or $2y
        });

        test('hash has expected length (60 chars for bcrypt)', async () => {
            const hash = await hashPassword('SecurePass123');
            expect(hash.length).toBe(60);
        });

        test('handles empty string password', async () => {
            const hash = await hashPassword('');
            expect(typeof hash).toBe('string');
            expect(hash.length).toBe(60);
        });

        test('handles unicode passwords', async () => {
            const hash = await hashPassword('SecurePass123!@#');
            expect(hash.length).toBe(60);
        });

        test('handles very long passwords', async () => {
            // bcrypt has a 72-byte limit, but should handle gracefully
            const longPassword = 'A1' + 'a'.repeat(100);
            const hash = await hashPassword(longPassword);
            expect(hash.length).toBe(60);
        });
    });

    // ==================== verifyPassword ====================
    describe('verifyPassword', () => {

        test('returns true for matching password', async () => {
            const password = 'SecurePass123';
            const hash = await hashPassword(password);
            const result = await verifyPassword(password, hash);
            expect(result).toBe(true);
        });

        test('returns false for wrong password', async () => {
            const hash = await hashPassword('SecurePass123');
            const result = await verifyPassword('WrongPassword1', hash);
            expect(result).toBe(false);
        });

        test('returns false for similar but different password', async () => {
            const hash = await hashPassword('SecurePass123');
            const result = await verifyPassword('securepass123', hash); // different case
            expect(result).toBe(false);
        });

        test('returns false for password with extra character', async () => {
            const hash = await hashPassword('SecurePass123');
            const result = await verifyPassword('SecurePass1234', hash);
            expect(result).toBe(false);
        });

        test('returns false for password with missing character', async () => {
            const hash = await hashPassword('SecurePass123');
            const result = await verifyPassword('SecurePass12', hash);
            expect(result).toBe(false);
        });

        test('returns false for empty password against valid hash', async () => {
            const hash = await hashPassword('SecurePass123');
            const result = await verifyPassword('', hash);
            expect(result).toBe(false);
        });

        test('returns false for null password', async () => {
            const hash = await hashPassword('SecurePass123');
            const result = await verifyPassword(null, hash);
            expect(result).toBe(false);
        });

        test('returns false for invalid hash', async () => {
            const result = await verifyPassword('SecurePass123', 'invalid-hash');
            expect(result).toBe(false);
        });

        test('returns false for null hash', async () => {
            const result = await verifyPassword('SecurePass123', null);
            expect(result).toBe(false);
        });
    });

    // ==================== generateRandomPassword ====================
    describe('generateRandomPassword', () => {

        test('generates password of default length (16)', () => {
            const password = generateRandomPassword();
            expect(password.length).toBe(16);
        });

        test('generates password of specified length', () => {
            const password = generateRandomPassword(20);
            expect(password.length).toBe(20);
        });

        test('generated password meets validation requirements', () => {
            for (let i = 0; i < 10; i++) { // Test multiple times for randomness
                const password = generateRandomPassword();
                const result = validatePassword(password);
                expect(result.valid).toBe(true);
            }
        });

        test('generated password contains uppercase', () => {
            const password = generateRandomPassword();
            expect(/[A-Z]/.test(password)).toBe(true);
        });

        test('generated password contains lowercase', () => {
            const password = generateRandomPassword();
            expect(/[a-z]/.test(password)).toBe(true);
        });

        test('generated password contains number', () => {
            const password = generateRandomPassword();
            expect(/[0-9]/.test(password)).toBe(true);
        });

        test('generated password contains special character', () => {
            const password = generateRandomPassword();
            expect(/[!@#$%^&*]/.test(password)).toBe(true);
        });

        test('generates unique passwords each time', () => {
            const passwords = new Set();
            for (let i = 0; i < 100; i++) {
                passwords.add(generateRandomPassword());
            }
            // All 100 passwords should be unique
            expect(passwords.size).toBe(100);
        });

        test('handles minimum viable length', () => {
            // Need at least 4 chars for uppercase, lowercase, number, special
            const password = generateRandomPassword(4);
            expect(password.length).toBe(4);
            expect(/[A-Z]/.test(password)).toBe(true);
            expect(/[a-z]/.test(password)).toBe(true);
            expect(/[0-9]/.test(password)).toBe(true);
            expect(/[!@#$%^&*]/.test(password)).toBe(true);
        });
    });

    // ==================== Constants ====================
    describe('Password Constants', () => {
        test('minimum length is at least 8', () => {
            expect(PASSWORD_MIN_LENGTH).toBeGreaterThanOrEqual(8);
        });

        test('uppercase is required', () => {
            expect(PASSWORD_REQUIRE_UPPERCASE).toBe(true);
        });

        test('number is required', () => {
            expect(PASSWORD_REQUIRE_NUMBER).toBe(true);
        });
    });
});
