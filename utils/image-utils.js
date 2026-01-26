/**
 * Image Utilities
 *
 * Shared utilities for resolving image URLs from Square catalog images.
 * Used by expiry-discounts, items, and other routes that display product images.
 *
 * Images are synced from Square's API and stored in the images table with their
 * Square CDN URLs. This module resolves image IDs to their URLs.
 */

const db = require('./database');
const logger = require('./logger');

/**
 * Resolve image IDs to URLs in batch
 *
 * Efficiently resolves multiple image IDs to their URLs in a single query.
 * Returns null for images not found in database.
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

    // Build result map for each item, filtering out images not found in database
    const resultMap = new Map();
    itemImageMapping.forEach(({ index, imageIds }) => {
        const urls = imageIds
            .map(id => urlMap[id] || null)
            .filter(url => url !== null);
        resultMap.set(index, urls);
    });

    return resultMap;
}

module.exports = {
    batchResolveImageUrls
};
