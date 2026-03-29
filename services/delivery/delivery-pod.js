/**
 * Delivery Proof of Delivery (POD) Service
 * Handles POD photo storage, retrieval, and cleanup.
 *
 * Extracted from delivery-service.js as part of leaf module split.
 *
 * Note: savePodPhoto depends on getOrderById/updateOrder/getSettings which
 * remain in delivery-service.js. Uses lazy require to avoid circular deps.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { validateUUID, POD_STORAGE_DIR } = require('./delivery-utils');

/**
 * Get delivery-service lazily to avoid circular dependency.
 * delivery-pod requires delivery-service for getOrderById/updateOrder,
 * and delivery-service requires delivery-pod for re-export.
 */
function _getDeliveryService() {
    return require('./delivery-service');
}

/**
 * Get delivery-settings lazily to avoid circular dependency.
 */
function _getDeliverySettings() {
    return require('./delivery-settings');
}

/**
 * Save a POD photo
 * @param {number} merchantId - The merchant ID
 * @param {string} orderId - The delivery order UUID
 * @param {Buffer} photoBuffer - Photo file buffer
 * @param {Object} metadata - Photo metadata
 * @returns {Promise<Object>} Created POD record
 */
async function savePodPhoto(merchantId, orderId, photoBuffer, metadata = {}) {
    const {
        originalFilename = 'pod.jpg',
        mimeType = 'image/jpeg',
        latitude = null,
        longitude = null
    } = metadata;

    // Validate orderId is a valid UUID format (security)
    validateUUID(orderId, 'order ID');

    // Validate image magic bytes (prevent MIME type spoofing)
    const magicBytes = photoBuffer.slice(0, 12);
    const isJpeg = magicBytes[0] === 0xFF && magicBytes[1] === 0xD8 && magicBytes[2] === 0xFF;
    const isPng = magicBytes[0] === 0x89 && magicBytes[1] === 0x50 && magicBytes[2] === 0x4E && magicBytes[3] === 0x47;
    const isGif = magicBytes[0] === 0x47 && magicBytes[1] === 0x49 && magicBytes[2] === 0x46;
    const isWebp = magicBytes[8] === 0x57 && magicBytes[9] === 0x45 && magicBytes[10] === 0x42 && magicBytes[11] === 0x50;

    if (!isJpeg && !isPng && !isGif && !isWebp) {
        throw new Error('Invalid image file - file content does not match image format');
    }

    // Verify order belongs to merchant
    const { getOrderById } = _getDeliveryService();
    const order = await getOrderById(merchantId, orderId);
    if (!order) {
        throw new Error('Order not found');
    }

    // Get retention settings
    const { getSettings } = _getDeliverySettings();
    const settings = await getSettings(merchantId);
    const retentionDays = settings?.pod_retention_days || 180;

    // Generate unique filename with merchant namespace
    // Use only safe extension based on detected type, not user input
    const fileId = crypto.randomUUID();
    const safeExt = isJpeg ? '.jpg' : isPng ? '.png' : isGif ? '.gif' : '.webp';
    const relativePath = `${merchantId}/${orderId}/${fileId}${safeExt}`;
    const fullPath = path.join(process.cwd(), POD_STORAGE_DIR, relativePath);

    // Ensure directory exists
    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });

    // Write file
    await fs.writeFile(fullPath, photoBuffer);

    // Calculate expiry date
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + retentionDays);

    // Create POD record
    const result = await db.query(
        `INSERT INTO delivery_pod (
            delivery_order_id, photo_path, original_filename,
            file_size_bytes, mime_type, latitude, longitude, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *`,
        [
            orderId, relativePath, originalFilename,
            photoBuffer.length, mimeType, latitude, longitude, expiresAt
        ]
    );

    // Update order status to delivered
    const { updateOrder } = _getDeliveryService();
    await updateOrder(merchantId, orderId, { status: 'delivered' });

    logger.info('Saved POD photo', { merchantId, orderId, podId: result.rows[0].id });

    return result.rows[0];
}

/**
 * Get POD photo path for serving
 * @param {number} merchantId - The merchant ID
 * @param {string} podId - The POD UUID
 * @returns {Promise<Object|null>} POD record with full path
 */
async function getPodPhoto(merchantId, podId) {
    // Validate UUID format (security)
    validateUUID(podId, 'POD ID');

    const result = await db.query(
        `SELECT dp.*, dord.merchant_id
         FROM delivery_pod dp
         JOIN delivery_orders dord ON dord.id = dp.delivery_order_id
         WHERE dp.id = $1 AND dord.merchant_id = $2`,
        [podId, merchantId]
    );

    if (result.rows.length === 0) {
        return null;
    }

    const pod = result.rows[0];
    const expectedPrefix = path.resolve(process.cwd(), POD_STORAGE_DIR);
    const resolvedPath = path.resolve(process.cwd(), POD_STORAGE_DIR, pod.photo_path);

    if (!resolvedPath.startsWith(expectedPrefix + path.sep) && resolvedPath !== expectedPrefix) {
        logger.warn('Path traversal attempt detected in POD photo_path', {
            merchantId, podId, photoPath: pod.photo_path
        });
        return null;
    }

    pod.full_path = resolvedPath;
    return pod;
}

/**
 * Clean up expired POD photos
 * @returns {Promise<Object>} Cleanup stats
 */
async function cleanupExpiredPods() {
    const expiredResult = await db.query(
        `SELECT dp.*, dord.merchant_id
         FROM delivery_pod dp
         JOIN delivery_orders dord ON dord.id = dp.delivery_order_id
         WHERE dp.expires_at < NOW()`
    );

    let deleted = 0;
    let errors = 0;

    for (const pod of expiredResult.rows) {
        try {
            const fullPath = path.join(process.cwd(), POD_STORAGE_DIR, pod.photo_path);
            await fs.unlink(fullPath);
            await db.query('DELETE FROM delivery_pod WHERE id = $1', [pod.id]);
            deleted++;
        } catch (err) {
            if (err.code !== 'ENOENT') {
                logger.error('Failed to delete expired POD', { podId: pod.id, error: err.message });
                errors++;
            } else {
                // File already gone, just delete record
                await db.query('DELETE FROM delivery_pod WHERE id = $1', [pod.id]);
                deleted++;
            }
        }
    }

    logger.info('POD cleanup complete', { deleted, errors });
    return { deleted, errors };
}

module.exports = {
    savePodPhoto,
    getPodPhoto,
    cleanupExpiredPods
};
