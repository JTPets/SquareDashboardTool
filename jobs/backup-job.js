/**
 * Database Backup Job
 *
 * Handles automated database backups using pg_dump.
 * Compresses backups with gzip and emails them if small enough,
 * otherwise saves locally with rotation.
 *
 * @module jobs/backup-job
 */

const { spawn } = require('child_process');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const db = require('../utils/database');
const logger = require('../utils/logger');
const emailNotifier = require('../utils/email-notifier');

/**
 * Run pg_dump using spawn with password in env (more secure than command line)
 * @param {Object} options - Database connection options
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runPgDump({ host, port, user, database, password }) {
    return new Promise((resolve, reject) => {
        const args = [
            '-h', host,
            '-p', port,
            '-U', user,
            '-d', database,
            '--no-owner',
            '--no-acl'
        ];

        const child = spawn('pg_dump', args, {
            env: { ...process.env, PGPASSWORD: password },
            maxBuffer: 100 * 1024 * 1024, // 100MB
            timeout: 300000 // 5 minutes
        });

        const chunks = [];
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            chunks.push(chunk);
        });

        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve({
                    stdout: Buffer.concat(chunks).toString('utf8'),
                    stderr
                });
            } else {
                reject(new Error(`pg_dump exited with code ${code}: ${stderr}`));
            }
        });

        child.on('error', (err) => {
            reject(err);
        });
    });
}

// Gmail attachment limit is 25MB, use 24MB for safety margin
const MAX_EMAIL_SIZE_MB = 24;
const MAX_EMAIL_SIZE_BYTES = MAX_EMAIL_SIZE_MB * 1024 * 1024;
const BACKUP_RETENTION_COUNT = 4; // Keep last 4 local backups

/**
 * Run automated database backup using pg_dump and email the result
 *
 * @returns {Promise<Object>} Backup result with size and location info
 * @throws {Error} If DB_PASSWORD is not set or pg_dump fails
 */
async function runAutomatedBackup() {
    const dbHost = process.env.DB_HOST || 'localhost';
    const dbPort = process.env.DB_PORT || '5432';
    const dbName = process.env.DB_NAME || 'square_dashboard_addon';
    const dbUser = process.env.DB_USER || 'postgres';
    const dbPassword = process.env.DB_PASSWORD;

    if (!dbPassword) {
        throw new Error('DB_PASSWORD environment variable is required for automated backup');
    }

    // Get database statistics first
    const statsResult = await db.query(`
        SELECT
            schemaname,
            relname AS tablename,
            n_live_tup AS row_count
        FROM pg_stat_user_tables
        ORDER BY n_live_tup DESC
    `);

    const dbInfo = {
        database: dbName,
        host: dbHost,
        tables: statsResult.rows
    };

    // Run pg_dump with password via environment variable (secure - not visible in process list)
    try {
        const { stdout: sqlDump, stderr } = await runPgDump({
            host: dbHost,
            port: dbPort,
            user: dbUser,
            database: dbName,
            password: dbPassword
        });

        if (stderr && !stderr.includes('Warning')) {
            logger.warn('pg_dump warnings', { stderr });
        }

        const originalSizeMB = (sqlDump.length / 1024 / 1024).toFixed(2);

        // Compress the backup with gzip
        const compressedBackup = zlib.gzipSync(sqlDump, { level: 9 });
        const compressedSizeMB = (compressedBackup.length / 1024 / 1024).toFixed(2);
        const compressionRatio = ((1 - compressedBackup.length / sqlDump.length) * 100).toFixed(1);

        logger.info('Backup compressed', {
            database: dbName,
            originalSize: `${originalSizeMB} MB`,
            compressedSize: `${compressedSizeMB} MB`,
            compressionRatio: `${compressionRatio}%`
        });

        const result = {
            database: dbName,
            originalSizeMB,
            compressedSizeMB,
            compressionRatio,
            tableCount: statsResult.rows.length
        };

        // Check if compressed backup fits in email
        if (compressedBackup.length <= MAX_EMAIL_SIZE_BYTES) {
            // Send compressed backup via email
            await emailNotifier.sendBackup(compressedBackup, dbInfo, {
                originalSizeMB,
                compressedSizeMB,
                compressionRatio
            });

            logger.info('Automated backup completed (sent via email)', {
                database: dbName,
                originalSize: `${originalSizeMB} MB`,
                compressedSize: `${compressedSizeMB} MB`,
                tableCount: statsResult.rows.length
            });

            return { ...result, delivery: 'email' };
        } else {
            // Backup too large for email - save locally
            const backupDir = path.join(__dirname, '..', 'output', 'backups');

            // Ensure backup directory exists
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true });
            }

            const timestamp = new Date().toISOString().split('T')[0];
            const filename = `backup_${timestamp}.sql.gz`;
            const filepath = path.join(backupDir, filename);

            // Save backup locally
            fs.writeFileSync(filepath, compressedBackup);

            logger.info('Backup saved locally (too large for email)', {
                filepath,
                compressedSize: `${compressedSizeMB} MB`,
                maxEmailSize: `${MAX_EMAIL_SIZE_MB} MB`
            });

            // Clean up old backups (keep last N)
            const backupFiles = fs.readdirSync(backupDir)
                .filter(f => f.startsWith('backup_') && f.endsWith('.sql.gz'))
                .sort()
                .reverse();

            if (backupFiles.length > BACKUP_RETENTION_COUNT) {
                const filesToDelete = backupFiles.slice(BACKUP_RETENTION_COUNT);
                for (const file of filesToDelete) {
                    fs.unlinkSync(path.join(backupDir, file));
                    logger.info('Deleted old backup', { file });
                }
            }

            // Send notification email about local backup
            await emailNotifier.sendBackupNotification(dbInfo, {
                filepath,
                filename,
                originalSizeMB,
                compressedSizeMB,
                compressionRatio,
                reason: 'Backup exceeds email attachment limit'
            });

            logger.info('Automated backup completed (saved locally)', {
                database: dbName,
                filepath,
                originalSize: `${originalSizeMB} MB`,
                compressedSize: `${compressedSizeMB} MB`,
                tableCount: statsResult.rows.length
            });

            return { ...result, delivery: 'local', filepath, filename };
        }
    } catch (error) {
        // Check if pg_dump is not installed
        if (error.message.includes('pg_dump: not found') || error.message.includes('command not found')) {
            throw new Error('pg_dump is not installed. Please install PostgreSQL client tools.');
        }
        throw error;
    }
}

/**
 * Cron job handler for scheduled backups
 * Wraps runAutomatedBackup with error handling and email alerts
 *
 * @returns {Promise<void>}
 */
async function runScheduledBackup() {
    logger.info('Running scheduled database backup');
    try {
        await runAutomatedBackup();
        logger.info('Scheduled database backup completed successfully');
    } catch (error) {
        logger.error('Scheduled database backup failed', { error: error.message, stack: error.stack });
        await emailNotifier.sendAlert(
            'Automated Database Backup Failed',
            `Failed to run scheduled database backup:\n\n${error.message}\n\nStack: ${error.stack}`
        );
    }
}

module.exports = {
    runAutomatedBackup,
    runScheduledBackup
};
