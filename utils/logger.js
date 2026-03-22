// Set timezone BEFORE requiring winston-daily-rotate-file
// This ensures log files are named using America/Toronto timezone
// Matches the timezone used in routes/logs.js for reading logs
// OSS: System-level process timezone for log file rotation — not per-merchant.
// All log files use a single server timezone regardless of merchant config.
process.env.TZ = 'America/Toronto';

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
// LOGIC CHANGE: strip PII from request logs (audit 8.x)
const { sanitize } = require('./log-sanitizer');

// TODO(pre-franchise): scope log files per-merchant or add merchantId to all log entries (MT-8)
// Ensure logs directory exists (in output folder to consolidate all file writes)
const logsDir = path.join(__dirname, '../output/logs');
const fs = require('fs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Configure log rotation with automatic cleanup
const fileRotateTransport = new DailyRotateFile({
  filename: path.join(logsDir, 'app-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',        // Rotate when file reaches 20MB
  maxFiles: '14d',       // Keep logs for 14 days
  zippedArchive: true,   // Compress old logs to save space
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  )
});

const errorRotateTransport = new DailyRotateFile({
  level: 'error',
  filename: path.join(logsDir, 'error-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '10m',        // Rotate when file reaches 10MB
  maxFiles: '30d',       // Keep error logs for 30 days (longer than regular logs)
  zippedArchive: true,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  )
});

// LOGIC CHANGE: strip PII from request logs (audit 8.x)
// Custom format that redacts email, phone, and customer name fields
const piiSanitizer = winston.format((info) => {
  // sanitize() returns a shallow copy — copy sanitized values back onto
  // the original info object to preserve Winston's Symbol properties
  // (e.g. Symbol.for('level')) which are required for log routing.
  const sanitized = sanitize(info);
  for (const key of Object.keys(sanitized)) {
    info[key] = sanitized[key];
  }
  return info;
});

// Create logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    piiSanitizer(),
    winston.format.json()
  ),
  defaultMeta: { service: 'square-dashboard-addon' },
  transports: [
    fileRotateTransport,
    errorRotateTransport,
    // Console output (only in development)
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Log rotation events for monitoring
fileRotateTransport.on('rotate', (oldFilename, newFilename) => {
  logger.info('Log file rotated', { oldFilename, newFilename });
});

fileRotateTransport.on('logRemoved', (removedFilename) => {
  logger.info('Old log file deleted', { removedFilename });
});

module.exports = logger;
