/**
 * Database Backup Job Tests
 *
 * Tests import, empty DB stats, spawn error handling, and scheduled wrapper.
 */

jest.mock('child_process', () => ({
    spawn: jest.fn(),
}));

jest.mock('zlib', () => ({
    gzipSync: jest.fn().mockReturnValue(Buffer.from('compressed-data')),
}));

jest.mock('fs', () => ({
    promises: {
        mkdir: jest.fn().mockResolvedValue(),
        writeFile: jest.fn().mockResolvedValue(),
        readdir: jest.fn().mockResolvedValue([]),
        unlink: jest.fn().mockResolvedValue(),
    },
}));

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../utils/email-notifier', () => ({
    sendBackup: jest.fn().mockResolvedValue(),
    sendBackupNotification: jest.fn().mockResolvedValue(),
    sendAlert: jest.fn().mockResolvedValue(),
}));

jest.mock('../../utils/r2-backup', () => ({
    uploadAndCleanup: jest.fn().mockResolvedValue({ uploaded: true, deleted: 0 }),
    isR2Enabled: jest.fn().mockReturnValue(false),
}));

const { spawn } = require('child_process');
const zlib = require('zlib');
const db = require('../../utils/database');
const emailNotifier = require('../../utils/email-notifier');
const logger = require('../../utils/logger');
const { runAutomatedBackup, runScheduledBackup } = require('../../jobs/backup-job');

// Helper to create a mock child process
function createMockChildProcess({ stdout = '', stderr = '', exitCode = 0, error = null }) {
    const stdoutCallbacks = {};
    const stderrCallbacks = {};
    const processCallbacks = {};

    const child = {
        stdout: {
            on: jest.fn((event, cb) => { stdoutCallbacks[event] = cb; }),
        },
        stderr: {
            on: jest.fn((event, cb) => { stderrCallbacks[event] = cb; }),
        },
        on: jest.fn((event, cb) => { processCallbacks[event] = cb; }),
    };

    // Schedule callbacks asynchronously
    process.nextTick(() => {
        if (stdout) {
            stdoutCallbacks.data?.(Buffer.from(stdout));
        }
        if (stderr) {
            stderrCallbacks.data?.(Buffer.from(stderr));
        }
        if (error) {
            processCallbacks.error?.(error);
        } else {
            processCallbacks.close?.(exitCode);
        }
    });

    return child;
}

describe('Backup Job', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = {
            ...originalEnv,
            DB_HOST: 'localhost',
            DB_PORT: '5432',
            DB_NAME: 'test_db',
            DB_USER: 'test_user',
            DB_PASSWORD: 'test_password',
        };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe('module exports', () => {
        it('should export runAutomatedBackup as a function', () => {
            expect(typeof runAutomatedBackup).toBe('function');
        });

        it('should export runScheduledBackup as a function', () => {
            expect(typeof runScheduledBackup).toBe('function');
        });
    });

    describe('runAutomatedBackup', () => {
        it('should throw if DB_PASSWORD is not set', async () => {
            delete process.env.DB_PASSWORD;

            await expect(runAutomatedBackup()).rejects.toThrow(
                'DB_PASSWORD environment variable is required'
            );
        });

        it('should handle empty DB stats gracefully', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const mockChild = createMockChildProcess({
                stdout: '-- PostgreSQL dump\nCREATE TABLE test();',
            });
            spawn.mockReturnValueOnce(mockChild);

            const result = await runAutomatedBackup();

            expect(result.tableCount).toBe(0);
            expect(result.delivery).toBe('email');
            expect(emailNotifier.sendBackup).toHaveBeenCalledTimes(1);
        });

        it('should handle pg_dump spawn error', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const mockChild = createMockChildProcess({
                error: new Error('spawn pg_dump ENOENT: command not found'),
            });
            spawn.mockReturnValueOnce(mockChild);

            await expect(runAutomatedBackup()).rejects.toThrow();
        });

        it('should handle pg_dump non-zero exit code', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ tablename: 'items', row_count: 10 }] });

            const mockChild = createMockChildProcess({
                exitCode: 1,
                stderr: 'connection refused',
            });
            spawn.mockReturnValueOnce(mockChild);

            await expect(runAutomatedBackup()).rejects.toThrow('pg_dump exited with code 1');
        });

        it('should compress and email backup when small enough', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { schemaname: 'public', tablename: 'items', row_count: 100 },
                    { schemaname: 'public', tablename: 'merchants', row_count: 5 },
                ],
            });

            const mockChild = createMockChildProcess({
                stdout: 'CREATE TABLE items(); INSERT INTO items VALUES(1);',
            });
            spawn.mockReturnValueOnce(mockChild);

            const result = await runAutomatedBackup();

            expect(result.delivery).toBe('email');
            expect(result.tableCount).toBe(2);
            expect(zlib.gzipSync).toHaveBeenCalled();
            expect(emailNotifier.sendBackup).toHaveBeenCalledTimes(1);
        });
    });

    describe('R2 off-site backup integration', () => {
        const r2Backup = require('../../utils/r2-backup');

        it('skips R2 upload when not enabled', async () => {
            r2Backup.isR2Enabled.mockReturnValue(false);
            db.query.mockResolvedValueOnce({ rows: [] });

            const mockChild = createMockChildProcess({
                stdout: 'CREATE TABLE test();',
            });
            spawn.mockReturnValueOnce(mockChild);

            const result = await runAutomatedBackup();

            expect(r2Backup.uploadAndCleanup).not.toHaveBeenCalled();
            expect(result.r2.uploaded).toBe(false);
        });

        it('uploads to R2 when enabled', async () => {
            r2Backup.isR2Enabled.mockReturnValue(true);
            r2Backup.uploadAndCleanup.mockResolvedValue({ uploaded: true, deleted: 1 });
            db.query.mockResolvedValueOnce({ rows: [] });

            const mockChild = createMockChildProcess({
                stdout: 'CREATE TABLE test();',
            });
            spawn.mockReturnValueOnce(mockChild);

            const result = await runAutomatedBackup();

            expect(r2Backup.uploadAndCleanup).toHaveBeenCalledWith(
                expect.any(Buffer),
                expect.stringMatching(/^backup_\d{4}-\d{2}-\d{2}\.sql\.gz$/)
            );
            expect(result.r2.uploaded).toBe(true);
            expect(result.r2.deleted).toBe(1);
        });
    });

    describe('runScheduledBackup', () => {
        it('should catch errors and send alert email', async () => {
            db.query.mockRejectedValueOnce(new Error('DB connection failed'));

            await runScheduledBackup();

            expect(logger.error).toHaveBeenCalledWith(
                'Scheduled database backup failed',
                expect.objectContaining({ error: 'DB connection failed' })
            );
            expect(emailNotifier.sendAlert).toHaveBeenCalledWith(
                'Automated Database Backup Failed',
                expect.stringContaining('DB connection failed')
            );
        });

        it('should not throw even when backup fails', async () => {
            db.query.mockRejectedValueOnce(new Error('fail'));

            await expect(runScheduledBackup()).resolves.toBeUndefined();
        });
    });
});
