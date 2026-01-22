/**
 * Tests for middleware/validators/index.js
 *
 * Tests the common validator utilities including:
 * - isValidUUID: Custom UUID validation function
 * - sanitizeString: String sanitization function
 * - handleValidationErrors: Error handling middleware
 */

const { isValidUUID, sanitizeString, handleValidationErrors } = require('../../middleware/validators/index');
const { validationResult } = require('express-validator');

describe('Validator Utilities', () => {
    describe('isValidUUID', () => {
        describe('valid UUIDs', () => {
            it('should accept valid v4 UUID (lowercase)', () => {
                expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
            });

            it('should accept valid v4 UUID (uppercase)', () => {
                expect(isValidUUID('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
            });

            it('should accept valid v4 UUID (mixed case)', () => {
                expect(isValidUUID('550e8400-E29B-41d4-A716-446655440000')).toBe(true);
            });

            it('should accept valid v1 UUID', () => {
                expect(isValidUUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(true);
            });

            it('should accept valid v3 UUID', () => {
                expect(isValidUUID('a3bb189e-8bf9-3888-9912-ace4e6543002')).toBe(true);
            });

            it('should accept valid v5 UUID', () => {
                expect(isValidUUID('886313e1-3b8a-5372-9b90-0c9aee199e5d')).toBe(true);
            });
        });

        describe('invalid UUIDs', () => {
            it('should reject null', () => {
                expect(isValidUUID(null)).toBe(false);
            });

            it('should reject undefined', () => {
                expect(isValidUUID(undefined)).toBe(false);
            });

            it('should reject empty string', () => {
                expect(isValidUUID('')).toBe(false);
            });

            it('should reject string without hyphens', () => {
                expect(isValidUUID('550e8400e29b41d4a716446655440000')).toBe(false);
            });

            it('should reject UUID with wrong segment lengths', () => {
                expect(isValidUUID('550e840-e29b-41d4-a716-446655440000')).toBe(false);
            });

            it('should reject UUID with invalid characters', () => {
                expect(isValidUUID('550e8400-e29b-41d4-a716-44665544000g')).toBe(false);
            });

            it('should reject UUID with spaces', () => {
                expect(isValidUUID('550e8400-e29b-41d4-a716-44665544 000')).toBe(false);
            });

            it('should reject random string', () => {
                expect(isValidUUID('not-a-uuid')).toBe(false);
            });

            it('should reject number', () => {
                expect(isValidUUID(12345)).toBe(false);
            });

            it('should reject object', () => {
                expect(isValidUUID({ id: '550e8400-e29b-41d4-a716-446655440000' })).toBe(false);
            });

            it('should reject UUID with invalid version digit (0)', () => {
                expect(isValidUUID('550e8400-e29b-01d4-a716-446655440000')).toBe(false);
            });

            it('should reject UUID with invalid version digit (6)', () => {
                expect(isValidUUID('550e8400-e29b-61d4-a716-446655440000')).toBe(false);
            });

            it('should reject UUID with invalid variant digit', () => {
                // Variant must be 8, 9, a, or b in position 19
                expect(isValidUUID('550e8400-e29b-41d4-0716-446655440000')).toBe(false);
            });
        });

        describe('edge cases', () => {
            it('should reject UUID with leading/trailing whitespace', () => {
                expect(isValidUUID(' 550e8400-e29b-41d4-a716-446655440000 ')).toBe(false);
            });

            it('should reject UUID with newline', () => {
                expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000\n')).toBe(false);
            });

            it('should accept all valid variant characters (8, 9, a, b)', () => {
                expect(isValidUUID('550e8400-e29b-41d4-8716-446655440000')).toBe(true);
                expect(isValidUUID('550e8400-e29b-41d4-9716-446655440000')).toBe(true);
                expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
                expect(isValidUUID('550e8400-e29b-41d4-b716-446655440000')).toBe(true);
            });
        });
    });

    describe('sanitizeString', () => {
        describe('basic sanitization', () => {
            it('should trim leading whitespace', () => {
                expect(sanitizeString('  hello')).toBe('hello');
            });

            it('should trim trailing whitespace', () => {
                expect(sanitizeString('hello  ')).toBe('hello');
            });

            it('should trim both leading and trailing whitespace', () => {
                expect(sanitizeString('  hello  ')).toBe('hello');
            });

            it('should preserve internal whitespace', () => {
                expect(sanitizeString('  hello world  ')).toBe('hello world');
            });

            it('should handle empty string', () => {
                expect(sanitizeString('')).toBe('');
            });

            it('should handle whitespace-only string', () => {
                expect(sanitizeString('   ')).toBe('');
            });
        });

        describe('null byte removal', () => {
            it('should remove null bytes', () => {
                expect(sanitizeString('hello\0world')).toBe('helloworld');
            });

            it('should remove multiple null bytes', () => {
                expect(sanitizeString('he\0llo\0wor\0ld')).toBe('helloworld');
            });

            it('should remove leading null byte', () => {
                expect(sanitizeString('\0hello')).toBe('hello');
            });

            it('should remove trailing null byte', () => {
                expect(sanitizeString('hello\0')).toBe('hello');
            });

            it('should handle string of only null bytes', () => {
                expect(sanitizeString('\0\0\0')).toBe('');
            });
        });

        describe('combined operations', () => {
            it('should trim and remove null bytes', () => {
                expect(sanitizeString('  he\0llo  ')).toBe('hello');
            });

            it('should handle complex input', () => {
                expect(sanitizeString('  \0hello\0 world\0  ')).toBe('hello world');
            });
        });

        describe('non-string handling', () => {
            it('should return null as-is', () => {
                expect(sanitizeString(null)).toBe(null);
            });

            it('should return undefined as-is', () => {
                expect(sanitizeString(undefined)).toBe(undefined);
            });

            it('should return number as-is', () => {
                expect(sanitizeString(123)).toBe(123);
            });

            it('should return object as-is', () => {
                const obj = { foo: 'bar' };
                expect(sanitizeString(obj)).toBe(obj);
            });

            it('should return array as-is', () => {
                const arr = ['a', 'b'];
                expect(sanitizeString(arr)).toBe(arr);
            });

            it('should return boolean as-is', () => {
                expect(sanitizeString(true)).toBe(true);
                expect(sanitizeString(false)).toBe(false);
            });
        });

        describe('special characters', () => {
            it('should preserve newlines', () => {
                expect(sanitizeString('hello\nworld')).toBe('hello\nworld');
            });

            it('should preserve tabs', () => {
                expect(sanitizeString('hello\tworld')).toBe('hello\tworld');
            });

            it('should preserve unicode', () => {
                expect(sanitizeString('  héllo wörld  ')).toBe('héllo wörld');
            });

            it('should preserve emojis', () => {
                expect(sanitizeString('  hello 🎁 world  ')).toBe('hello 🎁 world');
            });
        });
    });

    describe('handleValidationErrors', () => {
        let mockReq, mockRes, mockNext;

        beforeEach(() => {
            mockReq = {};
            mockRes = {
                status: jest.fn().mockReturnThis(),
                json: jest.fn().mockReturnThis()
            };
            mockNext = jest.fn();
        });

        it('should call next() when no validation errors', () => {
            // Mock validationResult to return empty errors
            jest.spyOn(require('express-validator'), 'validationResult')
                .mockReturnValue({ isEmpty: () => true, array: () => [] });

            handleValidationErrors(mockReq, mockRes, mockNext);

            expect(mockNext).toHaveBeenCalled();
            expect(mockRes.status).not.toHaveBeenCalled();
        });

        it('should return 400 with errors when validation fails', () => {
            const mockErrors = [
                { path: 'email', msg: 'Invalid email' },
                { path: 'password', msg: 'Password too short' }
            ];

            jest.spyOn(require('express-validator'), 'validationResult')
                .mockReturnValue({ isEmpty: () => false, array: () => mockErrors });

            handleValidationErrors(mockReq, mockRes, mockNext);

            expect(mockRes.status).toHaveBeenCalledWith(400);
            expect(mockRes.json).toHaveBeenCalledWith({
                error: 'Validation failed',
                details: [
                    { field: 'email', message: 'Invalid email' },
                    { field: 'password', message: 'Password too short' }
                ]
            });
            expect(mockNext).not.toHaveBeenCalled();
        });
    });
});
