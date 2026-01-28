/**
 * Log Management Routes
 *
 * Handles log viewing and management (admin only):
 * - View recent logs
 * - View error logs
 * - Download logs
 * - Get log statistics
 *
 * Endpoints:
 * - GET /api/logs           - View recent logs
 * - GET /api/logs/errors    - View error logs
 * - GET /api/logs/download  - Download log file
 * - GET /api/logs/stats     - Get log statistics
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/logs');

// Get today's date in America/Toronto timezone (YYYY-MM-DD format)
function getTodayLocal() {
    const options = { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' };
    const parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(new Date());
    const year = parts.find(p => p.type === 'year').value;
    const month = parts.find(p => p.type === 'month').value;
    const day = parts.find(p => p.type === 'day').value;
    return `${year}-${month}-${day}`;
}

/**
 * GET /api/logs
 * View recent logs
 * Requires admin role
 */
router.get('/logs', requireAdmin, validators.list, asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const logsDir = path.join(__dirname, '..', 'output', 'logs');

    // Get today's log file
    const today = getTodayLocal();
    const logFile = path.join(logsDir, `app-${today}.log`);

    const content = await fs.readFile(logFile, 'utf-8').catch(() => '');
    if (!content.trim()) {
        return res.json({ logs: [], count: 0, message: 'No logs for today yet' });
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

    res.json({ logs, count: logs.length, total: allLines.length });
}));

/**
 * GET /api/logs/errors
 * View errors only
 */
router.get('/logs/errors', requireAdmin, validators.errors, asyncHandler(async (req, res) => {
    const logsDir = path.join(__dirname, '..', 'output', 'logs');
    const today = getTodayLocal();
    const errorFile = path.join(logsDir, `error-${today}.log`);

    try {
        const content = await fs.readFile(errorFile, 'utf-8');
        const lines = content.trim().split('\n');
        const errors = lines.map(line => JSON.parse(line));
        res.json({ errors, count: errors.length });
    } catch {
        res.json({ errors: [], count: 0 }); // No errors is good!
    }
}));

/**
 * GET /api/logs/download
 * Download log file
 */
router.get('/logs/download', requireAdmin, validators.download, asyncHandler(async (req, res) => {
    const logsDir = path.join(__dirname, '..', 'output', 'logs');
    const today = getTodayLocal();
    const logFile = path.join(logsDir, `app-${today}.log`);

    res.download(logFile, `square-dashboard-addon-logs-${today}.log`);
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

    res.json({
        total: logs.length,
        errors: errors.length,
        warnings: warnCount,
        info: infoCount,
        today: today
    });
}));

module.exports = router;
