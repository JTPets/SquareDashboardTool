/**
 * Cloudflare R2 Off-Site Backup Upload
 *
 * Uploads backup files to Cloudflare R2 (S3-compatible) using
 * native HTTPS with AWS Signature V4 signing — no heavy SDK.
 *
 * Retains last 7 daily backups in R2, deleting older ones.
 *
 * Env vars required (all prefixed BACKUP_R2_):
 *   BACKUP_R2_ENABLED=true
 *   BACKUP_R2_ACCOUNT_ID=<cloudflare-account-id>
 *   BACKUP_R2_ACCESS_KEY_ID=<r2-access-key-id>
 *   BACKUP_R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
 *   BACKUP_R2_BUCKET_NAME=<bucket-name>
 *
 * @module utils/r2-backup
 */

const https = require('https');
const crypto = require('crypto');
const logger = require('./logger');

const R2_RETENTION_DAYS = 7;

/**
 * Check if R2 backup is configured and enabled
 * @returns {boolean}
 */
function isR2Enabled() {
    return process.env.BACKUP_R2_ENABLED === 'true'
        && !!process.env.BACKUP_R2_ACCOUNT_ID
        && !!process.env.BACKUP_R2_ACCESS_KEY_ID
        && !!process.env.BACKUP_R2_SECRET_ACCESS_KEY
        && !!process.env.BACKUP_R2_BUCKET_NAME;
}

/**
 * Build R2 endpoint hostname
 * @returns {string}
 */
function getR2Host() {
    return `${process.env.BACKUP_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

/**
 * Create HMAC-SHA256 digest
 */
function hmac(key, data) {
    return crypto.createHmac('sha256', key).update(data).digest();
}

/**
 * Create SHA-256 hash of data
 */
function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Generate AWS Signature V4 headers for S3-compatible API
 * @param {string} method - HTTP method
 * @param {string} path - URL path (e.g. /bucket/key)
 * @param {Buffer|string} body - Request body
 * @param {Object} extraHeaders - Additional headers
 * @returns {Object} - Headers with Authorization
 */
function signRequest(method, path, body, extraHeaders = {}) {
    const host = getR2Host();
    const accessKeyId = process.env.BACKUP_R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.BACKUP_R2_SECRET_ACCESS_KEY;
    const region = 'auto';
    const service = 's3';

    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:]/g, '').slice(0, 8);
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

    const payloadHash = sha256(body || '');

    const headers = {
        host,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        ...extraHeaders,
    };

    // Canonical request
    const signedHeaderKeys = Object.keys(headers).sort();
    const signedHeaders = signedHeaderKeys.join(';');
    const canonicalHeaders = signedHeaderKeys
        .map(k => `${k}:${headers[k]}\n`)
        .join('');

    const canonicalRequest = [
        method,
        path,
        '', // query string
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n');

    // String to sign
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        sha256(canonicalRequest),
    ].join('\n');

    // Signing key
    const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, 'aws4_request');

    const signature = crypto
        .createHmac('sha256', kSigning)
        .update(stringToSign)
        .digest('hex');

    headers['Authorization'] =
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return headers;
}

/**
 * Make an HTTPS request to R2
 * @param {string} method
 * @param {string} path
 * @param {Buffer|string} body
 * @param {Object} extraHeaders
 * @returns {Promise<{statusCode: number, body: string}>}
 */
function r2Request(method, path, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const headers = signRequest(method, path, body, extraHeaders);

        const req = https.request({
            hostname: getR2Host(),
            port: 443,
            path,
            method,
            headers,
            timeout: 120000, // 2 minutes for upload
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({
                statusCode: res.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(new Error('R2 request timed out'));
        });

        if (body) {
            req.write(body);
        }
        req.end();
    });
}

/**
 * Upload a backup file to R2
 * @param {Buffer} fileData - Compressed backup data
 * @param {string} filename - e.g. "backup_2026-03-22.sql.gz"
 * @returns {Promise<void>}
 */
async function uploadToR2(fileData, filename) {
    const bucket = process.env.BACKUP_R2_BUCKET_NAME;
    const path = `/${bucket}/${filename}`;

    logger.info('R2 backup: uploading', { filename, sizeBytes: fileData.length });

    const result = await r2Request('PUT', path, fileData, {
        'content-type': 'application/gzip',
        'content-length': String(fileData.length),
    });

    if (result.statusCode >= 200 && result.statusCode < 300) {
        logger.info('R2 backup: upload successful', { filename, statusCode: result.statusCode });
    } else {
        throw new Error(`R2 upload failed: HTTP ${result.statusCode} — ${result.body.slice(0, 200)}`);
    }
}

/**
 * List backup files in R2 bucket and delete those older than retention period
 * Retains last R2_RETENTION_DAYS daily backups.
 * @returns {Promise<number>} - Number of files deleted
 */
async function cleanupOldBackups() {
    const bucket = process.env.BACKUP_R2_BUCKET_NAME;
    const path = `/${bucket}?list-type=2&prefix=backup_`;

    const result = await r2Request('GET', path, '');

    if (result.statusCode !== 200) {
        logger.warn('R2 backup: failed to list objects for cleanup', {
            statusCode: result.statusCode,
        });
        return 0;
    }

    // Parse simple XML to extract keys — R2 returns S3 ListObjectsV2 XML
    const keyMatches = result.body.match(/<Key>([^<]+)<\/Key>/g);
    if (!keyMatches || keyMatches.length === 0) {
        return 0;
    }

    const keys = keyMatches
        .map(m => m.replace(/<\/?Key>/g, ''))
        .filter(k => k.startsWith('backup_') && k.endsWith('.sql.gz'))
        .sort()
        .reverse();

    if (keys.length <= R2_RETENTION_DAYS) {
        return 0;
    }

    const keysToDelete = keys.slice(R2_RETENTION_DAYS);
    let deleted = 0;

    for (const key of keysToDelete) {
        try {
            const delResult = await r2Request('DELETE', `/${bucket}/${key}`, '');
            if (delResult.statusCode >= 200 && delResult.statusCode < 300) {
                logger.info('R2 backup: deleted old backup', { key });
                deleted++;
            } else {
                logger.warn('R2 backup: failed to delete old backup', {
                    key,
                    statusCode: delResult.statusCode,
                });
            }
        } catch (err) {
            logger.warn('R2 backup: error deleting old backup', {
                key,
                error: err.message,
            });
        }
    }

    return deleted;
}

/**
 * Upload backup to R2 and clean up old backups.
 * Main entry point called from backup-job.js.
 * @param {Buffer} compressedBackup - gzipped SQL dump
 * @param {string} filename - e.g. "backup_2026-03-22.sql.gz"
 * @returns {Promise<{uploaded: boolean, deleted: number}>}
 */
async function uploadAndCleanup(compressedBackup, filename) {
    if (!isR2Enabled()) {
        return { uploaded: false, deleted: 0, reason: 'R2 not configured' };
    }

    try {
        await uploadToR2(compressedBackup, filename);
        const deleted = await cleanupOldBackups();
        return { uploaded: true, deleted };
    } catch (error) {
        logger.error('R2 backup: upload failed', {
            error: error.message,
            filename,
        });
        // Non-fatal — local backup still exists
        return { uploaded: false, deleted: 0, error: error.message };
    }
}

module.exports = {
    isR2Enabled,
    uploadAndCleanup,
    uploadToR2,
    cleanupOldBackups,
    // Exported for testing
    signRequest,
    R2_RETENTION_DAYS,
};
