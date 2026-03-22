/**
 * Winston Logger Integration Test
 *
 * Verifies that log entries actually appear in the output file after
 * passing through the full Winston format pipeline (timestamp, errors,
 * piiSanitizer, json). This would have caught the Symbol.for('level')
 * bug that caused Winston to silently drop all log entries.
 *
 * Uses the real logger module — jest.unmock overrides the global mock
 * from __tests__/setup.js.
 */

jest.unmock('../../utils/logger');

const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '../../output/logs');

/**
 * Find today's app log file. Winston-daily-rotate-file names it
 * app-YYYY-MM-DD.log using the America/Toronto timezone set in logger.js.
 */
function getTodayLogPath() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return path.join(logsDir, `app-${yyyy}-${mm}-${dd}.log`);
}

/**
 * Read the log file and return all lines that contain the given marker.
 */
function findLogLines(filePath, marker) {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split('\n').filter(line => line.includes(marker));
}

/**
 * Wait for ms milliseconds.
 */
function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Winston logger integration', () => {
    let logger;

    beforeAll(() => {
        logger = require('../../utils/logger');
    });

    afterAll(async () => {
        // Close transports so file handles are released
        await new Promise(resolve => {
            logger.on('finish', resolve);
            logger.end();
        });
    });

    it('writes log entries to the app log file', async () => {
        const marker = `integration-test-${Date.now()}`;
        logger.info(marker, { merchantId: 1 });

        // Wait for async file write to flush
        await wait(1500);

        const logPath = getTodayLogPath();
        expect(fs.existsSync(logPath)).toBe(true);

        const matches = findLogLines(logPath, marker);
        expect(matches.length).toBeGreaterThanOrEqual(1);

        // Verify it's valid JSON with expected fields
        const entry = JSON.parse(matches[0]);
        expect(entry.message).toBe(marker);
        expect(entry.merchantId).toBe(1);
        expect(entry.service).toBe('square-dashboard-addon');
        expect(entry.timestamp).toBeDefined();
    });

    it('writes PII-redacted entries to the log file', async () => {
        const marker = `pii-test-${Date.now()}`;
        logger.info(marker, { email: 'test@test.com', merchantId: 42 });

        await wait(1500);

        const logPath = getTodayLogPath();
        expect(fs.existsSync(logPath)).toBe(true);

        const matches = findLogLines(logPath, marker);
        expect(matches.length).toBeGreaterThanOrEqual(1);

        const entry = JSON.parse(matches[0]);
        expect(entry.message).toBe(marker);
        expect(entry.merchantId).toBe(42);

        // Email must be redacted — domain preserved, local part stripped
        expect(entry.email).toBe('***@test.com');
        // Raw email must NOT appear anywhere in the line
        expect(matches[0]).not.toContain('test@test.com');
    });
});
