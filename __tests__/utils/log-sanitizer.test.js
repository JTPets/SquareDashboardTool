/**
 * Tests for utils/log-sanitizer.js
 * Verifies PII redaction from log metadata (audit 8.x)
 */

const { sanitize, redactEmail, hashPii, PII_FIELDS } = require('../../utils/log-sanitizer');

describe('log-sanitizer', () => {
    describe('redactEmail', () => {
        it('redacts local part, preserves domain', () => {
            expect(redactEmail('john@example.com')).toBe('***@example.com');
        });

        it('handles null/undefined gracefully', () => {
            expect(redactEmail(null)).toBe('[redacted]');
            expect(redactEmail(undefined)).toBe('[redacted]');
        });

        it('handles strings without @', () => {
            expect(redactEmail('not-an-email')).toBe('[redacted]');
        });

        it('handles empty string', () => {
            expect(redactEmail('')).toBe('[redacted]');
        });
    });

    describe('hashPii', () => {
        it('returns 8-char hex hash', () => {
            const result = hashPii('John Doe');
            expect(result).toMatch(/^[0-9a-f]{8}$/);
        });

        it('is deterministic', () => {
            expect(hashPii('test')).toBe(hashPii('test'));
        });

        it('differs for different inputs', () => {
            expect(hashPii('Alice')).not.toBe(hashPii('Bob'));
        });

        it('handles null/undefined', () => {
            expect(hashPii(null)).toBe('[redacted]');
            expect(hashPii(undefined)).toBe('[redacted]');
        });
    });

    describe('sanitize', () => {
        it('redacts email fields', () => {
            const meta = { userId: 1, email: 'user@example.com', merchantId: 5 };
            const result = sanitize(meta);
            expect(result.email).toBe('***@example.com');
            expect(result.userId).toBe(1);
            expect(result.merchantId).toBe(5);
        });

        it('redacts phone fields — keeps last 4 digits', () => {
            const meta = { phone: '+1-555-123-4567', merchantId: 1 };
            const result = sanitize(meta);
            expect(result.phone).toBe('***4567');
            expect(result.merchantId).toBe(1);
        });

        it('redacts name fields with hash', () => {
            const meta = { customerName: 'John Doe', orderId: 'abc' };
            const result = sanitize(meta);
            expect(result.customerName).toMatch(/^\[redacted:[0-9a-f]{8}\]$/);
            expect(result.orderId).toBe('abc');
        });

        it('preserves safe fields', () => {
            const meta = {
                merchantId: 5,
                userId: 10,
                squareCustomerId: 'sq-123',
                orderId: 'ord-456',
            };
            const result = sanitize(meta);
            expect(result).toEqual(meta);
        });

        it('does not mutate original object', () => {
            const meta = { email: 'user@example.com' };
            sanitize(meta);
            expect(meta.email).toBe('user@example.com');
        });

        it('handles null/undefined input', () => {
            expect(sanitize(null)).toBeNull();
            expect(sanitize(undefined)).toBeUndefined();
        });

        it('handles empty object', () => {
            expect(sanitize({})).toEqual({});
        });

        it('redacts previousName and newName', () => {
            const meta = { previousName: 'Old Name', newName: 'New Name' };
            const result = sanitize(meta);
            expect(result.previousName).toMatch(/^\[redacted:/);
            expect(result.newName).toMatch(/^\[redacted:/);
        });

        it('redacts customerEmail field', () => {
            const meta = { customerEmail: 'cust@shop.com' };
            const result = sanitize(meta);
            expect(result.customerEmail).toBe('***@shop.com');
        });

        it('handles null PII values', () => {
            const meta = { phone: null, email: null, customerName: null };
            const result = sanitize(meta);
            expect(result.phone).toBe('[redacted]');
            expect(result.email).toBe('[redacted]');
            expect(result.customerName).toBe('[redacted]');
        });
    });

    describe('PII_FIELDS', () => {
        it('contains expected field names', () => {
            expect(PII_FIELDS.has('email')).toBe(true);
            expect(PII_FIELDS.has('phone')).toBe(true);
            expect(PII_FIELDS.has('customerName')).toBe(true);
            expect(PII_FIELDS.has('customer_name')).toBe(true);
            expect(PII_FIELDS.has('previousName')).toBe(true);
            expect(PII_FIELDS.has('newName')).toBe(true);
        });

        it('does not contain safe fields', () => {
            expect(PII_FIELDS.has('merchantId')).toBe(false);
            expect(PII_FIELDS.has('userId')).toBe(false);
            expect(PII_FIELDS.has('orderId')).toBe(false);
        });
    });
});
