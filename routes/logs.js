/**
 * Log Management Routes
 *
 * Handles log viewing and management (admin only):
 * - View recent logs (today or historical compressed .gz files)
 * - View error logs
 * - Download logs
 * - Get log statistics
 * - List dates with available log files
 *
 * Endpoints:
 * - GET /api/logs           - View recent logs (optional ?date=YYYY-MM-DD)
 * - GET /api/logs/errors    - View error logs (optional ?date=YYYY-MM-DD)
 * - GET /api/logs/download  - Download log file
 * - GET /api/logs/stats     - Get log statistics
 * - GET /api/logs/dates     - List dates with available log files
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const zlib = require('zlib');
const { promisify } = require('util');
const logger = require('../utils/logger');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/logs');
const { sendSuccess } = require('../utils/response-helper');

const gunzip = promisify(zlib.gunzip);

// Get today's date in server timezone (YYYY-MM-DD format)
// OSS: System-level — must match logger.js process.env.TZ for correct log file lookup.
// Not per-merchant; log files are stored using server timezone.
// en-CA locale used here for YYYY-MM-DD date format (ISO-like), not merchant preference.
function getTodayLocal() {
    const options = { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' };
    const parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(new Date());
    const year = parts.find(p => p.type === 'year').value;
    const month = parts.find(p => p.type === 'month').value;
    const day = parts.find(p => p.type === 'day').value;
    return `${year}-${month}-${day}`;
}

/**
 * Read log content for a given prefix ('app' or 'error') and date.
 * If date is today, reads the uncompressed file.
 * Otherwise, reads and concatenates all matching .gz rotations in order.
 * Returns '' if no file is found.
 */
async function readLogContent(logsDir, prefix, date) {
    const today = getTodayLocal();
    if (date === today) {
        const logFile = path.join(logsDir, `${prefix}-${date}.log`);
        try {
            return await fs.readFile(logFile, 'utf-8');
        } catch {
            return '';
        }
    }

    let entries;
    try {
        entries = await fs.readdir(logsDir);
    } catch {
        return '';
    }

    const base = `${prefix}-${date}.log`;
    const rotationRe = new RegExp(`^${base.replace(/[-]/g, '\\-')}\\.(\\d+)\\.gz$`);
    const matches = entries.filter(f => f === `${base}.gz` || rotationRe.test(f));
    if (matches.length === 0) return '';

    // Sort: base.log.gz (0) first, then .log.1.gz, .log.2.gz, etc.
    matches.sort((a, b) => {
        const getNum = n => {
            if (n === `${base}.gz`) return 0;
            const m = n.match(/\.(\d+)\.gz$/);
            return m ? parseInt(m[1], 10) : 0;
        };
        return getNum(a) - getNum(b);
    });

    const parts = [];
    for (const file of matches) {
        try {
            const buffer = await fs.readFile(path.join(logsDir, file));
            const decompressed = await gunzip(buffer);
            parts.push(decompressed.toString('utf-8'));
        } catch (err) {
            logger.warn('Failed to read compressed log file', { file, error: err.message });
        }
    }
    return parts.join('');
}

/**
 * Scan logs directory and return sorted list (newest first) of unique dates.
 */
async function listAvailableDates(logsDir) {
    let entries;
    try {
        entries = await fs.readdir(logsDir);
    } catch {
        return [];
    }

    const dateRe = /^(?:app|error)-(\d{4}-\d{2}-\d{2})\.log(?:\.\d+)?(?:\.gz)?$/;
    const dates = new Set();
    for (const name of entries) {
        const m = name.match(dateRe);
        if (m) dates.add(m[1]);
    }
    return Array.from(dates).sort().reverse();
}

/**
 * GET /api/logs
 * View recent logs. Optional ?date=YYYY-MM-DD selects a historical day.
 * Requires admin role.
 */
router.get('/logs', requireAdmin, validators.list, asyncHandler(async (req, res) => {
    const limitParam = parseInt(req.query.limit);
    const limit = isNaN(limitParam) ? 100 : limitParam;
    const logsDir = path.join(__dirname, '..', 'output', 'logs');
    const date = req.query.date || getTodayLocal();

    const content = await readLogContent(logsDir, 'app', date);
    if (!content.trim()) {
        const isToday = date === getTodayLocal();
        const message = isToday ? 'No logs for today yet' : 'No logs for this date';
        return sendSuccess(res, { logs: [], count: 0, date, message });
    }

    // limit=0 means all logs, otherwise take last N lines
    const allLines = content.trim().split('\n');
    const lines = limit === 0 ? allLines : allLines.slice(-limit);
    const logs = lines.map(line => {
        try {
            return JSON.parse(line);
        } catch {
            return { raw: line, level: 'unknown' };
        }
    });

    sendSuccess(res, { logs, count: logs.length, total: allLines.length, date });
}));

/**
 * GET /api/logs/errors
 * View errors only. Optional ?date=YYYY-MM-DD selects a historical day.
 */
router.get('/logs/errors', requireAdmin, validators.errors, asyncHandler(async (req, res) => {
    const logsDir = path.join(__dirname, '..', 'output', 'logs');
    const date = req.query.date || getTodayLocal();
    const limitParam = parseInt(req.query.limit);
    const limit = isNaN(limitParam) ? 200 : limitParam;

    const content = await readLogContent(logsDir, 'error', date);
    if (!content.trim()) {
        return sendSuccess(res, { errors: [], count: 0, date });
    }

    const allLines = content.trim().split('\n');
    const lines = limit === 0 ? allLines : allLines.slice(-limit);
    const errors = lines.map(line => {
        try { return JSON.parse(line); } catch { return { raw: line, level: 'error' }; }
    });
    sendSuccess(res, { errors, count: errors.length, total: allLines.length, date });
}));

/**
 * GET /api/logs/dates
 * Returns sorted list (newest first) of dates with available log files.
 */
router.get('/logs/dates', requireAdmin, validators.dates, asyncHandler(async (req, res) => {
    const logsDir = path.join(__dirname, '..', 'output', 'logs');
    const dates = await listAvailableDates(logsDir);
    sendSuccess(res, { dates });
}));

/**
 * GET /api/logs/download
 * Download log file
 */
router.get('/logs/download', requireAdmin, validators.download, asyncHandler(async (req, res) => {
    const logsDir = path.join(__dirname, '..', 'output', 'logs');
    const today = getTodayLocal();
    const logFile = path.join(logsDir, `app-${today}.log`);

    res.download(logFile, `sqtools-logs-${today}.log`);
}));

/**
 * GET /api/logs/stats
 * Log statistics
 */
router.get('/logs/stats', requireAdmin, validators.stats, asyncHandler(async (req, res) => {
    const logsDir = path.join(__dirname, '..', 'output', 'logs');
    const today = getTodayLocal();
    const logFile = path.join(logsDir, `app-${today}.log`);
    const errorFile = path.join(logsDir, `error-${today}.log`);

    const logContent = await fs.readFile(logFile, 'utf-8').catch(() => '');
    const errorContent = await fs.readFile(errorFile, 'utf-8').catch(() => '');

    const logLines = logContent.trim().split('\n').filter(Boolean);
    const errorLines = errorContent.trim().split('\n').filter(Boolean);

    const logs = logLines.map(line => {
        try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    const errors = errorLines.map(line => {
        try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    const warnCount = logs.filter(l => l.level === 'warn').length;
    const infoCount = logs.filter(l => l.level === 'info').length;

    sendSuccess(res, {
        total: logs.length,
        errors: errors.length,
        warnings: warnCount,
        info: infoCount,
        today: today
    });
}));

module.exports = router;
