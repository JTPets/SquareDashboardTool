/**
 * Log Management Routes Test Suite
 *
 * Tests for log viewing, downloading, and statistics (admin only).
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => next(),
    requireAdmin: (req, res, next) => {
        if (req.session?.user?.role === 'admin') {
            return next();
        }
        return res.status(403).json({ error: 'Admin access required' });
    },
}));

// Mock fs.promises for log file reads
const mockReadFile = jest.fn();
jest.mock('fs', () => ({
    promises: {
        readFile: (...args) => mockReadFile(...args),
    },
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');

function createTestApp(userRole = 'admin') {
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        req.session.user = { id: 1, email: 'test@example.com', role: userRole };
        next();
    });
    app.use('/api', require('../../routes/logs'));
    return app;
}

describe('Log Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('GET /api/logs', () => {
        it('should return parsed log lines', async () => {
            const logLines = [
                JSON.stringify({ level: 'info', message: 'Server started' }),
                JSON.stringify({ level: 'warn', message: 'Slow query' }),
            ].join('\n');
            mockReadFile.mockResolvedValueOnce(logLines);

            const res = await request(app)
                .get('/api/logs')
                .expect(200);

            expect(res.body.logs).toHaveLength(2);
            expect(res.body.count).toBe(2);
            expect(res.body.total).toBe(2);
            expect(res.body.logs[0].level).toBe('info');
        });

        it('should respect limit parameter', async () => {
            const logLines = Array(200).fill(0)
                .map((_, i) => JSON.stringify({ level: 'info', message: `Line ${i}` }))
                .join('\n');
            mockReadFile.mockResolvedValueOnce(logLines);

            const res = await request(app)
                .get('/api/logs?limit=10')
                .expect(200);

            expect(res.body.logs).toHaveLength(10);
            expect(res.body.total).toBe(200);
        });

        it('should return all logs when limit=0', async () => {
            const logLines = Array(5).fill(0)
                .map((_, i) => JSON.stringify({ level: 'info', message: `Line ${i}` }))
                .join('\n');
            mockReadFile.mockResolvedValueOnce(logLines);

            const res = await request(app)
                .get('/api/logs?limit=0')
                .expect(200);

            expect(res.body.logs).toHaveLength(5);
        });

        it('should handle missing log file', async () => {
            mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

            const res = await request(app)
                .get('/api/logs')
                .expect(200);

            expect(res.body.logs).toEqual([]);
            expect(res.body.count).toBe(0);
            expect(res.body.message).toContain('No logs');
        });

        it('should handle malformed JSON lines', async () => {
            const logLines = 'not json\n{"level":"info","message":"ok"}';
            mockReadFile.mockResolvedValueOnce(logLines);

            const res = await request(app)
                .get('/api/logs')
                .expect(200);

            expect(res.body.logs).toHaveLength(2);
            expect(res.body.logs[0].raw).toBe('not json');
            expect(res.body.logs[1].level).toBe('info');
        });

        it('should require admin role', async () => {
            const userApp = createTestApp('user');

            await request(userApp)
                .get('/api/logs')
                .expect(403);
        });
    });

    describe('GET /api/logs/errors', () => {
        it('should return error logs', async () => {
            const errorLines = [
                JSON.stringify({ level: 'error', message: 'DB timeout' }),
            ].join('\n');
            mockReadFile.mockResolvedValueOnce(errorLines);

            const res = await request(app)
                .get('/api/logs/errors')
                .expect(200);

            expect(res.body.errors).toHaveLength(1);
            expect(res.body.count).toBe(1);
        });

        it('should return empty array when no error file', async () => {
            mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

            const res = await request(app)
                .get('/api/logs/errors')
                .expect(200);

            expect(res.body.errors).toEqual([]);
            expect(res.body.count).toBe(0);
        });
    });

    describe('GET /api/logs/stats', () => {
        it('should return log statistics', async () => {
            const appLogs = [
                JSON.stringify({ level: 'info', message: 'ok' }),
                JSON.stringify({ level: 'info', message: 'ok2' }),
                JSON.stringify({ level: 'warn', message: 'slow' }),
            ].join('\n');
            const errorLogs = [
                JSON.stringify({ level: 'error', message: 'fail' }),
            ].join('\n');

            mockReadFile
                .mockResolvedValueOnce(appLogs)    // app log file
                .mockResolvedValueOnce(errorLogs); // error log file

            const res = await request(app)
                .get('/api/logs/stats')
                .expect(200);

            expect(res.body.total).toBe(3);
            expect(res.body.errors).toBe(1);
            expect(res.body.warnings).toBe(1);
            expect(res.body.info).toBe(2);
            expect(res.body.today).toBeDefined();
        });

        it('should handle missing files gracefully', async () => {
            mockReadFile
                .mockRejectedValueOnce(new Error('ENOENT'))
                .mockRejectedValueOnce(new Error('ENOENT'));

            const res = await request(app)
                .get('/api/logs/stats')
                .expect(200);

            expect(res.body.total).toBe(0);
            expect(res.body.errors).toBe(0);
        });
    });
});
