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
const mockReadDir = jest.fn();
jest.mock('fs', () => ({
    promises: {
        readFile: (...args) => mockReadFile(...args),
        readdir: (...args) => mockReadDir(...args),
    },
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const zlib = require('zlib');

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

// Compute today's date in same format as routes use, for date-param tests
function getTodayLocal() {
    const options = { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' };
    const parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(new Date());
    const year = parts.find(p => p.type === 'year').value;
    const month = parts.find(p => p.type === 'month').value;
    const day = parts.find(p => p.type === 'day').value;
    return `${year}-${month}-${day}`;
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

        it('should read uncompressed file when date=today', async () => {
            const today = getTodayLocal();
            const logLines = JSON.stringify({ level: 'info', message: 'today' });
            mockReadFile.mockResolvedValueOnce(logLines);

            const res = await request(app)
                .get(`/api/logs?date=${today}`)
                .expect(200);

            expect(res.body.logs).toHaveLength(1);
            expect(res.body.date).toBe(today);
            // Verify readFile called with uncompressed path
            expect(mockReadFile.mock.calls[0][0]).toContain(`app-${today}.log`);
            expect(mockReadFile.mock.calls[0][0]).not.toContain('.gz');
        });

        it('should read .gz file when date is past', async () => {
            const pastDate = '2020-01-01';
            const logLines = [
                JSON.stringify({ level: 'info', message: 'old entry' }),
                JSON.stringify({ level: 'warn', message: 'old warning' }),
            ].join('\n');
            const gzBuffer = zlib.gzipSync(Buffer.from(logLines));

            mockReadDir.mockResolvedValueOnce([`app-${pastDate}.log.gz`, 'other-file.txt']);
            mockReadFile.mockResolvedValueOnce(gzBuffer);

            const res = await request(app)
                .get(`/api/logs?date=${pastDate}`)
                .expect(200);

            expect(res.body.logs).toHaveLength(2);
            expect(res.body.logs[0].message).toBe('old entry');
            expect(res.body.date).toBe(pastDate);
        });

        it('should concatenate multiple .gz files for the same date in order', async () => {
            const pastDate = '2020-01-02';
            const part0 = JSON.stringify({ level: 'info', message: 'part0' });
            const part1 = JSON.stringify({ level: 'info', message: 'part1' });
            const part2 = JSON.stringify({ level: 'info', message: 'part2' });

            mockReadDir.mockResolvedValueOnce([
                `app-${pastDate}.log.2.gz`,
                `app-${pastDate}.log.gz`,
                `app-${pastDate}.log.1.gz`,
            ]);
            // Return in sorted order: .log.gz (0), .log.1.gz, .log.2.gz
            mockReadFile.mockResolvedValueOnce(zlib.gzipSync(Buffer.from(part0 + '\n')));
            mockReadFile.mockResolvedValueOnce(zlib.gzipSync(Buffer.from(part1 + '\n')));
            mockReadFile.mockResolvedValueOnce(zlib.gzipSync(Buffer.from(part2)));

            const res = await request(app)
                .get(`/api/logs?date=${pastDate}`)
                .expect(200);

            expect(res.body.logs).toHaveLength(3);
            expect(res.body.logs.map(l => l.message)).toEqual(['part0', 'part1', 'part2']);
            // Verify read order by filename in mock calls
            expect(mockReadFile.mock.calls[0][0]).toContain(`app-${pastDate}.log.gz`);
            expect(mockReadFile.mock.calls[1][0]).toContain(`app-${pastDate}.log.1.gz`);
            expect(mockReadFile.mock.calls[2][0]).toContain(`app-${pastDate}.log.2.gz`);
        });

        it('should return empty when no log files exist for the date', async () => {
            const pastDate = '2019-06-15';
            mockReadDir.mockResolvedValueOnce([`app-2020-01-01.log.gz`]);

            const res = await request(app)
                .get(`/api/logs?date=${pastDate}`)
                .expect(200);

            expect(res.body.logs).toEqual([]);
            expect(res.body.count).toBe(0);
            expect(res.body.message).toBe('No logs for this date');
            expect(res.body.date).toBe(pastDate);
        });

        it('should reject invalid date format', async () => {
            await request(app)
                .get('/api/logs?date=not-a-date')
                .expect(400);
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

        it('should read .gz error file when date is past', async () => {
            const pastDate = '2020-02-01';
            const errorLines = JSON.stringify({ level: 'error', message: 'old fail' });
            const gzBuffer = zlib.gzipSync(Buffer.from(errorLines));

            mockReadDir.mockResolvedValueOnce([`error-${pastDate}.log.gz`]);
            mockReadFile.mockResolvedValueOnce(gzBuffer);

            const res = await request(app)
                .get(`/api/logs/errors?date=${pastDate}`)
                .expect(200);

            expect(res.body.errors).toHaveLength(1);
            expect(res.body.errors[0].message).toBe('old fail');
            expect(res.body.date).toBe(pastDate);
        });
    });

    describe('GET /api/logs/dates', () => {
        it('should return sorted unique dates newest first', async () => {
            mockReadDir.mockResolvedValueOnce([
                'app-2026-04-14.log.gz',
                'error-2026-04-14.log.gz',
                'app-2026-04-15.log',
                'error-2026-04-15.log',
                'app-2026-04-13.log.1.gz',
                'app-2026-04-13.log.gz',
                'random-file.txt',
                'app-backup.log',
            ]);

            const res = await request(app)
                .get('/api/logs/dates')
                .expect(200);

            expect(res.body.dates).toEqual(['2026-04-15', '2026-04-14', '2026-04-13']);
        });

        it('should return empty array when directory unreadable', async () => {
            mockReadDir.mockRejectedValueOnce(new Error('ENOENT'));

            const res = await request(app)
                .get('/api/logs/dates')
                .expect(200);

            expect(res.body.dates).toEqual([]);
        });

        it('should require admin role', async () => {
            const userApp = createTestApp('user');

            await request(userApp)
                .get('/api/logs/dates')
                .expect(403);
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
