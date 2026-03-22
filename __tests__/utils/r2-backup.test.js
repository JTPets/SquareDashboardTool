/**
 * Tests for utils/r2-backup.js
 * Verifies R2 configuration detection and signing logic (audit 12.x)
 */

// Prevent logger from creating files during tests
jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

const { isR2Enabled, signRequest, R2_RETENTION_DAYS } = require('../../utils/r2-backup');

describe('r2-backup', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        // Restore env vars
        process.env = { ...originalEnv };
    });

    describe('isR2Enabled', () => {
        it('returns false when BACKUP_R2_ENABLED is not set', () => {
            delete process.env.BACKUP_R2_ENABLED;
            expect(isR2Enabled()).toBe(false);
        });

        it('returns false when BACKUP_R2_ENABLED is false', () => {
            process.env.BACKUP_R2_ENABLED = 'false';
            expect(isR2Enabled()).toBe(false);
        });

        it('returns false when enabled but missing required vars', () => {
            process.env.BACKUP_R2_ENABLED = 'true';
            process.env.BACKUP_R2_ACCOUNT_ID = 'acct';
            // Missing ACCESS_KEY_ID, SECRET_ACCESS_KEY, BUCKET_NAME
            delete process.env.BACKUP_R2_ACCESS_KEY_ID;
            delete process.env.BACKUP_R2_SECRET_ACCESS_KEY;
            delete process.env.BACKUP_R2_BUCKET_NAME;
            expect(isR2Enabled()).toBe(false);
        });

        it('returns true when all vars are configured', () => {
            process.env.BACKUP_R2_ENABLED = 'true';
            process.env.BACKUP_R2_ACCOUNT_ID = 'acct-123';
            process.env.BACKUP_R2_ACCESS_KEY_ID = 'key-123';
            process.env.BACKUP_R2_SECRET_ACCESS_KEY = 'secret-123';
            process.env.BACKUP_R2_BUCKET_NAME = 'my-bucket';
            expect(isR2Enabled()).toBe(true);
        });
    });

    describe('signRequest', () => {
        beforeEach(() => {
            process.env.BACKUP_R2_ACCOUNT_ID = 'test-account';
            process.env.BACKUP_R2_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
            process.env.BACKUP_R2_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
            process.env.BACKUP_R2_BUCKET_NAME = 'test-bucket';
        });

        it('returns headers with Authorization', () => {
            const headers = signRequest('PUT', '/test-bucket/test.gz', Buffer.from('test'));
            expect(headers).toHaveProperty('Authorization');
            expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256/);
        });

        it('includes x-amz-date header', () => {
            const headers = signRequest('GET', '/test-bucket', '');
            expect(headers).toHaveProperty('x-amz-date');
            expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
        });

        it('includes x-amz-content-sha256 header', () => {
            const headers = signRequest('PUT', '/test-bucket/file', Buffer.from('data'));
            expect(headers).toHaveProperty('x-amz-content-sha256');
            expect(headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
        });

        it('includes host header', () => {
            const headers = signRequest('GET', '/test-bucket', '');
            expect(headers.host).toBe('test-account.r2.cloudflarestorage.com');
        });
    });

    describe('constants', () => {
        it('retains 7 daily backups', () => {
            expect(R2_RETENTION_DAYS).toBe(7);
        });
    });
});
