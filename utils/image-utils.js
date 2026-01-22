/**
 * Image Utilities
 *
 * Shared utilities for resolving image URLs from Square catalog images.
 * Used by expiry-discounts, items, and other routes that display product images.
 */

const db = require('./database');
const logger = require('./logger');

// AWS S3 Configuration (fallback for images not in database)
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || 'items-images-production';
const AWS_S3_REGION = process.env.AWS_S3_REGION || 'us-west-2';

/**
 * Resolve image IDs to URLs in batch
 *
 * Efficiently resolves multiple image IDs to their URLs in a single query.
 * Falls back to S3 URL format for images not found in database.
 *
 * This is much more efficient than calling resolveImageUrls for each item
 * @param {Array} items - Array of objects with 'images' and optional 'item_images' fields
 * @returns {Promise<Map>} Map of item index -> image URLs array
 */
async function batchResolveImageUrls(items) {
    // Collect all unique image IDs
    const allImageIds = new Set();
    const itemImageMapping = []; // Track which images belong to which item

    items.forEach((item, index) => {
        let imageIds = item.images;
        if (!imageIds || !Array.isArray(imageIds) || imageIds.length === 0) {
            imageIds = item.item_images;
        }
        if (imageIds && Array.isArray(imageIds)) {
            imageIds.forEach(id => allImageIds.add(id));
        }
        itemImageMapping.push({
            index,
            imageIds: imageIds && Array.isArray(imageIds) ? imageIds : []
        });
    });

    // If no images to resolve, return empty results
    if (allImageIds.size === 0) {
        return new Map(items.map((_, i) => [i, []]));
    }

    // Single batch query for ALL images
    const imageIdArray = Array.from(allImageIds);
    let urlMap = {};

    try {
        const placeholders = imageIdArray.map((_, i) => `$${i + 1}`).join(',');
        const result = await db.query(
            `SELECT id, url FROM images WHERE id IN (${placeholders}) AND url IS NOT NULL`,
            imageIdArray
        );

        result.rows.forEach(row => {
            if (row.url) {
                urlMap[row.id] = row.url;
            }
        });
    } catch (error) {
        logger.error('Error in batch image URL resolution', { error: error.message, stack: error.stack });
    }

    // Build result map for each item
    const resultMap = new Map();
    itemImageMapping.forEach(({ index, imageIds }) => {
        const urls = imageIds.map(id => {
            if (urlMap[id]) {
                return urlMap[id];
            }
            return `https://${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com/files/${id}/original.jpeg`;
        });
        resultMap.set(index, urls);
    });

    return resultMap;
}

/**
 * Get S3 URL for an image ID
 * @param {string} imageId - The image ID
 * @returns {string} The S3 URL
 */
function getS3ImageUrl(imageId) {
    return `https://${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com/files/${imageId}/original.jpeg`;
}

module.exports = {
    batchResolveImageUrls,
    getS3ImageUrl,
    AWS_S3_BUCKET,
    AWS_S3_REGION
};
