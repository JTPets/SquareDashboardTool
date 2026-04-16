/**
 * Catalog Location Health Service
 *
 * Service for tracking Square catalog location mismatches where a variation's
 * present_at_all_locations / present_at_all_future_locations flags differ from
 * its parent ITEM. Multi-tenant — runs for any authenticated merchant.
 *
 * This table is a permanent audit trail — rows are never pruned or deleted.
 *
 * Exports:
 *   checkAndRecordHealth(merchantId) → { checked, newMismatches, resolved, existingOpen }
 *   getMismatchHistory(merchantId)   → all rows ordered by detected_at DESC
 *   getOpenMismatches(merchantId)    → rows where resolved_at IS NULL and status='mismatch'
 *
 * @module services/catalog/location-health-service
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getMerchantToken, makeSquareRequest } = require('../square/square-client');
const { SQUARE: { MAX_PAGINATION_ITERATIONS } } = require('../../config/constants');

/**
 * Fetch all ITEM objects with their variations from Square Catalog API (paginated)
 * Returns a map of itemId → { item, variations[] }
 */
async function fetchCatalogItems(merchantId) {
    const accessToken = await getMerchantToken(merchantId);
    const items = new Map();
    let cursor = null;
    let iterations = 0;

    do {
        if (++iterations > MAX_PAGINATION_ITERATIONS) {
            logger.warn('Location health: pagination limit reached', { merchantId, iterations });
            break;
        }

        const endpoint = `/v2/catalog/list?types=ITEM&include_deleted_objects=false&include_related_objects=true${cursor ? `&cursor=${cursor}` : ''}`;
        const data = await makeSquareRequest(endpoint, { accessToken });

        for (const obj of (data.objects || [])) {
            if (obj.type === 'ITEM') {
                items.set(obj.id, {
                    item: obj,
                    variations: (obj.item_data?.variations || [])
                });
            }
        }

        cursor = data.cursor;
    } while (cursor);

    return items;
}

/**
 * Detect mismatches between a variation and its parent item
 * Returns array of mismatch descriptions or empty array if valid
 */
function detectMismatches(item, variation) {
    const mismatches = [];

    const itemPresentAll = item.present_at_all_locations === true;
    const varPresentAll = variation.present_at_all_locations === true;

    if (itemPresentAll !== varPresentAll) {
        mismatches.push('present_at_all_locations');
    }

    // present_at_all_future_locations may not always be set — only flag if explicitly different
    const itemFuture = item.present_at_all_future_locations;
    const varFuture = variation.present_at_all_future_locations;
    if (itemFuture !== undefined && varFuture !== undefined && itemFuture !== varFuture) {
        mismatches.push('present_at_all_future_locations');
    }

    // absent_at_location_ids override: Square treats this as authoritative over
    // present_at_all_locations=true. If the item is absent at a location but the
    // variation is present there, Square returns 400 INVALID_VALUE.
    const itemAbsentIds = item.absent_at_location_ids || [];
    if (itemPresentAll && itemAbsentIds.length > 0) {
        const varAbsentSet = new Set(variation.absent_at_location_ids || []);
        const varPresentSet = new Set(variation.present_at_location_ids || []);
        const conflicting = itemAbsentIds.filter(locId => {
            if (varPresentAll) return !varAbsentSet.has(locId);
            return varPresentSet.has(locId);
        });
        if (conflicting.length > 0) {
            mismatches.push(
                `absent_at_location_ids override: item not at [${conflicting.join(', ')}] but variation is present`
            );
        }
    }

    return mismatches;
}

/**
 * Check all catalog items for location mismatches and record in health table
 *
 * @param {number} merchantId - The merchant ID
 * @returns {Promise<Object>} { checked, newMismatches, resolved, existingOpen }
 */
async function checkAndRecordHealth(merchantId) {
    logger.info('Starting catalog location health check', { merchantId });

    const catalogItems = await fetchCatalogItems(merchantId);

    // Load existing open mismatches
    const openResult = await db.query(
        `SELECT id, variation_id, item_id, mismatch_type
         FROM catalog_location_health
         WHERE merchant_id = $1 AND status = 'mismatch' AND resolved_at IS NULL`,
        [merchantId]
    );
    const openByVariation = new Map();
    for (const row of openResult.rows) {
        openByVariation.set(row.variation_id, row);
    }

    let checked = 0;
    let newMismatches = 0;
    let resolved = 0;
    const currentMismatchVariationIds = new Set();

    for (const [itemId, { item, variations }] of catalogItems) {
        for (const variation of variations) {
            checked++;
            const variationId = variation.id;
            const mismatches = detectMismatches(item, variation);

            if (mismatches.length > 0) {
                const mismatchType = mismatches.join(', ');
                currentMismatchVariationIds.add(variationId);

                // Only insert if no open mismatch row exists
                if (!openByVariation.has(variationId)) {
                    await db.query(
                        `INSERT INTO catalog_location_health
                         (merchant_id, variation_id, item_id, status, mismatch_type, check_type)
                         VALUES ($1, $2, $3, 'mismatch', $4, 'location_mismatch')`,
                        [merchantId, variationId, itemId, mismatchType]
                    );
                    newMismatches++;
                    logger.info('New location mismatch detected', {
                        merchantId, variationId, itemId, mismatchType
                    });
                }
            }
        }
    }

    // Resolve previously mismatched variations that are now valid
    for (const [variationId, row] of openByVariation) {
        if (!currentMismatchVariationIds.has(variationId)) {
            await db.query(
                `UPDATE catalog_location_health
                 SET resolved_at = NOW(), status = 'valid'
                 WHERE id = $1`,
                [row.id]
            );
            resolved++;
            logger.info('Location mismatch resolved', {
                merchantId, variationId: row.variation_id, itemId: row.item_id
            });
        }
    }

    const existingOpen = currentMismatchVariationIds.size - newMismatches;
    const summary = { checked, newMismatches, resolved, existingOpen };
    logger.info('Catalog location health check complete', { merchantId, ...summary });
    return summary;
}

/**
 * Get full mismatch history for a merchant
 *
 * @param {number} merchantId - The merchant ID
 * @returns {Promise<Array>} All health rows ordered by detected_at DESC
 */
async function getMismatchHistory(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getMismatchHistory');
    }

    const result = await db.query(
        `SELECT id, merchant_id, variation_id, item_id, status, mismatch_type,
                detected_at, resolved_at, notes
         FROM catalog_location_health
         WHERE merchant_id = $1
         ORDER BY detected_at DESC`,
        [merchantId]
    );
    return result.rows;
}

/**
 * Get currently open mismatches for a merchant
 *
 * @param {number} merchantId - The merchant ID
 * @returns {Promise<Array>} Open mismatch rows
 */
async function getOpenMismatches(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getOpenMismatches');
    }

    const result = await db.query(
        `SELECT id, merchant_id, variation_id, item_id, status, mismatch_type,
                detected_at, notes
         FROM catalog_location_health
         WHERE merchant_id = $1 AND status = 'mismatch' AND resolved_at IS NULL
         ORDER BY detected_at DESC`,
        [merchantId]
    );
    return result.rows;
}

module.exports = {
    checkAndRecordHealth,
    getMismatchHistory,
    getOpenMismatches
};
